import { describe, expect, it } from "vitest";
import worker from "../src/router";
import type { Env } from "../src/types";
import { invalidateConfigCache, maskSecret } from "../src/config";

/**
 * 运行时配置：GET /api/config 与 PATCH /api/config。
 *
 * 核心诉求（用户提出）：配置不该只能去 Cloudflare 后台改，后端要支持
 * 在面板里自定义输入。
 *
 * 三条安全底线必须钉死：
 *   1. GET 永不回显明文敏感值
 *   2. 改敏感字段必须提供当前密码
 *   3. env（CF secret）里的密码/令牌始终有效——它是改错密码后的逃生舱
 */

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: "env-github-token",
    GITHUB_OWNER: "zzgs219G",
    GITHUB_REPO: "apk-protect-action",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: fakeKv(new Map()),
    RELAY_TOKEN: "env-relay-token",
    RELAY_PASSWORD: "env-password",
    RATE_LIMIT_PER_MIN: "0",
    RUN_ID_WAIT_MS: "500",
    ...overrides,
  };
}

function fakeKv(store: Map<string, string>): KVNamespace {
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async list(opts: { prefix?: string; limit?: number } = {}) {
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(opts.prefix ?? ""))
        .slice(0, opts.limit ?? 1000)
        .map(([name]) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace;
}

function req(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Request {
  return new Request(`https://edge-relay.test${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
}

const AUTH = { authorization: "Bearer env-relay-token" };

function freshEnv(overrides: Partial<Env> = {}): Env {
  invalidateConfigCache();
  return env(overrides);
}

describe("GET /api/config", () => {
  it("requires auth", async () => {
    const resp = await worker.fetch(req("/api/config"), freshEnv(), {} as ExecutionContext);
    expect(resp.status).toBe(401);
  });

  it("never returns plaintext secrets", async () => {
    const resp = await worker.fetch(
      req("/api/config", {}, AUTH),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      config: Record<string, unknown>;
      sources: Record<string, string>;
    };

    // 明文绝不能出现
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("env-github-token");
    expect(raw).not.toContain("env-relay-token");
    expect(raw).not.toContain("env-password");

    // 敏感字段只给 set 标记与遮蔽值
    expect(body.config.github_token_set).toBe(true);
    expect(typeof body.config.github_token_masked).toBe("string");
    expect(body.config.github_token_masked).toContain("*");
    expect(body.config).not.toHaveProperty("github_token");
  });

  it("reports non-secret values and where they come from", async () => {
    const resp = await worker.fetch(
      req("/api/config", {}, AUTH),
      freshEnv(),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as {
      config: Record<string, unknown>;
      sources: Record<string, string>;
    };
    expect(body.config.github_owner).toBe("zzgs219G");
    expect(body.config.github_repo).toBe("apk-protect-action");
    expect(body.sources.github_owner).toBe("env");
  });
});

describe("PATCH /api/config", () => {
  it("requires auth", async () => {
    const resp = await worker.fetch(
      req("/api/config", { method: "PATCH", body: JSON.stringify({ values: { github_owner: "x" } }) }),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
  });

  it("updates a non-secret field and reports source as kv", async () => {
    const e = freshEnv();
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { github_owner: "newowner" } }),
        },
        AUTH,
      ),
      e,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      config: Record<string, unknown>;
      sources: Record<string, string>;
    };
    expect(body.config.github_owner).toBe("newowner");
    expect(body.sources.github_owner).toBe("kv");
  });

  it("rejects unknown keys instead of silently ignoring them", async () => {
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { githb_owner: "typo" } }),
        },
        AUTH,
      ),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("未知配置项");
  });

  it("refuses to change a secret without current_password", async () => {
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { github_token: "new-token" } }),
        },
        AUTH,
      ),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(403);
    expect((await resp.json() as { error: string }).error).toContain("current_password");
  });

  it("refuses a wrong current_password", async () => {
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            values: { github_token: "new-token" },
            current_password: "wrong",
          }),
        },
        AUTH,
      ),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(403);
  });

  it("accepts a secret change with the right current_password", async () => {
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            values: { github_token: "new-github-token-value" },
            current_password: "env-password",
          }),
        },
        AUTH,
      ),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { config: Record<string, unknown>; sources: Record<string, string> };
    expect(body.sources.github_token).toBe("kv");
    expect(body.config.github_token_set).toBe(true);
    // 回显的遮蔽值必须来自新值，且不含完整明文
    expect(JSON.stringify(body)).not.toContain("new-github-token-value");
  });

  it("clears an override with an empty string, falling back to env", async () => {
    const e = freshEnv();
    // 先改
    await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { github_owner: "tmp" } }),
        },
        AUTH,
      ),
      e,
      {} as ExecutionContext,
    );
    // 再清空
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { github_owner: "" } }),
        },
        AUTH,
      ),
      e,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { config: Record<string, unknown>; sources: Record<string, string> };
    expect(body.config.github_owner).toBe("zzgs219G");
    expect(body.sources.github_owner).toBe("env");
  });

  it("validates numeric ranges", async () => {
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { job_retention_days: "9999" } }),
        },
        AUTH,
      ),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
    expect((await resp.json() as { error: string }).error).toContain("job_retention_days");
  });

  it("rejects an empty values object", async () => {
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: {} }),
        },
        AUTH,
      ),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });
});

describe("escape hatch: env password stays valid after KV override", () => {
  it("still accepts the env password after the panel password changed", async () => {
    const e = freshEnv();

    // 通过面板改成新密码
    const patch = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            values: { relay_password: "panel-new-password" },
            current_password: "env-password",
          }),
        },
        AUTH,
      ),
      e,
      {} as ExecutionContext,
    );
    expect(patch.status).toBe(200);

    // 新密码可登录
    const withNew = await worker.fetch(
      req("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "panel-new-password" }),
      }),
      e,
      {} as ExecutionContext,
    );
    expect(withNew.status).toBe(200);

    // 旧密码（CF secret）仍然可登录——这是改错密码后的逃生舱
    const withEnv = await worker.fetch(
      req("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "env-password" }),
      }),
      e,
      {} as ExecutionContext,
    );
    expect(withEnv.status).toBe(200);
  });

  it("accepts both old and new relay_token during migration", async () => {
    const e = freshEnv();

    await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            values: { relay_token: "panel-new-token" },
            current_password: "env-password",
          }),
        },
        AUTH,
      ),
      e,
      {} as ExecutionContext,
    );

    invalidateConfigCache();

    // 新 token 可用
    const withNew = await worker.fetch(
      req("/api/jobs", {}, { authorization: "Bearer panel-new-token" }),
      e,
      {} as ExecutionContext,
    );
    expect(withNew.status).toBe(200);

    // 旧 token（env）仍可用，避免正在跑的 APP 立刻断掉
    const withOld = await worker.fetch(
      req("/api/jobs", {}, AUTH),
      e,
      {} as ExecutionContext,
    );
    expect(withOld.status).toBe(200);
  });
});

describe("POST /api/config/reveal — 按需查看明文", () => {
  const REVEAL_AUTH = { authorization: "Bearer env-relay-token" };

  function revealReq(body: unknown, headers: Record<string, string> = REVEAL_AUTH): Request {
    return new Request("https://edge-relay.test/api/config/reveal", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("requires auth", async () => {
    const resp = await worker.fetch(
      revealReq({ field: "github_token", current_password: "env-password" }, {}),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
  });

  it("returns 403 without the current password", async () => {
    // 关键安全边界：光有 session/令牌不足以读明文
    const resp = await worker.fetch(
      revealReq({ field: "github_token" }),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(403);
  });

  it("returns 403 with a wrong password", async () => {
    const resp = await worker.fetch(
      revealReq({ field: "github_token", current_password: "nope" }),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(403);
  });

  it("returns the plaintext for one field with the right password", async () => {
    const resp = await worker.fetch(
      revealReq({ field: "github_token", current_password: "env-password" }),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; field: string; value: string };
    expect(body.ok).toBe(true);
    expect(body.field).toBe("github_token");
    expect(body.value).toBe("env-github-token");
  });

  it("refuses non-secret fields — no batch dump via this endpoint", async () => {
    const resp = await worker.fetch(
      revealReq({ field: "github_owner", current_password: "env-password" }),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("404s a secret field that is not set", async () => {
    const resp = await worker.fetch(
      revealReq({ field: "r2_secret_access_key", current_password: "env-password" }),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
  });

  it("accepts the panel-set password too (dual channel)", async () => {
    const e = freshEnv();
    await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            values: { relay_password: "panel-new-password" },
            current_password: "env-password",
          }),
        },
        AUTH,
      ),
      e,
      {} as ExecutionContext,
    );
    invalidateConfigCache();

    const resp = await worker.fetch(
      revealReq({ field: "relay_password", current_password: "panel-new-password" }),
      e,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect((await resp.json() as { value: string }).value).toBe("panel-new-password");
  });
});

describe("maskSecret — 固定 6 星，不泄漏长度", () => {
  it("uses a fixed-width mask regardless of secret length", () => {
    const short = maskSecret("abcdefghijkl");      // 12
    const long = maskSecret("x".repeat(64));        // 64
    expect(short).toBe("abcd******ijkl");
    expect(long).toBe("xxxx******xxxx");
    // 两者中间都是 6 个星，无法从掩码推断真实长度
    expect(short!.length).toBe(long!.length);
  });

  it("handles very short secrets without revealing them", () => {
    expect(maskSecret("abc")).toBe("******");
    expect(maskSecret("")).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
  });
});
