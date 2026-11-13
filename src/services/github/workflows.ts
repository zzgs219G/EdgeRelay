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
  /** 是否正处在某个具体触发事件块内（push/pull_request/workflow_dispatch…） */
  let inDispatchBlock = false;
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
      inDispatchBlock = false;
      inInputs = false;
      continue;
    }
    if (indent === 0) {
      flush();
      inDispatch = false;
      inDispatchBlock = false;
      inInputs = false;
      continue;
    }
    if (inDispatch && trimmed.startsWith("inputs:")) {
      flush();
      inInputs = true;
      continue;
    }
    // `on:` 下可能有多个触发事件（push / pull_request / workflow_dispatch…），
    // 顺序任意。原实现在遇到【任何】其它事件时就 inDispatch = false，
    // 于是 workflow_dispatch 排在 push 之后（本仓库就是这样）时**永远
    // 解析不到**，inputs 静默变成空数组。
    //
    // 后果：新建任务页表单渲染为空（可容忍），但 build 路由用它做 input
    // 准入清单 → 所有可选参数（sign / no_lock / amice_probe）全被过滤掉，
    // 且只在 console 里留一条 warn，表现为「传了参数但 workflow 收到默认值」。
    //
    // 正确做法：只跳过【当前这个兄弟事件块】的其余内容，遇到
    // workflow_dispatch 仍然要能进入。用 inDispatch 表示「仍在 on: 块内」，
    // 用 inDispatchBlock 表示「正处在某个具体事件块内」。
    if (inDispatch && !inInputs && indent <= 4 && /^[a-z_]+:/.test(trimmed)) {
      if (trimmed === "workflow_dispatch:") {
        // 事件块切换：清掉上一个块的残留状态，下一行的 inputs: 才认得
        flush();
        inDispatchBlock = true;
        continue;
      }
      if (indent === 2) {
        // 这是另一个事件（push:/pull_request:/...）的标题行
        flush();
        inDispatchBlock = false;
        continue;
      }
    }
    if (inDispatch && inDispatchBlock && !inInputs && indent > 2) {
      // 其它事件块的内部行（branches / paths / …）—— 忽略，但不离开 on: 块
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
