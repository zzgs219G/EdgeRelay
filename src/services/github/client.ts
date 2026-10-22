/**
 * GitHub REST 客户端底座：错误类型、鉴权头、带超时的 fetch。
 *
 * 只封装 EdgeRelay 需要的端点，不引第三方 SDK（Worker 原生 fetch）。
 * 所有方法抛 GitHubError，由上层转成 ErrorResponse。
 */

import type { Env } from "../../shared/types";

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

export async function ghFetch(
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

/** 仓库路径前缀，所有端点共用。 */
export function repoPath(env: Env, suffix: string): string {
  return `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${suffix}`;
}
