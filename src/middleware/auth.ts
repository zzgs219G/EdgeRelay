/**
 * /api/* 鉴权。
 *
 * 两条通道，任一通过即可：
 *   1. Bearer <RELAY_TOKEN>            —— APP / 脚本等机器调用方
 *   2. session cookie (relay_session)  —— 浏览器里的管理面板
 *
 * 浏览器那条通道让 Vue 前端不必自己存令牌：cookie 是 HttpOnly 的，
 * 前端 JS 读不到，XSS 也偷不走；服务端旋转 RELAY_TOKEN 即可全部作废。
 *
 * 鉴权通过后返回**主体身份**（Principal），供路由做任务归属判断。
 * 见 services/principal.ts：任务归属是数据隔离的前提，jobId 可枚举。
 */

import type { ResolvedEnv } from "../services/config";
import { hasValidSession } from "../services/session";
import {
  PANEL_OWNER,
  relayTokens,
  tokenFingerprint,
  type Principal,
} from "../services/principal";
import { error, timingSafeEqual } from "../shared/http";

export interface AuthResult {
  /** 鉴权失败时的响应；成功为 null。 */
  error: Response | null;
  /** 鉴权通过时的主体；失败为 null。 */
  principal: Principal | null;
}

/**
 * 校验请求并解析出主体。
 *
 * 顺序：Bearer 令牌优先于面板会话。两者同时存在时以令牌为准——
 * 显式带令牌的调用方（APP/脚本）语义更明确。
 */
export async function authenticate(
  request: Request,
  env: ResolvedEnv,
): Promise<AuthResult> {
  // 双通道令牌：KV 里配置的（面板可改）与 CF secret 里的同时有效。
  // 迁移期新旧令牌并存，换令牌时不会让正在跑的 APP 立刻断掉。
  const tokens = relayTokens(env);

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (bearer) {
    let matched: string | null = null;
    // 常量时间比较，且逐个跑完不提前 return（避免用耗时区分命中位置）。
    for (const t of tokens) {
      if (timingSafeEqual(bearer, t)) matched = t;
    }
    if (matched !== null) {
      // 用**实际命中的那个令牌**算指纹，而不是请求里传的原文。
      // 两者相等（比较通过），但语义上归属应绑定到配置里的令牌——
      // 这样面板改 KV 令牌后，归属 ID 仍随之变化，旧任务自然隔离。
      return { error: null, principal: { kind: "token", id: await tokenFingerprint(matched) } };
    }
  }

  // 面板会话（浏览器）不需要 token 也能过——只要登录过。
  // 面板是特权主体：管理员能看全部任务。
  if (await hasValidSession(request, env)) {
    return { error: null, principal: { kind: "panel", id: PANEL_OWNER } };
  }

  if (tokens.length === 0) {
    return {
      error: error(500, "internal_error", "RELAY_TOKEN 未配置"),
      principal: null,
    };
  }
  return {
    error: error(401, "unauthorized", "无效或缺失的 Bearer 令牌 / 会话"),
    principal: null,
  };
}

/**
 * 兼容旧签名的薄封装：只要 Response | null。
 *
 * 保留它是因为 router 的鉴权流程只需要"过 / 不过"，而归属判断发生在
 * 具体路由里（各路由拿到 principal 后自行校验 owner）。
 */
export async function checkAuth(request: Request, env: ResolvedEnv): Promise<Response | null> {
  const { error: err } = await authenticate(request, env);
  return err;
}
