/**
 * 任务域的纯逻辑：job_id 生成、状态映射、停滞判定。
 *
 * 这里不碰 KV、不碰网络，因此可以直接单测。原先它们混在 kv_store.ts 里，
 * 想测一个新 job_id 的字典序就得先把整个 KV 层 mock 出来。
 */

import type { AppStatus, BuildJob, Env } from "../shared/types";

/** 默认停滞阈值：10 分钟。远大于 waitForRunId 的 4s，也远大于 GitHub 排队延迟。 */
export const DEFAULT_STALL_TIMEOUT_MIN = 10;

/**
 * job_id 的时间前缀：`1e15 - Date.now()` 的 base36。
 *
 * 为什么是「逆序」时间：KV 的 list() 按 key 字典序升序返回前 N 个。
 * 用逆序时间做前缀，字典序升序 = 创建时间降序，list() 天然先返回最新任务。
 */
function invTimePrefix(createdAtMs: number): string {
  const inv = 1_000_000_000_000_000 - createdAtMs;
  // 11 位 base36 足够覆盖 1e15（36^11 ≈ 1.3e17）
  return inv.toString(36).padStart(11, "0");
}

/**
 * 生成 job_id：`<逆序时间 base36 11位>-<8位随机>`。
 *
 * 时间前缀让 KV 的字典序 = 创建时间倒序，list() 天然先返回最新任务；
 * 随机后缀保证唯一性（同一毫秒内并发也不会撞）；整体仍是不透明 ID——
 * APP 推不出仓库信息，也无法反推出创建时间以外的东西。
 *
 * 为什么把时间嵌进 job_id 而不是另存一份：若 key 里带时间而 job_id
 * 不带，getJob(jobId) 就只能 list 扫描（1000 key + 逐条比对），而 APP
 * 每 5 秒轮询一次、每次都要 getJob，延迟和开销都不可接受。让 job_id
 * 自身含时间，key 可由 job_id 直接推出，get() 一次命中。
 */
export function newJobId(createdAtMs: number = Date.now()): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${invTimePrefix(createdAtMs)}-${rand}`;
}

/** APP 侧状态词映射，与 jian_box TaskCenterScreen 现有枚举保持一致。 */
export function toAppStatus(job: BuildJob): AppStatus {
  if (job.status === "completed") {
    return job.conclusion === "success" ? "SUCCESS" : "FAILED";
  }
  return job.status === "queued" ? "PENDING" : "PROCESSING";
}

/**
 * 判定任务是否已「停滞」——queued 且迟迟没绑上 run_id。
 *
 * 为什么必须有这个判断（踩过坑）：
 *   `waitForRunId` 只同步等 RUN_ID_WAIT_MS（默认 4s），匹配不上就以
 *   queued + run_id=null 落库，指望 cron 后续补绑。但若那次 dispatch
 *   其实没触发成功（GitHub 偶发静默失败、或 ref 名不对），cron 的
 *   `listRecentRuns` 也永远匹配不到候选，于是：
 *     - routes/status.ts 看到 run_id===null，原样返回不推进
 *     - reconcile 看到 !candidate，return 不推进
 *     - has_active 恒为 true
 *     - 前端轮询永不停（只被前端的 120 次上限挡一下，刷新即归零）
 *     - cron 每轮仍为它 list + get，持续 7 天（KV TTL）
 *
 * 也就是说：一条永远 queued 的僵尸任务会连续 7 天消耗 KV，
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

/** 停滞判死时写进任务记录的 error 文案（多处共用，避免措辞漂移）。 */
export function stalledMessage(): string {
  return `任务超时：创建 ${DEFAULT_STALL_TIMEOUT_MIN} 分钟后仍未关联到流水线运行（可能未成功触发）`;
}
