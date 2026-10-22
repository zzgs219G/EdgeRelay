/**
 * Cron 兜底轮询。
 *
 * 职责：
 *   1. 给 queued（run_id 未补绑）的任务尝试补绑 run_id；
 *   2. 给 in_progress 的任务刷新状态，完成时抓下载链接；
 *   3. 清理超过保留期的死任务（KV TTL 已负责大部分，这里只补漏）。
 *
 * 每轮 GitHub 调用次数 ≈ 未完结任务数 × 1~3，被 crons 的 2 分钟节奏
 * 天然限速。APP 轮询只读 KV，不再消耗 GitHub 配额。
 */

import type { BuildJob, Env } from "../shared/types";
import { isStalled, stalledMessage } from "../domain/job";
import {
  describeGitHubError,
  fetchLogArtifactUrl,
  getRun,
  GitHubError,
  listRecentRuns,
} from "./github";
import { explainDownloadFailure, resolveDownloadUrl } from "./download";
import {
  listOpenJobs,
  markSignalLightReconciled,
  patchJob,
  readOpenCount,
  reconcileSignalLight,
  shouldReconcileSignalLight,
} from "./kv";

/** 单轮最多处理的任务数，防一次 cron 跑爆 GitHub 配额。 */
const MAX_JOBS_PER_TICK = 40;

/**
 * 在途任务列表的 isolate 级缓存。
 *
 * 为什么必须有：cron 每 2 分钟一轮，每轮必调 listOpenJobs → 1 次 KV list
 * + 未完结任务数个 get。而 KV list 的免费额度是 1000 次/天，
 * 720 分钟/天，不加缓存约 720 次 list（且这与人有没有开着面板无关，
 * 是纯底噪）。
 *
 * 120 秒 TTL = 每两轮 cron 命中一次缓存，list 减半到约 360 次/天。
 * 代价是补绑 run_id 最多晚 2 分钟——build.ts 的 waitForRunId 已经
 * 同步补过一次，cron 只是兜底，可接受。
 */
const OPEN_JOBS_CACHE_MS = 120_000;

interface OpenJobsCache {
  at: number;
  jobs: BuildJob[];
}

let openJobsCache: OpenJobsCache | null = null;

/**
 * 拉未完结任务（带缓存）。
 *
 * 缓存只在本模块内，不跨模块共享，避免与面板列表缓存（15s）互相干扰。
 */
export async function listOpenJobsCached(env: Env): Promise<BuildJob[]> {
  const now = Date.now();
  if (openJobsCache && now - openJobsCache.at < OPEN_JOBS_CACHE_MS) {
    return openJobsCache.jobs;
  }
  const jobs = await listOpenJobs(env, MAX_JOBS_PER_TICK);
  openJobsCache = { at: now, jobs };
  return jobs;
}

/** 写完任务后清缓存：下一轮 cron 立刻能看到最新状态。 */
export function invalidateOpenJobsCache(): void {
  openJobsCache = null;
}

/**
 * 停滞任务的兜底判死。
 *
 * 与「等 cron 补绑」并存：先判死再补绑，顺序不能反——否则一条已经
 * 不可能的僵尸任务每轮还要打一次 GitHub 去撞 listRecentRuns。
 */
async function killStalled(env: Env, job: BuildJob): Promise<void> {
  invalidateOpenJobsCache();
  await patchJob(env, job.job_id, {
    status: "completed",
    conclusion: "failure",
    error: stalledMessage(),
  });
}

export async function reconcileOpenJobs(env: Env): Promise<{ processed: number }> {
  // ── 第一道闸：信号灯 ──
  //
  // KV list 额度 1000 次/天，而 cron 定期醒。原实现每轮都 list，
  // 加 120s 缓存也还有约 360 次/天，且空闲时照跑——而这个网关一天只有
  // 几个构建、每次几分钟，绝大部分 list 是白花的。
  //
  // 现在先花 1 次 get 看信号灯（get 额度 10 万/天，720 次只占 0.7%）：
  //   0       → 没有未完结任务，直接睡，一次 list 都不做
  //   > 0     → 有活，才往下走
  //   null    → 读不到/没写过。保守当作「可能有任务」，继续往下。
  //             宁可多 list 一次，也不能漏掉真在跑的任务。
  //
  // 信号灯在写入侧维护（putNewJob 建任务 +1、patchJob 跨终态线 -1），
  // 写竞争只会让它偏小而不会偏大，偏小的后果是「晚一小时被发现」而非
  // 「任务丢失」，由下面的每小时对账兜底。
  const openCount = await readOpenCount(env);
  if (openCount === 0) {
    // 空闲：顺手做每小时对账（这是 24 次/天的固定成本）。
    if (await shouldReconcileSignalLight(env)) {
      await reconcileSignalLight(env);
      await markSignalLightReconciled(env);
      // 对账发现其实有任务（信号灯写漏了）→ 补上处理
      const recount = await readOpenCount(env);
      if (recount !== null && recount > 0) return processOpenJobs(env);
    }
    return { processed: 0 };
  }

  return processOpenJobs(env);
}

