import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import type { Env } from "../src/shared/types";
import { invalidateConfigCache } from "../src/services/config";
import {
  __resetUsageForTests,
  flushUsage,
  getUsage,
  KV_LIMITS,
  wrapKvWithCounter,
} from "../src/services/usage";

/**
 * 额度仪表盘（GET /api/usage）。
 *
 * 两条底线必须钉死：
 *
 * 1. **不编造数字**。Cloudflare 的 GraphQL Analytics 没有 KV 数据集，
 *    官方查不到 KV 用量；Workers 请求数则需要额外 token。缺配置时
 *    必须返回 null + 提示，而不是 0——0 会被读成"今天没有请求"。
 *
 * 2. **记账不能自我放大**。统计本身也要写 KV（落盘用量），如果那次写入
 *    被计数器记进去，就会形成"越统计越耗额度"的正反馈。
 */

function fakeKv(store = new Map<string, string>()) {
  const ops = { get: 0, put: 0, list: 0, delete: 0 };
  const kv = {
    async get(k: string) {
      ops.get++;
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      ops.put++;
      store.set(k, v);
    },
    async delete(k: string) {
      ops.delete++;
      store.delete(k);
    },
    async list(opts: { prefix?: string; limit?: number } = {}) {
      ops.list++;
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(opts.prefix ?? ""))
        .slice(0, opts.limit ?? 1000)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace;
  return { kv, store, ops };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: "tok",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    EDGE_RELAY_KV: fakeKv().kv,
    RELAY_TOKEN: "t",
    RATE_LIMIT_PER_MIN: "0",
    ...overrides,
  };
}

function authedReq(path: string): Request {
  return new Request(`https://x.test${path}`, {
    headers: { authorization: "Bearer t" },
  });
}

beforeEach(() => {
  __resetUsageForTests();
  invalidateConfigCache();
  vi.unstubAllGlobals();
});

describe("KV 用量记账 — 计数准确性", () => {
  it("Proxy 记录 get / put / list / delete 次数", async () => {
    const { kv } = fakeKv();
    const counted = wrapKvWithCounter(kv);

    await counted.get("a");
    await counted.get("b");
    await counted.put("c", "1");
    await counted.list({ prefix: "x" });
    await counted.delete("d");

    const snap = await getUsage(kv);
    expect(snap.reads).toBe(2);
    expect(snap.writes).toBe(1);
    expect(snap.lists).toBe(1);
    expect(snap.deletes).toBe(1);
  });

  it("落盘时不把这次写入计入用量（否则自我放大）", async () => {
    const { kv, ops } = fakeKv();
    const counted = wrapKvWithCounter(kv);

    await counted.get("a"); // 1 read
    const beforeWrites = ops.put;

    // 用**原始** kv 落盘，不经代理
    const wrote = await flushUsage(kv, true);
    expect(wrote).toBe(true);

    // 落盘确实写了 1 次 KV（这是统计本身的成本）
    expect(ops.put).toBe(beforeWrites + 1);

    // 但用量里的 writes 不应包含这次落盘
    const snap = await getUsage(kv);
    expect(snap.writes).toBe(0);
    expect(snap.reads).toBe(1); // 落盘时的读也不该算进去
  });

  it("落盘后计数清零，且已落盘值可累加", async () => {
    const { kv, store } = fakeKv();
    const counted = wrapKvWithCounter(kv);

    await counted.put("a", "1");
    await counted.put("b", "2");
    expect(await flushUsage(kv, true)).toBe(true);

    // 再产生一些增量
    await counted.put("c", "3");

    const snap = await getUsage(kv);
    // 2 次已落盘 + 1 次未落盘增量
    expect(snap.writes).toBe(3);
    expect(store.size).toBeGreaterThan(0);
  });

  it("30 分钟内重复 flush 不写盘（节流生效）", async () => {
    const { kv, ops } = fakeKv();
    const counted = wrapKvWithCounter(kv);

    await counted.get("a");
    await flushUsage(kv, true);
    const putsAfterFirst = ops.put;

    await counted.get("b");
    const secondResult = await flushUsage(kv, false);

    expect(secondResult).toBe(false);
    expect(ops.put).toBe(putsAfterFirst);
  });

  it("没有增量时不写盘", async () => {
    const { kv, ops } = fakeKv();
    const before = ops.put;
    expect(await flushUsage(kv, true)).toBe(false);
    expect(ops.put).toBe(before);
  });
});

describe("GET /api/usage — 不编造数字", () => {
  it("未配置 CF token 时，workers.requests 为 null 且有提示", async () => {
    const { kv } = fakeKv();
    const resp = await worker.fetch(
      authedReq("/api/usage"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      workers: { requests: null; source: string; hint: string };
      kv: { reads: { used: number; limit: number; pct: number } };
      unavailable: { d1: string; pages: string };
    };

    // 关键：null 而不是 0
    expect(body.workers.requests).toBeNull();
    expect(body.workers.source).toBe("unconfigured");
    expect(body.workers.hint).toContain("CF_API_TOKEN");

    // KV 额度上限来自文档常量
    expect(body.kv.reads.limit).toBe(KV_LIMITS.reads);

    // 未启用的资源如实标注
    expect(body.unavailable.d1).toContain("未绑定 D1");
    expect(body.unavailable.pages).toContain("Workers");
  });

  it("配了 token 但 GraphQL 失败时，仍返回 null 而不是 0", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));

    const resp = await worker.fetch(
      authedReq("/api/usage"),
      env({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }),
      {} as ExecutionContext,
    );

    const body = (await resp.json()) as { workers: { requests: unknown } };
    expect(body.workers.requests).toBeNull();
  });

  it("GraphQL 正常时解析出请求数", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  { sum: { requests: 120, errors: 2 } },
                  { sum: { requests: 80, errors: 0 } },
                ],
              },
            ],
          },
        },
        errors: null,
      }),
    );

    const resp = await worker.fetch(
      authedReq("/api/usage"),
      env({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as {
      workers: { requests: { used: number; limit: number; pct: number }; errors: number; source: string };
    };

    expect(body.workers.source).toBe("graphql");
    expect(body.workers.requests.used).toBe(200);
    expect(body.workers.requests.limit).toBe(100_000);
    expect(body.workers.errors).toBe(2);
  });

  it("百分比按额度计算且不超过 100", async () => {
    const store = new Map<string, string>();
    // 预置一个超额的用量记录（模拟额度已爆）
    const today = new Date().toISOString().slice(0, 10);
    store.set(
      `meta:usage:${today}`,
      JSON.stringify({ reads: 250_000, writes: 2000, lists: 1500, deletes: 0 }),
    );
    const kv = fakeKv(store).kv;

    const resp = await worker.fetch(
      authedReq("/api/usage"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as {
      kv: {
        reads: { pct: number };
        writes: { pct: number };
        lists: { pct: number };
      };
    };

    expect(body.kv.reads.pct).toBe(100);
    expect(body.kv.writes.pct).toBe(100);
    expect(body.kv.lists.pct).toBe(100);
  });

  it("未认证时拒绝", async () => {
    const resp = await worker.fetch(
      new Request("https://x.test/api/usage"),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
  });
});
