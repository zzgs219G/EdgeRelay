/**
 * Worker fetch 入口：CORS → 静态资源 → 配置合并 → 鉴权 → 限流 → 路由表。
 *
 * 鉴权：除 OPTIONS 与 GET /health 外，所有 /api/* 路径要求
 *   Authorization: Bearer <RELAY_TOKEN> 或 session cookie
 * 令牌只存在于 Worker secret，APP 从不下发 GitHub Token。
 *
 * 本文件刻意保持"薄"：只做分发，任何业务逻辑都下沉到 routes/ 与
 * services/。这样加一个接口 = 加一个 routes/xxx.ts + 这里一行 case，
 * 两边都不会膨胀。
 */

import type { Env } from "./shared/types";
import { resolveEnv, type ResolvedEnv } from "./services/config";
import { reconcileOpenJobs } from "./services/reconcile";
import { authenticate } from "./middleware/auth";
import { PANEL_OWNER, type Principal } from "./services/principal";
import { wrapKvWithCounter } from "./services/usage";
import { checkRateLimit } from "./middleware/rate_limit";
import { healthCheck } from "./middleware/health";
import { error, json, withCors } from "./shared/http";

import { handleBuild } from "./routes/build";
import { handleStatus } from "./routes/status";
import { handleStatusSteps } from "./routes/status_steps";
import { handleWorkflows } from "./routes/workflows";
import { handleListJobs } from "./routes/jobs";
import { handleGetConfig, handlePatchConfig } from "./routes/config";
import { handleLogin, handleLogout, handleSession } from "./routes/auth";
import { handlePresign } from "./routes/r2_presign";
import { handleLogDownload } from "./routes/log_download";
import { handleArtifactDownload } from "./routes/artifact_download";
import { handleUsage } from "./routes/usage";

