/**
 * 未完结任务信号灯。
 *
 * 为什么要这个 key（KV list 额度是 1000 次/天，而 cron 每 2 分钟跑一轮）：
 *
 *   `listOpenJobs` 每轮必做一次 list。一天 720 轮 = 720 次 list，
 *   加 120s 缓存也还有约 360 次——**而且空闲时也照跑**。
 *   这个网关的真实使用模式是「一天几个构建、每次几分钟、其余时间空闲」，
 *   所以绝大部分 list 是白花的。
 *
 * 解法：用一个只存数字的 key 当信号灯。cron 先花 1 次 get 看它：
 *     0 → 直接回去睡，一次 list 都不做
 *    >0 → 才 list + 逐个 get
 *
 * 为什么敢信任一个数字（以及它的失效模式）：
 *   信号灯在写入侧维护（建任务 +1、转终态 -1），理论上有写竞争：
 *   两个任务同时完成时，都读到旧值、各自减一、后写覆盖 → 灯偏小 1。
 *   偏小不会丢任务，只会让那 1 个任务晚一小时被 cron 看见。
 *   配每小时一次 `reconcileSignalLight` 对账（真 list 一次，约 24 次/天），
 *   误差最多一小时自愈。这比自建「未完结 job_id 索引」安全——索引写错
 *   会让任务永久消失，而信号灯写错只是延迟。
 *
 * 账：cron 唤醒成本从 1 次 list 变成 1 次 get。get 的额度是 10 万/天，
 * 多花 720 次只占 0.7%。用便宜的换昂贵的，这就是全部思路。
 */

import type { Env } from "../../shared/types";
import { listOpenJobs } from "./jobs";

/** 信号灯 key：当前未完结（status !== completed）任务数。 */
const OPEN_COUNT_KEY = "meta:open_count";

/** 上次对账时间 key。 */
const LAST_RECONCILE_KEY = "meta:open_count_reconciled_at";

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
  // 保守作 0+1 也无意义，真正该做的是让下一次对账来补。
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
  void nowMs;
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
