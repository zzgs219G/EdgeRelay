/**
 * job_id 索引：让 /api/jobs 不再调 list。
 *
 * 为什么需要（这是一次线上故障的直接产物）：
 *
 *   信号灯只保护了 cron 路径。而 /api/jobs 一直在裸调 list：
 *   面板只要停在 Dashboard 就在轮询它，15s 缓存是 isolate 级的、跨实例
 *   形同虚设，实际轻松打出每天几千次 list —— KV list 额度只有 1000/天，
 *   于是「KV list() limit exceeded for the day」，整个面板 503。
 *
 *   教训：局部降额不等于整体降额。只看 cron 那一条路径时报告的
 *   「list 从 1440 降到约 20/天」是不完整的——面板路径一次都没降。
 *
 * 解法：维护一个只存 job_id 的索引 key，面板读它替代 list。
 *
 *   meta:job_ids = ["<最新 job_id>", ..., "<第 N 新>"]，按新→旧排列，
 *   上限 JOB_IDS_MAX 条（超出按最旧优先淘汰）。
 *
 * 与信号灯的差别、以及为什么这里敢用索引：
 *   信号灯存「一个数字」，索引存「一串 id」。数字写错了只是晚一小时
 *   被发现；索引漏写一个 id，那个任务就从面板上消失。
 *   所以索引的写失败必须能被发现和修复——
 *     - 写入时机只在「建任务」那一处（putNewJob），一天寥寥几次，
 *       写竞争概率极低（两个构建恰好同一毫秒创建）；
 *     - 配 rebuildJobIds 兜底：索引缺失/读坏/以及每小时一次，
 *       用一次真 list 重建（约 24 次/天，另计在额度内）；
 *     - 最坏情况：某任务从面板消失，但 job:<id> 记录本身完好，
 *       APP 的 /api/status 仍能查到，cron 也仍在推它——只是面板看不见。
 *
 * 成本：面板路径从 1 list + N get 变成 1 get（索引）+ N get（任务）。
 * get 的额度是 10 万/天，这是用便宜的换昂贵的，与信号灯同一思路。
 */

import type { Env } from "../../shared/types";

/** job_id 索引 key。 */
const JOB_IDS_KEY = "meta:job_ids";

/** 索引重建的节流时间 key。 */
const INDEX_ATTEMPT_KEY = "meta:job_ids_attempt_at";

/** 索引保留的最大条数。面板 limit 上限 200，取同值避免截断真实数据。 */
export const JOB_IDS_MAX = 200;

/**
 * 索引重建的节流窗口。
 *
 * 为什么必须在 KV 而不是 isolate 内存里：内存的话每个 isolate 各记一份，
 * Cloudflare 随时起新 isolate，"10 分钟一次"会退化成"每 isolate 每 10 分钟"，
 * 实例一多就等于没节流。
 */
export const INDEX_REBUILD_THROTTLE_MS = 10 * 60_000;

/** 读索引。缺失 / JSON 坏 → null（调用方应走 list 兜底并重建）。 */
export async function readJobIds(env: Env): Promise<string[] | null> {
  try {
    const raw = await env.EDGE_RELAY_KV.get(JOB_IDS_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((v): v is string => typeof v === "string");
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/**
 * 追加一个 job_id 到索引头部（最新在前）。
 *
 * 读-改-写：理论上两个并发建任务会互相覆盖，丢一个 id。已评估可接受：
 * 频率极低（一天几次、需同一毫秒），后果是面板少显示一条（记录本身
 * 完好、APP 可查），且 rebuildJobIds 会补回。
 */
export async function appendJobId(env: Env, jobId: string): Promise<void> {
  const cur = await readJobIds(env);
  const next = [jobId, ...(cur ?? [])].slice(0, JOB_IDS_MAX);
  try {
    await env.EDGE_RELAY_KV.put(JOB_IDS_KEY, JSON.stringify(next));
  } catch {
    /* 索引写失败不阻塞建任务：rebuildJobIds 会补 */
  }
}

/**
 * 用一次真实 list 重建索引。返回重建出的 id 数。
 *
 * 调用前必须先过 `shouldAttemptIndexRebuild` 的节流——额度耗尽时这是个
 * 会自残的路径：list 失败、索引仍未建立、下一次请求再来撞一次。
 */
export async function rebuildJobIds(env: Env, limit = JOB_IDS_MAX): Promise<number> {
  // 先记尝试时间：list 抛错时也要留下痕迹，否则节流失效。
  await markIndexRebuildAttempt(env);
  const listed = await env.EDGE_RELAY_KV.list({ prefix: "job:", limit });
  // list 按 key 字典序返回，而 job_id 前缀是逆序时间 → 天然是新→旧，
  // 与索引约定一致，无需再排序。
  const ids = listed.keys.map((k) => k.name.slice("job:".length));
  try {
    await env.EDGE_RELAY_KV.put(JOB_IDS_KEY, JSON.stringify(ids));
  } catch {
    /* 同上：写失败不阻塞 */
  }
  return ids.length;
}

/** 距上次尝试是否已超过节流窗口。读失败 → true（宁可多试一次）。 */
export async function shouldAttemptIndexRebuild(
  env: Env,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const raw = await env.EDGE_RELAY_KV.get(INDEX_ATTEMPT_KEY);
    const last = raw ? Number.parseInt(raw, 10) : 0;
    if (!Number.isFinite(last) || last <= 0) return true;
    return nowMs - last > INDEX_REBUILD_THROTTLE_MS;
  } catch {
    return true;
  }
}

/** 记录一次尝试（不论成败）。 */
export async function markIndexRebuildAttempt(
  env: Env,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    await env.EDGE_RELAY_KV.put(INDEX_ATTEMPT_KEY, String(nowMs));
  } catch {
    /* 写失败只会让下一次多试一次，无害 */
  }
}
