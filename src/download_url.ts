/**
 * 产物下载链接的解析：R2 直链优先，GitHub artifact 兜底。
 *
 * 为什么单独一个模块：status.ts（APP 轮询路径）与 reconcile.ts（cron
 * 路径）都要做同一件事，而这件事有个静默失败的坏味道——
 *
 *   `fetchDownloadUrlFromAnnotations` 抓不到 R2 链接时会退回 artifact，
 *   而 artifact 链接需要 GitHub 令牌。APP 侧早就不持有令牌了
 * （jian_box 的 TaskViewModel 会显式拦住它并提示"需令牌"）。
 *   于是一个配置缺失（R2_PUBLIC_DOMAIN）表现为「下载按钮点了没反应」，
 *   而网关侧毫无痕迹。
 *
 * 这个模块把「为什么兜底了」变成可观测的：调用方拿得到 reason，
 * 从而能进日志、进任务记录，而不是只有 APP 知道。
 */

import type { Env } from "./types";
import { fetchArtifactUrl, fetchDownloadUrlFromAnnotations } from "./github";

export interface ResolvedDownload {
  url: string | null;
  /** 兜底原因。null = 拿到了 R2 直链（理想情况）。 */
  reason: string | null;
  /** 最终链接是不是 GitHub artifact（APP 用不了的那种）。 */
  isArtifactFallback: boolean;
}

/**
 * 先试 R2 直链，失败再退 artifact。
 *
 * @param runId GitHub run id
 */
export async function resolveDownloadUrl(env: Env, runId: number): Promise<ResolvedDownload> {
  const ann = await fetchDownloadUrlFromAnnotations(env, runId);
  if (ann.url) {
    return { url: ann.url, reason: null, isArtifactFallback: false };
  }

  const artifact = await fetchArtifactUrl(env, runId);
  if (artifact) {
    return { url: artifact, reason: ann.reason, isArtifactFallback: true };
  }
  return { url: null, reason: ann.reason ?? "no_artifact_either", isArtifactFallback: false };
}
