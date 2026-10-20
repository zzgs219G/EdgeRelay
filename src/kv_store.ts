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

import type { BuildJob, Env } from "./types";

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

/**
 * 判定任务是否已「停滞」——queued 且迟迟没绑上 run_id。
 *
 * 为什么必须有这个判断（踩过坑）：
 *   `waitForRunId` 只同步等 RUN_ID_WAIT_MS（默认 4s），匹配不上就以
 *   queued + run_id=null 落库，指望 cron 后续补绑。但若那次 dispatch
 *   其实没触发成功（GitHub 偶发静默失败、或 ref 名不对），cron 的
 *   `listRecentRuns` 也永远匹配不到候选，于是：
 *     - status.ts 看到 run_id===null，原样返回不推进
 *     - reconcile 看到 !candidate，return 不推进
 *     - jobs.ts 的 has_active 恒为 true
 *     - 前端轮询永不停（只被前端的 120 次上限挡一下，刷新即归零）
 *     - cron 每分钟仍为它 list + get，持续 7 天（KV TTL）
 *
 * 也就是说：一条永远 queued 的僵尸任务会连续 7 天每分钟消耗 KV，
 * 而它自己永远等不到 completed。这里给一个任务级超时，到点主动判死，
 * 让 has_active 归 false，前端轮询与 cron 的 N+1 同时停。
 *
 * @param env    运行环境（读 JOB_STALL_TIMEOUT_MIN）
 * @param job    待判定任务
 * @param nowMs  当前时间（测试可注入）
 */
export function isStalled(
  env: Env,
  job: Pick<BuildJob, "status" | "run_id" | "created_at_ms">,
  nowMs: number = Date.now(),
): boolean {
  // 只有 queued 且没绑上 run_id 的才可能停滞。in_progress 有 run_id，
  // 状态推进由 GitHub 侧负责，不该由网关判死（构建可能真的跑很久）。
  if (job.status !== "queued" || job.run_id !== null) return false;
  const mins = Number.parseInt(env.JOB_STALL_TIMEOUT_MIN ?? "", 10);
  const timeoutMin = Number.isFinite(mins) && mins > 0 ? mins : DEFAULT_STALL_TIMEOUT_MIN;
  return nowMs - job.created_at_ms > timeoutMin * 60_000;
}

/** 默认停滞阈值：10 分钟。远大于 waitForRunId 的 4s，也远大于 GitHub 排队延迟。 */
export const DEFAULT_STALL_TIMEOUT_MIN = 10;

