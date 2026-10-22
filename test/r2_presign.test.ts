import { describe, expect, it } from "vitest";
import { buildPresignedUrl, validatePresignKey } from "../src/services/sigv4";
import { handlePresign } from "../src/routes/r2_presign";

/**
 * SigV4 预签名算法正确性。
 *
 * 这是整条 R2 上传链路最容易出错的一环，且无法在本机用真实 R2 验证。
 * 因此用 AWS 官方文档的「已知答案」做对拍：
 *
 *   AWS S3 SigV4 presigned URL 示例（GET object）
 *   AccessKey: AKIAIOSFODNN7EXAMPLE
 *   SecretKey: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
 *   桶: examplebucket  对象: test.txt
 *   时间: 2013-05-24T00:00:00Z  过期: 86400  region: us-east-1
 *   期望签名: aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404
 *
 * 只要我们的 SigV4 实现能复现这个签名，算法就是对的。
 */

const AWS_VECTOR = {
  accessKey: "AKIAIOSFODNN7EXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  endpoint: "https://examplebucket.s3.amazonaws.com",
  bucket: "examplebucket",
  key: "test.txt",
  region: "us-east-1",
  time: new Date("2013-05-24T00:00:00Z"),
  expires: 86400,
  expectedSignature:
    "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
};

describe("SigV4 预签名 — AWS 官方测试向量对拍", () => {
  it("reproduces the AWS reference signature for GET", async () => {
    const url = await buildPresignedUrl({
      method: "GET",
      accessKey: AWS_VECTOR.accessKey,
      secretKey: AWS_VECTOR.secretKey,
      endpoint: AWS_VECTOR.endpoint,
      bucket: AWS_VECTOR.bucket,
      key: AWS_VECTOR.key,
      region: AWS_VECTOR.region,
      time: AWS_VECTOR.time,
      expiresSec: AWS_VECTOR.expires,
      // 官方示例的 host 风格路径不带 bucket（virtual-hosted style）
      pathStyle: false,
    });

    const sig = new URL(url).searchParams.get("X-Amz-Signature");
    expect(sig).toBe(AWS_VECTOR.expectedSignature);
  });
});

