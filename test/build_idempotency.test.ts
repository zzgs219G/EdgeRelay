import { describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import type { BuildJob, Env } from "../src/shared/types";
import { tokenFingerprint } from "../src/services/principal";
import { invalidateConfigCache } from "../src/services/config";

/**
 * 构建提交的幂等键（client_request_id）。
 *
 * 要防的真实现象（用户报的「网关响应超时，重新查询没用，任务永远失败」）：
 *
 *   APP 点创建 → POST /api/build 超时 → APP 判失败，标 FAILED。
 *   但网关的顺序是 **先 putNewJob 落库、再 dispatchWorkflow**，所以那次
 *   超时完全可能发生在「任务已建成、GitHub 已跑完」之后。于是：
 *     - 网关：任务存在，conclusion=success，产物在 R2
 *     - APP：status=FAILED，runId 还停在假的 `PENDING_<ts>`
 *   两边永远对不上，且「重新查询」无从下手——它不知道该查哪个 job。
 *
 * 这些用例锁住三个必须成立的性质：
 *   1. 同一次提交重发 → **不重复 dispatch**（否则同一 APK 被加固两遍）
 *   2. 重发能拿回**同一个** job_id（否则孤儿的 job_id 永远找不回来）
 *   3. 反查接口不跨令牌泄漏（client_request_id 由客户端生成，可能撞值）
 */

function fakeKv(store = new Map<string, string>()): KVNamespace {
  return {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
    async delete(k: string) {
      store.delete(k);
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
    GITHUB_TOKEN: "tok",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    EDGE_RELAY_KV: fakeKv(),
    RELAY_TOKEN: "t",
    RATE_LIMIT_PER_MIN: "0",
    RUN_ID_WAIT_MS: "0",
    ...overrides,
  };
}

const CLIENT_ID = "3f2b0c1e-9d4a-4f7b-8c6e-1a2b3c4d5e6f";

function buildBody(clientRequestId?: string) {
  return {
    apk_url: "https://r2.example.com/apks/1.apk",
    workflow_file: "protect-modules.yml",
    protect_config: '{"modules":[]}',
    ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
  };
}

function buildReq(clientRequestId?: string, token = "t"): Request {
  return new Request("https://x.test/api/build", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(buildBody(clientRequestId)),
  });
}

function lookupReq(clientRequestId: string, token = "t"): Request {
  return new Request(`https://x.test/api/build/idem/${clientRequestId}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 没有 waitUntil 的 ctx：不启动后台 run_id 探测，避免污染 dispatch 计数。 */
const bareCtx = { passThroughOnException() {} } as unknown as ExecutionContext;

/** 装一个只统计 dispatch 次数的 GitHub 桩。 */
function stubGitHub() {
  const state = { dispatches: 0 };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/dispatches")) {
      state.dispatches++;
      return new Response(null, { status: 204 });
    }
    if (url.includes("/runs")) {
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  return state;
}

describe("build 幂等 — 同一次提交重发不重复 dispatch", () => {
  it("两次提交拿回同一个 job_id，且只 dispatch 一次", async () => {
    const store = new Map<string, string>();
    const gh = stubGitHub();
    const e = env({ EDGE_RELAY_KV: fakeKv(store) });

    const r1 = await worker.fetch(buildReq(CLIENT_ID), e, bareCtx);
    const b1 = (await r1.json()) as { job_id: string; success: boolean };
    const r2 = await worker.fetch(buildReq(CLIENT_ID), e, bareCtx);
    const b2 = (await r2.json()) as { job_id: string; success: boolean };

    expect(r1.status).toBe(200);
    // 第二次是幂等命中，不是 4xx —— 调用方（APP）按成功路径处理即可
    expect(r2.status).toBe(200);
    expect(b1.success).toBe(true);
    expect(b2.job_id).toBe(b1.job_id);
    // 核心断言：只触发了一次流水线。两次就是同一 APK 加固两遍。
    expect(gh.dispatches).toBe(1);

    vi.unstubAllGlobals();
  });

  it("不同 client_request_id 各自建任务（幂等不能退化成去重）", async () => {
    const store = new Map<string, string>();
    const gh = stubGitHub();
    const e = env({ EDGE_RELAY_KV: fakeKv(store) });

    const b1 = (await (await worker.fetch(buildReq("idem-aaaa-1111"), e, bareCtx)).json()) as {
      job_id: string;
    };
    const b2 = (await (await worker.fetch(buildReq("idem-bbbb-2222"), e, bareCtx)).json()) as {
      job_id: string;
    };

    expect(b1.job_id).not.toBe(b2.job_id);
    expect(gh.dispatches).toBe(2);

    vi.unstubAllGlobals();
  });

  it("不带 client_request_id 时行为与改造前一致（兼容老 APP）", async () => {
    const store = new Map<string, string>();
    const gh = stubGitHub();
    const e = env({ EDGE_RELAY_KV: fakeKv(store) });

    const r1 = await worker.fetch(buildReq(), e, bareCtx);
    const r2 = await worker.fetch(buildReq(), e, bareCtx);
    const b1 = (await r1.json()) as { job_id: string };
    const b2 = (await r2.json()) as { job_id: string };

    expect(r1.status).toBe(200);
    expect(b1.job_id).not.toBe(b2.job_id);
    expect(gh.dispatches).toBe(2);
    // 不该留下任何幂等映射
    expect([...store.keys()].some((k) => k.startsWith("idem:"))).toBe(false);

    vi.unstubAllGlobals();
  });

  it("重复提交时如实回带任务真实状态，而不是硬写 queued", async () => {
    const store = new Map<string, string>();
    stubGitHub();
    const e = env({ EDGE_RELAY_KV: fakeKv(store) });

    const b1 = (await (await worker.fetch(buildReq(CLIENT_ID), e, bareCtx)).json()) as {
      job_id: string;
    };
    // 模拟 status 回查把任务推进到 in_progress（真实链路里由 cron / status 做）
    const job = JSON.parse(store.get(`job:${b1.job_id}`)!) as BuildJob;
    store.set(`job:${b1.job_id}`, JSON.stringify({ ...job, status: "in_progress" }));

    const b2 = (await (await worker.fetch(buildReq(CLIENT_ID), e, bareCtx)).json()) as {
      status: string;
    };
    expect(b2.status).toBe("in_progress");

    vi.unstubAllGlobals();
  });

  it("client_request_id 格式非法一律 400，不落库", async () => {
    const store = new Map<string, string>();
    const gh = stubGitHub();
    const e = env({ EDGE_RELAY_KV: fakeKv(store) });

    // 含冒号（KV key 分隔符）、过短、过长、非法字符
    for (const bad of ["a:b:c", "short", "x".repeat(65), "空格 不合法"]) {
      const resp = await worker.fetch(buildReq(bad), e, bareCtx);
      expect(resp.status, `应拒绝 ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(gh.dispatches).toBe(0);
    expect([...store.keys()].some((k) => k.startsWith("job:"))).toBe(false);

    vi.unstubAllGlobals();
  });
});

