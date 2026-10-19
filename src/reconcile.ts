/**
 * Cron 兜底轮询。
 *
 * 职责：
 *   1. 给 queued（run_id 未补绑）的任务尝试补绑 run_id；
 *   2. 给 in_progress 的任务刷新状态，完成时抓下载链接；
 *   3. 清理超过保留期的死任务（KV TTL 已负责大部分，这里只补漏）。
 *
 * 每轮 GitHub 调用次数 ≈ 未完结任务数 × 1~3，被 crons 的 1 分钟节奏
 * 天然限速。APP 轮询只读 KV，不再消耗 GitHub 配额。
 */

import type { BuildJob, Env } from "./types";
import {
  describeGitHubError,
  fetchArtifactUrl,
  fetchDownloadUrlFromAnnotations,
  getRun,
  GitHubError,
  listRecentRuns,
} from "./github";
import { listOpenJobs, patchJob, putJob } from "./kv_store";

/** 单轮最多处理的任务数，防一次 cron 跑爆 GitHub 配额。 */
const MAX_JOBS_PER_TICK = 40;

export async function reconcileOpenJobs(env: Env): Promise<{ processed: number }> {
  const jobs = await listOpenJobs(env, MAX_JOBS_PER_TICK);
  let processed = 0;

  for (const job of jobs) {
    try {
      if (job.run_id === null) {
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
  await patchJob(env, job.job_id, {
    run_id: candidate.run_id,
    status: "in_progress",
    run_id_candidates: [...(job.run_id_candidates ?? []), candidate.run_id],
  });
}

/** in_progress 任务：刷新状态，完成时抓下载链接。 */
async function refreshInProgress(env: Env, job: BuildJob): Promise<void> {
  if (job.run_id === null) return;
  const run = await getRun(env, job.run_id);
  if (run.status !== "completed") {
    await patchJob(env, job.job_id, { status: "in_progress" });
    return;
  }
  const downloadUrl =
    run.conclusion === "success"
      ? (await fetchDownloadUrlFromAnnotations(env, run.run_id)) ?? (await fetchArtifactUrl(env, job.run_id))
      : null;
  await patchJob(env, job.job_id, {
    status: "completed",
    conclusion: run.conclusion,
    download_url: downloadUrl,
    error: run.conclusion === "success" ? null : `流水线以 ${run.conclusion ?? "unknown"} 结束`,
  });
}

/** 供测试注入：把任务标记为终态。 */
export async function markCompletedForTest(env: Env, jobId: string): Promise<void> {
  const jobs = await listOpenJobs(env, 1);
  const job = jobs.find((j) => j.job_id === jobId);
  if (!job) return;
  await putJob(env, {
    ...job,
    status: "completed",
    conclusion: "success",
    updated_at_ms: Date.now(),
  });
}
