import { describe, expect, it, vi } from "vitest";
import worker from "../src/router";
import type { BuildJob, Env } from "../src/shared/types";
import { invalidateConfigCache } from "../src/services/config";
import { invalidateJobsCache } from "../src/services/job_list_cache";
import { canAccessJob, tokenFingerprint, PANEL_OWNER } from "../src/services/principal";

/**
 * 任务归属与 apk_url 白名单。
 *
 * 这两项堵的是真实安全问题，而不是代码整洁问题：
 *
 * 1. 任务归属
 *    jobId 形如 `<逆序时间戳base36>-<8位随机>`，是可枚举的。没有归属校验时，
 *    任何持有 RELAY_TOKEN 的调用方只要猜/遍历 jobId，就能读到别人的任务、
 *    产物下载链接和加固配置。
 *
 * 2. apk_url 白名单
 *    apk_url 会原样传给 GitHub 流水线，由 **GitHub Runner** 去下载。
 *    只校验"是 http 链接"的话，攻击者可以让 Runner 去打内网、拉云厂商
 *    元数据地址（169.254.169.254，可窃取临时凭证），或拉超大文件烧 Actions
 *    分钟数。
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
    GITHUB_TOKEN: "test-github-token",
    GITHUB_OWNER: "zzgs219G",
    GITHUB_REPO: "apk-protect-action",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: fakeKv(),
    RELAY_TOKEN: "token-a",
    RATE_LIMIT_PER_MIN: "0",
    RUN_ID_WAIT_MS: "100",
    ...overrides,
  };
}

function req(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`https://edge-relay.test${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function job(overrides: Partial<BuildJob> = {}): BuildJob {
  return {
    job_id: "job-1",
    owner: "owner-a",
    run_id: null,
    workflow_file: "protect-modules.yml",
    workflow_name: "protect-modules.yml",
    protect_config: "{}",
    dpt_extra_args: "",
    display_name: "",
    status: "queued",
    conclusion: null,
    download_url: null,
    error: null,
    created_at_ms: Date.now(),
    updated_at_ms: Date.now(),
    ...overrides,
  };
}

const VALID_BUILD = {
  apk_url: "https://r2.example.com/apks/1_a.apk",
  workflow_file: "protect-modules.yml",
  protect_config: '{"modules":[]}',
};

describe("canAccessJob — 归属判定纯逻辑", () => {
  it("面板是管理员，能读任何任务", () => {
    const panel = { kind: "panel" as const, id: PANEL_OWNER };
    expect(canAccessJob(panel, "token:abc")).toBe(true);
    expect(canAccessJob(panel, undefined)).toBe(true);
  });

  it("令牌只能读自己的任务", () => {
    const t = { kind: "token" as const, id: "token:aaa" };
    expect(canAccessJob(t, "token:aaa")).toBe(true);
    expect(canAccessJob(t, "token:bbb")).toBe(false);
  });

  it("无 owner 的历史任务对已认证主体可见（避免升级瞬间在途任务失联）", () => {
    const t = { kind: "token" as const, id: "token:aaa" };
    expect(canAccessJob(t, undefined)).toBe(true);
  });

  it("令牌指纹稳定且不含原文", async () => {
    const a = await tokenFingerprint("secret-token");
    const b = await tokenFingerprint("secret-token");
    const c = await tokenFingerprint("other-token");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // 指纹绝不能把令牌原文带出来——它会进 KV 记录与日志
    expect(a).not.toContain("secret-token");
    expect(a.startsWith("token:")).toBe(true);
  });
});

describe("任务归属 — HTTP 层隔离", () => {
  it("令牌读不到别的令牌创建的任务（按 404 处理，不泄漏存在性）", async () => {
    const store = new Map<string, string>();
    store.set("job:job-1", JSON.stringify(job({ owner: "token:someone-else" })));

    const resp = await worker.fetch(
      req("/api/status/job-1", "token-a"),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(404);
    // 关键：错误信息不能暴露"任务存在但不属于你"
    const body = (await resp.json()) as { code: string; error: string };
    expect(body.code).toBe("not_found");
    expect(body.error).toContain("不存在或已过期");
  });

  it("令牌能读自己创建的任务", async () => {
    const store = new Map<string, string>();
    const owner = await tokenFingerprint("token-a");
    store.set("job:job-1", JSON.stringify(job({ owner, status: "completed", conclusion: "success" })));

    const resp = await worker.fetch(
      req("/api/status/job-1", "token-a"),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { job_id: string; app_status: string };
    expect(body.job_id).toBe("job-1");
    expect(body.app_status).toBe("SUCCESS");
  });

  it("创建任务时写入 owner", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    });

    const resp = await worker.fetch(
      req("/api/build", "token-a", { method: "POST", body: JSON.stringify(VALID_BUILD) }),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as { job_id: string };
    const saved = JSON.parse(store.get(`job:${body.job_id}`)!) as BuildJob;

    expect(saved.owner).toBe(await tokenFingerprint("token-a"));
    vi.unstubAllGlobals();
  });

  it("日志与产物代理同样校验归属", async () => {
    const store = new Map<string, string>();
    store.set("job:job-1", JSON.stringify(job({ owner: "token:someone-else", run_id: 1 })));

    for (const path of ["/api/log/job-1", "/api/artifact/job-1", "/api/status/job-1/steps"]) {
      const resp = await worker.fetch(
        req(path, "token-a"),
        env({ EDGE_RELAY_KV: fakeKv(store) }),
        {} as ExecutionContext,
      );
      expect(resp.status, path).toBe(404);
    }
  });

  it("/api/jobs 只返回自己的任务", async () => {
    invalidateConfigCache();
    invalidateJobsCache();
    const mine = await tokenFingerprint("token-a");
    const store = new Map<string, string>();
    store.set("job:job-a", JSON.stringify(job({ job_id: "job-a", owner: mine })));
    store.set("job:job-b", JSON.stringify(job({ job_id: "job-b", owner: "token:other" })));
    store.set("meta:job_ids", JSON.stringify(["job-a", "job-b"]));

    const resp = await worker.fetch(
      req("/api/jobs", "token-a"),
      env({ EDGE_RELAY_KV: fakeKv(store) }),
      {} as ExecutionContext,
    );
    const body = (await resp.json()) as { jobs: { job_id: string }[] };

    expect(body.jobs.map((j) => j.job_id)).toEqual(["job-a"]);
  });
});

describe("apk_url 白名单 — 防 SSRF", () => {
  function buildErr(apkUrl: string, overrides: Partial<Env> = {}) {
    return worker.fetch(
      req("/api/build", "token-a", {
        method: "POST",
        body: JSON.stringify({ ...VALID_BUILD, apk_url: apkUrl }),
      }),
      env(overrides),
      {} as ExecutionContext,
    );
  }

  it("配置了 R2_PUBLIC_DOMAIN 时，只接受该域名", async () => {
    const e = { R2_PUBLIC_DOMAIN: "https://r2.614118.xyz" };
    const ok = await buildErr("https://r2.614118.xyz/apks/1.apk", e);
    // 200 说明过了校验（dispatch 被桩打回但那是后续逻辑，不是 400）
    expect(ok.status).not.toBe(400);

    const bad = await buildErr("https://evil.example.com/apks/1.apk", e);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("域名必须是");
  });

  it("未配 R2_PUBLIC_DOMAIN 时，拒绝私网与元数据地址", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.1/x.apk",
      "https://192.168.1.1/x.apk",
      "https://172.16.0.1/x.apk",
      "https://127.0.0.1/x.apk",
      "https://localhost/x.apk",
      "https://foo.internal/x.apk",
    ]) {
      const resp = await buildErr(url);
      expect(resp.status, url).toBe(400);
    }
  });

  it("拒绝 http 明文（APK 走明文不可接受）", async () => {
    const resp = await buildErr("http://r2.example.com/apks/1.apk");
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toContain("https");
  });

  it("允许公网 https 地址（未配域名时的弱校验放行）", async () => {
    const resp = await buildErr("https://cdn.example.com/apks/1.apk");
    expect(resp.status).not.toBe(400);
  });
});
