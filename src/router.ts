/**
 * Worker fetch 入口：CORS → 鉴权 → 限流 → 路由表。
 *
 * 鉴权：除 OPTIONS 与 GET /health 外，所有路径要求
 *   Authorization: Bearer <RELAY_TOKEN>
 * 令牌只存在于 Worker secret，APP 从不下发 GitHub Token。
 */

import type { Env, ErrorCode, ErrorResponse } from "./types";
import { handleBuild } from "./build";
import { handleStatus } from "./status";
import { handleWorkflows } from "./workflows";
import { reconcileOpenJobs } from "./reconcile";
import {
  handleLogin,
  handleLogout,
  handleSession,
  hasValidSession,
  readCookie,
  SESSION_COOKIE_NAME,
} from "./ui";
import { handleListJobs } from "./jobs";
import { handleGetConfig, handlePatchConfig } from "./config_api";
import { handlePresign } from "./r2_presign";
import { handleStatusSteps } from "./status_steps";
import { handleLogDownload } from "./log_proxy";
import { loadConfig, resolveEnv, type ResolvedEnv } from "./config";
import { corsHeaders, error, json, timingSafeEqual, withCors } from "./http";

// 历史上其他模块从 router 引这两个，保留 re-export 以免改动扩散。
export { json, error, corsHeaders };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 预检：直接放行（具体请求仍要过鉴权）。
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    // 健康检查：不鉴权、不计流，供 CF 探活。
    //
    // 必须做真实探测，不能只回 ok:true —— 否则 KV 未绑 / namespace id
    // 填错时，/health 是全绿的，而每个真实请求才在 KV 上炸掉，排障时
    // 会被"健康检查明明正常"误导。
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
    const cfg: ResolvedEnv = await resolveEnv(env);

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

    // 鉴权 —— 只拦 /api/。
    //
    // deliberately 不做成全局前置：RELAY_TOKEN / RELAY_PASSWORD 是后端
    // secret，与"浏览器能否打开页面"无关。全局拦会把 / 这种本该返回
    // 页面的路径也变成 500，排障时看到的是一句与现象无关的报错。
    if (url.pathname.startsWith("/api/")) {
      const authErr = await checkAuth(request, cfg);
      if (authErr) return authErr;

      // 限流同样只作用于 API。
      const rlErr = checkRateLimit(request, cfg);
      if (rlErr) return rlErr;
    }

    try {
      switch (true) {
        case url.pathname === "/api/jobs" && request.method === "GET":
          return await handleListJobs(cfg, url);

        case url.pathname === "/api/workflows" && request.method === "GET":
          return await handleWorkflows(cfg, url);

        case url.pathname === "/api/build" && request.method === "POST":
          return await handleBuild(request, cfg, ctx);

        // 日志下载：代理 GitHub artifact（带令牌取回后转发给面板）
        case url.pathname.startsWith("/api/log/") && request.method === "GET": {
          const id = decodeURIComponent(url.pathname.slice("/api/log/".length));
          if (!id) return error(400, "bad_request", "缺少 jobId");
          return await handleLogDownload(cfg, id);
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
          return await handleStatusSteps(cfg, id);
        }

        case url.pathname === "/api/status/" && request.method === "GET":
          return error(400, "bad_request", "缺少 jobId");

        case url.pathname.startsWith("/api/status/") && request.method === "GET": {
          const jobId = decodeURIComponent(url.pathname.slice("/api/status/".length));
          if (!jobId) return error(400, "bad_request", "缺少 jobId");
          return await handleStatus(cfg, jobId);
        }

        // ── R2 预签名：APP 拿签名 URL 直传，密钥不出网关 ──
        case url.pathname === "/api/r2/presign" && request.method === "POST":
          return await handlePresign(request, cfg);

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
      //
      // 带上了调用方才拿得到 `err.stack` 之外的第一手信息，这也是
      // dashboard_entry.test.ts 盯的场景。
      return error(500, "internal_error", `网关内部错误：${detail}`);
    }
  },

  /**
   * Cron 兜底：每 2 分钟轮询未完结任务。
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

// ── 鉴权 ─────────────────────────────────────────────────────────────

/**
 * /api/* 鉴权：两条通道，任一通过即可。
 *
 *   1. Bearer <RELAY_TOKEN>            —— APP / 脚本等机器调用方
 *   2. session cookie (relay_session)  —— 浏览器里的管理面板
 *
 * 浏览器那条通道让 Vue 前端不必自己存令牌：cookie 是 HttpOnly 的，
 * 前端 JS 读不到，XSS 也偷不走；服务端旋转 RELAY_TOKEN 即可全部作废。
 */
