/**
 * GET /api/workflows — 列出可用流水线及其动态 inputs。
 *
 * APP 原来直连 GitHub 做两件事：拉 workflow 列表、拉 yml 原文解析
 * inputs。这两步都必须带 Token 且暴露仓库路径，所以整体搬进网关。
 * APP 只消费这里的结构化结果，不感知 owner/repo。
 *
 * 支持 ?with_inputs=1 拉取每个 workflow 的 inputs 元数据（默认关闭：
 * 一次 N 次 GitHub 调用，只为渲染表单时按需开启）。
 */

import type { Env, WorkflowListResponse } from "./types";
import { fetchWorkflowInputs, listWorkflows } from "./github";
import { error, json } from "./router";

export async function handleWorkflows(env: Env, url: URL): Promise<Response> {
  const withInputs = url.searchParams.get("with_inputs") === "1";
  try {
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
    const resp: WorkflowListResponse = { workflows };
    return json(resp);
  } catch (err) {
    return error(502, "upstream_error", "拉取 workflow 列表失败");
  }
}
