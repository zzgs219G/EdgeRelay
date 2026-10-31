/**
 * workflow 列表与 inputs 元数据的 isolate 级缓存。
 *
 * ── 为什么需要它（2026-10-30 用户日志） ──────────────────────────────
 *
 *   [04:33] <-- 200 /api/workflows?with_inputs=1  (16708ms)
 *   [04:48] <-- 200 /api/workflows               (32068ms)
 *
 * 两次相隔 15 分钟，拉的是**同一份数据**，却各自重新跑了一遍上游：
 *
 *   listWorkflows()         → GitHub 1 次调用
 *   fetchWorkflowInputs()   → 每个 workflow 各 1 次（并发，但受链路延迟支配）
 *
 * workflow 列表与 dispatch inputs 是仓库里的静态文件，只有「加/删 workflow
 * 文件」或「改 yml 里的 inputs 定义」才会变 —— 缓存 5 分钟对正确性零影响，
 * 却能把「反复进出新建任务页」的每次 16~32 秒降到首次之后接近 0。
 *
 * ── 为什么要按 with_inputs 分两个桶 ──────────────────────────────────
 * 两种请求的上游成本差一个数量级（1 次 vs 1+N 次）。若共用一个桶，
 * 不带 inputs 的请求会把结果写进桶里，随后带 inputs 的请求命中该桶，
 * 拿到的却是 `inputs: []` —— 表单会渲染成空的，且看起来"成功"。
 * 这是必须避免的静默错误，所以键里带上 withInputs。
 *
 * ── 为什么不缓存失败 ────────────────────────────────────────────────
 * 上游超时/限流时写缓存，会让故障在 TTL 内被"固化"：本来下一次就可能
 * 恢复，缓存却把空结果持续 5 分钟。失败一律不写。
 *
 * ── 为什么不用 KV ───────────────────────────────────────────────────
 * KV 的 writes/lists 额度比 reads 少两个数量级（见 job_list_cache.ts 的
 * 额度说明）。这里的缓存是纯加速、丢了也无所谓，用 isolate 内存即可，
 * 不占任何 KV 额度。
 */

import type { WorkflowMeta } from "../shared/types";

/**
 * 缓存时长。
 *
 * 5 分钟的依据：用户反馈的痛点是「同一批 workflow 反复拉取」，
 * 而 workflow 变更是人工操作（改 yml、提交、推送），本身就要几分钟才生效。
 * 更短会让缓存失去意义（面板轮询间隔就是几十秒级），更长则可能让
 * 刚改完 inputs 的用户困惑"为什么表单没更新"。
 */
export const WORKFLOWS_CACHE_TTL_MS = 5 * 60_000;

interface Entry {
  at: number;
  workflows: WorkflowMeta[];
}

/** 两个桶：不带 inputs 的轻量结果 / 带 inputs 的完整结果。 */
const buckets = new Map<string, Entry>();

function keyOf(withInputs: boolean): string {
  return withInputs ? "with" : "plain";
}

/**
 * 读缓存。命中且未过期返回副本，否则返回 null。
 *
 * 返回副本（浅拷贝数组 + 每项浅拷贝）而不是原引用：调用方可能就地改
 * `wf.inputs`，直接给原引用会让缓存内容被悄悄篡改。
 */
export function readWorkflowsCache(withInputs: boolean): WorkflowMeta[] | null {
  const e = buckets.get(keyOf(withInputs));
  if (!e) return null;
  if (Date.now() - e.at > WORKFLOWS_CACHE_TTL_MS) {
    buckets.delete(keyOf(withInputs));
    return null;
  }
  return e.workflows.map((w) => ({ ...w, inputs: [...(w.inputs ?? [])] }));
}

/** 写缓存。只应在成功拿到结果后调用。 */
export function writeWorkflowsCache(withInputs: boolean, workflows: WorkflowMeta[]): void {
  buckets.set(keyOf(withInputs), {
    at: Date.now(),
    workflows: workflows.map((w) => ({ ...w, inputs: [...(w.inputs ?? [])] })),
  });
}

/**
 * 清空缓存（测试隔离用；或在配置变更后由调用方显式调用）。
 *
 * 注意：不提供「按仓库分桶」——网关只服务一个仓库（owner/repo 来自配置），
 * 换配置需要重新部署，进程内缓存自然失效。
 */
export function clearWorkflowsCache(): void {
  buckets.clear();
}
