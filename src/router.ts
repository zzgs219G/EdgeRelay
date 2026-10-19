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

    // 鉴权。
    const authErr = checkAuth(request, env);
    if (authErr) return authErr;

    // 限流（令牌桶，per-token，isolate 内）。
    const rlErr = checkRateLimit(request, env);
    if (rlErr) return rlErr;

    try {
      switch (true) {
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

function checkAuth(request: Request, env: Env): Response | null {
  const expected = env.RELAY_TOKEN;
  if (!expected) {
    return error(500, "internal_error", "RELAY_TOKEN 未配置");
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !timingSafeEqual(token, expected)) {
    return error(401, "unauthorized", "无效或缺失的 Bearer 令牌");
  }
  return null;
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
    if (!env.BUILD_JOBS) {
      problems.push("BUILD_JOBS 未绑定（wrangler.toml 的 [[kv_namespaces]]）");
    } else {
      const probeKey = "health:probe";
      await env.BUILD_JOBS.put(probeKey, String(Date.now()), { expirationTtl: 60 });
      const back = await env.BUILD_JOBS.get(probeKey);
      kvOk = back !== null;
      if (!kvOk) problems.push("BUILD_JOBS 写入后读回为空");
    }
  } catch (err) {
    problems.push(
      `BUILD_JOBS 不可用: ${err instanceof Error ? err.message : String(err)}`,
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
