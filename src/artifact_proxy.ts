/**
 * GET /api/artifact/:jobId — 代理下载加固产物。
 *
 * 为什么需要（线上故障的直接产物）：
 *
 *   面板的下载按钮原本是 `<a :href="download_url">` 直跳。当 download_url
 *   是 GitHub artifact 链接（R2 直链没拿到时的兜底），浏览器点下去就是一次
 *   **不带 Authorization 头**的跨域请求——`<a>` 标签没法设请求头，令牌
 *   也绝不能进浏览器。GitHub 按未认证请求计费，而未认证限额只有 60 次/小时
 *   /IP，用户看到的是：
 *      {"message":"API rate limit exceeded for <IP>. (But here's the good
 *       news: Authenticated requests get a higher rate limit...)"}
 *
 *   也就是说：**一个网关侧能拿到的东西，因为交给浏览器直连而彻底拿不到。**
 *
 * 解法与日志下载完全同构（见 log_proxy.ts）：网关带令牌取回，再转发给已
 * 鉴权的调用方。面板走 `<a href="/api/artifact/:jobId">` 时浏览器会自动
 * 带上 session cookie，正好过路由的 checkAuth。
 *
 * 为什么不再依赖 R2_PUBLIC_DOMAIN：
 *   那是「拿到 R2 直链」的前提，缺了它会一路兜底到 artifact。而这条代理
 *   路径让「artifact 也能下」——R2 直链仍是首选（快、不耗网关流量），
 *   但拿不到时不再是无解。
 */

import type { BuildJob, Env } from "./types";
import { getJob } from "./kv_store";
import { LOG_ARTIFACT_NAME, listArtifacts } from "./github";
import { error } from "./http";

/** 产物上限。APK + 签名后的包可能上百 MB，给 1GB 宽限；超了说明配置有问题。 */
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

/** 取回上游的超时。大文件慢网络，比日志的 60s 宽松。 */
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;

export async function handleArtifactDownload(env: Env, jobId: string): Promise<Response> {
  const job = await getJob(env, jobId);
  if (!job) {
    return error(404, "not_found", `任务 ${jobId} 不存在或已过期`);
  }
  if (job.run_id === null) {
    return error(409, "bad_request", "任务尚未关联到流水线运行，暂无产物");
  }

  // 现查而不是用 job.download_url：download_url 可能是 R2 直链（这里用不上），
  // 也可能早就过期。现查 artifacts 列表拿到的是当前有效的下载地址。
  const artifacts = await listArtifacts(env, job.run_id);
  const target = artifacts.find((a) => a.name !== LOG_ARTIFACT_NAME && !a.expired);

  if (!target) {
    const others = artifacts.map((a) => a.name).join(", ") || "无";
    return error(
      404,
      "not_found",
      `找不到产物 artifact。现有 artifact：${others}`,
    );
  }
  if (target.size_in_bytes > MAX_ARTIFACT_BYTES) {
    return error(413, "bad_request", `产物文件过大（${target.size_in_bytes} 字节），拒绝转发`);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.archive_download_url, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "edge-relay",
      },
      // GitHub 的 artifact 下载会 302 到签名 URL，必须跟随
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    return error(
      502,
      "upstream_error",
      `下载产物失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!upstream.ok) {
    return error(502, "upstream_error", `下载产物失败：GitHub 返回 ${upstream.status}`);
  }

  // 原样转发。artifact 是 zip，保持 content-type；文件名带 job_id 便于区分。
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/zip");
  headers.set(
    "content-disposition",
    `attachment; filename="artifact-${job.job_id.slice(0, 8)}.zip"`,
  );
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");

  return new Response(upstream.body, { status: 200, headers });
}

/** 供测试与内部复用：判断某任务是否可能走代理下载。 */
export function canProxyArtifact(job: BuildJob): boolean {
  return job.run_id !== null;
}