describe("validatePresignKey", () => {
  it("accepts a normal apks key", () => {
    expect(validatePresignKey("apks/1700000000_app.apk")).toBeNull();
  });

  it("rejects keys outside apks/", () => {
    expect(validatePresignKey("private/secret.txt")).toMatch(/apks\//);
    expect(validatePresignKey("")).toMatch(/缺少/);
  });

  it("rejects path traversal", () => {
    // 关键安全边界：不能让 APP 签出一个能覆盖任意对象的 URL
    expect(validatePresignKey("apks/../private/x.apk")).toMatch(/\.\./);
    expect(validatePresignKey("apks//x.apk")).toMatch(/连续斜杠/);
  });

  it("accepts UTF-8 filenames — APK 名字普遍带中文", () => {
    // 真实事故：APP 的 key 是 `<时间戳>_<原始文件名>`，而 APK 文件名
    // 带中文（简盒-正式版.apk），被早期的字符白名单拒掉，上传直接失败。
    expect(validatePresignKey("apks/1700000000000_简盒-正式版.apk")).toBeNull();
    expect(validatePresignKey("apks/简盒 带空格.apk")).toBeNull();
    expect(validatePresignKey("apks/（1）副本.apk")).toBeNull();
    expect(validatePresignKey("apks/日本語テスト.apk")).toBeNull();
  });

  it("accepts characters that are legal in S3 keys", () => {
    expect(validatePresignKey("apks/a b.apk")).toBeNull();
    expect(validatePresignKey("apks/a+b.apk")).toBeNull();
    expect(validatePresignKey("apks/a@b.apk")).toBeNull();
    expect(validatePresignKey("apks/a=b.apk")).toBeNull();
  });

  it("rejects control characters that would break HTTP headers", () => {
    expect(validatePresignKey("apks/a\n.apk")).toMatch(/控制字符/);
    expect(validatePresignKey("apks/a\r.apk")).toMatch(/控制字符/);
    expect(validatePresignKey("apks/a\u0000.apk")).toMatch(/控制字符/);
  });

  it("rejects dot segments beyond the simple .. check", () => {
    expect(validatePresignKey("apks/./x.apk")).toMatch(/路径段/);
    expect(validatePresignKey("apks/a/../b.apk")).toMatch(/路径段/);
  });

  it("rejects a trailing slash", () => {
    expect(validatePresignKey("apks/dir/")).toMatch(/斜杠结尾/);
  });
});

describe("POST /api/r2/presign — handler", () => {
  const baseEnv = {
    GITHUB_TOKEN: "t",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    EDGE_RELAY_KV: {} as KVNamespace,
    RELAY_TOKEN: "rt",
    RELAY_PASSWORD: "pw",
    R2_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
    R2_BUCKET_NAME: "bucket",
    R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_PUBLIC_DOMAIN: "https://cdn.example.com",
  };

  function req(body: unknown): Request {
    return new Request("https://edge-relay.test/api/r2/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns a presigned PUT url for an apks/ key", async () => {
    const resp = await handlePresign(req({ key: "apks/123_app.apk" }), baseEnv as never);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      url: string;
      public_url: string;
      expires_at: number;
    };
    expect(body.ok).toBe(true);
    expect(body.url).toContain("X-Amz-Signature=");
    expect(body.url).toContain("/bucket/apks/123_app.apk");
    expect(body.public_url).toBe("https://cdn.example.com/apks/123_app.apk");
    expect(body.expires_at).toBeGreaterThan(Date.now());
  });

  it("returns 503 with the missing field names when R2 is not configured", async () => {
    const resp = await handlePresign(req({ key: "apks/a.apk" }), {
      ...baseEnv,
      R2_ACCESS_KEY_ID: "",
      R2_BUCKET_NAME: "",
    } as never);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { ok: boolean; missing: string[] };
    expect(body.ok).toBe(false);
    expect(body.missing).toEqual(
      expect.arrayContaining(["r2_access_key_id", "r2_bucket_name"]),
    );
  });

  it("rejects a key outside apks/ — cannot be used to overwrite other objects", async () => {
    const resp = await handlePresign(req({ key: "private/secret.txt" }), baseEnv as never);
    expect(resp.status).toBe(400);
  });

  it("rejects path traversal", async () => {
    const resp = await handlePresign(req({ key: "apks/../../etc/x" }), baseEnv as never);
    expect(resp.status).toBe(400);
  });

  it("never leaks the secret key into the response", async () => {
    const resp = await handlePresign(req({ key: "apks/a.apk" }), baseEnv as never);
    const text = await resp.text();
    expect(text).not.toContain("secret");
    // 但 access key id 会出现在签名 URL 的 credential 里，这是 SigV4 规范
    expect(text).toContain("AKIAEXAMPLE");
  });
});

describe("中文 key 的签名 URL", () => {
  it("percent-encodes UTF-8 exactly like encodeURIComponent", async () => {
    const key = "apks/1700000000000_简盒-正式版.apk";
    const url = await buildPresignedUrl({
      method: "PUT",
      accessKey: "AKIAEXAMPLE",
      secretKey: "secret",
      endpoint: "https://acc.r2.cloudflarestorage.com",
      bucket: "bucket",
      key,
      region: "auto",
      time: new Date("2026-10-20T00:00:00Z"),
      expiresSec: 600,
      pathStyle: true,
    });

    // canonical URI 必须是标准的 UTF-8 百分号编码
    expect(url).toContain("%E7%AE%80%E7%9B%92"); // 简盒
    expect(url).toContain("%E6%AD%A3%E5%BC%8F%E7%89%88"); // 正式版
    // 不能二次编码（% 变成 %25）
    expect(url).not.toContain("%25E7");
    // 签名参数必须存在
    expect(url).toContain("X-Amz-Signature=");
  });
});
