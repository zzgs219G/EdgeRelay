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
 * 本路由的两道闸：
 *   1. 读 job_id 索引替代 list（见 services/kv/job_index.ts）
 *   2. 15s 内存缓存吸收面板高频轮询（见 services/job_list_cache.ts）
 *
 * 性能约束（前端配合）：
 *   - 前端只在「确有进行中任务」时轮询，且间隔线性递增
 *   - has_active 排除停滞任务，避免僵尸任务让前端永不停
 *   见 frontend/src/views/Dashboard.vue 的 startPolling。
 */

import type { BuildJob, Env } from "../shared/types";
import { isStalled, toAppStatus } from "../domain/job";
import {
  getJobsByIds,
  JOB_IDS_MAX,
  readJobIds,
  rebuildJobIds,
  shouldAttemptIndexRebuild,
} from "../services/kv";
import { canAccessJob, type Principal } from "../services/principal";
import { CACHE_TTL_MS, readJobsCache, writeJobsCache } from "../services/job_list_cache";
import { json } from "../shared/http";

export async function handleListJobs(
  env: Env,
  url: URL,
  principal: Principal,
): Promise<Response> {
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const now = Date.now();
  // 缓存按主体分桶：不同令牌看到的列表不同，不能共用一份。
  // 但也不能为此禁用缓存——令牌（APP）恰恰是轮询最频繁的一方。
  const cachedList = readJobsCache(principal.id);
  if (cachedList && now - cachedList.at < CACHE_TTL_MS && cachedList.limit >= limit) {
    return json(cachedList.payload);
  }

  // 整个读路径包在 try 里：KV 抖动（namespace 未绑、额度打满、瞬时故障）
  // 不该让面板拿到一句「网关内部错误」——那是路由的总兜底，指不到任何
  // 具体原因。
  let jobs: BuildJob[];
  let degraded = false;
  try {
    const loaded = await loadRecentJobs(env, limit);
    jobs = loaded.jobs;
    degraded = loaded.degraded;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("list jobs failed", { error: detail });
    // 若有旧缓存，宁可给陈旧数据也别让面板空手——比报错好用。
    if (cachedList) return json(cachedList.payload);
    jobs = [];
    degraded = true;
  }
  jobs.sort((a, b) => b.created_at_ms - a.created_at_ms);

  // 归属过滤：令牌只能看到自己的任务；面板是管理员，看全部。
  // 过滤发生在取数之后，因为 job_id 索引本身不记录归属（那会让索引
  // 结构变复杂），而单次 get 的额度（10 万/天）足够覆盖这个过滤。
  const visible = principal.kind === "panel"
    ? jobs
    : jobs.filter((j) => canAccessJob(principal, j.owner));

  const payload = {
    jobs: visible.map((j) => ({
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
    //
    // 降级时（拿不到列表）也算非活跃：没有数据就不该继续轮询，
    // 那只会每 15 秒去撞一次注定失败的 list。
    has_active: !degraded && visible.some((j) => j.status !== "completed" && !isStalled(env, j)),
    // 拿不到列表时给前端一句人话。降级时仍返回 200：这不是网关故障，
    // 是 KV list 当日额度用尽，报 503 只会让人误以为服务挂了而反复刷新。
    notice: degraded
      ? "任务列表暂不可用：KV list 当日额度已用尽，00:00 UTC 重置后自动恢复"
      : null,
  };

  writeJobsCache(principal.id, { at: now, limit, payload });
  return json(payload);
}

/**
 * 取最近 N 条任务。**优先读索引，不调 list。**
 *
 * 为什么（线上故障的直接产物）：面板只要停在 Dashboard 就在轮询这个接口，
 * 而它原来每 15s 一次 list。缓存是 isolate 级的、跨实例形同虚设，
 * 实际轻松打出每天几千次 list —— KV list 额度只有 1000/天，于是整个
 * 面板 503「KV list() limit exceeded for the day」。
 *
 * 现在：1 次 get 读索引 + N 次 get 读任务，0 次 list。
 * get 的额度是 10 万/天，这是用便宜的换昂贵的。
 *
 * `degraded: true` 的含义：拿不到任务列表，但这不是故障——最常见的原因是
 * KV list 当日额度用尽（00:00 UTC 重置）。此时返回空列表 + 标记，让前端
 * 显示一句提示，而不是每轮请求都去撞一次注定失败的 list。
 */
async function loadRecentJobs(
  env: Env,
  limit: number,
): Promise<{ jobs: BuildJob[]; degraded: boolean }> {
  const ids = await readJobIds(env);
  if (ids !== null) {
    return { jobs: await getJobsByIds(env, ids.slice(0, limit)), degraded: false };
  }

  // 索引不可用 → 兜底：真 list 一次，并重建索引供后续使用。
  //
  // 但必须先过节流。曾经的实现没有节流，于是形成自残循环：
  //   索引没建 → 调 list → 额度已耗尽、list 抛错 → 索引还是没建
  //   → 下一次轮询再来一遍
  // 用户看到的就是一句反复出现的「KV list() limit exceeded」，且每次重试
  // 都在消耗（失败的 list 同样计入 Cloudflare 的操作计数）。
  if (!(await shouldAttemptIndexRebuild(env))) {
    return { jobs: [], degraded: true };
  }

  try {
    await rebuildJobIds(env, Math.max(limit, JOB_IDS_MAX));
    const rebuilt = (await readJobIds(env)) ?? [];
    return { jobs: await getJobsByIds(env, rebuilt.slice(0, limit)), degraded: false };
  } catch (err) {
    // list 失败（多半是额度耗尽）。不抛：抛上去只会让面板拿到 503，
    // 而 503 不会让任何人去修 KV——它只会让用户反复刷新。
    console.error("job id index rebuild failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { jobs: [], degraded: true };
  }
}