describe("build 幂等 — 反查接口", () => {
  it("用 client_request_id 能精确查回 job_id 与状态", async () => {
    const store = new Map<string, string>();
    stubGitHub();
    const e = env({ EDGE_RELAY_KV: fakeKv(store) });

    const created = (await (await worker.fetch(buildReq(CLIENT_ID), e, bareCtx)).json()) as {
      job_id: string;
    };

    const resp = await worker.fetch(lookupReq(CLIENT_ID), e, bareCtx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { success: boolean; job_id: string; status: string };
    expect(body.success).toBe(true);
    expect(body.job_id).toBe(created.job_id);
    expect(body.status).toBe("queued");

    vi.unstubAllGlobals();
  });

  it("从未提交过的 ID → 404（而不是 500 或空 200）", async () => {
    stubGitHub();
    const e = env();
    const resp = await worker.fetch(lookupReq("idem-never-seen-9999"), e, bareCtx);
    expect(resp.status).toBe(404);
    vi.unstubAllGlobals();
  });

  it("映射存在但任务已被清 → 404，不给悬空 job_id", async () => {
    const store = new Map<string, string>();
    stubGitHub();
    const e = env({ EDGE_RELAY_KV: fakeKv(store) });

    const created = (await (await worker.fetch(buildReq(CLIENT_ID), e, bareCtx)).json()) as {
      job_id: string;
    };
    // 模拟任务记录过了 TTL 被清（映射 TTL 24h，任务 TTL 7d，正常不会先清；
    // 但重建 KV / 手工删 key 会出现）。此时必须 404，否则 APP 会把一个
    // 查状态必然 404 的 job_id 写回本地，等于制造新的死任务。
    store.delete(`job:${created.job_id}`);

    const resp = await worker.fetch(lookupReq(CLIENT_ID), e, bareCtx);
    expect(resp.status).toBe(404);
    vi.unstubAllGlobals();
  });

  it("别的令牌用同一个 client_request_id 查不到（跨主体不泄漏）", async () => {
    const store = new Map<string, string>();
    stubGitHub();
    // KV 配置里换个令牌 = 迁移期双令牌并存：config 值 "t2" 生效，
    // 原 env 值 "t" 作为 RAW_RELAY_TOKEN 兜底，两者都通过鉴权（见 services/principal.relayTokens）。
    store.set("config:v1", JSON.stringify({ relay_token: "t2" }));
    invalidateConfigCache();
    const e = env({ EDGE_RELAY_KV: fakeKv(store) });

    const created = (await (await worker.fetch(buildReq(CLIENT_ID, "t"), e, bareCtx)).json()) as {
      job_id: string;
    };
    expect(created.job_id).toBeTruthy();

    // 令牌 t2 猜到了 t 的 client_request_id，也读不到 t 的 job
    const resp = await worker.fetch(lookupReq(CLIENT_ID, "t2"), e, bareCtx);
    expect(resp.status).toBe(404);

    invalidateConfigCache();
    vi.unstubAllGlobals();
  });

  it("映射 key 带 owner 指纹，两个令牌同 ID 互不覆盖", async () => {
    const store = new Map<string, string>();
    const gh = stubGitHub();
    store.set("config:v1", JSON.stringify({ relay_token: "t2" }));
    invalidateConfigCache();
    const e = env({ EDGE_RELAY_KV: fakeKv(store) });

    const a = (await (await worker.fetch(buildReq(CLIENT_ID, "t"), e, bareCtx)).json()) as {
      job_id: string;
    };
    const b = (await (await worker.fetch(buildReq(CLIENT_ID, "t2"), e, bareCtx)).json()) as {
      job_id: string;
    };

    expect(a.job_id).not.toBe(b.job_id);
    expect(gh.dispatches).toBe(2);

    // 各自反查回自己的
    const fa = (await (await worker.fetch(lookupReq(CLIENT_ID, "t"), e, bareCtx)).json()) as {
      job_id: string;
    };
    const fb = (await (await worker.fetch(lookupReq(CLIENT_ID, "t2"), e, bareCtx)).json()) as {
      job_id: string;
    };
    expect(fa.job_id).toBe(a.job_id);
    expect(fb.job_id).toBe(b.job_id);

    // 底层 key 形态确认：idem:<指纹>:<id>，两份互不覆盖
    expect(store.has(`idem:${await tokenFingerprint("t")}:${CLIENT_ID}`)).toBe(true);
    expect(store.has(`idem:${await tokenFingerprint("t2")}:${CLIENT_ID}`)).toBe(true);

    invalidateConfigCache();
    vi.unstubAllGlobals();
  });

  it("反查接口的非法 ID 格式 → 400", async () => {
    stubGitHub();
    const e = env();
    const resp = await worker.fetch(lookupReq("bad:id:format"), e, bareCtx);
    expect(resp.status).toBe(400);
    vi.unstubAllGlobals();
  });
});
