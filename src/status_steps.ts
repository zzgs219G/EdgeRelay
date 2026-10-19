/**
 * GET /api/status/:jobId/steps — 任务详情页的步骤明细。
 *
 * 为什么单独一个接口而不是并进 /api/status：
 *   /api/status 是 APP 每 5 秒轮询的热路径，必须只读 KV（零 GitHub 配额）。
 *   步骤明细要打两次 GitHub（jobs + 每个 job 的 steps），只该在用户主动
 *   展开详情时按需拉一次。
 *
 * 返回结构与 jian_box 的 RunDetail 对齐（jobs[].steps[]），避免 APP 侧
 * 做无谓的字段映射。
 */

import type { BuildJob, Env } from "./types";
import { getJob } from "./kv_store";
import { getRunSteps } from "./github";
import { error, json } from "./http";

export async function handleStatusSteps(env: Env, jobId: string): Promise<Response> {
  const job = await getJob(env, jobId);
  if (!job) {
    return error(404, "not_found", `任务 ${jobId} 不存在或已过期`);
  }
  if (job.run_id === null) {
    // run_id 还没补绑：还没有可查的步骤。返回空列表而不是 404，
    // 让 APP 的详情页能正常渲染「等待中」而不是弹错误。
    return json({
      job_id: job.job_id,
      status: job.status,
      app_status: job.conclusion === "success" ? "SUCCESS" : job.status === "queued" ? "PENDING" : "PROCESSING",
      available: false,
      jobs: [],
      reason: "任务尚未关联到流水线运行",
    });
  }

  try {
    const run = await getRunSteps(env, job.run_id);
    return json({
      job_id: job.job_id,
      status: job.status,
      conclusion: job.conclusion,
      available: true,
      run_started_at: run.run_started_at,
      updated_at: run.updated_at,
      jobs: run.jobs,
    });
  } catch (err) {
    // GitHub 侧瞬时错误不该让详情页整体失败——降级为空明细 + 原因。
    return json(
      {
        job_id: job.job_id,
        status: job.status,
        available: false,
        jobs: [],
        reason: err instanceof Error ? err.message : "查询 GitHub 失败",
      },
      200,
    );
  }
}

/** 供测试与内部复用。 */
export type { BuildJob };
