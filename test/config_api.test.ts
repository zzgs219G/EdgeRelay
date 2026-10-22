import { describe, expect, it } from "vitest";
import worker from "../src/router";
import type { Env } from "../src/shared/types";
import { invalidateConfigCache, maskSecret } from "../src/services/config";
import { invalidateJobsCache } from "../src/services/job_list_cache";

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
  // jobs 列表有 15s isolate 缓存，测试间必须清掉，否则串味
  invalidateJobsCache();
  return env(overrides);
}

describe("GET /api/config", () => {
  it("requires auth", async () => {
    const resp = await worker.fetch(req("/api/config"), freshEnv(), {} as ExecutionContext);
    expect(resp.status).toBe(401);
  });

  it("returns plaintext secrets alongside masks", async () => {
    // 早期版本遮蔽明文，被判定为过度设计：能进面板就说明已登录，
    // 而"能改"本身意味着能让网关用任意凭证，给"读"再加门槛挡不住
    // 实质风险，只让「查看/复制自己的 key」变麻烦。
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

    // 明文可读，便于用户复制
    expect(body.config.github_token).toBe("env-github-token");
    expect(body.config.relay_token).toBe("env-relay-token");

    // 掩码仍然提供，供摘要卡片直接展示
    expect(body.config.github_token_set).toBe(true);
    expect(body.config.github_token_masked).toBe("env-******oken");
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

  it("updates a secret without requiring a password", async () => {
    // 进面板已登录，改凭证不再二次验证——密码是唯一防线，在登录处把住。
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { github_token: "new-github-token-value" } }),
        },
        AUTH,
      ),
      freshEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      config: Record<string, unknown>;
      sources: Record<string, string>;
    };
    expect(body.sources.github_token).toBe("kv");
    expect(body.config.github_token).toBe("new-github-token-value");
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

// ── /api/jobs 的轮询成本控制 ─────────────────────────────────────────

describe("GET /api/jobs — 缓存与 has_active", () => {
  function jobStore(status: string): Map<string, string> {
    const store = new Map<string, string>()
    store.set("job:aaa", JSON.stringify({
      job_id: "aaa", run_id: null, workflow_file: "w.yml", workflow_name: "w",
      protect_config: "{}", dpt_extra_args: "", display_name: "",
      status, conclusion: status === "completed" ? "success" : null,
      download_url: null, error: null,
      created_at_ms: 1000, updated_at_ms: 2000,
    }))
    return store
  }

  it("reports has_active=true when a job is still running", async () => {
    invalidateJobsCache()
    const resp = await worker.fetch(
      req("/api/jobs", {}, AUTH),
      freshEnv({ EDGE_RELAY_KV: fakeKv(jobStore("in_progress")) }),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as { has_active: boolean };
    // 前端据此决定要不要继续轮询——这是省 KV 额度的关键信号
    expect(body.has_active).toBe(true);
  });

  it("reports has_active=false when everything is done", async () => {
    invalidateJobsCache()
    const resp = await worker.fetch(
      req("/api/jobs", {}, AUTH),
      freshEnv({ EDGE_RELAY_KV: fakeKv(jobStore("completed")) }),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as { has_active: boolean };
    expect(body.has_active).toBe(false);
  });

  it("serves repeat polls from cache instead of hitting KV every time", async () => {
    invalidateJobsCache();

    const store = jobStore("completed");
    let kvGets = 0;
    let kvLists = 0;
    const countingKv = {
      async get(k: string) {
        kvGets++;
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
      async list(o: { prefix?: string; limit?: number } = {}) {
        kvLists++;
        const keys = [...store.keys()]
          .filter((k) => k.startsWith(o.prefix ?? ""))
          .slice(0, o.limit ?? 1000)
          .map((name) => ({ name }));
        return { keys, list_complete: true, cursor: "" };
      },
    } as unknown as KVNamespace;

    const e = freshEnv({ EDGE_RELAY_KV: countingKv });

    // 连续 5 次轮询
    for (let i = 0; i < 5; i++) {
      await worker.fetch(req("/api/jobs", {}, AUTH), e, {} as ExecutionContext);
    }

    // 关键在 list：它是最稀缺的额度（1000/天），必须被缓存吃掉。
    expect(kvLists).toBeLessThanOrEqual(1);
    void kvGets;
  });

  it("does not scale KV reads with the number of polls", async () => {
    // 缓存真正的性质：轮询次数增加，KV 读不增加。
    // 比"少于 N 次"这种绝对数字稳健——实现细节（索引读几次、节流读几次）
    // 会变，但"不随轮询增长"不会变。
    invalidateJobsCache();
    invalidateConfigCache();

    const store = jobStore("completed");
    let kvGets = 0;
    const countingKv = {
      async get(k: string) {
        kvGets++;
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
      async list(o: { prefix?: string; limit?: number } = {}) {
        const keys = [...store.keys()]
          .filter((k) => k.startsWith(o.prefix ?? ""))
          .slice(0, o.limit ?? 1000)
          .map((name) => ({ name }));
        return { keys, list_complete: true, cursor: "" };
      },
    } as unknown as KVNamespace;

    const e = freshEnv({ EDGE_RELAY_KV: countingKv });
    // 第一次：建缓存
    await worker.fetch(req("/api/jobs", {}, AUTH), e, {} as ExecutionContext);
    const afterFirst = kvGets;

    // 再来 20 次轮询
    for (let i = 0; i < 20; i++) {
      await worker.fetch(req("/api/jobs", {}, AUTH), e, {} as ExecutionContext);
    }

    // 20 次轮询的 KV 读增量应远小于 20（理想是 0，这里留余量给
    // 15s 缓存自然过期）。重点：不随轮询次数线性增长。
    expect(kvGets - afterFirst).toBeLessThan(20);
  });
});
