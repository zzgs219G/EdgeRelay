/**
 * 任务记录的 KV 读写。
 *
 * key = `job:<job_id>`，value = BuildJob JSON。
 *
 * 为什么用 KV 而不是 D1 / DO：
 *   - 访问模式是「写几次、读多次、无复杂查询」，KV 免费额度足够；
 *   - 不需要 migration，部署零 schema 负担；
 *   - KV 的最终一致性（全球生效约 10-60s）靠 build 接口的「同步等 run_id」
 *     与 status 接口的「读缺失即回查 GitHub」两层兜底抵消，见 routes/build.ts /
 *     routes/status.ts。
 *
 * 本文件只管「单条任务」的增删改查。跨任务的聚合视图（信号灯、job_id
 * 索引）在 signal.ts / job_index.ts。
 */

import type { BuildJob, Env } from "../../shared/types";
import { appendJobId } from "./job_index";
import { bumpOpenCount, dropOpenCount } from "./signal";

function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

function retentionSeconds(env: Env): number {
  const days = Number.parseInt(env.JOB_RETENTION_DAYS ?? "7", 10);
  const safe = Number.isFinite(days) && days > 0 ? days : 7;
  // KV TTL 下限 60s，单次任务远长于此，无副作用。
  return safe * 24 * 60 * 60;
}

/**
 * 落库一个任务。**纯粹的 KV 写，不维护信号灯。**
 *
 * 为什么不在这里维护：`patchJob` 内部也调 putJob，若在这里 +1/-1，
 * 每次 patchJob 都会顺带改一次信号灯——而 patchJob 的调用点非常多
 * （reconcile 补绑、刷新、判死；status 完成回写…），语义各不相同。
 * 把维护下沉到这个最底层函数，等于让每个 patchJob 都 +1，
 * 信号灯会无限上涨。
 *
 * 信号灯的维护由两个语义明确的入口负责：
 *   - putNewJob（建任务，+1）
 *   - patchJob（仅在真的跨过终态线时 -1）
 */
export async function putJob(env: Env, job: BuildJob): Promise<void> {
  await env.EDGE_RELAY_KV.put(jobKey(job.job_id), JSON.stringify(job), {
    expirationTtl: retentionSeconds(env),
  });
}

/** 建任务专用入口：落库 + 信号灯 +1 + job_id 索引追加。 */
export async function putNewJob(env: Env, job: BuildJob): Promise<void> {
  await putJob(env, job);
  // 索引先行：面板要能立刻看到新任务，等不到每小时的对账。
  await appendJobId(env, job.job_id);
  if (job.status !== "completed") await bumpOpenCount(env);
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

/**
 * 任务状态推进（只覆盖传入字段，保留其余）。
 *
 * 无条件写：`patchJob` 一定会刷新 `updated_at_ms`，因此调用方必须自己
 * 先判断「值真的变了没有」——否则 reconcile 每轮的例行刷新会把 KV
 * 写额度（免费 1000 次/天）白白烧掉。见 services/reconcile.ts 的注释。
 */
export async function patchJob(
  env: Env,
  jobId: string,
  patch: Partial<BuildJob>,
): Promise<BuildJob | null> {
  const job = await getJob(env, jobId);
  if (!job) return null;
  const next: BuildJob = { ...job, ...patch, updated_at_ms: Date.now() };
  await putJob(env, next);
  // 信号灯 -1：仅当这次改动真的把任务推过了终态线。
  // 只改 updated_at_ms、或改 status 但仍是 in_progress 的调用不能减。
  if (next.status === "completed" && job.status !== "completed") {
    await dropOpenCount(env);
  }
  return next;
}

/** Cron 兜底轮询用：列出所有未完结任务（会消耗 1 次 KV list）。 */
export async function listOpenJobs(env: Env, limit = 200): Promise<BuildJob[]> {
  const listed = await env.EDGE_RELAY_KV.list({ prefix: "job:", limit });
  // 并发读而非串行：wall clock 不随任务数线性增长。
  const raws = await Promise.all(listed.keys.map((k) => env.EDGE_RELAY_KV.get(k.name)));
  const jobs: BuildJob[] = [];
  for (const raw of raws) {
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

/** 按 job_id 批量取任务。坏行跳过，已过期（TTL）的 key 返回 null 也跳过。 */
export async function getJobsByIds(env: Env, ids: string[]): Promise<BuildJob[]> {
  const raws = await Promise.all(ids.map((id) => env.EDGE_RELAY_KV.get(jobKey(id))));
  const jobs: BuildJob[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      jobs.push(JSON.parse(raw) as BuildJob);
    } catch {
      /* 跳过坏行 */
    }
  }
  return jobs;
}
