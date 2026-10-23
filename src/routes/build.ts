/**
 * POST /api/build — 触发一次加固构建。
 *
 * 关键设计：dispatch 之后同步等 run_id 出现再返回。
 *
 * GitHub 的 workflow_dispatch 返回 204 且不带 run_id，旧 APP 靠
 * 「列出 runs 猜一个 created_at 晚于任务创建时间的」来补绑，并发时极易
 * 绑到别人的 run 上（TaskViewModel.getLatestWorkflowRunId 的已知竞态）。
 * 这里改为：dispatch 成功后立刻按 workflow 列出 runs，跳过已消耗的候选
 * run_id，取最新的一个；最多等 RUN_ID_WAIT_MS（默认 4s）。
 *
 * 若 4s 内 GitHub 仍未列出该 run，job 仍以 queued 状态返回，run_id 留空，
 * 由 routes/status.ts 的「读缺失即回查」与 cron 兜底补绑。APP 无需特殊处理。
 */

import type { BuildJob, BuildRequest, BuildResponse, Env } from "../shared/types";
import { newJobId } from "../domain/job";
import { describeGitHubError, dispatchWorkflow, GitHubError, listRecentRuns } from "../services/github";
import { putJob, putNewJob } from "../services/kv";
import { describeModules } from "../services/modules";
import { invalidateJobsCache } from "../services/job_list_cache";
import type { Principal } from "../services/principal";
import { error, json } from "../shared/http";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_URL_BYTES = 2048;

/**
 * dispatch 后探测 runs 列表的次数。
 *
 * 3 次的依据：GitHub 的 workflow_dispatch 通常在 1-2 秒后就能在
 * runs 列表看到新 run，但存在偶发延迟。默认预算 4 秒 / 3 次 ≈ 每 1.3 秒
 * 探测一次，能覆盖这个分布；再多对 4 秒预算无意义（间隔被压到比 RTT
 * 还短，连续两次拿到同一份列表）。
 */
const RUN_ID_PROBE_ATTEMPTS = 3;

export async function handleBuild(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
): Promise<Response> {
  let body: BuildRequest;
  try {
    body = (await request.json()) as BuildRequest;
  } catch {
    return error(400, "bad_request", "请求体不是合法 JSON");
  }

  const problems = validateBuildRequest(body, env);
  if (problems.length > 0) {
    return error(400, "bad_request", problems.join("；"));
  }

  // 同一个 now 同时用于 job_id 的时间前缀与 created_at_ms。
  // 若分两次 Date.now()，极端情况下会差 1ms，导致 KV 字典序与
  // created_at_ms 排序不完全一致（列表顺序细微错乱）。
  const now = Date.now();
  const jobId = newJobId(now);
  const job: BuildJob = {
    job_id: jobId,
    owner: principal.id,
    run_id: null,
    workflow_file: body.workflow_file,
    workflow_name: body.workflow_file,
    protect_config: body.protect_config,
    dpt_extra_args: body.dpt_extra_args ?? "",
    display_name: body.display_name ?? "",
    // 解析「勾了哪些模块」用于任务列表展示。失败不阻塞构建（返回 []）。
    modules: await describeModules(env, body.protect_config),
    status: "queued",
    conclusion: null,
    download_url: null,
    error: null,
    created_at_ms: now,
    updated_at_ms: now,
  };

  // 先落库再触发：dispatch 失败也能在任务表里留下痕迹，便于排查。
  // 用 putNewJob 而非 putJob：它是唯一「新建任务」的语义入口，
  // 顺带把未完结信号灯 +1（详见 services/kv/jobs.ts）。
  await putNewJob(env, job);
  // 让面板立刻看到新任务，而不是等列表缓存（15s）过期。
  invalidateJobsCache();

  const inputs = buildDispatchInputs(body);
  try {
    await dispatchWorkflow(env, {
      workflowFile: body.workflow_file,
      apkUrl: body.apk_url,
      inputs,
    });
  } catch (err) {
    const msg =
      err instanceof GitHubError ? describeGitHubError(err) : "触发 GitHub 流水线失败";
    await putJob(env, {
      ...job,
      status: "completed",
      conclusion: "failure",
      error: msg,
      updated_at_ms: Date.now(),
    });
    // 用 200 而不是 502：dispatch 失败是**业务失败**（token 过期、
    // 参数不匹配、仓库不存在），不是网关故障。用 5xx 会让客户端把它
    // 当成"网关挂了"而重试整条请求，反而放大问题。
    // 任务已落库且标记为 completed/failure，APP 也能通过 jobId 查到。
    const resp: BuildResponse = {
      success: false,
      job_id: jobId,
      status: "completed",
      error: msg,
    };
    return json(resp, 200);
  }

  // ── run_id 补绑改为异步 ────────────────────────────────────────────
  //
  // 旧实现同步等 RUN_ID_WAIT_MS（默认 4s）才返回。问题：
  //   1. 请求最长挂 4 秒，Worker 有墙钟上限，高并发时容易攒住连接；
  //   2. 这 4 秒对调用方毫无价值——APP 拿到 job_id 就该返回，状态靠轮询。
  //
  // 现在：dispatch 成功后立刻返回 queued，把探测丢给 ctx.waitUntil。
  // 探测成功就写 in_progress，失败则由三个下游兜底，APP 无需区别对待：
  //   - routes/status.ts 的「读缺失即回查」
  //   - services/reconcile.ts 的 cron 补绑
  //   - 停滞判死（domain/job.ts 的 isStalled）
  //
  // 为什么仍保留同步探测能力：`BUILD_SYNC_RUN_ID=1` 可切回旧行为，
  // 供排查"run_id 到底有没有绑上"时使用，也让原有测试语义不变。
  if (env.BUILD_SYNC_RUN_ID === "1") {
    const runId = await waitForRunId(env, body.workflow_file, now);
    if (runId !== null) {
      await putJob(env, {
        ...job,
        run_id: runId,
        status: "in_progress",
        updated_at_ms: Date.now(),
      });
      const resp: BuildResponse = { success: true, job_id: jobId, status: "in_progress" };
      return json(resp, 200);
    }
  } else {
    // 防御：ExecutionContext 理论上一定有 waitUntil，但测试/边缘环境可能传
    // 空对象。此时**不启动**后台探测——而不是"启动了但没人等"。
    //
    // 为什么不能用 `void bindRunIdInBackground(...)`：那个 Promise 会继续
    // 跑、继续打 GitHub，与后续请求的计数器/桩函数互相污染（表现为
    // "探测次数多了 1 次"这种诡异 flaky）。run_id 补绑本来就有 cron 与
    // status 回查两条兜底，跳过不影响正确性。
    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(bindRunIdInBackground(env, job));
    }
  }

  // 刻意不返回 run_id：APP 只需要 job_id，而 run_id 属于 GitHub 侧信息，
  // 下发即暴露。调试时用 /api/status（服务端内部会带上，但不含 run_id）。
  const resp: BuildResponse = {
    success: true,
    job_id: jobId,
    status: "queued",
  };
  return json(resp, 200);
}

