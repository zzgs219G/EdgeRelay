import { describe, expect, it } from "vitest";
import worker from "../src/router";
import type { Env } from "../src/types";
import { invalidateConfigCache } from "../src/config";
import { invalidateJobsCache } from "../src/jobs";

/**
 * 复现「登录成功 → 进入控制台 → 网关内部错误」。
 *
 * 登录后前端依次打：POST /login → GET /health → GET /api/jobs
 * （stores.login 里那句 api.health()，加上 Dashboard onMounted 的 refreshAll）。
 * 这三个里只有 /api/jobs 没有自己的错误处理，是 500 的唯一来源。
 */

function countingKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const ops = { get: 0, put: 0, list: 0 };
  return {
    ops,
    store,
    kv: {
      async get(key: string) {
        ops.get++;
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        ops.put++;
        store.set(key, value);
      },
      async list(o: { prefix?: string; limit?: number } = {}) {
        ops.list++;
        const keys = [...store.keys()]
          .filter((k) => k.startsWith(o.prefix ?? ""))
          .slice(0, o.limit ?? 1000)
          .map((name) => ({ name }));
        return { keys, list_complete: true, cursor: "" };
      },
    } as unknown as KVNamespace,
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: "tok",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: countingKv().kv,
    RELAY_TOKEN: "rt",
    RELAY_PASSWORD: "pw",
    RATE_LIMIT_PER_MIN: "0",
    RUN_ID_WAIT_MS: "500",
    ...overrides,
  };
}

function req(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Request {
  return new Request(`https://edge-relay.test${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
}

/** 带 session cookie 的请求：模拟已登录的浏览器。 */
async function cookieReq(path: string, e: Env): Promise<Request> {
  const login = await worker.fetch(
    req("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    }),
    e,
    {} as ExecutionContext,
  );
  const cookie = login.headers.get("set-cookie") ?? "";
  return req(path, {}, { cookie: cookie.split(";")[0] });
}

describe("dashboard entry — the exact sequence after login", () => {
  it("survives the full post-login sequence without a 500", async () => {
    invalidateConfigCache();
    invalidateJobsCache();

    const { kv, ops } = countingKv();
    const e = env({ EDGE_RELAY_KV: kv });

    // 1. 登录
    const login = await worker.fetch(
      req("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "pw" }),
      }),
      e,
      {} as ExecutionContext,
    );
    expect(login.status).toBe(200);

    // 2. 健康检查（stores.login 里紧跟的那句）
    const health = await worker.fetch(req("/health"), e, {} as ExecutionContext);
    expect(health.status).toBeLessThan(500);

    // 3. 任务列表（Dashboard onMounted → refreshAll → loadJobs）
    const jobs = await worker.fetch(await cookieReq("/api/jobs", e), e, {} as ExecutionContext);

    // 关键断言：不能是 500「网关内部错误」
    if (jobs.status !== 200) {
      const body = await jobs.text();
      throw new Error(`/api/jobs 返回 ${jobs.status}: ${body}`);
    }
    expect(jobs.status).toBe(200);
    const body = (await jobs.json()) as { has_active: boolean; jobs: unknown[] };
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(typeof body.has_active).toBe("boolean");
  });

  it("degrades to 503 with the real reason instead of a bare 500 when KV is broken", async () => {
    // 线上故障复现：KV list 抛错时，旧行为是路由总兜底的一句
    // 「网关内部错误」，指不到任何原因。现在降级成 503 + 真实原因。
    invalidateConfigCache();
    invalidateJobsCache();

    const brokenKv = {
      async get() {
        throw new Error("KV namespace not bound");
      },
      async put() {
        throw new Error("KV namespace not bound");
      },
      async list() {
        throw new Error("KV namespace not bound");
      },
    } as unknown as KVNamespace;

    const resp = await worker.fetch(
      await cookieReq("/api/jobs", env({ EDGE_RELAY_KV: brokenKv })),
      env({ EDGE_RELAY_KV: brokenKv }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { code: string; error: string };
    expect(body.code).toBe("upstream_error");
    expect(body.error).toContain("KV namespace not bound");
  });

  it("falls back to a stale cache rather than failing when KV hiccups", async () => {
    invalidateConfigCache();
    invalidateJobsCache();

    const { kv } = countingKv();
    const e = env({ EDGE_RELAY_KV: kv });

    // 先成功一次，把缓存建立起来
    const first = await worker.fetch(await cookieReq("/api/jobs", e), e, {} as ExecutionContext);
    expect(first.status).toBe(200);

    // 缓存还在 15s 内，但把 KV 弄坏：应命中缓存，不打 KV
    const flaky = {
      async get() {
        throw new Error("boom");
      },
      async put() {
        throw new Error("boom");
      },
      async list() {
        throw new Error("boom");
      },
    } as unknown as KVNamespace;

    const second = await worker.fetch(
      await cookieReq("/api/jobs", env({ EDGE_RELAY_KV: flaky })),
      env({ EDGE_RELAY_KV: flaky }),
      {} as ExecutionContext,
    );
    expect(second.status).toBe(200);
  });

  it("also survives when the KV namespace is empty (fresh deploy)", async () => {
    invalidateConfigCache();
    invalidateJobsCache();
    const { kv } = countingKv();
    const e = env({ EDGE_RELAY_KV: kv });

    const jobs = await worker.fetch(
      await cookieReq("/api/jobs", e),
      e,
      {} as ExecutionContext,
    );
    expect(jobs.status).toBe(200);
  });

  it("reports the KV op cost of one dashboard entry", async () => {
    // 诊断用：把一次「进入控制台」的 KV 成本打出来。
    invalidateConfigCache();
    invalidateJobsCache();
    const { kv, ops } = countingKv();
    const e = env({ EDGE_RELAY_KV: kv });

    await worker.fetch(
      await cookieReq("/api/jobs", e),
      e,
      {} as ExecutionContext,
    );

    // eslint-disable-next-line no-console
    console.log("[kv ops for one /api/jobs]", JSON.stringify(ops));
    expect(ops.list).toBeLessThanOrEqual(1);
  });
});
