/**
 * GET /api/jobs — 管理台任务列表。
 *
 * 与 APP 用的 /api/status/:jobId 不同：这里一次要看多个任务，
 * 所以是独立的只读接口。同样走 cookie 或 Bearer 双通道（见 router.ts）。
 *
 * KV 额度（Cloudflare 免费档，见 developers.cloudflare.com/kv/platform/pricing）：
 *   reads  100,000 / 天
 *   writes  1,000 / 天
 *   lists   1,000 / 天   ← 比 reads 少 100 倍，是最稀缺的资源
 *
 * 历史上的错误认知：只盯着「面板 5 秒轮询会打爆读额度」，据此做了
 * 15s 缓存。但真正超标的是另外两条路径，且都与面板无关：
 *   1. cron 每分钟调 listOpenJobs → 1440 list/天，超 list 额度 44%
 *      （见 reconcile.ts 的 120s 缓存）
 *   2. refreshInProgress 每分钟 patchJob，状态没变也写
 *      → 20 分钟任务写 20 次，写额度只够 50 个任务
 *      （见 reconcile.ts 的 60s 节流）
 *
 * 本文件的缓存只解决面板这一条路径。
 *
 * 性能约束：
 *   1. 用内存短缓存吸收高频轮询（同一 isolate 内 15s 内只打一次 KV）
 *   2. 前端只在「确有进行中任务」时轮询，且间隔线性递增
 *   3. has_active 排除停滞任务，避免僵尸任务让前端永不停
 *   见 frontend/src/views/Dashboard.vue 的 startPolling。
 */

import type { BuildJob, Env } from "./types";
import { isStalled, toAppStatus } from "./kv_store";
import { json, error } from "./http";

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

  // 整个读路径包在 try 里：KV 抖动（namespace 未绑、额度打满、瞬时故障）
  // 不该让面板拿到一句「网关内部错误」——那是路由的总兜底，指不到任何
  // 具体原因。这里降级成 503 + 可读原因，用户知道该去看什么。
  let listed: { keys: { name: string }[] };
  let jobs: BuildJob[];
  try {
    listed = await env.EDGE_RELAY_KV.list({ prefix: "job:", limit });
    jobs = [];

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
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("list jobs failed", { error: detail });
    // 若有旧缓存，宁可给陈旧数据也别让面板空手——比报错好用。
    if (cache) return json(cache.payload);
    return error(
      503,
      "upstream_error",
      `读取任务列表失败：${detail}（检查 KV namespace 绑定与当日额度）`,
    );
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
      modules: j.modules ?? [],
      // 有 run_id 才可能有日志（artifact 是流水线跑起来才产生的）
      can_log: j.run_id !== null,
    })),
    // 前端据此决定还要不要继续轮询：没有在途任务就停下来。
    //
    // 停滞任务（queued 且补不上 run_id）必须算作非活跃，否则前端会永远
    // 轮询下去——它自己永远等不到 completed，而后端已把它判死。
    has_active: jobs.some(
      (j) => j.status !== "completed" && !isStalled(env, j),
    ),
  };

  cache = { at: now, limit, payload };
  return json(payload);
}

/** 写操作后清缓存，让面板立刻看到新任务。 */
export function invalidateJobsCache(): void {
  cache = null;
}