/**
 * 后台补绑 run_id（ctx.waitUntil 里跑）。
 *
 * 探测到就写 in_progress；探测不到什么都不做——保持 queued，交给
 * cron 与 status 回查。**不写 KV** 是刻意的：没变化就写只会白耗写额度
 * （免费档 1000 次/天）。
 */
async function bindRunIdInBackground(env: Env, job: BuildJob): Promise<void> {
  try {
    const runId = await waitForRunId(env, job.workflow_file, job.created_at_ms);
    if (runId === null) return;
    await putJob(env, {
      ...job,
      run_id: runId,
      status: "in_progress",
      updated_at_ms: Date.now(),
    });
  } catch (err) {
    // 后台任务失败不该影响已返回的响应，只留日志。
    console.error("background run_id bind failed", {
      job_id: job.job_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 校验 apk_url 的来源，防 SSRF 与额度滥用。
 *
 * 为什么必须校验：`apk_url` 会原样传给 GitHub 流水线，由 **GitHub Runner**
 * 去下载。只要是个 http 链接就放行的话，攻击者可以让 Runner 去拉：
 *   - 云厂商元数据地址（169.254.169.254）→ 窃取 Runner 上的临时凭证
 *   - 内网地址                                     → 端口扫描/内网探测
 *   - 超大的公开文件                              → 烧掉 Actions 分钟数
 *
 * 策略（按优先级）：
 *   1. 配了 R2_PUBLIC_DOMAIN  → host 必须与它一致（强校验）
 *   2. 没配                    → 拒绝私网/回环/元数据地址（弱校验兜底）
 *
 * 为什么第 2 种不直接全拒：R2_PUBLIC_DOMAIN 是"必须配"但线上曾长期漏配，
 * 直接拒绝会让整个构建接口在这个配置缺失时彻底不可用——那比 SSRF 风险
 * 更常见。弱校验能挡住最危险的地址，同时保留可用性。
 */
function checkApkUrlHost(raw: string, env: Env): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "apk_url 不是合法 URL";
  }

  // 只允许 https：http 明文传输 APK，且流水线侧无 TLS 校验。
  if (url.protocol !== "https:") {
    return "apk_url 必须是 https 链接";
  }

  // ── 强校验：配置了 R2 公开域名就只认它 ──
  const allowedDomain = (env.R2_PUBLIC_DOMAIN ?? "").trim();
  if (allowedDomain) {
    let allowedHost: string;
    try {
      allowedHost = new URL(allowedDomain).host;
    } catch {
      // 配置本身坏了：不能因此放行任意 host，退回弱校验。
      allowedHost = "";
    }
    if (allowedHost) {
      if (url.host !== allowedHost) {
        return `apk_url 的域名必须是 ${allowedHost}（R2 公开域名）`;
      }
      return null;
    }
  }

  // ── 弱校验：拒绝私网 / 回环 / 链路本地 / 元数据 ──
  const host = url.hostname.toLowerCase();

  // IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // 链路本地，含 169.254.169.254 元数据
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0;
    if (isPrivate) return "apk_url 不能指向私网或元数据地址";
  }

  // IPv6 字面量（URL 里带方括号，hostname 已去掉括号）
  if (host.includes(":")) {
    if (host === "::1" || host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) {
      return "apk_url 不能指向私网或回环地址";
    }
  }

  // 主机名形式的内网地址
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return "apk_url 不能指向内网主机";
  }

  return null;
}

