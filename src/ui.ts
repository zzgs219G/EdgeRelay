/**
 * 会话与登录：纯 JSON API，不返回任何 HTML。
 *
 * 曾经的错误设计：Worker 里手写了一个 HTML 登录页，Vue 里又有一个
 * Login.vue——于是出现"两个登录页"（未登录看到 Worker 那个，登录后
 * 看到 Vue 那个）。页面只该有一个实现，归前端。
 *
 * 现在：
 *   POST /login   {password} → 200 {ok:true} + Set-Cookie，或 401 {}
 *   POST /logout             → 200 {ok:true} + 清 cookie
 *   GET  /api/session        → {logged:boolean}，供前端启动时探测
 *
 * 所有页面路由（/、/dashboard、任意深链）一律交给 assets 里的 Vue SPA，
 * 由 vue-router 决定渲染登录页还是控制台。
 */

import type { Env } from "./types";
import type { ResolvedEnv } from "./config";

export const SESSION_COOKIE_NAME = "relay_session";
const SESSION_LABEL = "relay_session_v1";
const DEFAULT_SESSION_TTL_SEC = 8 * 60 * 60;

function arrayBufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSign(secret: string, payload: string): Promise<string> {
  if (!secret) {
    // crypto.subtle.importKey 对空密钥抛的 DataError（"key length (0)"）
    // 指不到"secret 没配"上，提前拦住并说清楚。
    throw new Error("HMAC 密钥为空：RELAY_PASSWORD secret 未配置");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return arrayBufferToHex(sig);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function readCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie") ?? "";
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return "";
}

/**
 * session cookie 的 HMAC 签名密钥。
 *
 * 从 RELAY_PASSWORD 派生，而不是 RELAY_TOKEN——那两个是不同用途的
 * secret：RELAY_PASSWORD 是浏览器登录凭据，RELAY_TOKEN 是 APP 调
 * /api/* 的机器令牌。面板登录只该依赖密码，缺 RELAY_TOKEN 不该让
 * 面板也登不进去。
 */
function sessionSecret(env: Env): string {
  const pw = env.RELAY_PASSWORD ?? "";
  const token = env.RELAY_TOKEN ?? "";
  // 配了 token 就并进标签，这样旋转 RELAY_TOKEN 仍会让所有已签发
  // session 失效（旧 cookie 的签名用带旧 token 的标签算的，验不过）。
  const info = token ? `relay-session-v1+tok:${token}` : "relay-session-v1";
  return `${info}:pw:${pw}`;
}

function sessionTtlSec(env: Env): number {
  const raw = Number.parseInt(env.RELAY_SESSION_TTL_SEC ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_TTL_SEC;
  return Math.min(Math.max(raw, 60), 30 * 24 * 60 * 60);
}

/** 构造 `<expiry_ms>.<hex_sig>` 会话 cookie 值。 */
export async function buildSessionCookie(env: Env, ttlSec: number): Promise<string> {
  const exp = Date.now() + ttlSec * 1000;
  const sig = await hmacSign(sessionSecret(env), `${SESSION_LABEL}:${exp}`);
  return `${exp}.${sig}`;
}

/** 校验会话 cookie：格式正确、未过期、签名匹配。 */
export async function verifySessionCookie(env: Env, raw: string): Promise<boolean> {
  const secret = sessionSecret(env);
  if (!secret || !raw) return false;
  const dot = raw.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number.parseInt(raw.slice(0, dot), 10);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  try {
    const expected = await hmacSign(secret, `${SESSION_LABEL}:${exp}`);
    return constantTimeEqual(raw.slice(dot + 1), expected);
  } catch {
    return false;
  }
}

/** 当前请求是否携带有效会话。 */
export async function hasValidSession(request: Request, env: Env): Promise<boolean> {
  // 只依赖 RELAY_PASSWORD（已派生进 sessionSecret）。缺 RELAY_TOKEN 不影响面板。
  if (!env.RELAY_PASSWORD) return false;
  return verifySessionCookie(env, readCookie(request, SESSION_COOKIE_NAME));
}

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
