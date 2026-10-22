/**
 * workflow 列表、dispatch，以及 yml inputs 元数据解析。
 */

import type { Env, WorkflowInputMeta, WorkflowMeta } from "../../shared/types";
import { ghFetch, repoPath } from "./client";

/** GitHub 返回的 workflow 摘要。 */
interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

/**
 * 构建流水线的文件名前缀白名单。
 *
 * 仓库里的 workflow 不全是「构建流水线」——还有辅助脚本，例如
 * notify-json-mirror.yml（configs 变更时通知镜像仓库）。那些不该出现在
 * APP 的新建任务页里，否则会多出一个选了就报错的选项。
 *
 * 用前缀而不是「解析每个 yml 看有没有 apk_url 输入」：后者语义更准，
 * 但要为每个 workflow 多打一次 GitHub、多解析一次 YAML，而当前仓库里
 * 构建流水线只有 protect-* 这一族。等真的出现多种命名再升级不迟。
 *
 * 改这里而不是改 APP：前缀是服务端约定，放网关可以随时调整，APP 也不必
 * 知道仓库里到底有哪些文件。
 */
const BUILD_WORKFLOW_PREFIX = "protect-";

/** 列出仓库内 active 的构建 workflow（不含 inputs 元数据）。 */
export async function listWorkflows(env: Env): Promise<WorkflowMeta[]> {
  const resp = await ghFetch(env, repoPath(env, "/actions/workflows?per_page=100"));
  const data = (await resp.json()) as { workflows?: GhWorkflow[] };
  return (data.workflows ?? [])
    .filter((w) => w.state === "active" && /\.(yml|yaml)$/.test(w.path))
    .filter((w) => (w.path.split("/").pop() ?? "").startsWith(BUILD_WORKFLOW_PREFIX))
    .map((w) => ({
      id: w.id,
      name: w.name,
      file_name: w.path.split("/").pop() ?? w.path,
      state: w.state,
      inputs: [],
    }));
}

/**
 * 拉取单个 workflow 的 yml 原文并解析 on.workflow_dispatch.inputs。
 * 复用 jian_box 的 GitHubDispatcher.parseDispatchInputs 语义（缩进层级感知），
 * 保证网关与 App 旧版解析结果一致。
 */
export async function fetchWorkflowInputs(
  env: Env,
  workflowFile: string,
): Promise<WorkflowInputMeta[]> {
  const resp = await ghFetch(
    env,
    repoPath(
      env,
      `/contents/.github/workflows/${encodeURIComponent(workflowFile)}?ref=${encodeURIComponent(
        env.GITHUB_REF ?? "main",
      )}`,
    ),
    { headers: { Accept: "application/vnd.github.raw" } },
  );
  const yml = await resp.text();
  return parseDispatchInputs(yml);
}

/**
 * 从 yml 原文解析 workflow_dispatch.inputs。
 * 与 jian_box GitHubDispatcher.parseDispatchInputs 逐分支对齐：
 * 缩进约定 on:=0 / workflow_dispatch:=2 / inputs:=4 / input键:=6 / 属性:=8。
 */
export function parseDispatchInputs(yml: string): WorkflowInputMeta[] {
  const inputs: WorkflowInputMeta[] = [];
  let inDispatch = false;
  let inInputs = false;
  let curName: string | null = null;
  let curDesc = "";
  let curRequired = false;
  let curDefault = "";
  let curType: "string" | "boolean" | "choice" = "string";
  let curOptions: string[] = [];
  let collectingOptions = false;

  const flush = () => {
    if (curName) {
      inputs.push({
        name: curName,
        description: curDesc,
        required: curRequired,
        default: curDefault,
        type: curType,
        options: curOptions.slice(),
      });
    }
    curName = null;
    curDesc = "";
    curRequired = false;
    curDefault = "";
    curType = "string";
    curOptions = [];
    collectingOptions = false;
  };

  for (const raw of yml.split("\n")) {
    const line = raw.split("#")[0].replace(/\s+$/, "");
    const indent = raw.length - raw.trimStart().length;
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (indent === 0 && (trimmed === "on:" || trimmed.startsWith("on:"))) {
      flush();
      inDispatch = true;
      inInputs = false;
      continue;
    }
    if (indent === 0) {
      flush();
      inDispatch = false;
      inInputs = false;
      continue;
    }
    if (inDispatch && trimmed === "workflow_dispatch:") {
      flush();
      inInputs = false;
      continue;
    }
    if (inDispatch && trimmed.startsWith("inputs:")) {
      flush();
      inInputs = true;
      continue;
    }
    if (
      inDispatch &&
      !inInputs &&
      indent >= 2 &&
      indent <= 4 &&
      trimmed !== "workflow_dispatch:" &&
      /^[a-z_]+:/.test(trimmed)
    ) {
      inDispatch = false;
      continue;
    }
    if (inInputs && indent === 6 && trimmed.endsWith(":")) {
      flush();
      curName = trimmed.replace(/:$/, "");
      continue;
    }
    if (!inInputs || curName === null) continue;

    if (indent > 6 && trimmed.startsWith("description:")) {
      curDesc = trimmed.replace("description:", "").trim().replace(/^['"]|['"]$/g, "");
      continue;
    }
    if (indent > 6 && trimmed.startsWith("required:")) {
      curRequired = trimmed.replace("required:", "").trim() === "true";
      continue;
    }
    if (indent > 6 && trimmed.startsWith("type:")) {
      const t = trimmed.replace("type:", "").trim().replace(/^['"]|['"]$/g, "");
      curType = t === "boolean" ? "boolean" : t === "choice" ? "choice" : "string";
      continue;
    }
    if (curType === "choice" && indent >= 8 && trimmed === "options:") {
      collectingOptions = true;
      continue;
    }
    if (curType === "choice" && collectingOptions && indent >= 8 && trimmed.startsWith("- ")) {
      curOptions.push(trimmed.replace("- ", "").trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (
      collectingOptions &&
      indent >= 7 &&
      indent <= 8 &&
      !trimmed.startsWith("- ") &&
      trimmed !== "options:"
    ) {
      // 关闭 options 收集窗口；本行仍可能是 default: 等属性，故不 continue。
      collectingOptions = false;
    }
    if (indent > 6 && trimmed.startsWith("default:")) {
      const v = trimmed.replace("default:", "").trim();
      curDefault = ["|", "|-", ">", ">-"].includes(v) ? "" : v.replace(/^['"]|['"]$/g, "");
      continue;
    }
  }
  flush();
  return inputs;
}

/**
 * 触发 workflow_dispatch。GitHub 成功返回 204 无响应体、无 run_id，
 * 因此 run_id 必须由 listRecentRuns 另行匹配（见 routes/build.ts）。
 */
export async function dispatchWorkflow(
  env: Env,
  params: {
    workflowFile: string;
    apkUrl: string;
    inputs: Record<string, string>;
  },
): Promise<void> {
  const ref = env.GITHUB_REF ?? "main";
  const body = {
    ref,
    inputs: { apk_url: params.apkUrl, ...params.inputs },
  };
  await ghFetch(
    env,
    repoPath(env, `/actions/workflows/${encodeURIComponent(params.workflowFile)}/dispatches`),
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}
