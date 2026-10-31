import { describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import type { BuildJob, Env } from "../src/shared/types";

/**
 * POST /api/build 的异步化（P2）。
 *
 * 旧实现 dispatch 之后**同步**等 run_id，最多挂 RUN_ID_WAIT_MS（默认 4s）：
 *   - 请求最长 4 秒，Worker 有墙钟上限，高并发时容易攒住连接；
 *   - 这 4 秒对调用方毫无价值——APP 拿到 job_id 就该走了，状态靠轮询。
 *
 * 新实现：dispatch 成功后立刻返回 queued，探测丢给 ctx.waitUntil。
 * run_id 由三条路径兜底，APP 无需区别对待：
 *   1. 后台 waitUntil 探测
 *   2. routes/status.ts 的「读缺失即回查」
 *   3. services/reconcile.ts 的 cron 补绑
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
    ...overrides,
  };
}

const BODY = {
  apk_url: "https://r2.example.com/apks/1.apk",
  workflow_file: "protect-modules.yml",
  protect_config: '{"modules":[]}',
};

function buildReq(): Request {
  return new Request("https://x.test/api/build", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(BODY),
  });
}

/** 记录 waitUntil 收到的 Promise，便于断言"后台确实被排队了"。 */
function ctxCapture() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    pending,
  };
}

describe("build 异步化 — 立即返回", () => {
  it("不等 run_id，dispatch 成功即返回 queued", async () => {
    // runs 接口故意慢 3000ms。若还是同步等待，响应必然 >3s。
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      if (url.includes("/runs")) {
        await new Promise((r) => setTimeout(r, 3000));
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const { ctx, pending } = ctxCapture();
    const started = Date.now();
    const resp = await worker.fetch(
      buildReq(),
      env({ RUN_ID_WAIT_MS: "4000" }),
      ctx,
    );
    const elapsed = Date.now() - started;

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string; job_id: string };
    expect(body.status).toBe("queued");
    // 关键断言：远小于 3000ms 的 runs RTT
    expect(elapsed).toBeLessThan(1500);
    // 后台探测确实被排进 waitUntil，而不是被丢弃
    expect(pending.length).toBe(1);

    vi.unstubAllGlobals();
  });

  it("后台探测成功后把 run_id 写回 KV", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      if (url.includes("/runs")) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 555,
                status: "in_progress",
                event: "workflow_dispatch",
                created_at: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const { ctx, pending } = ctxCapture();
    const resp = await worker.fetch(
      buildReq(),
      env({ EDGE_RELAY_KV: fakeKv(store), RUN_ID_WAIT_MS: "1000" }),
      ctx,
    );
    const body = (await resp.json()) as { job_id: string };

    // 等后台任务跑完（真实环境由 Cloudflare 在响应后继续执行）
    await Promise.all(pending);

    const saved = JSON.parse(store.get(`job:${body.job_id}`)!) as BuildJob;
    expect(saved.run_id).toBe(555);
    expect(saved.status).toBe("in_progress");

    vi.unstubAllGlobals();
  });

  it("没有 waitUntil 时不启动后台任务（避免污染后续请求）", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      if (url.includes("/runs")) {
        // 若后台任务被错误启动，这个计数器会 > 0
        probes++;
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    let probes = 0;

    const resp = await worker.fetch(buildReq(), env(), {} as ExecutionContext);
    expect(resp.status).toBe(200);
    // 给可能的游离 Promise 一点时间暴露自己
    await new Promise((r) => setTimeout(r, 50));
    expect(probes).toBe(0);

    vi.unstubAllGlobals();
  });
});
