/**
 * GET /api/workflows — 列出可用流水线及其动态 inputs。
 *
 * APP 原来直连 GitHub 做两件事：拉 workflow 列表、拉 yml 原文解析
 * inputs。这两步都必须带 Token 且暴露仓库路径，所以整体搬进网关。
 * APP 只消费这里的结构化结果，不感知 owner/repo。
 *
 * 支持 ?with_inputs=1 拉取每个 workflow 的 inputs 元数据（默认关闭：
 * 一次 N 次 GitHub 调用，只为渲染表单时按需开启）。
 *
 * ── 缓存（2026-10-30 加） ─────────────────────────────────────────
 * 实测日志里同一份数据相隔 15 分钟被拉了两次，分别耗时 16.7s / 32.1s。
 * workflow 与 inputs 都是仓库静态文件，短缓存对正确性无影响，却能把
 * 反复进出新建任务页的等待降到接近 0。细节见 services/workflows_cache.ts。
 */

import type { Env, WorkflowListResponse } from "../shared/types";
import { fetchWorkflowInputs, listWorkflows } from "../services/github";
import { error, json } from "../shared/http";
import { readWorkflowsCache, writeWorkflowsCache } from "../services/workflows_cache";

export async function handleWorkflows(env: Env, url: URL): Promise<Response> {
  const withInputs = url.searchParams.get("with_inputs") === "1";
  try {
    const cached = readWorkflowsCache(withInputs);
    if (cached) {
      const hit: WorkflowListResponse = { workflows: cached };
      return json(hit);
    }

    const workflows = await listWorkflows(env);
    if (withInputs) {
      // 并发拉取，单个失败不影响其它条目。
      await Promise.all(
        workflows.map(async (wf) => {
          try {
            wf.inputs = await fetchWorkflowInputs(env, wf.file_name);
          } catch {
            wf.inputs = [];
          }
        }),
      );
    }

    // 只在成功路径写缓存：失败（超时/限流）不缓存，避免把故障固化 5 分钟。
    writeWorkflowsCache(withInputs, workflows);

    const resp: WorkflowListResponse = { workflows };
    return json(resp);
  } catch {
    return error(502, "upstream_error", "拉取 workflow 列表失败");
  }
}
