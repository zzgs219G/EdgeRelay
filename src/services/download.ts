/**
 * 产物下载链接的解析：R2 直链优先，GitHub artifact 兜底。
 *
 * 为什么单独一个模块：routes/status.ts（APP 轮询路径）与
 * services/reconcile.ts（cron 路径）都要做同一件事，而这件事有个
 * 静默失败的坏味道——
 *
 *   `fetchDownloadUrlFromAnnotations` 抓不到 R2 链接时会退回 artifact，
 *   而 artifact 链接需要 GitHub 令牌。APP 侧早就不持有令牌了
 *   （jian_box 的 TaskViewModel 会显式拦住它并提示"需令牌"）。
 *   于是一个配置缺失（R2_PUBLIC_DOMAIN）表现为「下载按钮点了没反应」，
 *   而网关侧毫无痕迹。
 *
 * 这个模块把「为什么兜底了」变成可观测的：调用方拿得到 reason，
 * 从而能进日志、进任务记录，而不是只有 APP 知道。
 *
 * `explainDownloadFailure` 也放在这里（而不是 routes/status.ts）：
 * 它本来是 handler 里的函数，却被 cron 侧（services/reconcile.ts）引用，
 * 形成了「服务层反向依赖 HTTP 层」的坏味道。文案与原因码同源，
 * 放在一起最自然。
 */

import type { Env } from "../shared/types";
import { fetchArtifactUrl, fetchDownloadUrlFromAnnotations } from "./github";

export interface ResolvedDownload {
  url: string | null;
  /** 兜底原因。null = 拿到了 R2 直链（理想情况）。 */
  reason: string | null;
  /** 最终链接是不是 GitHub artifact（APP 用不了的那种）。 */
  isArtifactFallback: boolean;
}

/** 抓不到 R2 直链时的人类可读原因（写进日志，供 wrangler tail / CF 观测查看）。 */
export function explainDownloadFailure(reason: string | null | undefined): string | null {
  switch (reason) {
    case "r2_public_domain_missing":
      return "注解里的域名被 GitHub 打码成 ***，而网关未配 R2_PUBLIC_DOMAIN，无法补全 → 退回 GitHub artifact 链接（APP 无令牌，下不了）";
    case "no_apks_url_in_annotations":
      return "run 注解里没有 /apks/ 链接（流水线可能没喊 ::notice）→ 退回 GitHub artifact 链接";
    case "github_error":
      return "GitHub 调用失败（令牌或权限）";
    case "no_artifact_either":
      return "注解里没有 /apks/ 链接，且 run 没有可下载的 artifact";
    default:
      return null;
  }
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