// 历史上其他模块从 router 引这两个，保留 re-export 以免改动扩散。
export { json, error };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 预检：直接放行（具体请求仍要过鉴权）。
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    // 健康检查：不鉴权、不计流，供 CF 探活。
    //
    // 注意这里用原始 env 而非合并后的配置：healthCheck 自己已经要读写
    // KV 探针，再叠加一次 resolveEnv 就是两次 KV 读，纯浪费。
    if (url.pathname === "/health" && request.method === "GET") {
      return await healthCheck(env);
    }

    // 静态资源（SPA 的 js/css/字体、以及任意前端路由）不需要任何后端
    // 配置——直接交给 assets，连 KV 都不碰。这是最常见的一类请求，
    // 放在这里提前返回能省掉每请求一次 KV 读。
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json(
        {
          ok: false,
          error: "静态资源未绑定：wrangler.toml 的 [assets] 或 frontend/dist 缺失",
          path: url.pathname,
        },
        503,
      );
    }

    // 到这里才需要运行时配置（/login、/api/*）。
    // 把 KV 里的值合并进 env 供后续 handler 使用，各处仍照旧读
    // env.GITHUB_TOKEN 等，无需改动。
    const rawKv = env.EDGE_RELAY_KV;
    // 把 KV 包一层用量计数代理：所有经 env.EDGE_RELAY_KV 的操作都会被
    // 记账（19 个调用点一行不用改）。rawKv 保留给用量模块自己落盘，
    // 避免"统计本身消耗额度"的自我放大。
    const cfg: ResolvedEnv = await resolveEnv(
      env.EDGE_RELAY_KV ? { ...env, EDGE_RELAY_KV: wrapKvWithCounter(env.EDGE_RELAY_KV) } : env,
    );

    // 登录 / 登出 / 会话探测：纯 JSON，不鉴权（它们就是鉴权的一部分）。
    //
    // 页面只由 Vue 前端实现一份，Worker 不返回任何 HTML——历史上
    // Worker 手写过一个登录页，与 Vue 的 Login.vue 并存，导致"两个
    // 登录页"（未登录看到 Worker 那个，登录后看到 Vue 那个）。
    if (url.pathname === "/login" && request.method === "POST") {
      return await handleLogin(request, cfg);
    }
    if (url.pathname === "/logout" && request.method === "POST") {
      return handleLogout();
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      return await handleSession(request, cfg);
    }

    // 鉴权与限流 —— 只拦 /api/。
    //
    // deliberately 不做成全局前置：RELAY_TOKEN / RELAY_PASSWORD 是后端
    // secret，与"浏览器能否打开页面"无关。全局拦会把 / 这种本该返回
    // 页面的路径也变成 500，排障时看到的是一句与现象无关的报错。
    //
    // 鉴权通过后拿到 principal（主体身份），供各路由做任务归属校验。
    // 面板是特权主体（可读全部任务），令牌只能读自己的。
    let principal: Principal = { kind: "panel", id: PANEL_OWNER };
    if (url.pathname.startsWith("/api/")) {
      const auth = await authenticate(request, cfg);
      if (auth.error) return auth.error;
      if (auth.principal) principal = auth.principal;

      const rlErr = checkRateLimit(request, cfg);
      if (rlErr) return rlErr;
    }

    try {
      switch (true) {
        case url.pathname === "/api/jobs" && request.method === "GET":
          return await handleListJobs(cfg, url, principal);

        case url.pathname === "/api/workflows" && request.method === "GET":
          return await handleWorkflows(cfg, url);

        case url.pathname === "/api/build" && request.method === "POST":
          return await handleBuild(request, cfg, ctx, principal);

        // 日志下载：代理 GitHub artifact（带令牌取回后转发给面板）
        case url.pathname.startsWith("/api/log/") && request.method === "GET": {
          const id = decodeURIComponent(url.pathname.slice("/api/log/".length));
          if (!id) return error(400, "bad_request", "缺少 jobId");
          return await handleLogDownload(cfg, id, principal);
        }

        // 产物下载：同 log 的代理思路。download_url 是 GitHub artifact 链接时，
        // 浏览器直连会因不带令牌而撞未认证限额（60 次/小时/IP），
        // 必须由网关带令牌取回后再转发。
        case url.pathname.startsWith("/api/artifact/") && request.method === "GET": {
          const id = decodeURIComponent(url.pathname.slice("/api/artifact/".length));
          if (!id) return error(400, "bad_request", "缺少 jobId");
          return await handleArtifactDownload(cfg, id, principal);
        }

        // 步骤明细必须排在 /api/status/ 前缀匹配之前，
        // 否则会被当成 jobId="xxx/steps" 处理。
        case url.pathname.startsWith("/api/status/") &&
          url.pathname.endsWith("/steps") &&
          request.method === "GET": {
          const id = decodeURIComponent(
            url.pathname.slice("/api/status/".length, -"/steps".length),
          );
          if (!id) return error(400, "bad_request", "缺少 jobId");
          return await handleStatusSteps(cfg, id, principal);
        }

        case url.pathname === "/api/status/" && request.method === "GET":
          return error(400, "bad_request", "缺少 jobId");

        case url.pathname.startsWith("/api/status/") && request.method === "GET": {
          const jobId = decodeURIComponent(url.pathname.slice("/api/status/".length));
          if (!jobId) return error(400, "bad_request", "缺少 jobId");
          return await handleStatus(cfg, jobId, principal);
        }

        // ── R2 预签名：APP 拿签名 URL 直传，密钥不出网关 ──
        case url.pathname === "/api/r2/presign" && request.method === "POST":
          return await handlePresign(request, cfg);

        // ── 额度仪表盘：KV 用量自己记账，Workers 请求数可选接 GraphQL ──
        case url.pathname === "/api/usage" && request.method === "GET":
          return await handleUsage(cfg, rawKv);

        // ── 运行时配置：面板 UI 直接改，不必回 Cloudflare 控制台 ──
        case url.pathname === "/api/config" && request.method === "GET":
          return await handleGetConfig(cfg);

        case url.pathname === "/api/config" && request.method === "PATCH":
          return await handlePatchConfig(request, cfg);

        default:
          // 只有 /api/* 会走到这里（其它 GET 已在上面交给 assets）。
          // 非 /api/ 的未匹配路径不返回 JSON 404——那会骗过 SPA 兜底，
          // 让浏览器看到一串 JSON 而不是页面。
          if (url.pathname.startsWith("/api/")) {
            return error(404, "not_found", `未知路径 ${request.method} ${url.pathname}`);
          }
          return env.ASSETS
            ? env.ASSETS.fetch(request)
            : error(404, "not_found", `未知路径 ${request.method} ${url.pathname}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("unhandled route error", {
        path: url.pathname,
        error: detail,
      });
      // 把真实异常带回给调用方。
      //
      // 为什么改：曾经只返回「网关内部错误」五个字，而这是路由里唯一
      // 的总兜底。结果一次线上 500（/api/jobs）排查时，CF Observability
      // 只记了 request 行、看不出是哪个 handler 抛的，真实异常要另外去
      // 后台翻 console.error 的另一条日志——排障成本极高。
      //
      // 安全性：能走到这里的请求都已通过 checkAuth（Bearer 或 session），
      // 把异常消息回给已授权的调用方不构成泄漏。而 `detail` 只含错误
      // 消息、不含堆栈与请求内容。
      return error(500, "internal_error", `网关内部错误：${detail}`);
    }
  },

  /**
   * Cron 兜底：轮询未完结任务。
   *
   * APP 轮询 /api/status 只读 KV，真正的 GitHub 调用集中在这里，
   * 把 GitHub API 消耗压到与任务数无关的固定节奏上。
   *
   * 频率为什么不是每分钟：KV list 额度 1000 次/天，见 wrangler.toml
   * [triggers] 上方的说明。现由「信号灯 + 每 2 分钟」压到约 20 次/天。
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await reconcileOpenJobs(env);
    } catch (err) {
      console.error("scheduled reconcile error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
