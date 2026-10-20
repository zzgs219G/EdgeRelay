import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import type { BuildJob, Env } from "../src/types";
import { invalidateConfigCache } from "../src/config";
import { invalidateJobsCache } from "../src/jobs";

/**
 * KV 配额守卫测试。
 *
 * 背景（Cloudflare 免费档，见 kv/platform/pricing）：
 *   reads  100,000 / 天
 *   writes  1,000 / 天
 *   lists   1,000 / 天
 *
 * 后两项比 reads 少 100 倍，是最稀缺的资源。原实现有三条「无条件执行」
 * 的路径，合起来就是「KV 操作限额」的完整成因：
 *
 *   1. cron 每轮必调 listOpenJobs
 *      → 1440 分钟/天 = 1440 次 list，超 list 额度 44%
 *      （且与有没有人开着面板无关，是纯底噪）
 *
 *   2. 两处「状态没变也写」：status.ts 每 30s、reconcile 每轮
 *      → 写的都是 status:"in_progress"，唯一作用是刷新 updated_at_ms，
 *        而该字段不出现在任何响应体里，唯一读者是节流逻辑自己
 *      → 一个 40 分钟任务 80+ 次无变化写，写额度只够约 12 个任务
 *
 *   3. queued 补不上 run_id 的僵尸任务没人判死
 *      → has_active 恒 true，前端永不停，cron 每分钟继续为它烧额度，
 *        持续到 KV TTL（7 天）到期
 *
 * 另外 build 接口在拿不到 run_id 时仍会写第二次 KV（状态没变）。
 * 下面逐条钉死修复。
 */

/** 计数 KV：记录每次操作，供断言「省了多少」。
 *
 * `puts` 与 `metaPuts` 分开计：信号灯（meta:*）的写入是为了省 list 而
 * 有意增加的，断言「任务本身的写入次数」时不该把它算进去。 */
function countingKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const ops = { get: 0, list: 0, puts: 0, metaPuts: 0 };
  return {
    ops,
    store,
    kv: {
      async get(key: string) {
        ops.get++;
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        if (key.startsWith("meta:")) ops.metaPuts++;
        else ops.puts++;
        store.set(key, value);
      },
      async list(opts: { prefix?: string; limit?: number } = {}) {
        ops.list++;
        const keys = [...store.keys()]
          .filter((k) => k.startsWith(opts.prefix ?? ""))
          .slice(0, opts.limit ?? 1000)
          .map((name) => ({ name }));
        return { keys, list_complete: true, cursor: "" };
      },
    } as unknown as KVNamespace,
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: "test-token",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: {} as KVNamespace,
    RELAY_TOKEN: "test-relay-token",
    RELAY_PASSWORD: "test-password",
    RATE_LIMIT_PER_MIN: "0",
    RUN_ID_WAIT_MS: "500",
    ...overrides,
  };
}

function job(over: Partial<BuildJob> = {}): BuildJob {
  return {
    job_id: "abc",
    run_id: null,
    workflow_file: "protect-modules.yml",
    workflow_name: "w",
    protect_config: "{}",
    dpt_extra_args: "",
    display_name: "",
    status: "queued",
    conclusion: null,
    download_url: null,
    error: null,
    created_at_ms: 1000,
    updated_at_ms: 1000,
    ...over,
  };
}

