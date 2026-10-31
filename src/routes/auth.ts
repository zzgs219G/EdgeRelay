/**
 * 会话相关的 HTTP 接口：纯 JSON，不返回任何 HTML。
 *
 * 曾经的错误设计：Worker 里手写了一个 HTML 登录页，Vue 里又有一个
 * Login.vue——于是出现"两个登录页"（未登录看到 Worker 那个，登录后
 * 看到 Vue 那个）。页面只该有一个实现，归前端。
 *
 *   POST /login   {password} → 200 {ok:true} + Set-Cookie，或 401 {}
 *   POST /logout             → 200 {ok:true} + 清 cookie
 *   GET  /api/session        → {logged:boolean}，供前端启动时探测
 *
 * 所有页面路由（/、/dashboard、任意深链）一律交给 assets 里的 Vue SPA，
 * 由 vue-router 决定渲染登录页还是控制台。
 *
 * cookie 的签发/校验原语在 services/session.ts（中间件也要用）。
 */

import type { Env } from "../shared/types";
import type { ResolvedEnv } from "../services/config";
import {
  buildSessionCookie,
  hasValidSession,
  SESSION_COOKIE_NAME,
  sessionTtlSec,
} from "../services/session";

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function buildSetCookie(value: string, ttlSec: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${ttlSec}`,
  ].join("; ");
}

/**
 * POST /login
 *
 * body: {"password": "..."}（JSON）或 form-urlencoded 的 password 字段
 * 返回: 200 {ok:true} / 401 {ok:false,error} / 500 {ok:false,error}
 *
 * 只依赖 RELAY_PASSWORD。密码不匹配时统一慢响应约 750ms，压制暴力破解。
 */
export async function handleLogin(request: Request, env: ResolvedEnv): Promise<Response> {
  // 双通道：KV 里配置的密码（可在面板 UI 改）与 CF secret 里的密码
  // 同时有效。单通道会出问题——用户在 UI 里改密码时打错或忘记，
  // 就把自己彻底锁在门外，只能重开 Cloudflare 控制台。env 是逃生舱。
  const candidates = [env.RELAY_PASSWORD, env.RAW_RELAY_PASSWORD].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (candidates.length === 0) {
    return json(
      {
        ok: false,
        error:
          "服务端未配置管理密码。请在面板配置页设置，或执行 wrangler secret put RELAY_PASSWORD",
      },
      500,
    );
  }

  let provided = "";
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { password?: unknown };
      provided = typeof body.password === "string" ? body.password : "";
    } else {
      const form = await request.formData();
      const pw = form.get("password");
      provided = typeof pw === "string" ? pw : "";
    }
  } catch {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }

  // 无论成败都慢同样时长，避免用响应时间区分"密码错了"与"密码对了"。
  await new Promise((r) => setTimeout(r, 750));

  // 任一候选匹配即通过。常量时间比较逐个跑完，不提前 return。
  let matched = false;
  for (const c of candidates) {
    if (constantTimeEqual(provided, c)) matched = true;
  }
  if (!matched) {
    return json({ ok: false, error: "密码不正确" }, 401);
  }

  const ttl = sessionTtlSec(env);
  const cookie = await buildSessionCookie(env, ttl);
  return json({ ok: true }, 200, { "set-cookie": buildSetCookie(cookie, ttl) });
}

/** POST /logout：清除 cookie。返回 JSON，不用 303——前端用 fetch 调它。 */
export function handleLogout(): Response {
  return json({ ok: true }, 200, {
    "set-cookie": `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  });
}

/** GET /api/session：供前端启动时探测登录态。 */
export async function handleSession(request: Request, env: Env): Promise<Response> {
  return json({ logged: await hasValidSession(request, env) });
}
