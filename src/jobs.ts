/**
 * GET /api/jobs — 管理台任务列表。
 *
 * 与 APP 用的 /api/status/:jobId 不同：这里一次要看多个任务，
 * 所以是独立的只读接口。同样走 cookie 或 Bearer 双通道（见 router.ts）。
 *
 * 性能约束（KV 免费额度很低，必须省）：
 *   免费额度：KV 读 100k/天，KV **list 仅 1k/天**。
 *   原实现是 N+1：list(100) + 每个 key 各 get 一次 = 101 次操作/请求。
 *   面板 5 秒轮询挂 8 小时 → 约 58 万次读、5760 次 list，直接把额度打爆。
 *
 *   KV 没有批量 get，所以省不掉逐个读。真正的解法是「少读、少轮」：
 *     1. 用内存短缓存吸收高频轮询（同一 isolate 内 15s 内只打一次 KV）
 *     2. 前端只在「确有进行中任务」时轮询，且间隔拉长
 *   见 frontend/src/views/Dashboard.vue 的 startPolling。
 */

import type { BuildJob, Env } from "./types";
import { toAppStatus } from "./kv_store";
import { json } from "./http";

/** 列表结果缓存 15 秒：面板轮询再频繁也只在缓存过期时真的读 KV。 */
const CACHE_TTL_MS = 15_000;

interface CachedList {
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

export async function handleListJobs(env: Env, url: URL): Promise<Response> {
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS && cache.limit >= limit) {
    return json(cache.payload);
  }

  const listed = await env.EDGE_RELAY_KV.list({ prefix: "job:", limit });
  const jobs: BuildJob[] = [];

  // 逐个 get 无法避免（KV 无批量读）。但只在缓存过期时执行，
  // 实际频率从"每次轮询"降到"每 15 秒一次"。
  for (const key of listed.keys) {
    const raw = await env.EDGE_RELAY_KV.get(key.name);
    if (!raw) continue;
    try {
      jobs.push(JSON.parse(raw) as BuildJob);
    } catch {
      /* 跳过坏行 */
    }
  }
  jobs.sort((a, b) => b.created_at_ms - a.created_at_ms);

  const payload = {
    jobs: jobs.map((j) => ({
      job_id: j.job_id,
      status: j.status,
      app_status: toAppStatus(j),
      conclusion: j.conclusion,
      download_url: j.download_url,
      error: j.error,
      created_at_ms: j.created_at_ms,
      workflow_file: j.workflow_file,
      display_name: j.display_name,
    })),
    // 前端据此决定还要不要继续轮询：没有在途任务就停下来。
    has_active: jobs.some((j) => j.status !== "completed"),
  };

  cache = { at: now, limit, payload };
  return json(payload);
}

/** 写操作后清缓存，让面板立刻看到新任务。 */
export function invalidateJobsCache(): void {
  cache = null;
}