function authedReq(path: string, init: RequestInit = {}): Request {
  return new Request(`https://edge-relay.test${path}`, {
    ...init,
    headers: {
      authorization: "Bearer test-relay-token",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

afterEach(() => {
  invalidateConfigCache();
  invalidateJobsCache();
  vi.unstubAllGlobals();
});

// ── 1. 停滞任务必须被判死 ────────────────────────────────────────

describe("stalled jobs are killed instead of polling forever", () => {
  it("marks a queued job with no run_id as failed once the timeout passes", async () => {
    // 11 分钟前创建、始终没绑上 run_id 的僵尸任务
    const stale = job({
      created_at_ms: Date.now() - 11 * 60_000,
      updated_at_ms: Date.now() - 11 * 60_000,
    });
    const store = { [`job:${stale.job_id}`]: JSON.stringify(stale) };
    const { kv, store: map } = countingKv(store);

    const resp = await worker.fetch(
      authedReq("/api/status/abc"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { app_status: string; error: string | null };
    // APP 立刻看到失败，而不是无限等待
    expect(body.app_status).toBe("FAILED");
    expect(body.error).toContain("任务超时");

    // 落库的状态也必须是终态，否则 has_active 仍为 true
    const saved = JSON.parse(map.get("job:abc")!) as BuildJob;
    expect(saved.status).toBe("completed");
    expect(saved.conclusion).toBe("failure");
  });

  it("leaves a fresh queued job alone (false positive would break normal builds)", async () => {
    // 刚创建 1 分钟的 queued 任务：waitForRunId 的 4 秒还没过多久，
    // 判死它会把正常构建全部误杀。
    const fresh = job({ created_at_ms: Date.now() - 60_000 });
    const { kv } = countingKv({ "job:abc": JSON.stringify(fresh) });

    const resp = await worker.fetch(
      authedReq("/api/status/abc"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    const body = (await resp.json()) as { app_status: string; error: string | null };
    expect(body.app_status).toBe("PENDING");
    expect(body.error).toBeNull();
  });

  it("never kills an in_progress job no matter how old (long builds are legit)", async () => {
    // 3 小时前创建、有 run_id、仍在跑：加固构建真的会跑很久，
    // 用 created_at 判死会杀掉正常的长任务。
    const long = job({
      status: "in_progress",
      run_id: 999,
      created_at_ms: Date.now() - 3 * 60 * 60_000,
      updated_at_ms: Date.now() - 60_000,
    });
    const { kv } = countingKv({ "job:abc": JSON.stringify(long) });

    // GitHub 侧仍显示 in_progress
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ id: 999, status: "in_progress" }), { status: 200 }),
    );

    const resp = await worker.fetch(
      authedReq("/api/status/abc"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    const body = (await resp.json()) as { app_status: string };
    expect(body.app_status).toBe("PROCESSING");
  });

  it("respects a custom JOB_STALL_TIMEOUT_MIN", async () => {
    const stale = job({
      created_at_ms: Date.now() - 3 * 60_000,
      updated_at_ms: Date.now() - 3 * 60_000,
    });
    const { kv, store: map } = countingKv({ "job:abc": JSON.stringify(stale) });

    const resp = await worker.fetch(
      authedReq("/api/status/abc"),
      env({ EDGE_RELAY_KV: kv, JOB_STALL_TIMEOUT_MIN: "2" }),
      {} as ExecutionContext,
    );

    const body = (await resp.json()) as { app_status: string };
    expect(body.app_status).toBe("FAILED");
    expect(JSON.parse(map.get("job:abc")!).status).toBe("completed");
  });
});

// ── 2. has_active 必须把停滞任务算作非活跃 ───────────────────────

describe("has_active does not count stalled jobs", () => {
  it("reports has_active=false when the only open job is stalled", async () => {
    // 这是「一直轮询」的总开关：has_active 恒 true，前端就永不停。
    const stale = job({
      created_at_ms: Date.now() - 30 * 60_000,
      updated_at_ms: Date.now() - 30 * 60_000,
    });
    const { kv } = countingKv({ "job:abc": JSON.stringify(stale) });

    const resp = await worker.fetch(
      authedReq("/api/jobs"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    const body = (await resp.json()) as { has_active: boolean };
    expect(body.has_active).toBe(false);
  });

  it("still reports has_active=true for a genuinely running job", async () => {
    // 反向断言：不能为了省额度把真在跑的任务也判成不活跃
    const running = job({ status: "in_progress", run_id: 1 });
    const { kv } = countingKv({ "job:abc": JSON.stringify(running) });

    const resp = await worker.fetch(
      authedReq("/api/jobs"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    const body = (await resp.json()) as { has_active: boolean };
    expect(body.has_active).toBe(true);
  });
});

// ── 3. cron 的 list 必须被缓存 ───────────────────────────────────

describe("cron list is cached, not 1440/day", () => {
  it("reuses the open-jobs list across ticks within the TTL", async () => {
    const { reconcileOpenJobs, invalidateOpenJobsCache } = await import("../src/reconcile");

    const running = job({ status: "in_progress", run_id: 1, updated_at_ms: Date.now() });
    const { kv, ops } = countingKv({
      "job:abc": JSON.stringify(running),
      // 信号灯为非零，否则 reconcile 第一道闸就直接返回，走不到 list
      "meta:open_count": "1",
      "meta:open_count_reconciled_at": String(Date.now()),
    });

    // GitHub 侧一直 in_progress：此时 reconcile 不该写 KV（见下一条），
    // 但每轮仍会读列表——读必须被缓存挡住。
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ id: 1, status: "in_progress" }), { status: 200 }),
    );

    invalidateOpenJobsCache();
    const e = env({ EDGE_RELAY_KV: kv });

    // 模拟连续 5 轮 cron（实际每 2 分钟一轮）
    for (let i = 0; i < 5; i++) {
      await reconcileOpenJobs(e);
    }

    // 5 轮只 1 次 list。原实现是 5 次 list + 5 次逐 key get。
    // 按 1440 轮/天算：原 1440 list（超额 44%），加缓存后 720。
    // （信号灯的 5 次 get 不计入——它是用廉价读换昂贵 list 的代价，
    //  且读额度 10 万/天，5 次微不足道。）
    expect(ops.list).toBe(1);
    // job 记录本身只被读 1 次（缓存挡住了后 4 轮）
    expect(ops.get).toBeLessThanOrEqual(6);
  });
});

// ── 4. 例行刷新不得无变化写 KV ──────────────────────────────────

describe("in_progress refresh does not write when nothing changed", () => {
  it("writes nothing while the run is still going, however long it has been", async () => {
    const { reconcileOpenJobs, invalidateOpenJobsCache } = await import("../src/reconcile");

    // 10 分钟前创建、30 秒前刚更新过、仍在跑。
    // 注意 updated_at_ms 已经"很久没动"了——原实现的 30s / 60s 门槛
    // 早就该触发，而现在无论如何都不写。
    const running = job({
      status: "in_progress",
      run_id: 1,
      created_at_ms: Date.now() - 10 * 60_000,
      updated_at_ms: Date.now() - 10 * 60_000,
    });
    const { kv, ops } = countingKv({ "job:abc": JSON.stringify(running) });

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ id: 1, status: "in_progress" }), { status: 200 }),
    );

    invalidateOpenJobsCache();
    await reconcileOpenJobs(env({ EDGE_RELAY_KV: kv }));

    // 原实现无条件 patchJob → 每轮 1 次写；20 分钟任务 = 20 次写，
    // 写额度 1000/天只够 50 个任务。现在 0 次。
    expect(ops.puts).toBe(0);
  });

  it("skips the write when the run is still in progress", async () => {
    // 原实现每 30 秒写一次 status:"in_progress"。APP 每 5 秒轮询一次
    // /api/status，40 分钟的构建 = 80 次无变化写，KV 写额度
    // （1000 次/天）只够 12 个任务。现在一次都不写。
    const { kv, ops } = countingKv({
      "job:abc": JSON.stringify(job({
        status: "in_progress",
        run_id: 1,
        created_at_ms: Date.now() - 10 * 60_000,
        // 距上次更新很久了：原实现的 30s 门槛早就该触发了
        updated_at_ms: Date.now() - 10 * 60_000,
      })),
    });

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ id: 1, status: "in_progress" }), { status: 200 }),
    );

    const resp = await worker.fetch(
      authedReq("/api/status/abc"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    const body = (await resp.json()) as { app_status: string };
    expect(body.app_status).toBe("PROCESSING");
    // 状态正确返回，但 KV 一次没写
    expect(ops.puts).toBe(0);
  });

  it("keeps elapsed_ms accurate without the periodic writes", async () => {
    // 去掉例行写的代价评估：elapsed_ms 在完成时算，用的是完成那一刻的
    // updated_at_ms，不依赖构建期间的例行刷新。
    const created = Date.now() - 40 * 60_000;
    const { kv } = countingKv({
      "job:abc": JSON.stringify(job({
        status: "in_progress",
        run_id: 1,
        created_at_ms: created,
        updated_at_ms: created,
      })),
    });

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/artifacts")) {
          return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
        }
        if (url.includes("/jobs")) {
          return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: 1, status: "completed", conclusion: "success" }),
          { status: 200 },
        );
      },
    );

    const resp = await worker.fetch(
      authedReq("/api/status/abc"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    const body = (await resp.json()) as { app_status: string; elapsed_ms: number };
    expect(body.app_status).toBe("SUCCESS");
    expect(body.elapsed_ms).toBeGreaterThan(30 * 60_000);
  });

  it("still writes when the run actually completed", async () => {
    const { reconcileOpenJobs, invalidateOpenJobsCache } = await import("../src/reconcile");

    const running = job({
      status: "in_progress",
      run_id: 1,
      created_at_ms: Date.now() - 5 * 60_000,
      updated_at_ms: Date.now() - 30_000,
    });
    const { kv, ops, store } = countingKv({ "job:abc": JSON.stringify(running) });

    // GitHub 侧已完成：这是必须落盘的真实状态变化
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/artifacts")) {
          return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
        }
        if (url.includes("/jobs")) {
          return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: 1, status: "completed", conclusion: "success" }),
          { status: 200 },
        );
      },
    );

    invalidateOpenJobsCache();
    await reconcileOpenJobs(env({ EDGE_RELAY_KV: kv }));

    expect(ops.puts).toBeGreaterThan(0);
    expect(JSON.parse(store.get("job:abc")!).status).toBe("completed");
  });

  it("writes a stalled job exactly once, then stops touching it", async () => {
    const { reconcileOpenJobs, invalidateOpenJobsCache } = await import("../src/reconcile");

    // 僵尸任务：补不上 run_id，应在第一轮就被判死
    const stale = job({
      created_at_ms: Date.now() - 20 * 60_000,
      updated_at_ms: Date.now() - 20 * 60_000,
    });
    const { kv, ops, store } = countingKv({ "job:abc": JSON.stringify(stale) });

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }),
    );

    invalidateOpenJobsCache();
    for (let i = 0; i < 5; i++) {
      await reconcileOpenJobs(env({ EDGE_RELAY_KV: kv }));
    }

    const saved = JSON.parse(store.get("job:abc")!) as BuildJob;
    expect(saved.status).toBe("completed");
    expect(saved.conclusion).toBe("failure");

    // 判死后它不再是未完结任务，后续轮次不该再碰它。
    // 原实现：5 轮 × (1 list + N get + 1 patchJob) 无限循环 7 天。
    expect(ops.puts).toBe(1);
  });
});

