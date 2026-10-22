/**
 * run 查询：状态快照、最近 run 列表、job/step 明细。
 */

import type { Env } from "../../shared/types";
import { ghFetch, repoPath } from "./client";

interface GhRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_number: number;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  head_sha: string;
  event: string;
  path: string;
}

export interface RunSnapshot {
  run_id: number;
  status: string;
  conclusion: string | null;
  name: string;
  /** run 的创建时刻。绑定 run_id 时必须用它，不能用 updated_at。 */
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
}

function toSnapshot(r: GhRun): RunSnapshot {
  return {
    run_id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    name: r.name,
    created_at: r.created_at,
    run_started_at: r.run_started_at,
    updated_at: r.updated_at,
  };
}

/**
 * 列出某个 workflow 最近的 run，只保留「在本任务创建之后才创建的」。
 *
 * @param sinceMs 任务创建时刻（毫秒）。只返回 created_at 晚于它（留 90s
 *   时钟容差）的 run。
 *
 * 为什么必须用 created_at 而不是 updated_at（这里踩过坑）：
 *   updated_at 对正在运行的 run 会持续刷新。一个 20 分钟前创建、仍在
 *   跑的老 run，其 updated_at 是「几秒前」，于是被误判成「刚触发的
 *   run」而绑到新任务上——新任务从此一直显示那个老 run 的状态。
 */
export async function listRecentRuns(
  env: Env,
  workflowFile: string,
  sinceMs: number,
): Promise<RunSnapshot[]> {
  const resp = await ghFetch(
    env,
    repoPath(env, `/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=10`),
  );
  const data = (await resp.json()) as { workflow_runs?: GhRun[] };
  return (data.workflow_runs ?? [])
    .filter((r) => r.event === "workflow_dispatch")
    .map(toSnapshot)
    .filter((r) => {
      // created_at 缺失 / 不可解析时保守放行（宁可多一个候选，也别把
      // 真正的新 run 滤掉）。
      //
      // 注意不能写成 `Date.parse(r.created_at || "0")`——Date.parse("0")
      // 返回的是 2000-01-01（946656000000），不是 NaN，于是"缺字段"会
      // 被误判成"2000 年创建"，把所有 run 都滤掉。
      if (!r.created_at) return true;
      const created = Date.parse(r.created_at);
      if (!Number.isFinite(created)) return true;
      return created >= sinceMs - 90_000;
    })
    // 新的在前：run_id 单调递增，与 created_at 同序
    .sort((a, b) => b.run_id - a.run_id);
}

/** 查询单个 run 的当前状态。 */
export async function getRun(env: Env, runId: number): Promise<RunSnapshot> {
  const resp = await ghFetch(env, repoPath(env, `/actions/runs/${runId}`));
  return toSnapshot((await resp.json()) as GhRun);
}

export interface StepInfo {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface JobInfo {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: StepInfo[];
}

/**
 * 拉取某个 run 的 job / step 级明细。
 *
 * 与 jian_box TaskViewModel.fetchJobsForRun 等价，只是搬进网关——
 * 这条链路同样需要 Token 且暴露仓库路径。
 */
export async function getRunSteps(
  env: Env,
  runId: number,
): Promise<{ run_started_at: string | null; updated_at: string; jobs: JobInfo[] }> {
  // run 本体与 jobs 并行拉，省一个 RTT。
  const [runResp, jobsResp] = await Promise.all([
    ghFetch(env, repoPath(env, `/actions/runs/${runId}`)),
    ghFetch(env, repoPath(env, `/actions/runs/${runId}/jobs?per_page=20`)),
  ]);

  const run = (await runResp.json()) as GhRun;
  const jobsData = (await jobsResp.json()) as {
    jobs?: {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      started_at: string | null;
      completed_at: string | null;
      steps?: {
        name: string;
        status: string;
        conclusion: string | null;
        number: number;
        started_at: string | null;
        completed_at: string | null;
      }[];
    }[];
  };

  const jobs: JobInfo[] = (jobsData.jobs ?? []).map((j) => ({
    id: j.id,
    name: j.name || "未命名 Job",
    status: j.status,
    conclusion: j.conclusion ?? null,
    started_at: j.started_at ?? null,
    completed_at: j.completed_at ?? null,
    // GitHub 偶尔不给 number，用索引兜底（与旧 APP 行为一致）
    steps: (j.steps ?? []).map((s, idx) => ({
      name: s.name || "未命名步骤",
      status: s.status,
      conclusion: s.conclusion ?? null,
      number: s.number > 0 ? s.number : idx + 1,
      started_at: s.started_at ?? null,
      completed_at: s.completed_at ?? null,
    })),
  }));

  return {
    run_started_at: run.run_started_at,
    updated_at: run.updated_at,
    jobs,
  };
}
