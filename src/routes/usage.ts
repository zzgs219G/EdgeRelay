/**
 * GET /api/usage — 额度仪表盘数据。
 *
 * 数据来源分两类，必须在响应里区分清楚，否则用户会拿估算值当权威：
 *
 *   1. **KV 用量** — 自己记账（services/usage.ts）。Cloudflare 的
 *      GraphQL Analytics API 没有 KV 数据集，官方查不到，只能自己数。
 *
 *   2. **Workers 请求数** — 配了 CF_API_TOKEN 且给了 account tag 时，
 *      走 GraphQL Analytics（workersInvocationsAdaptive）。没配则返回
 *      null，前端显示"未接入"，**绝不编造数字**。
 *
 * D1 与 Pages 在本项目未启用（wrangler.toml 里没有 d1_databases，
 * 部署形态是 Workers + assets 而非 Pages），响应里如实标记 enabled:false。
 */

import type { Env } from "../shared/types";
import type { ResolvedEnv } from "../services/config";
import {
  getUsage,
  KV_LIMITS,
  WORKERS_LIMITS,
  type KvCounters,
} from "../services/usage";
import { readJobIds } from "../services/kv";
import { json } from "../shared/http";

/** Workers 请求数查询的超时。GraphQL 偶尔很慢，不能拖住整个面板。 */
const GRAPHQL_TIMEOUT_MS = 8_000;

interface WorkersUsage {
  requests: number;
  errors: number;
  /** 数据窗口（UTC 当日 00:00 到现在）。 */
  since: string;
  until: string;
}

/**
 * 查 Workers 请求数（可选）。
 *
 * 需要两个配置：
 *   CF_API_TOKEN       — 权限：Account → Account Analytics → Read
 *   CF_ACCOUNT_ID      — 32 位账户 tag
 *
 * 任缺其一就返回 null（前端显示"未接入"），而不是静默返回 0——
 * 0 会被误读成"今天没有请求"。
 */
async function fetchWorkersUsage(env: ResolvedEnv): Promise<WorkersUsage | null> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (!token || !accountId) return null;

  const now = new Date();
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const query = `query($accountTag: string, $since: string, $until: string) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 1000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum {
            requests
            errors
          }
        }
      }
    }
  }`;

  try {
    const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: accountId,
          since: startOfDay.toISOString(),
          until: now.toISOString(),
        },
      }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });

    if (!resp.ok) {
      // 401/403 多半是 token 权限不对，把状态码带进日志便于排障。
      console.error("graphql usage query failed", { status: resp.status });
      return null;
    }

    const body = (await resp.json()) as {
      data?: {
        viewer?: {
          accounts?: {
            workersInvocationsAdaptive?: { sum?: { requests?: number; errors?: number } }[];
          }[];
        };
      };
      errors?: unknown;
    };

    if (body.errors) {
      console.error("graphql usage query returned errors", {
        errors: JSON.stringify(body.errors).slice(0, 300),
      });
      return null;
    }

    const rows =
      body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    const requests = rows.reduce((n, r) => n + (r.sum?.requests ?? 0), 0);
    const errors = rows.reduce((n, r) => n + (r.sum?.errors ?? 0), 0);

    return { requests, errors, since: startOfDay.toISOString(), until: now.toISOString() };
  } catch (err) {
    console.error("graphql usage query threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** 把计数换成"用量 + 额度 + 百分比"，前端直接渲染进度条。 */
function withLimits(c: KvCounters) {
  return {
    reads: {
      used: c.reads,
      limit: KV_LIMITS.reads,
      pct: pct(c.reads, KV_LIMITS.reads),
    },
    writes: {
      used: c.writes,
      limit: KV_LIMITS.writes,
      pct: pct(c.writes, KV_LIMITS.writes),
    },
    lists: {
      used: c.lists,
      limit: KV_LIMITS.lists,
      pct: pct(c.lists, KV_LIMITS.lists),
    },
    deletes: {
      used: c.deletes,
      limit: KV_LIMITS.deletes,
      pct: pct(c.deletes, KV_LIMITS.deletes),
    },
  };
}

function pct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 1000) / 10);
}

export async function handleUsage(
  env: ResolvedEnv,
  rawKv: KVNamespace,
): Promise<Response> {
  const [usage, workers, jobIds] = await Promise.all([
    getUsage(rawKv),
    fetchWorkersUsage(env),
    readJobIds(env),
  ]);

  // 构建次数额度：Cloudflare Workers Builds 没有公开 API 可查。
  // 用自己任务表里保留的 job 数作为下界近似——索引上限 200 条，
  // 超过就只能说明"至少 200"。这里如实标注是近似值。
  const trackedJobs = jobIds?.length ?? 0;
  const jobIndexFull = trackedJobs >= 200;

  return json({
    ok: true,
    generated_at: Date.now(),
    /** KV 用量按 UTC 日重置，与 Cloudflare 计费窗口一致。 */
    date: usage.date,
    kv: {
      ...withLimits(usage),
      source: usage.source,
      /** false = 本 isolate 有未落盘的增量，数字可能略偏小。 */
      flushed: usage.flushed,
      /** 额度上限来自文档常量，不是 API 查询结果。 */
      limits_source: "doc-2026-10",
    },
    workers: workers
      ? {
          requests: {
            used: workers.requests,
            limit: WORKERS_LIMITS.requests,
            pct: pct(workers.requests, WORKERS_LIMITS.requests),
          },
          errors: workers.errors,
          window: { since: workers.since, until: workers.until },
          source: "graphql",
        }
      : {
          // 未接入时明确说 null，绝不编造 0
          requests: null,
          errors: null,
          source: "unconfigured",
          hint: "配置 CF_API_TOKEN（Account Analytics: Read）与 CF_ACCOUNT_ID 后可见",
        },
    builds: {
      /** 任务表里当前保留的任务数（近似"构建次数"）。 */
      tracked: trackedJobs,
      /** true = 索引已达上限，真实构建数可能更多。 */
      index_full: jobIndexFull,
      source: "job-index",
      hint: "Cloudflare Workers Builds 无公开用量 API；此值来自网关自己的任务索引",
    },
    /** 本项目未启用的资源，如实标注而非省略。 */
    unavailable: {
      d1: "本项目未绑定 D1（wrangler.toml 无 d1_databases）",
      pages: "本项目部署形态为 Workers + assets，不使用 Pages",
    },
  });
}
