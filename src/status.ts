/**
 * GET /api/status/:jobId — 查询任务状态。
 *
 * 读 KV 为准；KV 未命中或 run_id 尚未补绑时，回查 GitHub 一次并写回。
 * 这样即使 build 接口的「同步等 run_id」超时，或 cron 尚未跑到，
 * APP 的第一次查询也能拿到真实状态——不会出现「跑完了还显示处理中」。
 */

import type { BuildJob, Env, JobStatus, JobStatusResponse } from "./types";
import {
  describeGitHubError,
  fetchArtifactUrl,
  fetchDownloadUrlFromAnnotations,
  getRun,
  GitHubError,
} from "./github";
import { getJob, patchJob, toAppStatus } from "./kv_store";
import { error, json } from "./router";

export async function handleStatus(env: Env, jobId: string): Promise<Response> {
  let job = await getJob(env, jobId);
  if (!job) {
    return error(404, "not_found", `任务 ${jobId} 不存在或已过期`);
  }

  // 终态直接返回，不再打 GitHub（省钱 + 稳定）。
  if (job.status === "completed") {
    return json(toResponse(job));
  }

  if (job.run_id === null) {
    // run_id 还没补上：等 cron 或 build 阶段的 waitForRunId。此时不能
    // 回查（没有 run_id 可查），原样返回 queued/in_progress。
    return json(toResponse(job));
  }

  // run_id 已知：回查一次真实状态，顺带在完成时抓下载链接。
  try {
    const run = await getRun(env, job.run_id);
    if (run.status === "completed") {
      const downloadUrl = run.conclusion === "success"
        ? await fetchDownloadUrlFromAnnotations(env, run.run_id) ?? await fetchArtifactUrl(env, run.run_id)
        : null;
      const patch: Partial<BuildJob> = {
        status: "completed" as JobStatus,
        conclusion: run.conclusion,
        download_url: downloadUrl,
        error: run.conclusion === "success" ? null : `流水线以 ${run.conclusion ?? "unknown"} 结束`,
      };
      const updated = await patchJob(env, jobId, patch);
      return json(toResponse(updated ?? { ...job, ...patch }));
    }
    // 仍在跑：顺带刷新 updated_at，让 APP 的「最后更新」时间有意义。
    if (Date.now() - job.updated_at_ms > 30_000) {
      await patchJob(env, jobId, { status: "in_progress" });
    }
    return json(toResponse({ ...job, status: "in_progress" }));
  } catch (err) {
    const msg = err instanceof GitHubError ? describeGitHubError(err) : "查询 GitHub 失败";
    // GitHub 侧瞬时错误不覆盖任务状态，只把错误带回给 APP 展示。
    return json({ ...toResponse(job), error: msg });
  }
}

function toResponse(job: BuildJob): JobStatusResponse {
  return {
    job_id: job.job_id,
    status: job.status,
    app_status: toAppStatus(job),
    conclusion: job.conclusion,
    download_url: job.download_url,
    error: job.error,
    elapsed_ms: job.status === "completed" ? job.updated_at_ms - job.created_at_ms : 0,
    server_time: Date.now(),
  };
}
