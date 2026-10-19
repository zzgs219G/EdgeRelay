import { vi } from "vitest";
import { describe, expect, it } from "vitest";
import { listRecentRuns, listWorkflows } from "../src/github";
import { newJobId } from "../src/kv_store";
import type { Env } from "../src/types";

/**
 * 自查发现的 bug 的回归测试。
 *
 * 每个用例对应一个真实缺陷，注释里写明「为什么原来的写法是错的」，
 * 避免将来有人"优化"回去。
 */

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: "t",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: {} as KVNamespace,
    RELAY_TOKEN: "rt",
    RELAY_PASSWORD: "pw",
    ...overrides,
  };
}

function stubGitHub(runs: unknown[]): void {
  vi.stubGlobal("fetch", async () =>
    Response.json({ workflow_runs: runs }),
  );
}

describe("listRecentRuns — 用 created_at 而非 updated_at 过滤", () => {
  it("excludes an old run that is still updating", async () => {
    // 真实场景：一个 20 分钟前创建、仍在运行的 run，其 updated_at 是
    // "几秒前"。若按 updated_at 过滤，它会被当成"刚触发的 run"而绑到
    // 新任务上——新任务从此一直显示那个老 run 的状态。
    const now = Date.now();
    stubGitHub([
      {
        id: 900,
        name: "old",
        status: "in_progress",
        conclusion: null,
        event: "workflow_dispatch",
        created_at: new Date(now - 20 * 60_000).toISOString(), // 20 分钟前创建
        updated_at: new Date(now - 5_000).toISOString(), // 但 5 秒前刚更新
        run_started_at: new Date(now - 20 * 60_000).toISOString(),
      },
      {
        id: 901,
        name: "new",
        status: "queued",
        conclusion: null,
        event: "workflow_dispatch",
        created_at: new Date(now - 500).toISOString(),
        updated_at: new Date(now - 400).toISOString(),
        run_started_at: null,
      },
    ]);

    // sinceMs = 1 秒前触发的新任务
    const runs = await listRecentRuns(env(), "w.yml", now - 1_000);
    expect(runs.map((r) => r.run_id)).toEqual([901]);
  });

  it("does not drop runs when created_at is missing", async () => {
    // 曾经的写法：Date.parse(r.created_at || "0")
    // Date.parse("0") 返回 2000-01-01（946656000000），不是 NaN。
    // 于是"缺字段"被判成"2000 年创建"，所有 run 都被滤掉。
    const now = Date.now();
    stubGitHub([
      {
        id: 902,
        name: "no-created-at",
        status: "queued",
        conclusion: null,
        event: "workflow_dispatch",
        // created_at 故意缺失
        updated_at: new Date(now).toISOString(),
        run_started_at: null,
      },
    ]);
    const runs = await listRecentRuns(env(), "w.yml", now - 1_000);
    expect(runs.map((r) => r.run_id)).toEqual([902]);
  });

  it("keeps only workflow_dispatch runs", async () => {
    const now = Date.now();
    stubGitHub([
      {
        id: 903,
        name: "push-triggered",
        status: "completed",
        conclusion: "success",
        event: "push",
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        run_started_at: new Date(now).toISOString(),
      },
    ]);
    const runs = await listRecentRuns(env(), "w.yml", now - 1_000);
    expect(runs).toEqual([]);
  });

  it("returns newest first", async () => {
    const now = Date.now();
    stubGitHub([
      {
        id: 905,
        name: "b",
        status: "queued",
        conclusion: null,
        event: "workflow_dispatch",
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        run_started_at: null,
      },
      {
        id: 904,
        name: "a",
        status: "queued",
        conclusion: null,
        event: "workflow_dispatch",
        created_at: new Date(now - 100).toISOString(),
        updated_at: new Date(now - 100).toISOString(),
        run_started_at: null,
      },
    ]);
    const runs = await listRecentRuns(env(), "w.yml", now - 1_000);
    expect(runs.map((r) => r.run_id)).toEqual([905, 904]);
  });
});

describe("newJobId — 时间前缀让 KV 字典序等于时间序", () => {
  it("sorts newer jobs first as plain strings", () => {
    // KV 的 list() 按 key 字典序返回。job_id 若用随机 UUID，字典序与
    // 创建时间无关——任务超过 limit 条后，取到的是"字典序最小的 N 个"
    // 而非"最新的 N 个"，新任务可能永远不显示。
    const older = newJobId(1_700_000_000_000);
    const newer = newJobId(1_700_000_001_000);

    // 逆序前缀：更新的 job_id 字符串更小，因此排在前面
    expect(newer < older).toBe(true);
  });

  it("is unique even within the same millisecond", () => {
    const ts = 1_700_000_000_000;
    const ids = new Set(Array.from({ length: 200 }, () => newJobId(ts)));
    expect(ids.size).toBe(200);
  });

  it("stays opaque — no repo or timing info leaked beyond ordering", () => {
    const id = newJobId(1_700_000_000_000);
    expect(id).toMatch(/^[0-9a-z]{11}-[0-9a-f]{8}$/);
  });
});

describe("listWorkflows — 只返回构建流水线", () => {
  function stubWorkflows(list: unknown[]): void {
    vi.stubGlobal("fetch", async () => Response.json({ workflows: list }));
  }

  const wf = (path: string, state = "active") => ({
    id: 1,
    name: path,
    path,
    state,
  });

  it("keeps protect-* workflows", async () => {
    stubWorkflows([
      wf(".github/workflows/protect-modules.yml"),
      wf(".github/workflows/protect-dex.yml"),
    ]);
    const result = await listWorkflows(env());
    expect(result.map((w) => w.file_name)).toEqual([
      "protect-modules.yml",
      "protect-dex.yml",
    ]);
  });

  it("excludes helper workflows such as notify-json-mirror.yml", async () => {
    // 真实问题：notify-json-mirror.yml 是为 schema 镜像加的辅助 workflow，
    // 它没有 apk_url 输入、不是加固流水线。不过滤的话 APP 新建任务页
    // 会多出一个选了就报错的选项。
    stubWorkflows([
      wf(".github/workflows/protect-modules.yml"),
      wf(".github/workflows/notify-json-mirror.yml"),
    ]);
    const result = await listWorkflows(env());
    expect(result.map((w) => w.file_name)).toEqual(["protect-modules.yml"]);
  });

  it("still excludes inactive workflows", async () => {
    stubWorkflows([
      wf(".github/workflows/protect-modules.yml", "disabled_manually"),
      wf(".github/workflows/protect-other.yml"),
    ]);
    const result = await listWorkflows(env());
    expect(result.map((w) => w.file_name)).toEqual(["protect-other.yml"]);
  });

  it("returns empty when nothing matches the prefix", async () => {
    stubWorkflows([wf(".github/workflows/build.yml")]);
    const result = await listWorkflows(env());
    expect(result).toEqual([]);
  });
});
