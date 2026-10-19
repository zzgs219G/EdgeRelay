/**
 * R2 预签名上传：POST /api/r2/presign
 *
 * 为什么要这个接口：
 *   APP 需要直传 APK 到 R2（大文件不适合过 Worker），但 S3 上传必须用
 *   Access Key / Secret Key 做 SigV4 签名。这两个密钥原本躺在公开可下载
 *   的配置 JSON 里（AES 密码硬编码在 APP 内），等于公开泄漏。
 *
 *   改为：密钥只存网关，APP 向网关要一个「只能往某个 key PUT、几分钟
 *   过期」的签名 URL，拿它直传。即使这个 URL 泄漏，攻击者也只能在
 *   有效期内覆盖那一个 object，读不到任何已有文件。
 *
 * 实现：S3 SigV4 query-string 签名（AWS 兼容），用 crypto.subtle 做
 * HMAC，不引任何 S3 SDK。
 *
 * 正确性由 test/r2_presign.test.ts 用 AWS 官方示例签名值对拍保证。
 */

import type { ResolvedEnv } from "./config";
import { json } from "./http";

/** 预签名有效期。10 分钟足够传完一个 APK，同时把泄漏窗口压到最小。 */
const PRESIGN_TTL_SEC = 600;

// ── SigV4 原语 ───────────────────────────────────────────────────────

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return toHex(buf);
}

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

/** SigV4 派生密钥：kDate → kRegion → kService → kSigning。 */
async function signingKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  let k: BufferSource = new TextEncoder().encode(`AWS4${secret}`);
  k = await hmac(k, dateStamp);
  k = await hmac(k, region);
  k = await hmac(k, service);
  return hmac(k, "aws4_request");
}

/** RFC 3986 编码。S3 的 canonical URI 要求空格编码成 %20 而非 +。 */
function uriEncode(str: string, encodeSlash = true): string {
  let out = "";
  for (const ch of str) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += ch;
    } else {
      for (const b of new TextEncoder().encode(ch)) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

// ── 预签名核心（可独立测试）─────────────────────────────────────────

export interface PresignParams {
  method: "PUT" | "GET";
  accessKey: string;
  secretKey: string;
  /** 形如 https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  /** 对象 key，可含 / */
  key: string;
  region: string;
  time: Date;
  expiresSec: number;
  /**
   * path 风格（endpoint/bucket/key）还是 virtual-hosted 风格
   * （bucket.endpoint/key）。R2 用 path 风格；AWS 官方示例用
   * virtual-hosted，因此测试里传 false。
   */
  pathStyle: boolean;
}

/**
 * 构造 SigV4 预签名 URL。
 *
 * 抽成纯函数（不依赖 env / Request）是为了能用 AWS 官方测试向量对拍——
 * 这是唯一能在没有真实 R2 的情况下验证算法正确性的办法。
 */
export async function buildPresignedUrl(p: PresignParams): Promise<string> {
  const service = "s3";
  const host = new URL(p.endpoint).host;
  const { amzDate, dateStamp } = amzDates(p.time);
  const credentialScope = `${dateStamp}/${p.region}/${service}/aws4_request`;

  // canonical URI：path 风格含 bucket 段，virtual-hosted 不含
  const encodedKey = p.key.split("/").map((s) => uriEncode(s)).join("/");
  const canonicalUri = p.pathStyle ? `/${p.bucket}/${encodedKey}` : `/${encodedKey}`;

  const signedHeaders = "host";
  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${p.accessKey}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(p.expiresSec),
    "X-Amz-SignedHeaders": signedHeaders,
  };

  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(queryParams[k])}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    p.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kSigning = await signingKey(p.secretKey, dateStamp, p.region, service);
  const signature = toHex(await hmac(kSigning, stringToSign));

  const base = p.pathStyle
    ? `${p.endpoint.replace(/\/$/, "")}${canonicalUri}`
    : `${new URL(p.endpoint).protocol}//${host}${canonicalUri}`;

  return `${base}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ── key 校验 ─────────────────────────────────────────────────────────

/**
 * 只允许 apks/ 前缀 + 安全字符。
 *
 * 这是安全边界：不能让 APP 签出一个能覆盖任意对象的 URL（比如
 * `../private/xxx`）。签名 URL 一旦能指向任意 key，等于把整个桶的
 * 写权限发出去。
 */
export function validatePresignKey(key: string): string | null {
  if (!key) return "缺少 key";
  if (key.length > 512) return "key 过长";
  if (!key.startsWith("apks/")) return "key 必须以 apks/ 开头";
  if (key.includes("..")) return "key 不能包含 ..";
  if (key.includes("//")) return "key 不能包含连续斜杠";
  if (!/^[A-Za-z0-9/_.\-]+$/.test(key)) return "key 只能包含字母数字与 / _ . -";
  return null;
}

// ── HTTP handler ─────────────────────────────────────────────────────

export interface PresignRequest {
  key?: string;
  /** 预留：不参与签名，仅回显给 APP 设置 Content-Type。 */
  content_type?: string;
}

export interface PresignResponse {
  ok: true;
  url: string;
  headers: Record<string, string>;
  public_url: string;
  expires_at: number;
}

export async function handlePresign(
  request: Request,
  env: ResolvedEnv,
): Promise<Response> {
  const accessKey = env.R2_ACCESS_KEY_ID ?? "";
  const secretKey = env.R2_SECRET_ACCESS_KEY ?? "";
  const endpoint = (env.R2_ENDPOINT ?? "").trim();
  const bucket = env.R2_BUCKET_NAME ?? "";

  const missing: string[] = [];
  if (!accessKey) missing.push("r2_access_key_id");
  if (!secretKey) missing.push("r2_secret_access_key");
  if (!endpoint) missing.push("r2_endpoint");
  if (!bucket) missing.push("r2_bucket_name");
  if (missing.length > 0) {
    return json(
      {
        ok: false,
        error: `R2 未配置，缺少：${missing.join(", ")}。在面板配置页填写即可。`,
        missing,
      },
      503,
    );
  }

  let body: PresignRequest;
  try {
    body = (await request.json()) as PresignRequest;
  } catch {
    return json({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  const keyErr = validatePresignKey(key);
  if (keyErr) {
    return json({ ok: false, error: keyErr }, 400);
  }

  const now = new Date();
  const url = await buildPresignedUrl({
    method: "PUT",
    accessKey,
    secretKey,
    endpoint,
    bucket,
    key,
    region: "auto", // R2 的 S3 API 固定用 auto
    time: now,
    expiresSec: PRESIGN_TTL_SEC,
    // R2 用 path 风格：https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
    pathStyle: true,
  });

  const publicDomain = (env.R2_PUBLIC_DOMAIN ?? "").trim().replace(/\/$/, "");
  const resp: PresignResponse = {
    ok: true,
    url,
    // 只签了 host，除 content-type（不参与签名）外无需额外 header。
    headers: {},
    public_url: publicDomain ? `${publicDomain}/${key}` : "",
    expires_at: now.getTime() + PRESIGN_TTL_SEC * 1000,
  };
  return json(resp);
}
