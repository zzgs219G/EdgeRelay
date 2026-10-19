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

/**
 * job key：`job:<job_id>`，其中 job_id 自带逆序时间戳前缀。
 *
 * 为什么需要时间前缀：KV 的 list() 按 key 字典序返回前 N 个。若 job_id
 * 是随机 UUID，字典序与创建时间无关——任务超过 limit 条后，取到的是
 * 「字典序最小的 N 个」而不是「最新的 N 个」，新任务可能永远不显示。
 *
 * 为什么把时间嵌进 job_id 而不是另外存一份：若 key 里带时间而 job_id
 * 不带，getJob(jobId) 就只能 list 扫描（1000 key + 逐条比对），而 APP
 * 每 5 秒轮询一次、每次都要 getJob，延迟和开销都不可接受。让 job_id
 * 自身含时间（base36 编码 8 字符），key 可由 job_id 直接推出，get() 一次命中。
 *
 * job_id 形如 `mvfn7uzx-a1b2c3d4`：前段是 1e15 - Date.now() 的 base36，
 * 后段 8 位随机。对 APP 而言仍是不透明 ID，推不出仓库信息。
 */
function invTimePrefix(createdAtMs: number): string {
  const inv = 1_000_000_000_000_000 - createdAtMs;
  // 11 位 base36 足够覆盖 1e15（36^11 ≈ 1.3e17）
  return inv.toString(36).padStart(11, "0");
}

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

/**
 * 生成 job_id：`<逆序时间 base36 11位>-<8位随机>`。
 *
 * 时间前缀让 KV 的字典序 = 创建时间倒序，list() 天然先返回最新任务；
 * 随机后缀保证唯一性（同一毫秒内并发也不会撞）；整体仍是不透明 ID。
 */
export function newJobId(createdAtMs: number = Date.now()): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${invTimePrefix(createdAtMs)}-${rand}`;
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
