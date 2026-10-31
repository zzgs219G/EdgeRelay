import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/router";
import type { Env } from "../src/shared/types";
import { invalidateConfigCache } from "../src/services/config";
import { invalidateJobsCache } from "../src/services/job_list_cache";

/**
 * 凭证防误删。
 *
 * 背景（docs/报错.md 报的 401 Requires authentication）：
 *   前端曾经的 bug：关闭配置弹窗时把敏感输入框清成 ''，而 baseline 仍是
 *   旧值，于是「空 ≠ 旧值」被判定为改动、保存按钮亮起。此时点保存会把
 *   空串提交给 PATCH，而空串的语义是「清除 KV 覆盖，回退 env」。
 *   若 CF 侧没配 GITHUB_TOKEN secret，KV 里那份令牌就被删光了——
 *   之后每次构建都是 GitHub 401，而用户明明"设置过 token"。
 *
 * 两层防护：
 *   1. 前端（Config.vue onEditorClosed）：从 baseline 还原，不清空
 *   2. 后端（本文件测的）：清除敏感字段必须显式带 clear 数组
 *
 * 第二层是必需的：前端 bug 会再犯，而后端这一层能让误删变成一句
 * 可读的 400，而不是静默删掉凭证。
 */

function fakeKv(store: Map<string, string>): KVNamespace {
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async list(opts: { prefix?: string; limit?: number } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(opts.prefix ?? ""))
        .slice(0, opts.limit ?? 1000)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace;
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    // 故意不设 GITHUB_TOKEN：这正是出 bug 的场景——用户只在面板 KV 里
    // 配了令牌，CF 侧没有 secret。此时"清除 KV 覆盖"等于让令牌彻底消失。
    GITHUB_TOKEN: "",
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

const AUTH = { authorization: "Bearer env-relay-token" };

function req(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Request {
  return new Request(`https://edge-relay.test${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
}

function patch(values: Record<string, unknown>, clear?: string[]): Request {
  const body: Record<string, unknown> = { values };
  if (clear) body.clear = clear;
  return req(
    "/api/config",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    AUTH,
  );
}

/** 先往 KV 里写一个 token，模拟"用户已经设置过 token"。 */
async function seedToken(e: Env, token = "ghp_real_secret_token"): Promise<void> {
  const resp = await worker.fetch(
    patch({ github_token: token }),
    e,
    {} as ExecutionContext,
  );
  expect(resp.status).toBe(200);
}

describe("clearing a secret field requires explicit intent", () => {
  it("refuses a bare empty string on a secret field (the 401 bug)", async () => {
    // 这正是出 bug 的那次请求：前端误提交 {"github_token": ""}
    const e = env({ EDGE_RELAY_KV: fakeKv(new Map()) });
    await seedToken(e);

    const resp = await worker.fetch(patch({ github_token: "" }), e, {} as ExecutionContext);

    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("github_token");
    expect(body.error).toContain("clear");

    // KV 里的令牌必须还在
    const raw = await e.EDGE_RELAY_KV.get("config:v1");
    expect(JSON.parse(raw!).github_token).toBe("ghp_real_secret_token");
  });

  it("still allows clearing when clear[] names the field", async () => {
    // 清除能力必须保留：面板的「恢复默认」和清空回退 CF secret 都靠它
    const e = env({ EDGE_RELAY_KV: fakeKv(new Map()) });
    await seedToken(e);

    const resp = await worker.fetch(
      patch({ github_token: "" }, ["github_token"]),
      e,
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(200);
    const raw = await e.EDGE_RELAY_KV.get("config:v1");
    expect(JSON.parse(raw!).github_token).toBeUndefined();
  });

  it("protects relay_token and relay_password the same way", async () => {
    const e = env({ EDGE_RELAY_KV: fakeKv(new Map()) });
    await seedToken(e, "x");
    await worker.fetch(patch({ relay_token: "app-token" }), e, {} as ExecutionContext);
    await worker.fetch(patch({ relay_password: "panel-pw" }), e, {} as ExecutionContext);

    for (const field of ["relay_token", "relay_password"]) {
      const resp = await worker.fetch(patch({ [field]: "" }), e, {} as ExecutionContext);
      expect(resp.status).toBe(400);
    }

    const raw = await e.EDGE_RELAY_KV.get("config:v1");
    const saved = JSON.parse(raw!);
    expect(saved.relay_token).toBe("app-token");
    expect(saved.relay_password).toBe("panel-pw");
  });

  it("does not block clearing non-secret fields (that is a normal operation)", async () => {
    const e = env({ EDGE_RELAY_KV: fakeKv(new Map()) });
    await worker.fetch(patch({ github_owner: "someone-else" }), e, {} as ExecutionContext);

    // 普通字段清空 = 回退 env，不该被拦住
    const resp = await worker.fetch(patch({ github_owner: "" }), e, {} as ExecutionContext);
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as { config: Record<string, unknown> };
    expect(body.config.github_owner).toBe("zzgs219G");
  });

  it("ignores unknown names in clear[] rather than failing the whole patch", async () => {
    const e = env({ EDGE_RELAY_KV: fakeKv(new Map()) });
    await seedToken(e);

    const resp = await worker.fetch(
      patch({ github_token: "" }, ["not_a_field", "github_token"]),
      e,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
  });

  it("treats a non-array clear as absent (fail closed, not open)", async () => {
    const e = env({ EDGE_RELAY_KV: fakeKv(new Map()) });
    await seedToken(e);

    // clear: "github_token"（字符串而非数组）不该被当成显式意图
    const resp = await worker.fetch(
      req(
        "/api/config",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: { github_token: "" }, clear: "github_token" }),
        },
        AUTH,
      ),
      e,
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });
});

describe("config round-trip still reports the token it was given", () => {
  it("shows the saved token on GET (the '设置过却不显示' half of the bug)", async () => {
    const e = env({ EDGE_RELAY_KV: fakeKv(new Map()) });
    await seedToken(e, "ghp_abcdefghijklmnop");

    invalidateConfigCache();
    const resp = await worker.fetch(req("/api/config", {}, AUTH), e, {} as ExecutionContext);
    const body = (await resp.json()) as {
      config: Record<string, unknown>;
      sources: Record<string, string>;
    };

    // 明文可读：用户要能确认"我设的就是这个值"
    expect(body.config.github_token).toBe("ghp_abcdefghijklmnop");
    expect(body.config.github_token_set).toBe(true);
    expect(body.sources.github_token).toBe("kv");
  });
});

afterEach(() => {
  invalidateConfigCache();
  invalidateJobsCache();
});