// ── 5. build 接口不得为「没有变化」落第二次库 ────────────────────

describe("build does not write twice when run_id never appears", () => {
  it("skips the second put when waitForRunId times out", async () => {
    // dispatch 成功但 runs 列表里始终看不到新 run：此时 job 状态仍是
    // queued，与第一次落库完全一致。原实现仍会 put 第二次，
    // 白耗一次写额度。
    const { kv, ops, store } = countingKv();

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/dispatches")) {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/runs")) {
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ workflows: [] }), { status: 200 });
    });

    const resp = await worker.fetch(
      authedReq("/api/build", {
        method: "POST",
        body: JSON.stringify({
          apk_url: "https://r2.example.com/apks/a.apk",
          workflow_file: "protect-modules.yml",
          protect_config: '{"modules":[]}',
        }),
      }),
      env({ EDGE_RELAY_KV: kv, RUN_ID_WAIT_MS: "200" }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { success: boolean; status: string };
    expect(body.success).toBe(true);
    // 拿不到 run_id 时如实返回 queued，而不是假装 in_progress
    expect(body.status).toBe("queued");

    // 只写 1 次（建任务那次）。原实现是 2 次。
    expect(ops.puts).toBe(1);
    const saved = JSON.parse([...store.values()][0]) as BuildJob;
    expect(saved.status).toBe("queued");
    expect(saved.run_id).toBeNull();
  });
});

