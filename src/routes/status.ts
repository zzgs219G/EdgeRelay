/**
 * GET /api/status/:jobId — 查询任务状态。
 *
 * 读 KV 为准；KV 未命中或 run_id 尚未补绑时，回查 GitHub 一次并写回。
 * 这样即使 build 接口的「同步等 run_id」超时，或 cron 尚未跑到，
 * APP 的第一次查询也能拿到真实状态——不会出现「跑完了还显示处理中」。
 *
 * 这是 APP 每 5 秒轮询的热路径，因此只读 KV、不打 GitHub（唯一例外是
 * run_id 已知且未终态时的状态确认，那是必要的）。
 */

import type { BuildJob, Env, JobStatus, JobStatusResponse } from "../shared/types";
import { isStalled, stalledMessage, toAppStatus } from "../domain/job";
import { describeGitHubError, fetchLogArtifactUrl, getRun, GitHubError } from "../services/github";
import { getJob, patchJob } from "../services/kv";
import { explainDownloadFailure, resolveDownloadUrl } from "../services/download";
import { canAccessJob, type Principal } from "../services/principal";
import { error, json } from "../shared/http";

export async function handleStatus(
  env: Env,
  jobId: string,
  principal: Principal,
): Promise<Response> {
  const job = await getJob(env, jobId);
  if (!job) {
    return error(404, "not_found", `任务 ${jobId} 不存在或已过期`);
  }

  // 归属校验：不是自己的任务按"不存在"处理，不泄漏任务是否存在。
  if (!canAccessJob(principal, job.owner)) {
    return error(404, "not_found", `任务 ${jobId} 不存在或已过期`);
  }

  // 终态直接返回，不再打 GitHub（省钱 + 稳定）。
  if (job.status === "completed") {
    return json(toResponse(job));
  }

  if (job.run_id === null) {
    // run_id 还没补上：等 cron 或 build 阶段的 waitForRunId。此时不能
    // 回查（没有 run_id 可查），原样返回 queued/in_progress。
    //
    // 但停滞任务例外：它可能永远补不上（那次 dispatch 没真触发），
    // 继续原样返回会让前端一直轮询、has_active 恒为 true。这里顺手
    // 判死，让 APP 立刻看到失败而不是无限等待。
    if (isStalled(env, job)) {
      const patch: Partial<BuildJob> = {
        status: "completed" as JobStatus,
        conclusion: "failure",
        error: stalledMessage(),
      };
      const updated = await patchJob(env, jobId, patch);
      return json(toResponse(updated ?? { ...job, ...patch }));
    }
    return json(toResponse(job));
  }

  // run_id 已知：回查一次真实状态，顺带在完成时抓下载链接。
  try {
    const run = await getRun(env, job.run_id);
    if (run.status === "completed") {
      const dl = run.conclusion === "success"
        ? await resolveDownloadUrl(env, run.run_id)
        : { url: null, reason: null, isArtifactFallback: false };
      // 兜底原因必须留痕：曾经这里静默退回 artifact，网关侧零痕迹，
      // 只有 APP 弹一句"需令牌"，排查全靠读代码反推。
      if (dl.reason) {
        console.error("download url fell back", {
          job_id: job.job_id,
          run_id: run.run_id,
          reason: dl.reason,
          hint: explainDownloadFailure(dl.reason),
        });
      }
      // 日志与成败无关：失败时更要看日志，所以无条件抓。
      const logUrl = await fetchLogArtifactUrl(env, run.run_id);
      const patch: Partial<BuildJob> = {
        status: "completed" as JobStatus,
        conclusion: run.conclusion,
        download_url: dl.url,
        log_url: logUrl,
        // 兜底原因写到 error 里，让面板与 APP 都能看见"为什么下不了"。
        // 这不覆盖真正的失败原因（conclusion 非 success 时那才该是 error）。
        error:
          run.conclusion !== "success"
            ? `流水线以 ${run.conclusion ?? "unknown"} 结束`
            : dl.isArtifactFallback
              ? `产物链接兜底为 GitHub artifact（需令牌，APP 下不了）：${explainDownloadFailure(dl.reason) ?? "原因未知"}`
              : null,
      };
      const updated = await patchJob(env, jobId, patch);
      return json(toResponse(updated ?? { ...job, ...patch }));
    }
    // 仍在跑：直接返回，不写 KV。
    //
    // 曾经这里每 30 秒写一次 `status: "in_progress"`，为的是刷新
    // updated_at_ms。但 `updated_at_ms` 不出现在任何响应体里
    // （toResponse 不含它，/api/jobs 的 payload 也不含它），唯一读它的
    // 就是下面这句节流判断自己——等于「写一个没人看的字段，来节流后续
    // 对同一个字段的写入」。
    //
    // 而 APP 每 5 秒轮询一次这个接口：40 分钟的构建 = 80 次无变化写。
    // KV 写额度只有 1000 次/天，12 个任务就见底。
    //
    // 不再写。updated_at_ms 的语义收缩为「最后一次真实状态变化的时刻」，
    // 完成时由下面的 patchJob 写入，elapsed_ms 仍然准确。
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
