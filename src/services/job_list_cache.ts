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
 */

/** 列表结果缓存 15 秒：面板轮询再频繁也只在缓存过期时真的读 KV。 */
export const CACHE_TTL_MS = 15_000;

export interface CachedList {
  at: number;
  limit: number;
  payload: unknown;
}

/**
 * isolate 级缓存。
 *
 * 为什么安全：任务列表是「他自己的面板在看」的只读视图，15 秒的陈旧
 * 对体验无影响（构建本身要几分钟）。而省下的是数量级的 KV 调用。
 *
 * 不缓存单任务状态查询（/api/status）：那是 APP 轮询的热路径，
 * 单次 get 成本低，且新鲜度对「刚跑完要立刻看到」很关键。
 */
let cache: CachedList | null = null;

export function readJobsCache(): CachedList | null {
  return cache;
}

export function writeJobsCache(entry: CachedList): void {
  cache = entry;
}

/** 写操作后清缓存，让面板立刻看到新任务。 */
export function invalidateJobsCache(): void {
  cache = null;
}
