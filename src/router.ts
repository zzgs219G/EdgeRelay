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
import { handleLogin, handleLogout, handleSession, hasValidSession } from "./ui";
import { handleListJobs } from "./jobs";
import { handleGetConfig, handlePatchConfig } from "./config_api";
import { resolveEnv, type ResolvedEnv } from "./config";
import { corsHeaders, error, json, timingSafeEqual, withCors } from "./http";

// 历史上其他模块从 router 引这两个，保留 re-export 以免改动扩散。
export { json, error, corsHeaders };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 把 KV 里的运行时配置合并进 env，供后续所有 handler 使用。
    // 这样各处仍照旧读 env.GITHUB_TOKEN 等，无需改动；而操作者可以
    // 在面板 UI 改配置（存 KV），不必每次回 Cloudflare 控制台。
    const cfg: ResolvedEnv = await resolveEnv(env);

    // 预检：直接放行（具体请求仍要过鉴权）。
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    // 健康检查：不鉴权、不计流，供 CF 探活。
    //
    // 必须做真实探测，不能只回 ok:true —— 否则 KV 未绑 / namespace id
    // 填错时，/health 是全绿的，而每个真实请求才在 KV 上炸掉，排障时
    // 会被"健康检查明明正常"误导。
    if (url.pathname === "/health" && request.method === "GET") {
      return await healthCheck(cfg);
    }

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

    // 其余非 /api/ 的 GET 一律交给 assets 里的 SPA。
    //
    // run_worker_first = true 让所有请求先过 Worker，而 assets 配了
    // not_found_handling = "single-page-application"。Worker 若在这里
    // 返回 JSON 404，SPA 兜底就永远没机会跑，/dashboard、/assets/*.js、
    // 任何深链全会变成一串 JSON。
    //
    // 登录与否由 vue-router 判断：未登录渲染 Login.vue，已登录渲染
    // Dashboard.vue。Worker 不再关心页面该显示什么。
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      // ASSETS 未绑定（本地 dev 或配错了）：给出可诊断的提示。
      return json(
        {
          ok: false,
          error: "静态资源未绑定：wrangler.toml 的 [assets] 或 frontend/dist 缺失",
          path: url.pathname,
        },
        503,
      );
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

        case url.pathname === "/api/status/" && request.method === "GET":
          return error(400, "bad_request", "缺少 jobId");

        case url.pathname.startsWith("/api/status/") && request.method === "GET": {
          const jobId = decodeURIComponent(url.pathname.slice("/api/status/".length));
          if (!jobId) return error(400, "bad_request", "缺少 jobId");
          return await handleStatus(cfg, jobId);
        }

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
      console.error("unhandled route error", {
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      return error(500, "internal_error", "网关内部错误");
    }
  },

  /**
   * Cron 兜底：每分钟轮询所有未完结任务。
   * APP 轮询 /api/status 只读 KV，真正的 GitHub 调用集中在这里，
   * 把 GitHub API 消耗压到与任务数无关的固定节奏上。
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

  const header = request.headers.get("authorization") ?? "";
  const token = header.slice(7).trim() || "anonymous";
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
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!env.GITHUB_OWNER) missing.push("GITHUB_OWNER");
  if (!env.GITHUB_REPO) missing.push("GITHUB_REPO");

  if (missing.length > 0) {
    warnings.push(`构建接口不可用（/api/workflows、/api/build 会失败）：缺 ${missing.join(", ")}`);
  }
  // RELAY_TOKEN 缺失只影响 APP，明确说出来而不是算作故障
  if (!env.RELAY_TOKEN) {
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
