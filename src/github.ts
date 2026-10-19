/**
 * GitHub REST API 最小客户端。
 *
 * 只封装 EdgeRelay 需要的五个端点，不引第三方 SDK（Worker 原生 fetch）。
 * 所有方法抛 GitHubError，由上层转成 ErrorResponse。
 */

import type { Env, WorkflowInputMeta, WorkflowMeta } from "./types";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string = "",
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

const API = "https://api.github.com";

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "edge-relay",
  };
}

/** 单次 GitHub 调用的超时。 */
const GH_TIMEOUT_MS = 10_000;

async function ghFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  // 必须带超时：Worker 有墙钟上限，fetch 挂住会一直等到平台强杀，
  // 用户拿到的是无信息的 1101（Worker threw exception），而不是
  // 一句能排障的错误。10s 远大于 GitHub 正常响应时间（通常 <300ms）。
  const timeout = AbortSignal.timeout(GH_TIMEOUT_MS);
  const resp = await fetch(`${API}${path}`, {
    ...init,
    // 调用方若自己传了 signal，用它的；否则用默认超时。
    signal: init.signal ?? timeout,
    headers: { ...headers(env), ...(init.headers ?? {}) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new GitHubError(
      `GitHub ${init.method ?? "GET"} ${path} -> ${resp.status}`,
      resp.status,
      body.slice(0, 500),
    );
  }
  return resp;
}

/** 把 GitHub 的错误码翻译成 APP 能直接展示的排障提示。 */
export function describeGitHubError(err: GitHubError): string {
  switch (err.status) {
    case 401:
      return "网关 GitHub 令牌无效或已过期（Worker secret GITHUB_TOKEN）";
    case 403:
      return "GitHub 配额不足或令牌缺少 Actions 读写权限";
    case 404:
      return "仓库或 workflow 不存在（检查 GITHUB_OWNER / GITHUB_REPO / workflow_file）";
    case 422:
      return "流水线参数不匹配：必填参数缺失或类型不符";
    default:
      return `GitHub API 错误 ${err.status}`;
  }
}

// ── workflow 列表 ────────────────────────────────────────────────────

interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

/** 列出仓库内 active 的 workflow（不含 inputs 元数据）。 */
export async function listWorkflows(env: Env): Promise<WorkflowMeta[]> {
  const resp = await ghFetch(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows?per_page=100`,
  );
  const data = (await resp.json()) as { workflows?: GhWorkflow[] };
  return (data.workflows ?? [])
    .filter((w) => w.state === "active" && /\.(yml|yaml)$/.test(w.path))
    .map((w) => ({
      id: w.id,
      name: w.name,
      file_name: w.path.split("/").pop() ?? w.path,
      state: w.state,
      inputs: [],
    }));
}

// ── workflow_dispatch.inputs 元数据 ──────────────────────────────────

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
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/.github/workflows/${encodeURIComponent(
      workflowFile,
    )}?ref=${encodeURIComponent(env.GITHUB_REF ?? "main")}`,
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
    if (collectingOptions && indent >= 7 && indent <= 8 && !trimmed.startsWith("- ") && trimmed !== "options:") {
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

// ── dispatch ─────────────────────────────────────────────────────────

/**
 * 触发 workflow_dispatch。GitHub 成功返回 204 无响应体、无 run_id，
 * 因此 run_id 必须由 listRecentRuns 另行匹配（见 build.ts）。
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
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${encodeURIComponent(
      params.workflowFile,
    )}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

// ── run 查询 ─────────────────────────────────────────────────────────

interface GhRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_number: number;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  head_sha: string;
  event: string;
  path: string;
}

export interface RunSnapshot {
  run_id: number;
  status: string;
  conclusion: string | null;
  name: string;
  /** run 的创建时刻。绑定 run_id 时必须用它，不能用 updated_at。 */
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
}

/**
 * 列出某个 workflow 最近的 run，只保留「在本任务创建之后才创建的」。
 *
 * @param sinceMs 任务创建时刻（毫秒）。只返回 created_at 晚于它（留 90s
 *   时钟容差）的 run。
 *
 * 为什么必须用 created_at 而不是 updated_at（这里踩过坑）：
 *   updated_at 对正在运行的 run 会持续刷新。一个 20 分钟前创建、仍在
 *   跑的老 run，其 updated_at 是「几秒前」，于是被误判成「刚触发的
 *   run」而绑到新任务上——新任务从此一直显示那个老 run 的状态。
 */
export async function listRecentRuns(
  env: Env,
  workflowFile: string,
  sinceMs: number,
): Promise<RunSnapshot[]> {
  const resp = await ghFetch(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${encodeURIComponent(
      workflowFile,
    )}/runs?per_page=10`,
  );
  const data = (await resp.json()) as { workflow_runs?: GhRun[] };
  return (data.workflow_runs ?? [])
    .filter((r) => r.event === "workflow_dispatch")
    .map((r) => ({
      run_id: r.id,
      status: r.status,
      conclusion: r.conclusion,
      name: r.name,
      created_at: r.created_at,
      run_started_at: r.run_started_at,
      updated_at: r.updated_at,
    }))
    .filter((r) => {
      // created_at 缺失 / 不可解析时保守放行（宁可多一个候选，也别把
      // 真正的新 run 滤掉）。
      //
      // 注意不能写成 `Date.parse(r.created_at || "0")`——Date.parse("0")
      // 返回的是 2000-01-01（946656000000），不是 NaN，于是"缺字段"会
      // 被误判成"2000 年创建"，把所有 run 都滤掉。
      if (!r.created_at) return true;
      const created = Date.parse(r.created_at);
      if (!Number.isFinite(created)) return true;
      return created >= sinceMs - 90_000;
    })
    // 新的在前：run_id 单调递增，与 created_at 同序
    .sort((a, b) => b.run_id - a.run_id);
}

/** 查询单个 run 的当前状态。 */
export async function getRun(
  env: Env,
  runId: number,
): Promise<RunSnapshot> {
  const resp = await ghFetch(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${runId}`,
  );
  const r = (await resp.json()) as GhRun;
  return {
    run_id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    name: r.name,
    created_at: r.created_at,
    run_started_at: r.run_started_at,
    updated_at: r.updated_at,
  };
}

// ── 产物下载链接 ─────────────────────────────────────────────────────

interface GhAnnotation {
  title?: string;
  message?: string;
}

/**
 * 从 run 的 job 注解中抓取流水线 ::notice 喊出的 R2 产物路径。
 *
 * 与 jian_box TaskViewModel.fetchR2UrlFromAnnotations 等价：注解里
 * R2_PUBLIC_DOMAIN 会被 GitHub 打码成 ***，用 env.R2_PUBLIC_DOMAIN
 * 补全；抓不到返回 null，由调用方退回 artifact 兜底。
 */
export async function fetchDownloadUrlFromAnnotations(
  env: Env,
  runId: number,
): Promise<string | null> {
  const publicDomain = (env as unknown as { R2_PUBLIC_DOMAIN?: string }).R2_PUBLIC_DOMAIN;
  const jobsResp = await ghFetch(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${runId}/jobs?per_page=20`,
  );
  const jobsData = (await jobsResp.json()) as { jobs?: { id: number }[] };
  const urlRegex = /(?:https?:\/\/[^\s"<>]+|\*\*\*)\/apks\/[^\s"<>]+/;
  for (const job of jobsData.jobs ?? []) {
    if (!job.id) continue;
    let annotations: GhAnnotation[] = [];
    try {
      const annResp = await ghFetch(
        env,
        `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/check-runs/${job.id}/annotations`,
      );
      annotations = (await annResp.json()) as GhAnnotation[];
    } catch {
      continue;
    }
    for (const ann of annotations) {
      const text = `${ann.title ?? ""} ${ann.message ?? ""}`;
      const match = urlRegex.exec(text);
      if (!match) continue;
      let url = match[0];
      if (url.startsWith("***")) {
        if (!publicDomain) continue;
        url = publicDomain.replace(/\/$/, "") + url.slice(3);
      }
      if (url.startsWith("http")) return url;
    }
  }
  return null;
}

/** 注解抓不到时退回 run 的第一个 artifact 下载地址。 */
export async function fetchArtifactUrl(
  env: Env,
  runId: number,
): Promise<string | null> {
  try {
    const resp = await ghFetch(
      env,
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${runId}/artifacts`,
    );
    const data = (await resp.json()) as { artifacts?: { archive_download_url: string }[] };
    return data.artifacts?.[0]?.archive_download_url ?? null;
  } catch {
    return null;
  }
}
