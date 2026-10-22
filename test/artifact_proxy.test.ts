import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import type { BuildJob, Env } from "../src/shared/types";
import { invalidateConfigCache } from "../src/services/config";
import { invalidateJobsCache } from "../src/services/job_list_cache";

/**
 * GET /api/artifact/:jobId — 产物下载代理。
 *
 * 线上故障：面板点「下载产物」直接跳 download_url。当那是 GitHub artifact
 * 链接时，`<a>` 标签的请求**不带 Authorization 头**，GitHub 按未认证计费
 * （60 次/小时/IP），用户看到：
 *   {"message":"API rate limit exceeded for <IP>. (But here's the good
 *    news: Authenticated requests get a higher rate limit...)"}
 *
 * 网关明明持有令牌，却因为交给浏览器直连而彻底拿不到。修法与日志下载同构：
 * 网关带令牌取回，再转发给已鉴权的调用方。
 */

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    kv: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async list(o: { prefix?: string; limit?: number } = {}) {
        const keys = [...store.keys()]
          .filter((k) => k.startsWith(o.prefix ?? ""))
          .slice(0, o.limit ?? 1000)
          .map((name) => ({ name }));
        return { keys, list_complete: true, cursor: "" };
      },
    } as unknown as KVNamespace,
  };
}

function job(over: Partial<BuildJob> = {}): BuildJob {
  return {
    job_id: "abc",
    run_id: 7,
    workflow_file: "protect-modules.yml",
    workflow_name: "w",
    protect_config: "{}",
    dpt_extra_args: "",
    display_name: "",
    status: "completed",
    conclusion: "success",
    download_url: "https://api.github.com/repos/o/r/actions/artifacts/99/zip",
    error: null,
    created_at_ms: 1000,
    updated_at_ms: 2000,
    ...over,
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: "test-github-token",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: fakeKv().kv,
    RELAY_TOKEN: "test-relay-token",
    RELAY_PASSWORD: "test-password",
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

const AUTH = { authorization: "Bearer test-relay-token" };

afterEach(() => {
  invalidateConfigCache();
  invalidateJobsCache();
  vi.unstubAllGlobals();
});

describe("GET /api/artifact/:jobId — proxy instead of a doomed direct link", () => {
  it("fetches with the gateway token and streams the zip back", async () => {
    const { kv } = fakeKv({ "job:abc": JSON.stringify(job()) });
    let sentAuth: string | null = null;

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        // 列表请求：以 /artifacts 结尾（无 id）;下载请求：/artifacts/<id>/zip
        if (url.includes("/actions/runs/7/artifacts")) {
          return new Response(
            JSON.stringify({
              artifacts: [
                { name: "构建日志-build.log", expired: false },
                {
                  name: "signed.zip",
                  archive_download_url: "https://api.github.com/artifacts/99/zip",
                  expired: false,
                  size_in_bytes: 1234,
                },
              ],
            }),
            { status: 200 },
          );
        }
        // 实际取回 zip 的那一跳
        sentAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
        return new Response("ZIPDATA", { status: 200 });
      },
    );

    const resp = await worker.fetch(
      req("/api/artifact/abc", {}, AUTH),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ZIPDATA");
    // 关键：网关带了令牌，而不是让浏览器裸奔
    expect(sentAuth).toBe("Bearer test-github-token");
  });

  it("requires auth — it must not become a public download endpoint", async () => {
    const { kv } = fakeKv({ "job:abc": JSON.stringify(job()) });

    const resp = await worker.fetch(
      req("/api/artifact/abc"),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(401);
  });

  it("404s for an unknown job", async () => {
    const { kv } = fakeKv();
    const resp = await worker.fetch(
      req("/api/artifact/nope", {}, AUTH),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
  });

  it("409s when the job has no run_id yet", async () => {
    const { kv } = fakeKv({ "job:abc": JSON.stringify(job({ run_id: null })) });
    const resp = await worker.fetch(
      req("/api/artifact/abc", {}, AUTH),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(409);
  });

  it("rejects an oversized artifact rather than proxying it", async () => {
    const { kv } = fakeKv({ "job:abc": JSON.stringify(job()) });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/artifacts")) {
        return new Response(
          JSON.stringify({
            artifacts: [
              {
                name: "huge.zip",
                archive_download_url: "https://api.github.com/artifacts/1/zip",
                expired: false,
                size_in_bytes: 2 * 1024 * 1024 * 1024,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("x", { status: 200 });
    });

    const resp = await worker.fetch(
      req("/api/artifact/abc", {}, AUTH),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(413);
  });

  it("lists what is available when no product artifact exists", async () => {
    const { kv } = fakeKv({ "job:abc": JSON.stringify(job()) });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/artifacts")) {
        return new Response(
          JSON.stringify({
            artifacts: [{ name: "构建日志-build.log", expired: false }],
          }),
          { status: 200 },
        );
      }
      return new Response("x", { status: 200 });
    });

    const resp = await worker.fetch(
      req("/api/artifact/abc", {}, AUTH),
      env({ EDGE_RELAY_KV: kv }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string };
    // 让人知道现在有什么，而不是干巴巴一个 404
    expect(body.error).toContain("构建日志-build.log");
  });
});