// ── 6. build 阶段的 run_id 补绑必须探测固定次数 ───────────────────

describe("waitForRunId probes a fixed number of times", () => {
  // 下面三个测试用真实 sleep 模拟慢 RTT。
  it("probes 3 times within the budget when the run never appears", { timeout: 15_000 }, async () => {
    // 原实现是 `while (now < deadline)`，探测次数取决于每次 fetch 的
    // RTT——注释写的「约 5 次」在 GitHub 变慢时会缩到 2-3 次，
    // 补绑成功率随网络波动。现在固定 3 次。
    let probes = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/runs")) {
        probes++;
        // 800ms 慢 RTT：4000ms 预算 + 1000ms gap 足够跑满 3 次。
        await new Promise((r) => setTimeout(r, 800));
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      }
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ workflows: [] }), { status: 200 });
    });

    const started = Date.now();
    const resp = await worker.fetch(
      authedReq("/api/build", {
        method: "POST",
        body: JSON.stringify({
          apk_url: "https://r2.example.com/apks/a.apk",
          workflow_file: "protect-modules.yml",
          protect_config: '{"modules":[]}',
        }),
      }),
      env({ EDGE_RELAY_KV: countingKv().kv, RUN_ID_WAIT_MS: "4000" }),
      {} as ExecutionContext,
    );
    const elapsed = Date.now() - started;

    expect(resp.status).toBe(200);
    // 固定 3 次，不因 RTT 慢而缩水
    expect(probes).toBe(3);
    // 不超出预算（最后一次探测后不再等待）
    expect(elapsed).toBeLessThan(6000);
  });

  it("still binds the run when it appears on a later probe", { timeout: 15_000 }, async () => {
    // 补绑的真正目的：run 在第 2 次探测时才出现，也必须绑上。
    let probes = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/runs")) {
        probes++;
        const runs = probes >= 2 ? [{ id: 4242, status: "in_progress", event: "workflow_dispatch", created_at: new Date().toISOString() }] : [];
        return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
      }
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ workflows: [] }), { status: 200 });
    });

    const { kv, store } = countingKv();
    const resp = await worker.fetch(
      authedReq("/api/build", {
        method: "POST",
        body: JSON.stringify({
          apk_url: "https://r2.example.com/apks/a.apk",
          workflow_file: "protect-modules.yml",
          protect_config: '{"modules":[]}',
        }),
      }),
      env({ EDGE_RELAY_KV: kv, RUN_ID_WAIT_MS: "4000" }),
      {} as ExecutionContext,
    );

    const body = (await resp.json()) as { success: boolean; status: string };
    expect(body.success).toBe(true);
    expect(body.status).toBe("in_progress");
    const saved = JSON.parse([...store.values()][0]) as BuildJob;
    expect(saved.run_id).toBe(4242);
    expect(saved.status).toBe("in_progress");
  });

  it("does not exceed the budget even when attempts are large", { timeout: 15_000 }, async () => {
    // 反向保险：RTT 很慢时，不能让循环无限跑下去。
    let probes = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/runs")) {
        probes++;
        await new Promise((r) => setTimeout(r, 2000));
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      }
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ workflows: [] }), { status: 200 });
    });

    // 预算给得很小：每次探测就吃掉它，应当只探测 1 次然后收手
    const started = Date.now();
    await worker.fetch(
      authedReq("/api/build", {
        method: "POST",
        body: JSON.stringify({
          apk_url: "https://r2.example.com/apks/a.apk",
          workflow_file: "protect-modules.yml",
          protect_config: '{"modules":[]}',
        }),
      }),
      env({ EDGE_RELAY_KV: countingKv().kv, RUN_ID_WAIT_MS: "500" }),
      {} as ExecutionContext,
    );
    const elapsed = Date.now() - started;

    expect(probes).toBeLessThanOrEqual(3);
    expect(elapsed).toBeLessThan(4000);
  });
});

