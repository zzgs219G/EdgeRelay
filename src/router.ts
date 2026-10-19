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
import { handleLogin, handleLogout, hasValidSession, renderLoginPage } from "./ui";
import { handleListJobs } from "./jobs";
import { htmlResponse } from "./http";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 预检：直接放行（具体请求仍要过鉴权）。
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // 健康检查：不鉴权、不计流，供 CF 探活。
    //
    // 必须做真实探测，不能只回 ok:true —— 否则 KV 未绑 / namespace id
    // 填错时，/health 是全绿的，而每个真实请求才在 KV 上炸掉，排障时
    // 会被"健康检查明明正常"误导。
    if (url.pathname === "/health" && request.method === "GET") {
      return await healthCheck(env);
    }

    // 登录 / 登出：不鉴权（它们就是鉴权的一部分）。
    if (url.pathname === "/login" && request.method === "POST") {
      return await handleLogin(request, env);
    }
    if (url.pathname === "/logout" && request.method === "POST") {
      return handleLogout();
    }

    // 根路径：未登录给登录页，已登录放行给 SPA（assets 托管）。
    // 这是"打开网页不该报 RELAY_TOKEN 未配置"的关键——页面本身与
    // 后端 secret 无关，secret 缺失只在调 /api/* 时才暴露。
    if (url.pathname === "/" && request.method === "GET") {
      if (await hasValidSession(request, env)) {
        return env.ASSETS ? env.ASSETS.fetch(request) : htmlResponse(renderLoginPage());
      }
      return htmlResponse(renderLoginPage());
    }

    // 鉴权 —— 只拦 /api/。
    //
    // deliberately 不做成全局前置：RELAY_TOKEN / RELAY_PASSWORD 是后端
    // secret，与"浏览器能否打开页面"无关。全局拦会把 / 这种本该返回
    // 页面的路径也变成 500，排障时看到的是一句与现象无关的报错。
    if (url.pathname.startsWith("/api/")) {
      const authErr = await checkAuth(request, env);
      if (authErr) return authErr;

      // 限流同样只作用于 API。
      const rlErr = checkRateLimit(request, env);
      if (rlErr) return rlErr;
    }

    try {
      switch (true) {
        case url.pathname === "/api/jobs" && request.method === "GET":
          return await handleListJobs(env, url);

        case url.pathname === "/api/workflows" && request.method === "GET":
          return await handleWorkflows(env, url);

        case url.pathname === "/api/build" && request.method === "POST":
          return await handleBuild(request, env, ctx);

        case url.pathname.startsWith("/api/status/") && request.method === "GET": {
          const jobId = decodeURIComponent(url.pathname.slice("/api/status/".length));
          if (!jobId) return error(400, "bad_request", "缺少 jobId");
          return await handleStatus(env, jobId);
        }

        default:
          return error(404, "not_found", `未知路径 ${request.method} ${url.pathname}`);
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
async function checkAuth(request: Request, env: Env): Promise<Response | null> {
  const expected = env.RELAY_TOKEN;
  if (!expected) {
    return error(500, "internal_error", "RELAY_TOKEN 未配置");
  }

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer && timingSafeEqual(bearer, expected)) return null;

  if (await hasValidSession(request, env)) return null;

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
async function healthCheck(env: Env): Promise<Response> {
  const problems: string[] = [];
  const missing: string[] = [];

  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!env.RELAY_TOKEN) missing.push("RELAY_TOKEN");
  if (!env.GITHUB_OWNER) missing.push("GITHUB_OWNER");
  if (!env.GITHUB_REPO) missing.push("GITHUB_REPO");

  // KV 真实探测：写一个探针键再读回。
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

  if (missing.length > 0) problems.push(`未配置的 secret/vars: ${missing.join(", ")}`);

  const healthy = kvOk && missing.length === 0;
  return json(
    {
      ok: healthy,
      service: "edge-relay",
      server_time: Date.now(),
      kv: kvOk ? "ok" : "error",
      missing,
      problems,
    },
    healthy ? 200 : 503,
  );
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

export function error(status: number, code: ErrorCode, message: string): Response {
  const body: ErrorResponse = { success: false, error: message, code };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

/** 允许所有来源跨域（APP 为原生客户端，无 cookie 需求）。 */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
  };
}

function corsResponse(resp: Response): Response {
  for (const [k, v] of Object.entries(corsHeaders())) {
    resp.headers.set(k, v);
  }
  return resp;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