/** 真正处理未完结任务（信号灯已确认非零，或对账后确认有活）。 */
async function processOpenJobs(env: Env): Promise<{ processed: number }> {
  const jobs = await listOpenJobsCached(env);
  let processed = 0;

  for (const job of jobs) {
    try {
      if (job.run_id === null) {
        // 先判死，再尝试补绑：判死能省掉后续每一轮的无效 GitHub 调用，
        // 也让 has_active 归 false，前端轮询与这里的 N+1 同时停。
        if (isStalled(env, job)) {
          await killStalled(env, job);
          processed += 1;
          continue;
        }
        await tryBindRunId(env, job);
        continue;
      }
      if (job.status === "in_progress") {
        await refreshInProgress(env, job);
      }
      processed += 1;
    } catch (err) {
      if (err instanceof GitHubError) {
        // 令牌/权限类错误对所有任务都一样，记录下来后跳出本轮，避免
        // 每个任务各撞一次 403。
        console.error("reconcile aborting", {
          status: err.status,
          hint: describeGitHubError(err),
        });
        break;
      }
      console.error("reconcile job failed", {
        job_id: job.job_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { processed };
}

/** queued 任务：尝试用创建时间匹配出 run_id。 */
async function tryBindRunId(env: Env, job: BuildJob): Promise<void> {
  const runs = await listRecentRuns(env, job.workflow_file, job.created_at_ms);
  const candidate = runs.find((r) => !(job.run_id_candidates ?? []).includes(r.run_id));
  if (!candidate) return;
  invalidateOpenJobsCache();
  await patchJob(env, job.job_id, {
    run_id: candidate.run_id,
    status: "in_progress",
    run_id_candidates: [...(job.run_id_candidates ?? []), candidate.run_id],
  });
}

/**
 * in_progress 任务：刷新状态，完成时抓下载链接。
 *
 * 明确不写「状态没变」的情况。理由见 routes/status.ts：`patchJob` 无条件
 * 刷新 `updated_at_ms`，而该字段不出现在任何响应体里，唯一读者是节流逻辑
 * 自己。cron 每 2 分钟处理一轮（list 有 120s 缓存），若每轮都写，
 * 一个 40 分钟的构建就是 20 次无变化写；叠加 APP 轮询路径的同类写，
 * KV 写额度（1000 次/天）只够十几个任务。
 *
 * 现在：只有状态真的变成 completed 才写。
 */
async function refreshInProgress(env: Env, job: BuildJob): Promise<void> {
  if (job.run_id === null) return;
  const run = await getRun(env, job.run_id);
  if (run.status !== "completed") return;
  const dl = run.conclusion === "success" ? await resolveDownloadUrl(env, run.run_id) : null;
  if (dl?.reason) {
    console.error("download url fell back", {
      job_id: job.job_id,
      run_id: run.run_id,
      reason: dl.reason,
      hint: explainDownloadFailure(dl.reason),
    });
  }
  // 日志与成败无关：失败时更要看，所以无条件抓
  const logUrl = await fetchLogArtifactUrl(env, run.run_id);
  // 任务转终态，缓存必须失效——否则下一轮 cron 从缓存里读到的还是
  // in_progress 副本，会把这个已完成的任务再处理一遍。
  invalidateOpenJobsCache();
  await patchJob(env, job.job_id, {
    status: "completed",
    conclusion: run.conclusion,
    download_url: dl?.url ?? null,
    log_url: logUrl,
    error:
      run.conclusion !== "success"
        ? `流水线以 ${run.conclusion ?? "unknown"} 结束`
        : dl?.isArtifactFallback
          ? `产物链接兜底为 GitHub artifact（需令牌，APP 下不了）：${explainDownloadFailure(dl.reason) ?? "原因未知"}`
          : null,
  });
}
