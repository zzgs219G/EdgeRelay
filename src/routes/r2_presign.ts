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
 * 签名算法在 services/sigv4.ts（纯函数，可用 AWS 官方向量对拍）。
 */

import type { ResolvedEnv } from "../services/config";
import { buildPresignedUrl, PRESIGN_TTL_SEC, validatePresignKey } from "../services/sigv4";
import { json } from "../shared/http";

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
