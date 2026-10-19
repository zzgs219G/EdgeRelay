import { describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import { invalidateJobsCache } from "../src/jobs";
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

/**
 * 伪 ASSETS binding：记录被请求的路径，返回可辨识的响应体。
 * 用来断言"Worker 把请求交给 assets 了"，而不是自己返回 JSON 或 HTML。
 */
function assetsSpy(): { fetcher: Fetcher; seen: string[] } {
  const seen: string[] = [];
  const fetcher = {
    fetch: async (r: Request) => {
      const p = new URL(r.url).pathname;
      seen.push(p);
      return new Response(`asset:${p}`, { headers: { "content-type": "text/plain" } });
    },
  } as unknown as Fetcher;
  return { fetcher, seen };
}

// ── 会话原语 ────────────────────────────────────────────────────────

describe("session cookie", () => {
  it("round-trips: build → verify", async () => {
    const cookie = await buildSessionCookie(env(), 3600);
    expect(cookie).toMatch(/^\d+\.[0-9a-f]+$/);
    expect(await verifySessionCookie(env(), cookie)).toBe(true);
  });

  it("rejects a cookie signed with a different password", async () => {
    // 用密码 A 签，用密码 B 验 → 必须拒。这是"改密码后旧 session 全失效"的保证。
    const cookie = await buildSessionCookie(env({ RELAY_PASSWORD: "other-pw" }), 3600);
    expect(await verifySessionCookie(env(), cookie)).toBe(false);
  });

  it("rejects a tampered expiry", async () => {
    const cookie = await buildSessionCookie(env(), 3600);
    const [exp] = cookie.split(".");
    const tampered = `${Number(exp) + 60_000}.${cookie.split(".")[1]}`;
    expect(await verifySessionCookie(env(), tampered)).toBe(false);
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
    expect(await verifySessionCookie(env(), `${exp}.${sig}`)).toBe(false);
  });

  it("rejects empty / malformed input", async () => {
    expect(await verifySessionCookie(env(), "")).toBe(false);
    expect(await verifySessionCookie(env(), "nodot")).toBe(false);
    expect(await verifySessionCookie(env(), ".sig")).toBe(false);
    expect(await verifySessionCookie(env({ RELAY_PASSWORD: "" }), "123.abc")).toBe(false);
  });

  it("reads a named cookie out of a Cookie header", () => {
    const r = req("/", {}, { cookie: `other=1; ${SESSION_COOKIE_NAME}=abc; x=2` });
    expect(readCookie(r, SESSION_COOKIE_NAME)).toBe("abc");
    expect(readCookie(r, "missing")).toBe("");
  });
});

// ── 根路径：核心回归 ────────────────────────────────────────────────

describe("GET / — 打开网页", () => {
  it("hands / to the SPA, never returning an error page for missing secrets", async () => {
    // 用户实际遇到的问题：RELAY_TOKEN / RELAY_PASSWORD 都没配，打开网页
    // 却报 "RELAY_TOKEN 未配置"。现在 Worker 不返回任何 HTML——页面完全
    // 由 assets 里的 Vue 提供，与后端 secret 无关。
    const { fetcher, seen } = assetsSpy();
    const resp = await worker.fetch(
      req("/"),
      env({ ASSETS: fetcher, RELAY_TOKEN: "", RELAY_PASSWORD: "" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect(seen).toEqual(["/"]);
    const text = await resp.text();
    expect(text).not.toContain("RELAY_TOKEN 未配置");
  });

  it("does not require auth to reach the SPA", async () => {
    const { fetcher } = assetsSpy();
    const resp = await worker.fetch(req("/"), env({ ASSETS: fetcher }), {} as ExecutionContext);
    expect(resp.status).toBe(200);
  });

  it("does not gate the SPA on session state", async () => {
    // 有 cookie 与没 cookie 都该拿到同一份 index.html——登录与否由
    // vue-router 判断，Worker 不参与。
    const { fetcher, seen } = assetsSpy();
    const cookie = await buildSessionCookie(env(), 3600);
    const withCookie = await worker.fetch(
      req("/", {}, { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      env({ ASSETS: fetcher }),
      {} as ExecutionContext,
    );
    const without = await worker.fetch(
      req("/"),
      env({ ASSETS: fetcher }),
      {} as ExecutionContext,
    );
    expect(withCookie.status).toBe(200);
    expect(without.status).toBe(200);
    expect(seen).toEqual(["/", "/"]);
  });

  it("returns a diagnosable 503 when ASSETS is unbound", async () => {
    // 本地 dev 或 [assets] 配错的情况。Worker 不再伪造一个 HTML 登录页，
    // 而是明确说明静态资源没绑——比给一个"看起来能用但其实不是真前端"
    // 的页面更容易排障。
    const resp = await worker.fetch(req("/"), env(), {} as ExecutionContext);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("静态资源未绑定");
  });
});

// ── 登录 / 登出 ─────────────────────────────────────────────────────

describe("POST /login", () => {
  it("sets an HttpOnly session cookie and returns JSON on the right password", async () => {
    const resp = await worker.fetch(
      req("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test-password" }),
      }),
      env(),
      {} as ExecutionContext,
    );
    // 纯 JSON：不再 303 重定向——前端用 fetch 调它，由 vue-router 跳转。
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");
    expect((await resp.json() as { ok: boolean }).ok).toBe(true);

    const setCookie = resp.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("accepts form-urlencoded too (progressive fallback)", async () => {
    const resp = await worker.fetch(
      req("/login", {
        method: "POST",
        body: new URLSearchParams({ password: "test-password" }),
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect((await resp.json() as { ok: boolean }).ok).toBe(true);
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
    expect((await resp.json() as { error: string }).error).toContain("密码不正确");
  });

  it("logs in fine with RELAY_TOKEN unset (panel must not depend on it)", async () => {
    // 线上真实事故：RELAY_PASSWORD 配了但 RELAY_TOKEN 没配，登录 500。
    // RELAY_TOKEN 是 APP 调 /api/* 的机器令牌，与面板登录无关——
    // session cookie 的签名密钥从 RELAY_PASSWORD 派生，缺它面板照常能登。
    const resp = await worker.fetch(
      req("/login", {
        method: "POST",
        body: new URLSearchParams({ password: "test-password" }),
      }),
      env({ RELAY_TOKEN: "" }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect((await resp.json() as { ok: boolean }).ok).toBe(true);
    expect(resp.headers.get("set-cookie")).toContain(SESSION_COOKIE_NAME);
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
    expect((await resp.json() as { error: string }).error).toContain("RELAY_PASSWORD");
  });
});

describe("POST /logout", () => {
  it("clears the cookie and returns JSON", async () => {
    const resp = await worker.fetch(
      req("/logout", { method: "POST" }),
      env(),
      {} as ExecutionContext,
    );
    // 前端用 fetch 调它，所以必须是 200 + JSON，不能是 303 重定向
    // （fetch 会自动跟随 303 并拿到 HTML，导致 res.json() 失败）。
    expect(resp.status).toBe(200);
    expect((await resp.json() as { ok: boolean }).ok).toBe(true);
    expect(resp.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });
});

// ── SPA 路由与静态资源必须交给 assets ──────────────────────────────

describe("SPA routes fall through to assets", () => {
  it("serves /dashboard from assets instead of 404 JSON", async () => {
    // 线上事故：登录成功 303 到 /dashboard，Worker 没有该路由，
    // default 分支返回 {"success":false,"error":"未知路径 GET /dashboard"}
    const { fetcher, seen } = assetsSpy();
    const resp = await worker.fetch(
      req("/dashboard"),
      env({ ASSETS: fetcher }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("asset:/dashboard");
    expect(seen).toEqual(["/dashboard"]);
  });

  it("serves built JS/CSS from assets", async () => {
    // run_worker_first = true 让这些请求也先过 Worker；Worker 必须放行，
    // 否则 assets 的 SPA 兜底永不生效，页面是一片 JSON 404。
    const { fetcher, seen } = assetsSpy();
    for (const p of ["/assets/index-abc123.js", "/assets/index-abc123.css", "/favicon.svg"]) {
      const resp = await worker.fetch(
        req(p),
        env({ ASSETS: fetcher }),
        {} as ExecutionContext,
      );
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe(`asset:${p}`);
    }
    expect(seen).toEqual([
      "/assets/index-abc123.js",
      "/assets/index-abc123.css",
      "/favicon.svg",
    ]);
  });

  it("serves deep SPA routes from assets", async () => {
    const { fetcher, seen } = assetsSpy();
    const resp = await worker.fetch(
      req("/some/deep/route"),
      env({ ASSETS: fetcher }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect(seen).toEqual(["/some/deep/route"]);
  });

  it("still 404s JSON for unknown /api/ paths", async () => {
    const resp = await worker.fetch(
      req("/api/definitely-not-a-route", {}, { authorization: "Bearer test-relay-token" }),
      env({ ASSETS: assetsSpy().fetcher }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(404);
    expect((await resp.json() as { code: string }).code).toBe("not_found");
  });

  it("serves / from assets when logged in", async () => {
    const cookie = await buildSessionCookie(env(), 3600);
    const { fetcher, seen } = assetsSpy();
    const resp = await worker.fetch(
      req("/", {}, { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      env({ ASSETS: fetcher }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("asset:/");
    expect(seen).toEqual(["/"]);
  });

  it("gives the SPA at / even when not logged in", async () => {
    // 登录与否由 vue-router 判断，Worker 不再插手。这样登录页只有
    // Login.vue 一个实现，不会出现"两个不同样式的登录页"。
    const { fetcher, seen } = assetsSpy();
    const resp = await worker.fetch(
      req("/"),
      env({ ASSETS: fetcher }),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect(seen).toEqual(["/"]);
  });
});

// ── /api/* 双通道鉴权 ───────────────────────────────────────────────

describe("/api/* accepts cookie or Bearer", () => {
  it("accepts a valid session cookie (browser path)", async () => {
    const store = new Map<string, string>();
    const cookie = await buildSessionCookie(env(), 3600);
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

  it("rejects a cookie signed with a different password", async () => {
    // cookie 是用别的 RELAY_PASSWORD 签的，验不过
    const cookie = await buildSessionCookie(env({ RELAY_PASSWORD: "other-pw" }), 3600);
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
    invalidateJobsCache();
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
