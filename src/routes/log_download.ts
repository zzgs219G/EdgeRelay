/**
 * GET /api/log/:jobId — 代理下载构建日志。
 *
 * 为什么不把 GitHub artifact 的 archive_download_url 直接给浏览器：
 *   那个 URL 需要 `Authorization: Bearer <GITHUB_TOKEN>`，令牌绝不能进
 *   浏览器。所以由网关带令牌取回、再原样转发给已登录的面板。
 *
 * 为什么日志值得单独做接口：
 *   流水线的日志 artifact 是 `if: always()` 上传的——**失败的任务也有**。
 *   而失败恰恰是最需要看日志的时刻，产物链接那种「只有成功才有」的
 *   设计在这里没用。
 */

import type { Env } from "../shared/types";
import { getJob } from "../services/kv";
import { listArtifacts, LOG_ARTIFACT_NAME } from "../services/github";
import { error } from "../shared/http";

/** 日志 artifact 不应超过这个大小；超过说明配置有问题，别整包转发。 */
const MAX_LOG_BYTES = 20 * 1024 * 1024;

export async function handleLogDownload(env: Env, jobId: string): Promise<Response> {
  const job = await getJob(env, jobId);
  if (!job) {
    return error(404, "not_found", `任务 ${jobId} 不存在或已过期`);
  }
  if (job.run_id === null) {
    return error(409, "bad_request", "任务尚未关联到流水线运行，暂无日志");
  }

  // 现查一次而不是用 job.log_url：artifact 可能在任务完成后才上传完成
  // （upload-artifact 是最后一步），存在「任务已 completed 但 artifact
  // 列表还空」的时间窗。现查能覆盖这种情况。
  const artifacts = await listArtifacts(env, job.run_id);
  const logArtifact = artifacts.find((a) => a.name === LOG_ARTIFACT_NAME && !a.expired);

  if (!logArtifact) {
    const others = artifacts.map((a) => a.name).join(", ") || "无";
    return error(
      404,
      "not_found",
      `找不到日志 artifact「${LOG_ARTIFACT_NAME}」。现有 artifact：${others}`,
    );
  }
  if (logArtifact.size_in_bytes > MAX_LOG_BYTES) {
    return error(413, "bad_request", "日志文件过大，拒绝转发");
  }

  // 带令牌取回 zip
  let upstream: Response;
  try {
    upstream = await fetch(logArtifact.archive_download_url, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "edge-relay",
      },
      // GitHub 的 artifact 下载会 302 到签名 URL，跟随它
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return error(
      502,
      "upstream_error",
      `下载日志失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!upstream.ok) {
    return error(502, "upstream_error", `下载日志失败：GitHub 返回 ${upstream.status}`);
  }

  // 原样转发。artifact 是 zip，保持 content-type；
  // 文件名用 job_id 便于操作者区分。
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/zip");
  headers.set(
    "content-disposition",
    `attachment; filename="log-${job.job_id.slice(0, 8)}.zip"`,
  );
  headers.set("cache-control", "no-store");
  // CORS：面板同源，但显式给出无妨
  headers.set("access-control-allow-origin", "*");

  return new Response(upstream.body, { status: 200, headers });
}
