import { describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import type { BuildJob, Env } from "../src/shared/types";

/**
 * 用 vi.stubGlobal 拦掉 fetch，模拟 GitHub REST API。
 * 这样无需真实 token 就能验证「dispatch → 等 run_id → 落库」链路。
 */
function stubGitHub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  });
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: "test-github-token",
    GITHUB_OWNER: "zzgs219G",
    GITHUB_REPO: "apk-protect-action",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: {} as KVNamespace,
    RELAY_TOKEN: "test-relay-token",
    RATE_LIMIT_PER_MIN: "0",
    RUN_ID_WAIT_MS: "1500",
    ...overrides,
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

const VALID_BODY = {
  apk_url: "https://r2.example.com/apks/123_test.apk",
  workflow_file: "protect-modules.yml",
  protect_config: '{"modules":[]}',
  display_name: "简盒·v1.2.3",
};

describe("EdgeRelay — auth", () => {
  it("rejects requests without a bearer token", async () => {
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/api/workflows"),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("unauthorized");
  });

  it("rejects a wrong bearer token", async () => {
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/api/workflows", {
        headers: { authorization: "Bearer nope" },
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
  });

  it("lets OPTIONS preflight through without a token", async () => {
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/api/build", { method: "OPTIONS" }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves /health without a token", async () => {
    // 这里只验证"无需令牌即可访问"，不关心健康状态（可能是 200 或 503，
    // 取决于 KV 是否可用）。要断言健康状态看下面的 /health 用例组。
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/health"),
      env(),
      {} as ExecutionContext,
    );
    expect([200, 503]).toContain(resp.status);
    expect((await resp.json() as { ok: unknown }).ok).toBeDefined();
  });

  it("returns 500 when RELAY_TOKEN is not configured", async () => {
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/api/workflows"),
      env({ RELAY_TOKEN: "" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(500);
  });
});

describe("EdgeRelay — validation", () => {
  it("rejects a non-JSON body", async () => {
    const resp = await worker.fetch(
      authedReq("/api/build", { method: "POST", body: "not-json" }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("rejects an http apk_url", async () => {
    const resp = await worker.fetch(
      authedReq("/api/build", {
        method: "POST",
        body: JSON.stringify({ ...VALID_BODY, apk_url: "ftp://x/y.apk" }),
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("http(s)");
  });

  it("rejects a path-carrying workflow_file", async () => {
    const resp = await worker.fetch(
      authedReq("/api/build", {
        method: "POST",
        body: JSON.stringify({ ...VALID_BODY, workflow_file: "../../evil.yml" }),
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
    expect((await resp.json() as { error: string }).error).toContain("workflow_file");
  });

  it("rejects a non-JSON protect_config", async () => {
    const resp = await worker.fetch(
      authedReq("/api/build", {
        method: "POST",
        body: JSON.stringify({ ...VALID_BODY, protect_config: "{oops" }),
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
    expect((await resp.json() as { error: string }).error).toContain("protect_config");
  });

  it("rejects an oversized protect_config", async () => {
    const resp = await worker.fetch(
      authedReq("/api/build", {
        method: "POST",
        body: JSON.stringify({ ...VALID_BODY, protect_config: `{"x":"${"a".repeat(70_000)}"}` }),
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });
});

describe("EdgeRelay — routing", () => {
  it("404s unknown paths", async () => {
    const resp = await worker.fetch(
      authedReq("/api/nope"),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
    expect((await resp.json() as { code: string }).code).toBe("not_found");
  });

  it("400s a status query with an empty jobId", async () => {
    const resp = await worker.fetch(
      authedReq("/api/status/"),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });
});

describe("EdgeRelay — status of an unknown job", () => {
  it("returns 404 not_found", async () => {
    const store = new Map<string, string>();
    stubGitHub(() => new Response("{}", { status: 200 }));
    const resp = await worker.fetch(
      authedReq("/api/status/does-not-exist"),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
    expect((await resp.json() as { code: string }).code).toBe("not_found");
  });
});

describe("EdgeRelay — build happy path", () => {
  it("dispatches, binds run_id, and stores the job", async () => {
    const store = new Map<string, string>();
    const seen: string[] = [];

    stubGitHub((url, init) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/dispatches")) {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/actions/workflows/protect-modules.yml/runs")) {
        return Response.json({
          workflow_runs: [
            {
              id: 987654,
              name: "APK加固-模块勾选",
              status: "in_progress",
              conclusion: null,
              event: "workflow_dispatch",
              updated_at: new Date().toISOString(),
              run_started_at: new Date().toISOString(),
            },
          ],
        });
      }
      return new Response("{}", { status: 200 });
    });

    const resp = await worker.fetch(
      authedReq("/api/build", { method: "POST", body: JSON.stringify(VALID_BODY) }),
      // BUILD_SYNC_RUN_ID=1：本用例断言"落库后 run_id 已绑定"，
      // 需要同步等待的旧行为。默认（异步）路径见下面的"returns queued
      // immediately"用例。
      env({ EDGE_RELAY_KV: fakeKv(store), RUN_ID_WAIT_MS: "2000", BUILD_SYNC_RUN_ID: "1" }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      success: boolean;
      job_id: string;
      run_id?: number;
    };
    expect(body.success).toBe(true);
    // run_id 刻意不下发：APP 只需要 job_id，run_id 属于 GitHub 侧信息，
    // 出现在响应里就等于暴露给客户端。内部仍会绑定（下面从 KV 断言）。
    expect(body.run_id).toBeUndefined();

    // dispatch 必须带上 apk_url + protect_config，且打到正确的 workflow。
    const dispatch = seen.find((s) => s.includes("/dispatches"));
    expect(dispatch).toBeDefined();
    expect(dispatch).toContain("protect-modules.yml");

    // job 已落库且 run_id 绑定成功。
    const stored = JSON.parse(store.get(`job:${body.job_id}`)!) as BuildJob;
    expect(stored.run_id).toBe(987654);
    expect(stored.status).toBe("in_progress");
    expect(stored.display_name).toBe("简盒·v1.2.3");
  });

  it("never sends the GitHub token back to the client", async () => {
    const store = new Map<string, string>();
    stubGitHub(() => new Response(null, { status: 204 }));
    const resp = await worker.fetch(
      authedReq("/api/build", { method: "POST", body: JSON.stringify(VALID_BODY) }),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    const text = await resp.text();
    expect(text).not.toContain("test-github-token");
    expect(text).not.toContain("zzgs219G");
  });

  it("falls back to queued when GitHub never lists the run", async () => {
    const store = new Map<string, string>();
    stubGitHub((url) => {
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      if (url.includes("/runs")) return Response.json({ workflow_runs: [] });
      return new Response("{}", { status: 200 });
    });

    const resp = await worker.fetch(
      authedReq("/api/build", { method: "POST", body: JSON.stringify(VALID_BODY) }),
      env({ EDGE_RELAY_KV: fakeKv(store), RUN_ID_WAIT_MS: "800" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { run_id?: number; status: string };
    // 同样不下发 run_id；状态仍能正确表达"还没绑上"
    expect(body.run_id).toBeUndefined();
    expect(body.status).toBe("queued");
  });

  it("marks the job failed when dispatch is rejected", async () => {
    const store = new Map<string, string>();
    stubGitHub(() => new Response("bad input", { status: 422 }));

    const resp = await worker.fetch(
      authedReq("/api/build", { method: "POST", body: JSON.stringify(VALID_BODY) }),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    // 200 而非 502：dispatch 失败是业务失败（参数/权限/仓库），不是网关
    // 故障。用 5xx 会诱导客户端重试整条请求，放大问题。
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("参数不匹配");

    const [, job] = [...store.entries()][0];
    expect((JSON.parse(job) as BuildJob).status).toBe("completed");
    expect((JSON.parse(job) as BuildJob).conclusion).toBe("failure");
  });
});

describe("EdgeRelay — rate limit", () => {
  it("returns 429 once the bucket is drained", async () => {
    const store = new Map<string, string>();
    stubGitHub(() => new Response("{}", { status: 200 }));
    const e = env({ EDGE_RELAY_KV: fakeKv(store), RATE_LIMIT_PER_MIN: "2" });

    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const resp = await worker.fetch(
        authedReq("/api/workflows"),
        e,
        {} as ExecutionContext,
      );
      codes.push(resp.status);
    }
    expect(codes.slice(0, 2)).toEqual([200, 200]);
    expect(codes[2]).toBe(429);
    expect(codes[3]).toBe(429);
  });
});

describe("EdgeRelay — /health", () => {
  it("returns 503 and names the problem when KV is unbound", async () => {
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/health"),
      env({ EDGE_RELAY_KV: undefined as unknown as KVNamespace }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { ok: boolean; kv: string; problems: string[] };
    expect(body.ok).toBe(false);
    expect(body.kv).toBe("error");
    expect(body.problems.join(" ")).toContain("EDGE_RELAY_KV");
  });

  it("returns 200 when KV round-trips and secrets are present", async () => {
    const store = new Map<string, string>();
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/health"),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; kv: string; problems: string[] };
    expect(body.ok).toBe(true);
    expect(body.kv).toBe("ok");
    expect(body.problems).toEqual([]);
    // 探针键必须真的写进去了，否则 kv:ok 是假的。
    expect([...store.keys()].some((k) => k.startsWith("health:probe"))).toBe(true);
  });

  it("is 200-degraded when KV works but a build secret is missing", async () => {
    // 判断标准是「面板与接口能不能用」，不是「所有 secret 都配了」。
    // KV 正常 → 面板可用 → 200；缺 GITHUB_TOKEN 只让构建不可用，
    // 通过 warnings 告知，不该渲染成整站故障。
    const store = new Map<string, string>();
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/health"),
      env({ EDGE_RELAY_KV: fakeKv(store), GITHUB_TOKEN: "" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      missing: string[];
      warnings: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.missing).toContain("GITHUB_TOKEN");
    expect(body.warnings.join(" ")).toContain("构建接口不可用");
  });

  it("is 200-degraded when only RELAY_TOKEN is missing", async () => {
    // 真实体验问题：RELAY_TOKEN 只影响 APP，面板用 session cookie。
    // 之前把它列为必填，导致前台永远显示"后端未就绪"。
    const store = new Map<string, string>();
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/health"),
      env({ EDGE_RELAY_KV: fakeKv(store), RELAY_TOKEN: "" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      missing: string[];
      warnings: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.missing).not.toContain("RELAY_TOKEN");
    expect(body.warnings.join(" ")).toContain("RELAY_TOKEN");
  });
});

// ── 最小 KV 假实现（内存 Map + list） ────────────────────────────────

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
