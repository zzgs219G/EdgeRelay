/**
 * GET /api/build/idem/:clientRequestId — 用提交时生成的幂等键查回 job_id。
 *
 * 为什么需要这个接口（它才是「重新查询」能救回任务的关键）：
 *
 *   客户端提交构建时如果请求超时，它拿不到 job_id——但网关是「先落库、
 *   再 dispatch」，任务很可能已经建成、GitHub 甚至已经跑完。旧版 APP
 *   在这种情况下只能把本地任务标 FAILED，并且**永远无法自愈**：它不知道
 *   该查哪个 job。
 *
 *   有了 client_request_id，APP 本地存着这个值，事后就能精确问一次
 *   「我那次提交最终对应哪个 job」，拿到 job_id 后走正常的
 *   /api/status 流程。这不是按时间窗猜，是**精确匹配**，零歧义。
 *
 * 为什么不用 /api/status 复用：语义不同。status 查的是「某个任务的状态」，
 * 这里查的是「某次提交落到哪个任务」，是两次不同的寻址。
 *
 * 安全：
 *   - 只查 principal 自己名下的映射（key 带 owner，见 services/kv/idem.ts）
 *   - 命中映射后还要校验任务记录的 owner，双保险
 *   - 查不到一律 404，不区分「没这个 ID」与「ID 是别人的」——避免探测
 */

import type { BuildResponse, Env } from "../shared/types";
import { getJob, getJobIdByClientRequestId, normalizeClientRequestId } from "../services/kv";
import { canAccessJob, type Principal } from "../services/principal";
import { error, json } from "../shared/http";

export async function handleBuildLookup(
  env: Env,
  clientRequestIdRaw: string,
  principal: Principal,
): Promise<Response> {
  const clientRequestId = normalizeClientRequestId(clientRequestIdRaw);
  if (clientRequestId === null) {
    return error(400, "bad_request", "client_request_id 格式非法（允许 A-Z a-z 0-9 . _ - ，长度 8~64）");
  }

  const jobId = await getJobIdByClientRequestId(env, principal.id, clientRequestId);
  if (!jobId) {
    return error(404, "not_found", "该提交未在网关留下记录（可能已过期，或当时请求未抵达网关）");
  }

  // 映射指向的任务必须实际存在且可访问。任一不满足都按 404 处理：
  // 让调用方看到「查不到」而不是一个查状态必然 404 的悬空 jobId。
  const job = await getJob(env, jobId);
  if (!job || !canAccessJob(principal, job.owner)) {
    return error(404, "not_found", "该提交未在网关留下记录（可能已过期）");
  }

  // 复用 BuildResponse：调用方拿到 job_id 后与正常提交的后续流程完全一致，
  // 不需要为「查回来的」和「当场返回的」写两套分支。
  const resp: BuildResponse = {
    success: true,
    job_id: job.job_id,
    status: job.status,
  };
  return json(resp, 200);
}