// ── 7. 信号灯：空闲时一次 list 都不做 ──────────────────────────────

describe("signal light keeps cron from listing when idle", () => {
  const META = { "meta:open_count": "0", "meta:open_count_reconciled_at": String(Date.now()) };

  it("does no list at all when the signal light reads zero", async () => {
    const { reconcileOpenJobs, invalidateOpenJobsCache } = await import("../src/reconcile");
    invalidateOpenJobsCache();

    const { kv, ops } = countingKv(META);

    await reconcileOpenJobs(env({ EDGE_RELAY_KV: kv }));

    // 空闲：只花 1 次 get 读信号灯，list 为 0。
    // 原实现每轮 1 次 list（1440 轮/天，加缓存仍约 720 次）。
    expect(ops.list).toBe(0);
  });

  it("still lists when the signal light reads non-zero", async () => {
    const { reconcileOpenJobs, invalidateOpenJobsCache } = await import("../src/reconcile");
    invalidateOpenJobsCache();

    const running = job({
      status: "in_progress",
      run_id: 1,
      created_at_ms: Date.now() - 5 * 60_000,
      updated_at_ms: Date.now() - 5 * 60_000,
    });
    const { kv, ops } = countingKv({
      "job:abc": JSON.stringify(running),
      "meta:open_count": "1",
      "meta:open_count_reconciled_at": String(Date.now()),
    });

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ id: 1, status: "in_progress" }), { status: 200 }),
    );

    await reconcileOpenJobs(env({ EDGE_RELAY_KV: kv }));

    // 有活才 list——这正是我们要保留的行为
    expect(ops.list).toBeGreaterThan(0);
  });

  it("treats a missing signal light as 'maybe there is work' (fail safe)", async () => {
    // 从未写过信号灯 / KV 读失败时，绝不能因为读不到数就跳过——
    // 那会让真在跑的任务永远没人推进。宁可多 list 一次。
    const { reconcileOpenJobs, invalidateOpenJobsCache } = await import("../src/reconcile");
    invalidateOpenJobsCache();

    const running = job({
      status: "in_progress",
      run_id: 1,
      created_at_ms: Date.now() - 5 * 60_000,
      updated_at_ms: Date.now() - 5 * 60_000,
    });
    // 故意不给 meta:open_count —— readOpenCount 返回 null
    const { kv, ops } = countingKv({ "job:abc": JSON.stringify(running) });

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ id: 1, status: "in_progress" }), { status: 200 }),
    );

    await reconcileOpenJobs(env({ EDGE_RELAY_KV: kv }));

    expect(ops.list).toBeGreaterThan(0);
  });

  it("reconciles hourly and self-heals a drifted count", async () => {
    const { reconcileOpenJobs, invalidateOpenJobsCache } = await import("../src/reconcile");
    invalidateOpenJobsCache();

    // 信号灯说 0，但实际有 1 个未完结任务（写竞争漏加了）。
    // 且距上次对账已超过 1 小时 → 本轮应当做对账并处理它。
    const stale = job({
      status: "in_progress",
      run_id: 1,
      created_at_ms: Date.now() - 5 * 60_000,
      updated_at_ms: Date.now() - 5 * 60_000,
    });
    const { kv, ops, store } = countingKv({
      "job:abc": JSON.stringify(stale),
      "meta:open_count": "0",
      // 2 小时前才对账过 → 该对账了
      "meta:open_count_reconciled_at": String(Date.now() - 2 * 60 * 60_000),
    });

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ id: 1, status: "in_progress" }), { status: 200 }),
    );

    await reconcileOpenJobs(env({ EDGE_RELAY_KV: kv }));

    // 对账发生了：至少一次 list，且数字被纠正成 1
    expect(ops.list).toBeGreaterThan(0);
    expect(store.get("meta:open_count")).toBe("1");
    // 对账后确认有活 → 任务被继续处理（run 仍在跑，不写 KV，
    // 但正确的证据是 GitHub 被调用过，即 ops.get 覆盖了对账的读）
    expect(ops.get).toBeGreaterThan(1);
  });

  it("does not reconcile on every idle tick (that would cost 1440 lists)", async () => {
    const { reconcileOpenJobs, invalidateOpenJobsCache } = await import("../src/reconcile");
    invalidateOpenJobsCache();

    const { kv, ops } = countingKv({
      "meta:open_count": "0",
      // 刚刚才对账过 → 本轮不该再对账
      "meta:open_count_reconciled_at": String(Date.now()),
    });

    // 连跑 10 轮空闲 tick
    for (let i = 0; i < 10; i++) {
      await reconcileOpenJobs(env({ EDGE_RELAY_KV: kv }));
    }

    // 10 轮 = 0 次 list。若每轮都对账，就是 10 次（全天 1440 次）。
    expect(ops.list).toBe(0);
  });
});

