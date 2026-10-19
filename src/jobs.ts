/**
 * GET /api/jobs — 管理台任务列表。
 *
 * 与 APP 用的 /api/status/:jobId 不同：这里一次要看多个任务，
 * 所以是独立的只读接口。同样走 cookie 或 Bearer 双通道（见 router.ts）。
 */

import type { BuildJob, Env } from "./types";
import { toAppStatus } from "./kv_store";
import { json } from "./router";

export async function handleListJobs(env: Env, url: URL): Promise<Response> {
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const listed = await env.EDGE_RELAY_KV.list({ prefix: "job:", limit });
  const jobs: BuildJob[] = [];
  for (const key of listed.keys) {
    if (key.name.startsWith("health:")) continue;
    const raw = await env.EDGE_RELAY_KV.get(key.name);
    if (!raw) continue;
    try {
      jobs.push(JSON.parse(raw) as BuildJob);
    } catch {
      /* 跳过坏行 */
    }
  }
  jobs.sort((a, b) => b.created_at_ms - a.created_at_ms);

  return json({
    jobs: jobs.map((j) => ({
      job_id: j.job_id,
      status: j.status,
      app_status: toAppStatus(j),
      conclusion: j.conclusion,
      download_url: j.download_url,
      error: j.error,
      created_at_ms: j.created_at_ms,
      workflow_file: j.workflow_file,
      display_name: j.display_name,
    })),
  });
}
