/**
 * KV 用量记账 + 额度仪表盘数据。
 *
 * ── 为什么必须自己记账 ─────────────────────────────────────────────
 *
 * Cloudflare 的 GraphQL Analytics API **没有 KV 数据集**。Workers 请求数、
 * CPU 时间、错误数都能查到，但 KV 的读/写/list 次数查不到——只能在控制台
 * 肉眼看。
 *
 * 而 KV 恰恰是这个项目最稀缺的资源（免费档：读 10 万/天、写 1000/天、
 * list 1000/天）。所以要看清额度，只能自己数。
 *
 * ── 怎么数得不亏本 ─────────────────────────────────────────────────
 *
 * 困境：把计数存进 KV 本身就要花 KV 写额度。每 2 分钟 flush 一次
 * = 720 写/天，直接吃掉 72% 的写额度——比不统计还糟。
 *
 * 解法三层：
 *   1. **Proxy 拦截**：在 router 入口把 env.EDGE_RELAY_KV 包一层计数代理，
 *      19 个调用点一行都不用改。
 *   2. **内存累加**：计数只存在 isolate 内存里，不碰 KV。
 *   3. **低频 flush**：最多每 30 分钟落一次盘，且计数没变化就不写。
 *      上限 48 写/天 = 额度的 4.8%。冷启动会丢一点计数，可接受。
 *
 * ── 为什么额度上限是硬编码常量 ─────────────────────────────────────
 *
 * Cloudflare 没有"查询我的免费额度上限"的 API，那些数字只存在于文档里。
 * 这里硬编码 2026-10 的免费档数值，并在响应里带上 `source: "doc-2026-10"`，
 * 将来额度调整时一眼能看出数据出处。
 */

import type { Env } from "../shared/types";

/** 免费额度上限。来源：developers.cloudflare.com/kv/platform/limits/ */
export const KV_LIMITS = {
  reads: 100_000,
  writes: 1_000,
  lists: 1_000,
  deletes: 1_000,
} as const;

/** Workers 免费档。来源：workers/platform/limits/ */
export const WORKERS_LIMITS = {
  requests: 100_000,
  cpuMsPerDay: 10 * 60 * 1000,
} as const;

/** flush 间隔：30 分钟。48 写/天，占写额度 4.8%。 */
const FLUSH_INTERVAL_MS = 30 * 60_000;

/** 计数快照。 */
export interface KvCounters {
  reads: number;
  writes: number;
  lists: number;
  deletes: number;
}

/** 当日用量（含跨 isolate 持久化的部分 + 本 isolate 未落盘的增量）。 */
export interface UsageSnapshot extends KvCounters {
  /** UTC 日期，形如 2026-10-23。KV 免费额度按 UTC 零点重置。 */
  date: string;
  /** 数据来源标记，便于判断是否过期或仅是估算。 */
  source: "instrumented" | "doc-2026-10";
  /** 本次 isolate 的增量是否已落盘。false 表示数字可能偏小。 */
  flushed: boolean;
}

/** isolate 内存里的当日计数。 */
let counters: KvCounters = { reads: 0, writes: 0, lists: 0, deletes: 0 };
/** counters 对应的 UTC 日期，跨日时清零。 */
let counterDate = utcDate();
/** 上次 flush 时间（0 = 从未）。 */
let lastFlushAt = 0;

