/**
 * 构建提交的幂等映射：`client_request_id → job_id`。
 *
 * 为什么需要（一次线上问题的直接产物，见 docs/变更历史.md）：
 *
 *   APP 触发构建时，`POST /api/build` 超时会被判为失败——但网关的顺序是
 *   **先 putNewJob 落库、再 dispatchWorkflow**，所以"超时"完全可能发生在
 *   「服务端已经建成任务、GitHub 已经在跑」之后。此时 APP 手里没有 job_id
 *   （响应没回来），只能把本地任务标成 FAILED 并留一个假的 `PENDING_<ts>`。
 *   结果就是：网关有任务、流水线成功、APP 永远显示失败，且「重新查询」
 *   无从下手——它不知道该查哪个 job。
 *
 *   事后按「创建时间窗」去 /api/jobs 猜能救回来，但那是启发式：
 *   同一分钟内提交两个任务就有歧义。要根治必须让**同一次提交可被重新识别**。
 *
 * 做法：APP 在提交前生成一个 UUID 作为 `client_request_id` 并本地落库，
 * 提交时带上。网关把它与 job_id 的对应关系存 KV：
 *   - 收到带相同 client_request_id 的请求 → 直接返回已有 job_id，不重复 dispatch
 *   - APP 事后可以用 `GET /api/build/idem/<client_request_id>` 精确查回 job_id
 *
 * ⚠️ 这不是严格的分布式幂等。KV 最终一致（跨地域最长约 60s），且没有
 *    compare-and-swap，所以两个**完全相同**的请求若在同一瞬间到达不同
 *   isolate，仍可能各建一个任务。本模块解决的是实际发生的那个场景：
 *   客户端超时后**隔几秒**重试（同地域、读自己的写），此时映射必然可见。
 *    若将来需要严格幂等，正确解是 Durable Object 或 D1 的唯一索引。
 */

import type { Env } from "../../shared/types";

/**
 * 映射保留时长：24 小时。
 *
 * 依据：重试/补救都发生在「任务刚提交后」的分钟级窗口内。24 小时足够覆盖
 * 「用户第二天打开 APP 才想起来点重新查询」，又不会长期占 KV。
 * 注意它与任务记录本身的 TTL（JOB_RETENTION_DAYS，默认 7 天）是两回事：
 * 映射先过期不影响任务可查，只是「按 client_request_id 反查」失效。
 */
export const IDEM_TTL_SECONDS = 24 * 60 * 60;

/**
 * client_request_id 的合法形态。
 *
 * 限制字符集是为了让它能安全地进 KV key（冒号是 key 里的分隔符）与 URL 路径。
 * 宽松到足够容纳 UUID（含连字符）、nanoid、以及带前缀的自定义格式。
 */
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/** 校验客户端 ID。空串视为「未提供」（兼容旧版 APP），返回 null 而非报错。 */
export function normalizeClientRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return CLIENT_REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * 幂等 key：`idem:<owner>:<client_request_id>`。
 *
 * 必须带 owner：client_request_id 由客户端生成，不同设备/不同令牌有可能
 * 撞上同一个值（例如都用了固定前缀）。带上归属 ID 才能保证 A 的请求不会
 * 把 B 的 job_id 返回给 A——那等于跨任务越权读取。
 */
function idemKey(owner: string, clientRequestId: string): string {
  return `idem:${owner}:${clientRequestId}`;
}

/** 查已绑定的 job_id。未绑定 / 读失败 → null（宁可多建一个，不可卡死）。 */
export async function getJobIdByClientRequestId(
  env: Env,
  owner: string,
  clientRequestId: string,
): Promise<string | null> {
  try {
    const raw = await env.EDGE_RELAY_KV.get(idemKey(owner, clientRequestId));
    const id = (raw ?? "").trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * 绑定 client_request_id → job_id。
 *
 * 调用时机必须在 **dispatchWorkflow 之前**：否则「已落库、正在 dispatch」
 * 这段时间里到达的重试会读不到映射，从而重复 dispatch——而这正是要防的。
 *
 * 写失败不抛出：幂等只是「防重复」的优化，不能因为 KV 抖动让一次正常的
 * 构建请求失败。失败时退化为旧行为（可能产生一个孤儿任务），可接受。
 */
export async function bindClientRequestId(
  env: Env,
  owner: string,
  clientRequestId: string,
  jobId: string,
): Promise<void> {
  try {
    await env.EDGE_RELAY_KV.put(idemKey(owner, clientRequestId), jobId, {
      expirationTtl: IDEM_TTL_SECONDS,
    });
  } catch {
    /* 见上：不阻塞构建 */
  }
}