function jobKey(jobId: string): string {
  return `job:${jobId}`;
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

/** 建任务专用入口：落库 + 信号灯 +1。 */
export async function putNewJob(env: Env, job: BuildJob): Promise<void> {
  await putJob(env, job);
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
 * 先判断「值真的变了没有」——否则 reconcile 每分钟的例行刷新会把 KV
 * 写额度（免费 1000 次/天）白白烧掉。见 reconcile.ts 的节流注释。
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

/** Cron 兜底轮询用：列出所有未完结任务。 */
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

// ── 未完结任务信号灯 ────────────────────────────────────────────────
//
// 为什么要这个 key（KV list 额度是 1000 次/天，而 cron 每分钟跑一轮）：
//
//   `listOpenJobs` 每轮必做一次 list。一天 1440 轮 = 1440 次 list，
//   加 120s 缓存也还有约 720 次，占掉额度的 72%——**而且空闲时也照跑**。
//   这个网关的真实使用模式是「一天几个构建、每次几分钟、其余时间空闲」，
//   所以绝大部分 list 是白花的。
//
// 解法：用一个只存数字的 key 当信号灯。cron 先花 1 次 get 看它：
//     0 → 直接回去睡，一次 list 都不做
//     >0 → 才 list + 逐个 get
//
// 为什么敢信任一个数字（以及它的失效模式）：
//   信号灯在写入侧维护（建任务 +1、转终态 -1），理论上有写竞争：
//   两个任务同时完成时，都读到旧值、各自减一、后写覆盖 → 灯偏小 1。
//   偏小不会丢任务，只会让那 1 个任务晚一小时被 cron 看见。
//   配每小时一次 `reconcileSignalLight` 对账（真 list 一次，约 24 次/天），
//   误差最多一小时自愈。这比自建「未完结 job_id 索引」安全——索引写错
//   会让任务永久消失，而信号灯写错只是延迟。
//
// 账：cron 唤醒成本从 1 次 list 变成 1 次 get。get 的额度是 10 万/天，
// 多花 1440 次只占 1.4%。用便宜的换昂贵的，这就是全部思路。

/** 信号灯 key：当前未完结（status !== completed）任务数。 */
const OPEN_COUNT_KEY = "meta:open_count";

/** 信号灯对账间隔：每小时一次，防写竞争让数字漂移。 */
export const SIGNAL_RECONCILE_MS = 60 * 60_000;

/** 读信号灯。KV 读失败 / JSON 坏 → 返回 null（调用方应保守地当作「可能有任务」）。 */
export async function readOpenCount(env: Env): Promise<number | null> {
  try {
    const raw = await env.EDGE_RELAY_KV.get(OPEN_COUNT_KEY);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 写信号灯。用 `Math.max(0, ...)` 夹住，防止写竞争把数字减成负数——
 * 负数会让 cron 永远以为没任务（`> 0` 判断不成立）。
 */
export async function writeOpenCount(env: Env, count: number): Promise<void> {
  try {
    await env.EDGE_RELAY_KV.put(OPEN_COUNT_KEY, String(Math.max(0, count)));
  } catch {
    // 信号灯写失败不该让主流程失败：最坏情况是数字滞后，由每小时对账纠正。
  }
}

/** 未完结任务数 +1。建任务时调。 */
export async function bumpOpenCount(env: Env): Promise<void> {
  const cur = await readOpenCount(env);
  // null = 从未写过。此时不能假定是 0——可能只是 KV 读抖动。
  // 保守作 +1 无意义（0+1），真正该做的是让下一次对账来补。
  // 这里返回 null 让调用方知道「没把握」，由 reconcile 的对账兜底。
  if (cur === null) {
    await writeOpenCount(env, 1);
    return;
  }
  await writeOpenCount(env, cur + 1);
}

/**
 * 未完结任务数 -1。任务转终态时调。
 *
 * 幂等：重复调用不会把数字减到负数（writeOpenCount 已夹住）。
 */
export async function dropOpenCount(env: Env): Promise<void> {
  const cur = await readOpenCount(env);
  if (cur === null || cur <= 0) {
    // 已经是 0 或读不到：不减。减成负数比停在 0 更危险。
    return;
  }
  await writeOpenCount(env, cur - 1);
}

/**
 * 对账：用一次真实 list 重建信号灯。
 *
 * 每小时一次（调用方控制节奏），费用约 24 次 list/天。
 * 这是信号灯唯一的纠偏机制——写竞争造成的漂移在此修复。
 */
export async function reconcileSignalLight(
  env: Env,
  nowMs: number = Date.now(),
): Promise<number> {
  const jobs = await listOpenJobs(env);
  await writeOpenCount(env, jobs.length);
  return jobs.length;
}

/**
 * 信号灯是否需要更新（用于调用方决定要不要对账）。
 *
 * 单独存一个「上次对账时间」key。为什么不放在 isolate 内存里：
 * isolate 不跨实例共享，Cloudflare 随时可能起新 isolate，内存里的时间戳
 * 会让「每小时一次」退化成「每 isolate 一次」。
 */
const LAST_RECONCILE_KEY = "meta:open_count_reconciled_at";

export async function shouldReconcileSignalLight(
  env: Env,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const raw = await env.EDGE_RELAY_KV.get(LAST_RECONCILE_KEY);
    const last = raw ? Number.parseInt(raw, 10) : 0;
    if (!Number.isFinite(last)) return true;
    return nowMs - last > SIGNAL_RECONCILE_MS;
  } catch {
    return true;
  }
}

export async function markSignalLightReconciled(
  env: Env,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    await env.EDGE_RELAY_KV.put(LAST_RECONCILE_KEY, String(nowMs));
  } catch {
    /* 时间戳写失败只会让下一次多对账一次，无害 */
  }
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