function utcDate(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function usageKey(date: string): string {
  return `meta:usage:${date}`;
}

/** 跨日时把内存计数清零（KV 额度按 UTC 零点重置）。 */
function rolloverIfNeeded(now: number = Date.now()): void {
  const today = utcDate(now);
  if (today !== counterDate) {
    counterDate = today;
    counters = { reads: 0, writes: 0, lists: 0, deletes: 0 };
    lastFlushAt = 0;
  }
}

/** 记录一次 KV 操作。Proxy 里调用。 */
export function recordKvOp(op: keyof KvCounters, n = 1): void {
  rolloverIfNeeded();
  counters[op] += n;
}

/**
 * 把 env.EDGE_RELAY_KV 包成计数代理。
 *
 * 为什么用 Proxy 而不是改 19 个调用点：调用点分散在 kv/jobs.ts、
 * kv/signal.ts、kv/job_index.ts、config.ts、health.ts 里，逐个包一层
 * 既啰嗦又容易漏。在入口处包一次，所有经 env 的访问都被记到。
 *
 * 注意：只统计 `env.EDGE_RELAY_KV`。usage 模块自己落盘时必须用
 * **原始** KV（见 flushUsage 的 rawKv 参数），否则会把记账本身的写入
 * 也计入用量，形成自我放大。
 */
export function wrapKvWithCounter(kv: KVNamespace): KVNamespace {
  // 没有绑定时（KV 未配置）原样返回，proxy 会因 undefined 抛错。
  if (!kv) return kv;

  const wrapFn = (op: keyof KvCounters, fn: (...args: never[]) => unknown) =>
    function (this: unknown, ...args: never[]) {
      recordKvOp(op);
      return fn.apply(kv, args);
    };

  return new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return wrapFn("reads", target.get.bind(target) as (...args: never[]) => unknown);
      }
      if (prop === "put") {
        return wrapFn("writes", target.put.bind(target) as (...args: never[]) => unknown);
      }
      if (prop === "list") {
        return wrapFn("lists", target.list.bind(target) as (...args: never[]) => unknown);
      }
      if (prop === "delete") {
        return wrapFn("deletes", target.delete.bind(target) as (...args: never[]) => unknown);
      }
      // getWithMetadata 在 Cloudflare 里也算一次读
      if (prop === "getWithMetadata") {
        return wrapFn(
          "reads",
          target.getWithMetadata.bind(target) as (...args: never[]) => unknown,
        );
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 把内存增量落盘（低频，带节流）。
 *
 * @param rawKv 原始 KV，**不能**是计数代理——否则这次写入会被记进
 *              用量，造成"统计本身消耗额度"的自我放大。
 * @param force 强制落盘（测试或显式刷新用）
 * @returns 是否真的写了
 */
export async function flushUsage(
  rawKv: KVNamespace,
  force = false,
  now: number = Date.now(),
): Promise<boolean> {
  rolloverIfNeeded(now);
  const pending =
    counters.reads + counters.writes + counters.lists + counters.deletes;
  if (pending === 0) return false;
  if (!force && now - lastFlushAt < FLUSH_INTERVAL_MS) return false;

  const date = counterDate;
  const existing = await readPersistedUsageRaw(rawKv, date);
  const merged: KvCounters = {
    reads: existing.reads + counters.reads,
    writes: existing.writes + counters.writes,
    lists: existing.lists + counters.lists,
    deletes: existing.deletes + counters.deletes,
  };

  try {
    await rawKv.put(usageKey(date), JSON.stringify(merged), {
      // 用量记录保留 40 天：够回看趋势，也不会永久堆积。
      expirationTtl: 40 * 24 * 60 * 60,
    });
  } catch {
    // 落盘失败不影响业务：最坏情况是这次增量丢失，下次 flush 会带上
    // 新的增量。不重试以避免在额度紧张时反复撞失败。
    return false;
  }

  // 落盘成功才清零，避免写失败时数据凭空消失。
  counters = { reads: 0, writes: 0, lists: 0, deletes: 0 };
  lastFlushAt = now;
  return true;
}

/** 内部用：读已落盘数值（不经过计数代理，避免自己记自己）。 */
async function readPersistedUsageRaw(
  rawKv: KVNamespace,
  date: string,
): Promise<KvCounters> {
  if (!rawKv) return { reads: 0, writes: 0, lists: 0, deletes: 0 };
  try {
    const raw = await rawKv.get(usageKey(date));
    if (!raw) return { reads: 0, writes: 0, lists: 0, deletes: 0 };
    const p = JSON.parse(raw) as Partial<KvCounters>;
    return {
      reads: Number(p.reads) || 0,
      writes: Number(p.writes) || 0,
      lists: Number(p.lists) || 0,
      deletes: Number(p.deletes) || 0,
    };
  } catch {
    return { reads: 0, writes: 0, lists: 0, deletes: 0 };
  }
}

/**
 * 取当日用量总览（已落盘 + 本 isolate 未落盘增量）。
 */
export async function getUsage(
  rawKv: KVNamespace,
  now: number = Date.now(),
): Promise<UsageSnapshot> {
  rolloverIfNeeded(now);
  const date = counterDate;
  const persisted = await readPersistedUsageRaw(rawKv, date);
  return {
    date,
    reads: persisted.reads + counters.reads,
    writes: persisted.writes + counters.writes,
    lists: persisted.lists + counters.lists,
    deletes: persisted.deletes + counters.deletes,
    source: "instrumented",
    flushed: lastFlushAt > 0 && now - lastFlushAt < FLUSH_INTERVAL_MS,
  };
}

/** 仅供测试：重置模块内状态。 */
export function __resetUsageForTests(): void {
  counters = { reads: 0, writes: 0, lists: 0, deletes: 0 };
  counterDate = utcDate();
  lastFlushAt = 0;
}
