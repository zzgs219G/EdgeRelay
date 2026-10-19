import { describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import type { BuildJob, Env } from "../src/types";

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
    BUILD_JOBS: {} as KVNamespace,
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
    const resp = await worker.fetch(
      new Request("https://edge-relay.test/health"),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
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
      env({ BUILD_JOBS: fakeKv(store) }),
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
      env({ BUILD_JOBS: fakeKv(store), RUN_ID_WAIT_MS: "2000" }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { success: boolean; job_id: string; run_id: number };
    expect(body.success).toBe(true);
    expect(body.run_id).toBe(987654);

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
      env({ BUILD_JOBS: fakeKv(store) }),
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
      env({ BUILD_JOBS: fakeKv(store), RUN_ID_WAIT_MS: "800" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { run_id: number | null; status: string };
    expect(body.run_id).toBeNull();
    expect(body.status).toBe("queued");
  });

  it("marks the job failed when dispatch is rejected", async () => {
    const store = new Map<string, string>();
    stubGitHub(() => new Response("bad input", { status: 422 }));

    const resp = await worker.fetch(
      authedReq("/api/build", { method: "POST", body: JSON.stringify(VALID_BODY) }),
      env({ BUILD_JOBS: fakeKv(store) }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(502);
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
    const e = env({ BUILD_JOBS: fakeKv(store), RATE_LIMIT_PER_MIN: "2" });

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
