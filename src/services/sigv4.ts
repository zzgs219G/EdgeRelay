/**
 * S3 SigV4 预签名算法（AWS 兼容），纯函数，不依赖 env / Request。
 *
 * 为什么抽成纯函数：这是整条 R2 上传链路最容易出错的一环，且无法在本机
 * 用真实 R2 验证。只有把它与 HTTP handler 解耦，才能用 AWS 官方文档的
 * 「已知答案」做对拍测试（见 test/r2_presign.test.ts）。
 *
 * 用 crypto.subtle 做 HMAC，不引任何 S3 SDK。
 */

/** 预签名有效期。10 分钟足够传完一个 APK，同时把泄漏窗口压到最小。 */
export const PRESIGN_TTL_SEC = 600;

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

// ── 预签名核心 ───────────────────────────────────────────────────────

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

/** 构造 SigV4 预签名 URL。 */
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
 * 校验 key 的**路径安全性**，不限制字符集。
 *
 * 安全边界只有三条（都是为了让签名 URL 不能指向 apks/ 之外的对象）：
 *   1. 必须以 apks/ 开头
 *   2. 不能含 ..（防路径穿越）
 *   3. 不能含 // 或控制字符（防歧义路径）
 *
 * 早期版本还加了 `[A-Za-z0-9/_.-]` 字符白名单，本意是"安全"，实际是
 * 拒绝正常输入——APP 的 key 是 `<时间戳>_<原始文件名>`，而 APK 文件名
 * 普遍带中文（如「简盒-正式版.apk」），于是上传直接被拒。
 *
 * S3 的 object key 本身支持任意 UTF-8；canonical URI 会由 uriEncode
 * 按 UTF-8 逐字节百分号编码（与 encodeURIComponent 结果一致，已对拍）。
 * 所以放开字符集不影响签名正确性。
 */
export function validatePresignKey(key: string): string | null {
  if (!key) return "缺少 key";
  if (key.length > 512) return "key 过长";
  if (!key.startsWith("apks/")) return "key 必须以 apks/ 开头";

  // 路径穿越：任何 .. 段都不允许
  if (key.split("/").some((seg) => seg === ".." || seg === ".")) {
    return "key 不能包含 . 或 .. 路径段";
  }
  if (key.includes("//")) return "key 不能包含连续斜杠";
  if (key.endsWith("/")) return "key 不能以斜杠结尾";

  // 控制字符（含换行）会破坏 HTTP 头与签名，一律拒绝
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return "key 不能包含控制字符";

  return null;
}
