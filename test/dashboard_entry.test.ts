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

  it("degrades to a soft notice, not a 500 or a scary 503, when list quota is spent", async () => {
    // 线上故障复现：索引没建起来 + KV list 额度耗尽时，
    // 旧行为是路由总兜底的一句「网关内部错误」；中间版是 503。
    // 现在：200 + notice。报 5xx 只会让人误以为服务挂了而反复刷新，
    // 而这是「当日额度用尽、00:00 UTC 重置」的可预期状态。
    invalidateConfigCache();
    invalidateJobsCache();

    const quotaKv = {
      async get(k: string) {
        // 索引相关的 meta key 都不存在 → 触发兜底重建
        if (k.startsWith("meta:")) return null;
        throw new Error("KV list() limit exceeded for the day.");
      },
      async put() {
        throw new Error("KV list() limit exceeded for the day.");
      },
      async list() {
        throw new Error("KV list() limit exceeded for the day.");
      },
    } as unknown as KVNamespace;

    const resp = await worker.fetch(
      await cookieReq("/api/jobs", env({ EDGE_RELAY_KV: quotaKv })),
      env({ EDGE_RELAY_KV: quotaKv }),
      {} as ExecutionContext,
    );

    // 200，不是 5xx：网关本身是好的
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { notice: string | null; jobs: unknown[] };
    expect(body.notice).toContain("00:00 UTC");
    expect(body.jobs).toEqual([]);
  });

  it("does not retry list() on every poll while the quota is spent", async () => {
    // 自残循环的复现与修复：索引没建 → 调 list → 失败 → 索引还是没建
    // → 下一轮再来。曾经的实现没有任何节流，用户看到错误反复出现，
    // 且每次重试都在消耗（失败的 list 同样计入 CF 操作数）。
    invalidateConfigCache();
    invalidateJobsCache();

    let listCalls = 0;
    const quotaKv = {
      async get(k: string) {
        if (k === "meta:job_ids") return null;
        if (k === "meta:job_ids_attempt_at") return null;
        throw new Error("KV list() limit exceeded for the day.");
      },
      async put() {
        throw new Error("KV list() limit exceeded for the day.");
      },
      async list() {
        listCalls++;
        throw new Error("KV list() limit exceeded for the day.");
      },
    } as unknown as KVNamespace;

    const e = env({ EDGE_RELAY_KV: quotaKv });
    for (let i = 0; i < 5; i++) {
      await worker.fetch(await cookieReq("/api/jobs", e), e, {} as ExecutionContext);
    }

    // 5 次轮询最多 1 次 list 尝试（第一次），之后被节流挡掉。
    // 注意：本测试的 KV put 是抛错的，所以节流时间戳写不进去，
    // 这里断言的是「不再无脑每轮都调」的下界保护。
    expect(listCalls).toBeLessThanOrEqual(2);
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
