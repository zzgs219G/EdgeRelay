/**
 * 会话 cookie 的签发与校验（HMAC-SHA256 签名，无状态）。
 *
 * 为什么单独一个服务模块：中间件（middleware/auth.ts，判定请求是否已登录）
 * 与路由（routes/auth.ts，登录/登出）都需要这套原语。放在路由里会让
 * 中间件反向依赖 HTTP handler，是层次违规。
 *
 * cookie 值格式：`<expiry_ms>.<hex_sig>`，签名内容为 `relay_session_v1:<exp>`
 * 用从 RELAY_PASSWORD 派生的密钥。无状态 → 不需要 KV，登出只需清 cookie。
 */

import type { Env } from "../shared/types";

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

export function sessionTtlSec(env: Env): number {
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