/**
 * 组装除 apk_url 之外的 workflow inputs。
 */
function buildDispatchInputs(body: BuildRequest): Record<string, string> {
  const inputs: Record<string, string> = {};
  // protect_config 是永久冻结的 input 键名（apk-protect-action 设计约定）。
  inputs.protect_config = body.protect_config;
  if (body.dpt_extra_args) inputs.dpt_extra_args = body.dpt_extra_args;
  return inputs;
}

/**
 * dispatch 后探测 runs 列表拿 run_id。
 *
 * 固定探测次数而不是「等满预算」：每次探测自身要花一个 RTT（GitHub
 * 正常 <300ms，慢时上秒），原实现的 `while (now < deadline)` 把等待
 * 和 RTT 混在一起，注释写的「约 5 次」在 fetch 变慢时会缩到 2-3 次，
 * 补绑成功率随网络波动。
 *
 * 改成「预算内最多探测 N 次，间隔均分」：探测次数确定，接住 GitHub
 * 偶发延迟（run 通常 1-2 秒后才出现在列表里）的能力稳定。
 *
 * 补绑在这里做扎实，downstream 收益很大：run_id === null 的任务
 * 正是会让 has_active 恒 true、触发停滞判死、并让 cron 每轮白打一次
 * GitHub 的那一类（见 domain/job.ts 的 isStalled）。
 *
 * @param attempts 探测次数，默认 3（可经 RUN_ID_PROBE_ATTEMPTS 覆盖）
 * @returns run_id，或 null（由 cron / status 回查补上）
 */
async function waitForRunId(
  env: Env,
  workflowFile: string,
  sinceMs: number,
  attempts = RUN_ID_PROBE_ATTEMPTS,
): Promise<number | null> {
  const budgetMs = Number.parseInt(env.RUN_ID_WAIT_MS ?? "4000", 10);
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 4000;
  const deadline = Date.now() + budget;
  const seen = new Set<number>();

  // 间隔 = 预算均分给 attempts+1 段（最后一次探测后不必再等满）。
  const gap = budget / (attempts + 1);

  for (let i = 0; i < attempts; i++) {
    // 关键：探测本身也要受预算约束。只查 deadline 来控制「等待」是不够的
    // ——单次 fetch 就可能吃掉整个预算（GitHub 慢时一次 RTT 上秒），
    // 那样 attempts 次串起来会把墙钟放大几倍，而 Worker 有墙钟上限。
    // 已超时就不再发起新的上游调用。
    if (Date.now() >= deadline) break;

    try {
      const runs = await listRecentRuns(env, workflowFile, sinceMs);
      for (const run of runs) {
        if (seen.has(run.run_id)) continue;
        seen.add(run.run_id);
        return run.run_id;
      }
    } catch {
      // GitHub 瞬时抖动：继续探测，不因此失败整个 build。
    }

    // 末次探测后不等待；否则按 gap 等，但不越过 deadline。
    if (i === attempts - 1) break;
    const wait = Math.min(gap, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleep(wait);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateBuildRequest(body: BuildRequest, env: Env): string[] {
  const problems: string[] = [];
  if (typeof body.apk_url !== "string" || body.apk_url.length === 0) {
    problems.push("apk_url 不能为空");
  } else {
    if (body.apk_url.length > MAX_URL_BYTES) problems.push("apk_url 过长");
    if (!/^https?:\/\//.test(body.apk_url)) {
      problems.push("apk_url 必须是 http(s) 链接");
    } else {
      const hostProblem = checkApkUrlHost(body.apk_url, env);
      if (hostProblem) problems.push(hostProblem);
    }
  }
  if (typeof body.workflow_file !== "string" || body.workflow_file.length === 0) {
    problems.push("workflow_file 不能为空");
  } else if (!/^[\w.-]+\.(yml|yaml)$/.test(body.workflow_file)) {
    problems.push("workflow_file 必须是无路径的 yml/yaml 文件名");
  }
  if (typeof body.protect_config !== "string" || body.protect_config.length === 0) {
    problems.push("protect_config 不能为空");
  } else if (new TextEncoder().encode(body.protect_config).length > MAX_CONFIG_BYTES) {
    problems.push("protect_config 超过 64KB");
  } else {
    try {
      JSON.parse(body.protect_config);
    } catch {
      problems.push("protect_config 不是合法 JSON");
    }
  }
  if (body.dpt_extra_args && new TextEncoder().encode(body.dpt_extra_args).length > 4096) {
    problems.push("dpt_extra_args 过长");
  }
  return problems;
}
