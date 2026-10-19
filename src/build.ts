/**
 * POST /api/build — 触发一次加固构建。
 *
 * 关键设计：dispatch 之后同步等 run_id 出现再返回。
 *
 * GitHub 的 workflow_dispatch 返回 204 且不带 run_id，旧 APP 靠
 * 「列出 runs 猜一个 created_at 晚于任务创建时间的」来补绑，并发时极易
 * 绑到别人的 run 上（TaskViewModel.getLatestWorkflowRunId 的已知竞态）。
 * 这里改为：dispatch 成功后立刻按 workflow 列出 runs，跳过已消耗的候选
 * run_id，取最新的一个；最多等 RUN_ID_WAIT_MS（默认 4s）。
 *
 * 若 4s 内 GitHub 仍未列出该 run，job 仍以 queued 状态返回，run_id 留空，
 * 由 status.ts 的「读缺失即回查」与 cron 兜底补绑。APP 无需特殊处理。
 */

import type { BuildJob, BuildRequest, BuildResponse, Env } from "./types";
import {
  dispatchWorkflow,
  describeGitHubError,
  GitHubError,
  listRecentRuns,
} from "./github";
import { newJobId, putJob } from "./kv_store";
import { error, json } from "./router";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_URL_BYTES = 2048;

export async function handleBuild(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: BuildRequest;
  try {
    body = (await request.json()) as BuildRequest;
  } catch {
    return error(400, "bad_request", "请求体不是合法 JSON");
  }

  const problems = validateBuildRequest(body);
  if (problems.length > 0) {
    return error(400, "bad_request", problems.join("；"));
  }

  const jobId = newJobId();
  const now = Date.now();
  const job: BuildJob = {
    job_id: jobId,
    run_id: null,
    workflow_file: body.workflow_file,
    workflow_name: body.workflow_file,
    protect_config: body.protect_config,
    dpt_extra_args: body.dpt_extra_args ?? "",
    display_name: body.display_name ?? "",
    status: "queued",
    conclusion: null,
    download_url: null,
    error: null,
    created_at_ms: now,
    updated_at_ms: now,
  };

  // 先落库再触发：dispatch 失败也能在任务表里留下痕迹，便于排查。
  await putJob(env, job);

  const inputs = buildDispatchInputs(body);
  try {
    await dispatchWorkflow(env, {
      workflowFile: body.workflow_file,
      apkUrl: body.apk_url,
      inputs,
    });
  } catch (err) {
    const msg =
      err instanceof GitHubError ? describeGitHubError(err) : "触发 GitHub 流水线失败";
    await putJob(env, {
      ...job,
      status: "completed",
      conclusion: "failure",
      error: msg,
      updated_at_ms: Date.now(),
    });
    const resp: BuildResponse = {
      success: false,
      job_id: jobId,
      status: "completed",
      error: msg,
    };
    return json(resp, 502);
  }

  // 同步等 run_id（不占满整个请求预算，失败可丢弃）。
  const runId = await waitForRunId(env, body.workflow_file, now);
  const updated = await putJobAndReturn(env, {
    ...job,
    run_id: runId,
    status: runId ? "in_progress" : "queued",
    updated_at_ms: Date.now(),
  });

  // 已经把状态写成 in_progress 了，这里顺手触发一次状态刷新不划算——
  // cron 每分钟兜底 + APP 轮询 /api/status 都会推进，无需 waitUntil。
  void ctx;

  const resp: BuildResponse = {
    success: true,
    job_id: jobId,
    run_id: runId,
    status: updated.status,
  };
  return json(resp, 200);
}

/** 组装除 apk_url 之外的 workflow inputs。 */
function buildDispatchInputs(body: BuildRequest): Record<string, string> {
  const inputs: Record<string, string> = {};
  // protect_config 是永久冻结的 input 键名（apk-protect-action 设计约定）。
  inputs.protect_config = body.protect_config;
  if (body.dpt_extra_args) inputs.dpt_extra_args = body.dpt_extra_args;
  return inputs;
}

/**
 * dispatch 后轮询 runs 列表拿 run_id。
 * 每次间隔 700ms，总预算 RUN_ID_WAIT_MS（默认 4000ms，约 5 次）。
 */
async function waitForRunId(
  env: Env,
  workflowFile: string,
  sinceMs: number,
): Promise<number | null> {
  const budgetMs = Number.parseInt(env.RUN_ID_WAIT_MS ?? "4000", 10);
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 4000;
  const deadline = Date.now() + budget;
  const seen = new Set<number>();

  while (Date.now() < deadline) {
    try {
      const runs = await listRecentRuns(env, workflowFile, sinceMs);
      for (const run of runs) {
        if (seen.has(run.run_id)) continue;
        seen.add(run.run_id);
        return run.run_id;
      }
    } catch {
      // GitHub 瞬时抖动：继续等，不因此失败整个 build。
    }
    await sleep(Math.min(700, Math.max(0, deadline - Date.now())));
  }
  return null;
}

async function putJobAndReturn(env: Env, job: BuildJob): Promise<BuildJob> {
  await putJob(env, job);
  return job;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateBuildRequest(body: BuildRequest): string[] {
  const problems: string[] = [];
  if (typeof body.apk_url !== "string" || body.apk_url.length === 0) {
    problems.push("apk_url 不能为空");
  } else {
    if (body.apk_url.length > MAX_URL_BYTES) problems.push("apk_url 过长");
    if (!/^https?:\/\//.test(body.apk_url)) problems.push("apk_url 必须是 http(s) 链接");
  }
  if (typeof body.workflow_file !== "string" || body.workflow_file.length === 0) {
    problems.push("workflow_file 不能为空");
  } else if (!/^[\w.-]+\.(yml|yaml)$/.test(body.workflow_file)) {
    problems.push("workflow_file 必须是无路径的 yml/yaml 文件名");
  }
  if (typeof body.protect_config !== "string" || body.protect_config.length === 0) {
    problems.push("protect_config 不能为空");
  } else if (new TextEncoder().encode(body.protect_config).length > MAX_CONFIG_BYTES) {
    problems.push("protect_config 超过 64KB");
  } else {
    try {
      JSON.parse(body.protect_config);
    } catch {
      problems.push("protect_config 不是合法 JSON");
    }
  }
  if (body.dpt_extra_args && new TextEncoder().encode(body.dpt_extra_args).length > 4096) {
    problems.push("dpt_extra_args 过长");
  }
  return problems;
}
