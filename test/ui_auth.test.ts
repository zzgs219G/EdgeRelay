import { describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import type { Env } from "../src/types";
import {
  buildSessionCookie,
  readCookie,
  SESSION_COOKIE_NAME,
  verifySessionCookie,
} from "../src/ui";

/**
 * 登录 / 会话 / 根路径行为。
 *
 * 核心回归：打开网页不能因为后端 secret 未配置而报错。
 * 这是用户实际遇到的问题（"打开网页就是 RELAY_TOKEN 未配置"）。
 */

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: "test-github-token",
    GITHUB_OWNER: "zzgs219G",
    GITHUB_REPO: "apk-protect-action",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: {} as KVNamespace,
    RELAY_TOKEN: "test-relay-token",
    RELAY_PASSWORD: "test-password",
    RATE_LIMIT_PER_MIN: "0",
    RUN_ID_WAIT_MS: "500",
    ...overrides,
  };
}

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

function req(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Request {
  return new Request(`https://edge-relay.test${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
}

// ── 会话原语 ────────────────────────────────────────────────────────

describe("session cookie", () => {
  it("round-trips: build → verify", async () => {
    const cookie = await buildSessionCookie("secret", 3600);
    expect(cookie).toMatch(/^\d+\.[0-9a-f]+$/);
    expect(await verifySessionCookie("secret", cookie)).toBe(true);
  });

  it("rejects a cookie signed with a different secret", async () => {
    const cookie = await buildSessionCookie("secret-a", 3600);
    expect(await verifySessionCookie("secret-b", cookie)).toBe(false);
  });

  it("rejects a tampered expiry", async () => {
    const cookie = await buildSessionCookie("secret", 3600);
    const [exp] = cookie.split(".");
    const tampered = `${Number(exp) + 60_000}.${cookie.split(".")[1]}`;
    expect(await verifySessionCookie("secret", tampered)).toBe(false);
  });

  it("rejects an expired cookie", async () => {
    // 手工构造一个过期但签名正确的 cookie。
    const secret = "secret";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const exp = Date.now() - 1000;
    const sigBuf = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`relay_session_v1:${exp}`),
    );
    const sig = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await verifySessionCookie(secret, `${exp}.${sig}`)).toBe(false);
  });

  it("rejects empty / malformed input", async () => {
    expect(await verifySessionCookie("secret", "")).toBe(false);
    expect(await verifySessionCookie("secret", "nodot")).toBe(false);
    expect(await verifySessionCookie("secret", ".sig")).toBe(false);
    expect(await verifySessionCookie("", "123.abc")).toBe(false);
  });

  it("reads a named cookie out of a Cookie header", () => {
    const r = req("/", {}, { cookie: `other=1; ${SESSION_COOKIE_NAME}=abc; x=2` });
    expect(readCookie(r, SESSION_COOKIE_NAME)).toBe("abc");
    expect(readCookie(r, "missing")).toBe("");
  });
});

// ── 根路径：核心回归 ────────────────────────────────────────────────

describe("GET / — 打开网页", () => {
  it("returns a login page when no session, even with secrets missing", async () => {
    // 这是用户实际遇到的问题：RELAY_TOKEN / RELAY_PASSWORD 都没配，
    // 打开网页却报 "RELAY_TOKEN 未配置"。现在必须给登录页。
    const resp = await worker.fetch(
      req("/"),
      env({ RELAY_TOKEN: "", RELAY_PASSWORD: "" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    const html = await resp.text();
    expect(html).toContain("EdgeRelay");
    expect(html).toContain("管理密码");
    // 绝不能把后端 secret 的状态泄漏到页面上当成错误
    expect(html).not.toContain("RELAY_TOKEN 未配置");
  });

  it("does not require auth to see the login page", async () => {
    const resp = await worker.fetch(req("/"), env(), {} as ExecutionContext);
    expect(resp.status).toBe(200);
  });

  it("offers ASSETS to a logged-in browser", async () => {
    const cookie = await buildSessionCookie("test-relay-token", 3600);
    const fetched: string[] = [];
    const assets = {
      fetch: async (r: Request) => {
        fetched.push(new URL(r.url).pathname);
        return new Response("<html>SPA</html>", { headers: { "content-type": "text/html" } });
      },
    } as unknown as Fetcher;

    const resp = await worker.fetch(
      req("/", {}, { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      env({ ASSETS: assets }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("SPA");
    expect(fetched).toEqual(["/"]);
  });

  it("falls back to the login page when ASSETS is unbound but session is valid", async () => {
    const cookie = await buildSessionCookie("test-relay-token", 3600);
    const resp = await worker.fetch(
      req("/", {}, { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("EdgeRelay");
  });
});

// ── 登录 / 登出 ─────────────────────────────────────────────────────

describe("POST /login", () => {
  it("sets an HttpOnly session cookie on the right password", async () => {
    const resp = await worker.fetch(
      req("/login", {
        method: "POST",
        body: new URLSearchParams({ password: "test-password" }),
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(303);
    expect(resp.headers.get("location")).toBe("/dashboard");
    const setCookie = resp.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("rejects a wrong password without setting a cookie", async () => {
    const resp = await worker.fetch(
      req("/login", {
        method: "POST",
        body: new URLSearchParams({ password: "wrong" }),
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
    expect(resp.headers.get("set-cookie")).toBeNull();
    expect(await resp.text()).toContain("密码不正确");
  });

  it("explains itself when RELAY_PASSWORD is unset", async () => {
    const resp = await worker.fetch(
      req("/login", {
        method: "POST",
        body: new URLSearchParams({ password: "anything" }),
      }),
      env({ RELAY_PASSWORD: "" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(500);
    expect(await resp.text()).toContain("RELAY_PASSWORD");
  });
});

describe("POST /logout", () => {
  it("clears the cookie and redirects", async () => {
    const resp = await worker.fetch(
      req("/logout", { method: "POST" }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(303);
    const setCookie = resp.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
  });
});

// ── /api/* 双通道鉴权 ───────────────────────────────────────────────

describe("/api/* accepts cookie or Bearer", () => {
  it("accepts a valid session cookie (browser path)", async () => {
    const store = new Map<string, string>();
    const cookie = await buildSessionCookie("test-relay-token", 3600);
    const resp = await worker.fetch(
      req("/api/jobs", {}, { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
  });

  it("accepts a Bearer token (APP path)", async () => {
    const store = new Map<string, string>();
    const resp = await worker.fetch(
      req("/api/jobs", {}, { authorization: "Bearer test-relay-token" }),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
  });

  it("rejects neither", async () => {
    const resp = await worker.fetch(
      req("/api/jobs"),
      env({ EDGE_RELAY_KV: fakeKv(new Map()) }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
  });

  it("rejects a cookie signed with the wrong secret", async () => {
    const cookie = await buildSessionCookie("some-other-token", 3600);
    const resp = await worker.fetch(
      req("/api/jobs", {}, { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      env({ EDGE_RELAY_KV: fakeKv(new Map()) }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
  });

  it("still blocks /api/build without auth", async () => {
    const resp = await worker.fetch(
      req("/api/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apk_url: "https://x/y.apk",
          workflow_file: "protect-modules.yml",
          protect_config: "{}",
        }),
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
  });
});

describe("GET /api/jobs", () => {
  it("returns jobs newest-first, skipping the health probe key", async () => {
    const store = new Map<string, string>();
    store.set("job:aaa", JSON.stringify({
      job_id: "aaa", run_id: null, workflow_file: "w.yml", workflow_name: "w",
      protect_config: "{}", dpt_extra_args: "", display_name: "",
      status: "completed", conclusion: "success", download_url: "https://d/x.apk",
      error: null, created_at_ms: 1000, updated_at_ms: 2000,
    }));
    store.set("job:bbb", JSON.stringify({
      job_id: "bbb", run_id: null, workflow_file: "w.yml", workflow_name: "w",
      protect_config: "{}", dpt_extra_args: "", display_name: "",
      status: "queued", conclusion: null, download_url: null,
      error: null, created_at_ms: 3000, updated_at_ms: 3000,
    }));
    store.set("health:probe", "123");

    const resp = await worker.fetch(
      req("/api/jobs", {}, { authorization: "Bearer test-relay-token" }),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as { jobs: { job_id: string; app_status: string }[] };
    expect(body.jobs.map((j) => j.job_id)).toEqual(["bbb", "aaa"]);
    expect(body.jobs[0].app_status).toBe("PENDING");
    expect(body.jobs[1].app_status).toBe("SUCCESS");
    expect(body.jobs.some((j) => j.job_id === "health:probe")).toBe(false);
  });

  it("clamps the limit parameter", async () => {
    const store = new Map<string, string>();
    for (let i = 0; i < 5; i++) {
      store.set(`job:${i}`, JSON.stringify({
        job_id: `j${i}`, run_id: null, workflow_file: "w.yml", workflow_name: "w",
        protect_config: "{}", dpt_extra_args: "", display_name: "",
        status: "queued", conclusion: null, download_url: null,
        error: null, created_at_ms: 1000 + i, updated_at_ms: 1000 + i,
      }));
    }
    const resp = await worker.fetch(
      req("/api/jobs?limit=99999", {}, { authorization: "Bearer test-relay-token" }),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as { jobs: unknown[] };
    expect(body.jobs.length).toBe(5);
  });
});