async function checkAuth(request: Request, env: ResolvedEnv): Promise<Response | null> {
  // 双通道令牌：KV 里配置的（面板可改）与 CF secret 里的同时有效。
  // 迁移期新旧令牌并存，换令牌时不会让正在跑的 APP 立刻断掉。
  const tokens = [env.RELAY_TOKEN, env.RAW_RELAY_TOKEN].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (bearer) {
    let ok = false;
    for (const t of tokens) {
      if (timingSafeEqual(bearer, t)) ok = true;
    }
    if (ok) return null;
  }

  // 面板会话（浏览器）不需要 token 也能过——只要登录过。
  if (await hasValidSession(request, env)) return null;

  if (tokens.length === 0) {
    return error(500, "internal_error", "RELAY_TOKEN 未配置");
  }
  return error(401, "unauthorized", "无效或缺失的 Bearer 令牌 / 会话");
}

// ── 限流 ─────────────────────────────────────────────────────────────

interface Bucket {
  tokens: number;
  updated_at: number;
}

const buckets = new Map<string, Bucket>();
const BUCKET_TTL_MS = 10 * 60 * 1000;

/**
 * per-token 令牌桶。状态在 Worker isolate 内，冷启动重置——
 * 定位为防突发滥用，不是严格 SLO。
 */
function checkRateLimit(request: Request, env: Env): Response | null {
  const cap = Number.parseInt(env.RATE_LIMIT_PER_MIN ?? "120", 10);
  if (!Number.isFinite(cap) || cap <= 0) return null;

  // 限流 key 必须能区分调用方，否则所有人共用一个桶。
  //
  // 这里踩过坑：原实现取 authorization 头，`header.slice(7).trim()` 对
  // 没有 "Bearer " 前缀的值会直接截断成垃圾串；而面板请求根本带 cookie
  // 不带这个头，于是所有面板流量都落进同一个 "anonymous" 桶，两个浏览器
  // 加起来 120 次/分钟就互相限流。
  //
  // 现在的 key 优先级：Bearer 令牌 > session cookie > 连接 IP。
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const session = readCookie(request, SESSION_COOKIE_NAME);
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const token = bearer || session || ip || "anonymous";
  const now = Date.now();

  let bucket = buckets.get(token);
  if (!bucket || now - bucket.updated_at > BUCKET_TTL_MS) {
    bucket = { tokens: cap, updated_at: now };
    buckets.set(token, bucket);
  }

  // 按时间补充令牌。
  const elapsedMin = (now - bucket.updated_at) / 60_000;
  bucket.tokens = Math.min(cap, bucket.tokens + elapsedMin * cap);
  bucket.updated_at = now;

  if (bucket.tokens < 1) {
    const retryAfterSec = Math.ceil((1 - bucket.tokens) / (cap / 60));
    return new Response(
      JSON.stringify({
        success: false,
        error: `请求过于频繁，请 ${retryAfterSec}s 后重试`,
        code: "rate_limited",
      } satisfies ErrorResponse),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfterSec),
          ...corsHeaders(),
        },
      },
    );
  }

  bucket.tokens -= 1;
  // 顺手清理过期桶，防内存无限增长。
  if (buckets.size > 512) {
    for (const [k, v] of buckets) {
      if (now - v.updated_at > BUCKET_TTL_MS) buckets.delete(k);
    }
  }
  return null;
}

