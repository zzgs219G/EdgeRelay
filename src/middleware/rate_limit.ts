/**
 * per-token 令牌桶限流。
 *
 * 状态在 Worker isolate 内，冷启动重置——定位为防突发滥用，不是严格 SLO。
 */

import type { Env, ErrorResponse } from "../shared/types";
import { SESSION_COOKIE_NAME, readCookie } from "../services/session";
import { corsHeaders } from "../shared/http";

interface Bucket {
  tokens: number;
  updated_at: number;
}

const buckets = new Map<string, Bucket>();
const BUCKET_TTL_MS = 10 * 60 * 1000;

export function checkRateLimit(request: Request, env: Env): Response | null {
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
