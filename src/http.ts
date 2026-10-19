/**
 * 共享 HTTP 工具：JSON 响应、错误响应、CORS 头、常量时间比较。
 *
 * 单独成文件是为了打断循环依赖：router.ts 要 import config_api.ts 的
 * handler，而 config_api.ts 又需要 json()。若 json() 留在 router.ts 里
 * 就成了环。
 */

import type { ErrorCode, ErrorResponse } from "./types";

/** 允许所有来源跨域（APP 为原生客户端，无 cookie 需求）。 */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
  };
}

export function withCors(resp: Response): Response {
  for (const [k, v] of Object.entries(corsHeaders())) {
    resp.headers.set(k, v);
  }
  return resp;
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

/** 常量时间字符串比较，避免用响应时间侧信道猜令牌。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