// ── 工具 ─────────────────────────────────────────────────────────────

/**
 * 真实健康检查：探测 KV 读写 + 报告缺失的配置。
 *
 * 分别用 200（健康）与 503（不健康）表达，让 CF 探活与人工排障都能
 * 一眼看出问题，而不是拿到一个恒为 true 的 ok 字段。
 */
/**
 * 健康检查。
 *
 * 判断标准 = 「管理面板与构建接口能不能正常用」，而不是「所有 secret 都配了」。
 *
 * 曾经把 RELAY_TOKEN 列为必填，导致一个自相矛盾的体验：文档说"接 APP
 * 时才需要 RELAY_TOKEN"，但前台一直显示"后端未就绪"——因为健康检查
 * 把它当硬性条件。RELAY_TOKEN 只影响 APP 的 Bearer 鉴权，面板用
 * session cookie，不受影响。
 *
 * 现在的分级：
 *   fatal  （503）：KV 不可用 —— 面板和所有接口都会挂
 *   degraded（200）：缺 GITHUB_TOKEN 等 —— 面板能进，但构建会失败，
 *                    用 warnings 告诉操作者哪部分不可用
 */
async function healthCheck(env: Env): Promise<Response> {
  const problems: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  // 判断"配没配"必须用合并后的配置：用户在面板里填了 GitHub Token 但
  // 没在 CF 里设 secret，光看 env 会误报缺失。
  // loadConfig 有 30s isolate 缓存，与下面的 KV 探针不冲突。
  const kvCfg = await loadConfig(env);
  const hasToken = Boolean(kvCfg.github_token || env.GITHUB_TOKEN);
  const hasOwner = Boolean(kvCfg.github_owner || env.GITHUB_OWNER);
  const hasRepo = Boolean(kvCfg.github_repo || env.GITHUB_REPO);
  const hasRelayToken = Boolean(kvCfg.relay_token || env.RELAY_TOKEN);

  // ── 致命：KV 不可用则整个网关无法工作 ──
  let kvOk = false;
  try {
    if (!env.EDGE_RELAY_KV) {
      problems.push("EDGE_RELAY_KV 未绑定（wrangler.toml 的 [[kv_namespaces]]）");
    } else {
      const probeKey = "health:probe";
      await env.EDGE_RELAY_KV.put(probeKey, String(Date.now()), { expirationTtl: 60 });
      const back = await env.EDGE_RELAY_KV.get(probeKey);
      kvOk = back !== null;
      if (!kvOk) problems.push("EDGE_RELAY_KV 写入后读回为空");
    }
  } catch (err) {
    problems.push(
      `EDGE_RELAY_KV 不可用: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 非致命：缺失只会让部分功能不可用，不该挡住面板 ──
  if (!hasToken) missing.push("GITHUB_TOKEN");
  if (!hasOwner) missing.push("GITHUB_OWNER");
  if (!hasRepo) missing.push("GITHUB_REPO");

  if (missing.length > 0) {
    warnings.push(`构建接口不可用（/api/workflows、/api/build 会失败）：缺 ${missing.join(", ")}`);
  }
  // RELAY_TOKEN 缺失只影响 APP，明确说出来而不是算作故障
  if (!hasRelayToken) {
    warnings.push("RELAY_TOKEN 未配置：APP 无法调用 /api/*（面板不受影响）");
  }

  const healthy = kvOk;
  return json(
    {
      ok: healthy,
      service: "edge-relay",
      server_time: Date.now(),
      kv: kvOk ? "ok" : "error",
      // missing 保留给"会导致构建失败"的项，语义与 warnings 一致
      missing,
      problems,
      warnings,
    },
    healthy ? 200 : 503,
  );
}


// json / error / corsHeaders / withCors / timingSafeEqual 见 http.ts
