/**
 * /api/* 鉴权。
 *
 * 两条通道，任一通过即可：
 *   1. Bearer <RELAY_TOKEN>            —— APP / 脚本等机器调用方
 *   2. session cookie (relay_session)  —— 浏览器里的管理面板
 *
 * 浏览器那条通道让 Vue 前端不必自己存令牌：cookie 是 HttpOnly 的，
 * 前端 JS 读不到，XSS 也偷不走；服务端旋转 RELAY_TOKEN 即可全部作废。
 */

import type { ResolvedEnv } from "../services/config";
import { hasValidSession } from "../services/session";
import { error, timingSafeEqual } from "../shared/http";

export async function checkAuth(request: Request, env: ResolvedEnv): Promise<Response | null> {
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
