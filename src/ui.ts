/**
 * 前端层：登录页 HTML + session 管理。
 *
 * 为什么 Worker 里还有一个 HTML 页面：assets 托管 Vue 构建产物后，
 * /api/* 走 Worker，其余走静态资源。但「未登录时打开 /」需要 Worker
 * 决定给登录页还是让 SPA 自己路由——这里直接由 Worker 返回一个
 * 极简登录页，避免为了一个登录表单把整个 Vue bundle 都拉下来。
 *
 * 登录成功后种 HttpOnly session cookie，前端 Vue 应用通过
 * /api/jobs 探测登录态（200=已登录，401=未登录）。
 */

import type { Env } from "./types";

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
    // crypto.subtle.importKey 对空密钥抛的 DataError 信息（"key length (0)"）
    // 完全指不到"secret 没配"上，所以在这里提前拦住并说清楚。
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
 * 从 RELAY_PASSWORD 派生，而不是用 RELAY_TOKEN——那两个是不同用途的
 * secret：RELAY_PASSWORD 是浏览器登录凭据，RELAY_TOKEN 是 APP 调 /api/*
 * 的机器令牌。面板登录只该依赖密码，缺 RELAY_TOKEN 不该让面板也登不进去。
 *
 * 用 HKDF 式的 info 标签把「密码」和「签名密钥」两个角色分开，避免同一份
 * 密钥材料既当口令又当 MAC key。
 */
function sessionSecret(env: Env): string {
  const pw = env.RELAY_PASSWORD ?? "";
  const token = env.RELAY_TOKEN ?? "";
  // 派生标签：固定串 + token 是否存在。配了 token 就把它并进标签，
  // 这样旋转 RELAY_TOKEN 仍会让所有已签发的 session 失效（旧 cookie 的
  // 签名是用带旧 token 的标签算的，验不过）。
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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 登录页（极简，无外部依赖）。 */
export function renderLoginPage(errorMessage?: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EdgeRelay · 登录</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0b0e14;color:#e6e9ef;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:340px;background:#141922;border:1px solid #232a36;border-radius:16px;padding:32px 28px}
h1{font-size:20px;margin:0}
.sub{color:#8b94a7;font-size:13px;margin:4px 0 24px}
input{width:100%;padding:11px 12px;background:#0b0e14;color:#e6e9ef;
  border:1px solid #232a36;border-radius:8px;font-size:14px}
input:focus{outline:none;border-color:#4f8cff}
button{width:100%;padding:11px;margin-top:14px;background:#4f8cff;color:#fff;
  border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.err{color:#f85149;font-size:13px;margin-top:12px;min-height:20px}
.hint{color:#8b94a7;font-size:12px;margin-top:16px}
code{font-family:ui-monospace,Menlo,monospace}
</style>
</head>
<body>
<div class="card">
  <h1>EdgeRelay</h1>
  <p class="sub">APK 构建网关 · 管理控制台</p>
  <form method="POST" action="/login" autocomplete="off">
    <input type="password" name="password" placeholder="请输入管理密码" required autofocus>
    <button type="submit">进入控制台</button>
  </form>
  <div class="err">${errorMessage ? escapeHtml(errorMessage) : ""}</div>
  <p class="hint">密码由 <code>wrangler secret put RELAY_PASSWORD</code> 设置</p>
</div>
</body>
</html>`;
}

/** 登录成功页（meta refresh 进 SPA）。 */
function renderLoginSuccessPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=/">
<title>登录成功</title>
</head>
<body style="background:#0b0e14;color:#8b94a7;font-family:sans-serif;text-align:center;padding-top:40vh">
正在进入控制台…
</body>
</html>`;
}

/**
 * POST /login。
 *
 * 只依赖 RELAY_PASSWORD。RELAY_TOKEN 是 APP 调 /api/* 用的机器令牌，
 * 与面板登录无关——缺它只让 APP 用不了，面板照常能登。
 *
 * 密码不匹配时统一慢响应约 750ms，压制暴力破解吞吐。
 * 未配置 RELAY_PASSWORD 时明确报错，而不是接受任意密码。
 */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const expected = env.RELAY_PASSWORD;
  if (!expected) {
    return html(
      renderLoginPage("服务端未配置 RELAY_PASSWORD，请先执行 wrangler secret put RELAY_PASSWORD"),
      500,
    );
  }

  let provided = "";
  try {
    const form = await request.formData();
    const pw = form.get("password");
    provided = typeof pw === "string" ? pw : "";
  } catch {
    return html(renderLoginPage("请求格式错误"), 400);
  }

  // 无论成败都慢同样时长，避免用响应时间区分"密码错了"与"密码对了"。
  await new Promise((r) => setTimeout(r, 750));

  if (!constantTimeEqual(provided, expected)) {
    return html(renderLoginPage("密码不正确"), 401);
  }

  const ttl = sessionTtlSec(env);
  const cookie = await buildSessionCookie(env, ttl);
  const headers = new Headers({ "set-cookie": buildSetCookie(cookie, ttl) });
  headers.set("location", "/dashboard");
  return new Response(renderLoginSuccessPage(), {
    status: 303,
    headers,
  });
}

/** POST /logout：清除 cookie 回登录页。 */
export function handleLogout(): Response {
  const headers = new Headers();
  headers.set(
    "set-cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );
  headers.set("location", "/");
  return new Response(null, { status: 303, headers });
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
