/**
 * 任务记录的 KV 读写。
 *
 * key = `job:<job_id>`，value = BuildJob JSON。
 *
 * 为什么用 KV 而不是 D1 / DO：
 *   - 访问模式是「写几次、读多次、无复杂查询」，KV 免费额度足够；
 *   - 不需要 migration，部署零 schema 负担；
 *   - KV 的最终一致性（全球生效约 10-60s）靠 build 接口的「同步等 run_id」
 *     与 status 接口的「读缺失即回查 GitHub」两层兜底抵消，见 build.ts /
 *     status.ts。
 */

import type { BuildJob, Env, JobStatus } from "./types";

function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

export async function putJob(env: Env, job: BuildJob): Promise<void> {
  await env.EDGE_RELAY_KV.put(jobKey(job.job_id), JSON.stringify(job), {
    expirationTtl: retentionSeconds(env),
  });
}

export async function getJob(env: Env, jobId: string): Promise<BuildJob | null> {
  const raw = await env.EDGE_RELAY_KV.get(jobKey(jobId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BuildJob;
  } catch {
    return null;
  }
}

/** 任务状态推进（只覆盖传入字段，保留其余）。 */
export async function patchJob(
  env: Env,
  jobId: string,
  patch: Partial<BuildJob>,
): Promise<BuildJob | null> {
  const job = await getJob(env, jobId);
  if (!job) return null;
  const next: BuildJob = { ...job, ...patch, updated_at_ms: Date.now() };
  await putJob(env, next);
  return next;
}

/** Cron 兜底轮询用：列出所有未完结任务。 */
export async function listOpenJobs(env: Env, limit = 200): Promise<BuildJob[]> {
  const listed = await env.EDGE_RELAY_KV.list({ prefix: "job:", limit });
  const jobs: BuildJob[] = [];
  for (const key of listed.keys) {
    if (key.name.endsWith(":run_id_hint")) continue;
    const raw = await env.EDGE_RELAY_KV.get(key.name);
    if (!raw) continue;
    try {
      const job = JSON.parse(raw) as BuildJob;
      if (job.status !== "completed") jobs.push(job);
    } catch {
      /* 跳过坏行 */
    }
  }
  return jobs;
}

export function newJobId(): string {
  return crypto.randomUUID();
}

function retentionSeconds(env: Env): number {
  const days = Number.parseInt(env.JOB_RETENTION_DAYS ?? "7", 10);
  const safe = Number.isFinite(days) && days > 0 ? days : 7;
  // KV TTL 下限 60s，单次任务远长于此，无副作用。
  return safe * 24 * 60 * 60;
}

/** APP 侧状态词映射，与 jian_box TaskCenterScreen 现有枚举保持一致。 */
export function toAppStatus(job: BuildJob): "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" {
  if (job.status === "completed") {
    return job.conclusion === "success" ? "SUCCESS" : "FAILED";
  }
  return job.status === "queued" ? "PENDING" : "PROCESSING";
}

export function isTerminal(status: JobStatus): boolean {
  return status === "completed";
}
