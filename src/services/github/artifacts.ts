/**
 * artifact 清单与下载链接：注解里的 R2 直链、artifact 兜底、日志 artifact。
 */

import type { Env } from "../../shared/types";
import { ghFetch, repoPath } from "./client";

interface GhAnnotation {
  title?: string;
  message?: string;
}

/**
 * 注解抓取的结果。`reason` 说明为什么没拿到 R2 直链——这不是可选的锦上添花：
 * 曾经这里抓到被打码的 URL 却静默 `continue`，网关侧零痕迹，只有 APP 弹一句
 * 「需令牌」，排查全靠读代码反推。
 */
export interface AnnotationResult {
  url: string | null;
  /** 失败原因（成功时为 null）。 */
  reason:
    | null
    | "r2_public_domain_missing" // 注解里的域名被 GitHub 打码成 ***，而 R2_PUBLIC_DOMAIN 未配
    | "no_apks_url_in_annotations" // 注解里没有 /apks/ 链接（流水线可能没喊 notice）
    | "github_error"; // GitHub 调用失败（令牌/权限）
}

/**
 * 从 run 的 job 注解中抓取流水线 ::notice 喊出的 R2 产物路径。
 *
 * 与 jian_box TaskViewModel.fetchR2UrlFromAnnotations 等价：注解里
 * R2_PUBLIC_DOMAIN 会被 GitHub 打码成 ***，用 env.R2_PUBLIC_DOMAIN
 * 补全；抓不到由调用方退回 artifact 兜底。
 */
export async function fetchDownloadUrlFromAnnotations(
  env: Env,
  runId: number,
): Promise<AnnotationResult> {
  const publicDomain = env.R2_PUBLIC_DOMAIN;
  let jobsData: { jobs?: { id: number }[] };
  try {
    const jobsResp = await ghFetch(env, repoPath(env, `/actions/runs/${runId}/jobs?per_page=20`));
    jobsData = (await jobsResp.json()) as { jobs?: { id: number }[] };
  } catch {
    return { url: null, reason: "github_error" };
  }

  const urlRegex = /(?:https?:\/\/[^\s"<>]+|\*\*\*)\/apks\/[^\s"<>]+/;
  let sawMaskedUrl = false;

  for (const job of jobsData.jobs ?? []) {
    if (!job.id) continue;
    let annotations: GhAnnotation[] = [];
    try {
      const annResp = await ghFetch(env, repoPath(env, `/check-runs/${job.id}/annotations`));
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
        // 关键分支：域名被 GitHub 打码了。若 R2_PUBLIC_DOMAIN 没配，
        // 这里曾经是静默 continue——现在记下来，让上层能报出真正原因。
        sawMaskedUrl = true;
        if (!publicDomain) continue;
        url = publicDomain.replace(/\/$/, "") + url.slice(3);
      }
      if (url.startsWith("http")) return { url, reason: null };
    }
  }

  if (sawMaskedUrl) return { url: null, reason: "r2_public_domain_missing" };
  return { url: null, reason: "no_apks_url_in_annotations" };
}

/** run 的 artifact 清单。 */
export interface ArtifactInfo {
  name: string;
  /** 下载需要 GitHub 令牌，APP 拿不到——面板侧走自己的鉴权。 */
  archive_download_url: string;
  size_in_bytes: number;
  expired: boolean;
}

/**
 * 列出 run 的全部 artifact。
 *
 * 早期实现只取 `artifacts[0]`，但那是不安全的假设——流水线会上传两个
 * artifact（构建日志 + 加固包），返回顺序不保证，可能把日志当成产物
 * 链接给用户。
 */
export async function listArtifacts(env: Env, runId: number): Promise<ArtifactInfo[]> {
  try {
    const resp = await ghFetch(env, repoPath(env, `/actions/runs/${runId}/artifacts`));
    const data = (await resp.json()) as {
      artifacts?: {
        name: string;
        archive_download_url: string;
        size_in_bytes: number;
        expired: boolean;
      }[];
    };
    return (data.artifacts ?? []).map((a) => ({
      name: a.name,
      archive_download_url: a.archive_download_url,
      size_in_bytes: a.size_in_bytes,
      expired: a.expired,
    }));
  } catch {
    return [];
  }
}

/** 构建日志 artifact 的名字（与 protect-modules.yml 保持一致）。 */
export const LOG_ARTIFACT_NAME = "构建日志-build.log";

/**
 * 找构建日志 artifact 的下载地址。
 *
 * 日志是 `if: always()` 上传的，所以**失败的任务也有日志**——这正是
 * 排障最需要的场景。
 */
export async function fetchLogArtifactUrl(env: Env, runId: number): Promise<string | null> {
  const artifacts = await listArtifacts(env, runId);
  const hit = artifacts.find((a) => a.name === LOG_ARTIFACT_NAME && !a.expired);
  return hit?.archive_download_url ?? null;
}

/**
 * 找加固产物 artifact 的下载地址（R2 链接抓不到时的兜底）。
 *
 * 只排除日志，不按精确名匹配——产物名可能随流水线改动，
 * 而日志名是固定的。
 */
export async function fetchArtifactUrl(env: Env, runId: number): Promise<string | null> {
  const artifacts = await listArtifacts(env, runId);
  const hit = artifacts.find((a) => a.name !== LOG_ARTIFACT_NAME && !a.expired);
  return hit?.archive_download_url ?? null;
}