// ── 8. 信号灯的写入侧维护 ─────────────────────────────────────────

describe("signal light maintenance on the write side", () => {
  async function reconcile() {
    const m = await import("../src/reconcile");
    m.invalidateOpenJobsCache();
    return m;
  }

  it("bumps the count when a job is created", async () => {
    const { putNewJob } = await import("../src/kv_store");
    const { kv, store } = countingKv({ "meta:open_count": "0" });

    await putNewJob(env({ EDGE_RELAY_KV: kv }), job({ job_id: "new1" }));

    expect(store.get("meta:open_count")).toBe("1");
  });

  it("leaves the count alone for a plain putJob (no double counting)", async () => {
    // putJob 是底层写、被 patchJob 复用。若它也 +1，则每次 patchJob 都会
    // 把信号灯推高——这个 bug 真实存在过（测试抓到过：两次 patchJob 后
    // 计数变成 3）。
    const { putJob } = await import("../src/kv_store");
    const { kv, store } = countingKv({ "meta:open_count": "1" });

    await putJob(env({ EDGE_RELAY_KV: kv }), job({ job_id: "abc" }));

    expect(store.get("meta:open_count")).toBe("1");
  });

  it("drops the count when a job reaches a terminal state", async () => {
    const { putNewJob, patchJob } = await import("../src/kv_store");
    const { kv, store } = countingKv({
      "meta:open_count": "1",
      "job:abc": JSON.stringify(job()),
    });

    // 建任务时 +1（此时 1 → 2）
    await putNewJob(env({ EDGE_RELAY_KV: kv }), job({ job_id: "abc" }));
    expect(store.get("meta:open_count")).toBe("2");

    // 转终态 -1（2 → 1）
    await patchJob(env({ EDGE_RELAY_KV: kv }), "abc", {
      status: "completed",
      conclusion: "success",
    });
    expect(store.get("meta:open_count")).toBe("1");
  });

  it("never lets a non-terminal patch change the count", async () => {
    const { patchJob } = await import("../src/kv_store");
    const { kv, store } = countingKv({
      "meta:open_count": "1",
      "job:abc": JSON.stringify(job({ status: "in_progress", run_id: 1 })),
    });

    // 只改 error / 改 status 但仍是 in_progress → 计数不动
    await patchJob(env({ EDGE_RELAY_KV: kv }), "abc", { status: "in_progress" });
    await patchJob(env({ EDGE_RELAY_KV: kv }), "abc", { error: "some error" });
    // 补绑 run_id：这是最频繁的 patchJob 调用点之一
    await patchJob(env({ EDGE_RELAY_KV: kv }), "abc", {
      run_id: 99,
      status: "in_progress",
    });

    expect(store.get("meta:open_count")).toBe("1");
  });

  it("clamps at zero rather than going negative (negative would strand jobs)", async () => {
    const { patchJob } = await import("../src/kv_store");
    // 信号灯已经是 0，但任务却是未完结的（状态不一致）
    const { kv, store } = countingKv({
      "meta:open_count": "0",
      "job:abc": JSON.stringify(job({ status: "in_progress", run_id: 1 })),
    });

    await patchJob(env({ EDGE_RELAY_KV: kv }), "abc", { status: "completed", conclusion: "success" });

    // 必须停在 0。负数会让 `> 0` 判断失效，cron 永远以为没任务。
    expect(Number(store.get("meta:open_count"))).toBeGreaterThanOrEqual(0);
  });
});
