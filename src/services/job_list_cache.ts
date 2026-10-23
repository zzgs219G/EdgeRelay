/**
 * 面板任务列表的 isolate 级短缓存。
 *
 * 为什么从 routes/jobs.ts 里拆出来：`routes/build.ts` 建完任务后需要
 * `invalidateJobsCache()`，而 handler 反过来 import 另一个 handler 是
 * 明确的层次违规（还会随路由增加演变成环）。缓存是共享状态，属于服务层。
 *
 * KV 额度（Cloudflare 免费档，见 developers.cloudflare.com/kv/platform/pricing）：
 *   reads  100,000 / 天
 *   writes  1,000 / 天
 *   lists   1,000 / 天   ← 比 reads 少 100 倍，是最稀缺的资源
 *
 * 本文件的缓存只解决「面板高频轮询」这一条路径：
 *   1. 用内存短缓存吸收高频轮询（同一 isolate 内 15s 只打一次 KV）
 *   2. 前端只在「确有进行中任务」时轮询，且间隔线性递增
 *   见 frontend/src/views/Dashboard.vue 的 startPolling。
 *
 * ── 为什么缓存要按主体分桶 ──────────────────────────────────────────
 *
 * 加了任务归属之后，不同令牌看到的列表内容不同（各自只能看自己的任务）。
 * 早期版本为了避开串味，直接对非面板主体**禁用缓存**——那是错的：
 * 令牌恰恰是高频轮询的一方（APP 每 5 秒一次），禁用等于把它打回
 * 每次都真读 KV，反而把读额度打爆。
 *
 * 现在按 `principal.id` 分桶：每个主体一份独立缓存，互不串味，
 * 且各自都能享受 15s 合并窗口。桶数量有上限，超出按最旧淘汰。
 */

/** 列表结果缓存 15 秒：面板轮询再频繁也只在缓存过期时真的读 KV。 */
export const CACHE_TTL_MS = 15_000;

/** 最多保留多少个主体的缓存。令牌数量极少（个位数），32 足够。 */
const MAX_BUCKETS = 32;

export interface CachedList {
  at: number;
  limit: number;
  payload: unknown;
}

/**
 * 按主体分桶的缓存。
 *
 * 为什么安全：任务列表是「他自己的面板/APP 在看」的只读视图，15 秒的陈旧
 * 对体验无影响（构建本身要几分钟）。而省下的是数量级的 KV 调用。
 *
 * 不缓存单任务状态查询（/api/status）：那是 APP 轮询的热路径，
 * 单次 get 成本低，且新鲜度对「刚跑完要立刻看到」很关键。
 */
const buckets = new Map<string, CachedList>();

export function readJobsCache(ownerId: string): CachedList | null {
  return buckets.get(ownerId) ?? null;
}

export function writeJobsCache(ownerId: string, entry: CachedList): void {
  buckets.set(ownerId, entry);
  if (buckets.size > MAX_BUCKETS) {
    // 淘汰最旧的一个（Map 保持插入顺序，第一个就是最旧的）。
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }
}

/** 写操作后清缓存，让所有主体立刻看到新任务。 */
export function invalidateJobsCache(): void {
  buckets.clear();
}
