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
import { describeModules } from "./modules";
import { invalidateJobsCache } from "./jobs";
import { error, json } from "./router";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_URL_BYTES = 2048;

/**
 * dispatch 后探测 runs 列表的次数。
 *
 * 3 次的依据：GitHub 的 workflow_dispatch 通常在 1-2 秒后就能在
 * runs 列表看到新 run，但存在偶发延迟。默认预算 4 秒 / 3 次 ≈ 每 1.3 秒
 * 探测一次，能覆盖这个分布；再多对 4 秒预算无意义（间隔被压到比 RTT
 * 还短，连续两次拿到同一份列表）。
 */
const RUN_ID_PROBE_ATTEMPTS = 3;

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

  // 同一个 now 同时用于 job_id 的时间前缀与 created_at_ms。
  // 若分两次 Date.now()，极端情况下会差 1ms，导致 KV 字典序与
  // created_at_ms 排序不完全一致（列表顺序细微错乱）。
  const now = Date.now();
  const jobId = newJobId(now);
  const job: BuildJob = {
    job_id: jobId,
    run_id: null,
    workflow_file: body.workflow_file,
    workflow_name: body.workflow_file,
    protect_config: body.protect_config,
    dpt_extra_args: body.dpt_extra_args ?? "",
    display_name: body.display_name ?? "",
    // 解析「勾了哪些模块」用于任务列表展示。失败不阻塞构建（返回 []）。
    modules: await describeModules(env, body.protect_config),
    status: "queued",
    conclusion: null,
    download_url: null,
    error: null,
    created_at_ms: now,
    updated_at_ms: now,
  };

  // 先落库再触发：dispatch 失败也能在任务表里留下痕迹，便于排查。
  await putJob(env, job);
  // 让面板立刻看到新任务，而不是等列表缓存（15s）过期。
  invalidateJobsCache();

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
    // 用 200 而不是 502：dispatch 失败是**业务失败**（token 过期、
    // 参数不匹配、仓库不存在），不是网关故障。用 5xx 会让客户端把它
    // 当成"网关挂了"而重试整条请求，反而放大问题。
    // 任务已落库且标记为 completed/failure，APP 也能通过 jobId 查到。
    const resp: BuildResponse = {
      success: false,
      job_id: jobId,
      status: "completed",
      error: msg,
    };
    return json(resp, 200);
  }

  // 同步等 run_id（不占满整个请求预算，失败可丢弃）。
  const runId = await waitForRunId(env, body.workflow_file, now);

  // 没拿到 run_id 就不写第二次：状态仍是 queued，与落库时一致，
  // 这次写只会白耗一次 KV 写额度（免费 1000 次/天）。
  // run_id 由 status.ts 的「读缺失即回查」与 cron 补绑，见 kv_store.ts。
  const finalStatus = runId !== null ? "in_progress" : job.status;
  if (runId !== null) {
    await putJobAndReturn(env, {
      ...job,
      run_id: runId,
      status: finalStatus,
      updated_at_ms: Date.now(),
    });
  }

  // 已经把状态写成 in_progress 了，这里顺手触发一次状态刷新不划算——
  // cron 每分钟兜底 + APP 轮询 /api/status 都会推进，无需 waitUntil。
  void ctx;

  // 刻意不返回 run_id：APP 只需要 job_id，而 run_id 属于 GitHub 侧信息，
  // 下发即暴露。调试时用 /api/status（服务端内部会带上，但不含 run_id）。
  const resp: BuildResponse = {
    success: true,
    job_id: jobId,
    status: finalStatus,
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
 * dispatch 后探测 runs 列表拿 run_id。
 *
 * 固定探测次数而不是「等满预算」：每次探测自身要花一个 RTT（GitHub
 * 正常 <300ms，慢时上秒），原实现的 `while (now < deadline)` 把等待
 * 和 RTT 混在一起，注释写的「约 5 次」在 fetch 变慢时会缩到 2-3 次，
 * 补绑成功率随网络波动。
 *
 * 改成「预算内最多探测 N 次，间隔均分」：探测次数确定，接住 GitHub
 * 偶发延迟（run 通常 1-2 秒后才出现在列表里）的能力稳定。
 *
 * 补绑在这里做扎实， downstream 收益很大：run_id === null 的任务
 * 正是会让 has_active 恒 true、触发停滞判死、并让 cron 每轮白打一次
 * GitHub 的那一类（见 reconcile.ts 与 kv_store.ts 的 isStalled）。
 *
 * @param attempts 探测次数，默认 3（可经 RUN_ID_PROBE_ATTEMPTS 覆盖）
 * @returns run_id，或 null（由 cron / status 回查补上）
 */
async function waitForRunId(
  env: Env,
  workflowFile: string,
  sinceMs: number,
  attempts = RUN_ID_PROBE_ATTEMPTS,
): Promise<number | null> {
  const budgetMs = Number.parseInt(env.RUN_ID_WAIT_MS ?? "4000", 10);
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 4000;
  const deadline = Date.now() + budget;
  const seen = new Set<number>();

  // 间隔 = 预算均分给 attempts+1 段（最后一次探测后不必再等满）。
  const gap = budget / (attempts + 1);

  for (let i = 0; i < attempts; i++) {
    // 关键：探测本身也要受预算约束。只查 deadline 来控制「等待」是不够的
    // ——单次 fetch 就可能吃掉整个预算（GitHub 慢时一次 RTT 上秒），
    // 那样 attempts 次串起来会把墙钟放大几倍，而 Worker 有墙钟上限。
    // 已超时就不再发起新的上游调用。
    if (Date.now() >= deadline) break;

    try {
      const runs = await listRecentRuns(env, workflowFile, sinceMs);
      for (const run of runs) {
        if (seen.has(run.run_id)) continue;
        seen.add(run.run_id);
        return run.run_id;
      }
    } catch {
      // GitHub 瞬时抖动：继续探测，不因此失败整个 build。
    }

    // 末次探测后不等待；否则按 gap 等，但不越过 deadline。
    if (i === attempts - 1) break;
    const wait = Math.min(gap, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleep(wait);
  }
  return null;
}

async function putJobAndReturn(env: Env, job: BuildJob): Promise<void> {
  await putJob(env, job);
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
