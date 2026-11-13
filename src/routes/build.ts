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
import { describeGitHubError, dispatchWorkflow, fetchWorkflowInputs, GitHubError, listRecentRuns } from "../services/github";
import { putJob, putNewJob } from "../services/kv";
import { bindClientRequestId, getJob, getJobIdByClientRequestId, normalizeClientRequestId } from "../services/kv";
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

  // ── 幂等短路：同一次提交的重试直接拿回原 job_id ──
  //
  // 这是「超时后不产生孤儿任务」的核心。网关的顺序是「先落库、再 dispatch」，
  // 所以客户端超时完全可能发生在任务建成之后——旧版 APP 因此永远拿不到
  // job_id，只能把本地任务标 FAILED，而 GitHub 那边其实已经跑完了。
  //
  // 命中即原样返回，**绝不重新 dispatch**：重复 dispatch 会让同一个 APK
  // 被加固两遍，产出两个任务、两份产物、双倍 Actions 分钟数。
  //
  // 响应里的 status 用任务记录的真实状态（可能是 queued，也可能已经被
  // cron/status 回查推进到 in_progress），调用方按既有逻辑处理即可。
  const clientRequestId = normalizeClientRequestId(body.client_request_id);
  if (body.client_request_id && clientRequestId === null) {
    return error(400, "bad_request", "client_request_id 格式非法（允许 A-Z a-z 0-9 . _ - ，长度 8~64）");
  }
  if (clientRequestId) {
    const existingJobId = await getJobIdByClientRequestId(env, principal.id, clientRequestId);
    if (existingJobId) {
      const existing = await getJob(env, existingJobId);
      if (existing) {
        console.log("build idempotent hit", {
          client_request_id: clientRequestId,
          job_id: existingJobId,
        });
        const resp: BuildResponse = {
          success: true,
          job_id: existingJobId,
          status: existing.status,
        };
        return json(resp, 200);
      }
      // 映射存在但任务记录读不到：可能任务已过 TTL 被清、或映射残留。
      // 不能直接返回这个 job_id（调用方去查状态会 404），落到下面新建。
      // 这也意味着旧映射会被新任务覆盖——正确的自愈方向。
      console.error("idem mapping points to missing job", {
        client_request_id: clientRequestId,
        job_id: existingJobId,
      });
    }
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
    ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
  };

  // 先落库再触发：dispatch 失败也能在任务表里留下痕迹，便于排查。
  // 用 putNewJob 而非 putJob：它是唯一「新建任务」的语义入口，
  // 顺带把未完结信号灯 +1（详见 services/kv/jobs.ts）。
  await putNewJob(env, job);

  // ⚠️ 幂等映射必须在 dispatch 之前写。
  //
  // 在这两行之间到达的重试请求，会读到映射并直接返回同一个 jobId；
  // 若把 bind 挪到 dispatch 之后（或放进 waitUntil），这段窗口里的重试
  // 读不到映射 → 重复 dispatch → 两个任务、两次加固，正是本机制要防的。
  //
  // 顺序之所以安全：映射里存的 jobId 对应的任务此刻已经落库（上一行），
  // 所以拿到 jobId 的调用方去 /api/status 一定能查到它，不会出现
  // 「映射有效但任务不存在」的悬空指针。
  if (clientRequestId) {
    await bindClientRequestId(env, principal.id, clientRequestId, jobId);
  }
  // 让面板立刻看到新任务，而不是等列表缓存（15s）过期。
  invalidateJobsCache();

  // 向 workflow 自己问「你声明了哪些 input」——见 buildDispatchInputs 的说明。
  // 读取失败不阻塞构建：退回「只传历史三字段」，与本次重构之前一致。
  // 加固本身跟 input 声明无关，失败面必须限定在「可选参数传不进去」。
  let declared: Set<string> | null = null;
  try {
    const metas = await fetchWorkflowInputs(env, body.workflow_file);
    declared = new Set(metas.map((m) => m.name));
  } catch (err) {
    console.warn(`[build] 读取 workflow inputs 失败，退回历史字段: ${String(err)}`);
  }

  const inputs = buildDispatchInputs(body, declared);
  // TEMP-DIAG: 排查 no_lock 为何到不了 workflow
  console.log(`[DIAG] declared=${declared ? [...declared].join(",") : "null"} inputs=${JSON.stringify(inputs)}`);
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
 *
 * @param declared workflow yml 里 `on.workflow_dispatch.inputs` 声明的键集合。
 *                 `null` = 没拿到声明（上游读取失败），此时只转发三个历史
 *                 字段，行为退回本次重构之前 —— 宁可少传可选项，也不要
 *                 因为一次 404 把整条构建打死。
 *
 * ## 为什么不是「逐字段硬编码」
 *
 * 原实现只认 protect_config / dpt_extra_args / sign 三个，workflow 每加
 * 一个 input 都要同步改这里，否则该字段被**静默丢弃**：不报错、不警告，
 * 上游以为传了、workflow 收到的是默认值。实测踩过 —— trigger_build.py 传
 * no_lock=true，workflow 里仍是 0，排查了半天。
 *
 * ## 为什么也不是「全量透传」
 *
 * 曾试过遍历 body 全量转发，结果 `display_name`（网关自己的任务显示名，
 * 从来不是 workflow input）被一起发给 GitHub：
 *
 *     HTTP 422: Unexpected inputs provided: ["display_name"]
 *
 * 而且失败发生在 dispatch 阶段，任务早已落库，用户看到的是
 * 「流水线参数不匹配」这种跟真实原因无关的提示。
 *
 * ## 现在的做法：向 workflow 自己问「你有哪些 input」
 *
 * `fetchWorkflowInputs()` 读 `.github/workflows/<file>` 的 yml 原文解析
 * `workflow_dispatch.inputs`，同一函数早已用于新建任务页的表单渲染。
 * 用它做准入清单，等于把 workflow yml 当作唯一真相源：
 *
 *   · workflow 新增 input → 这里自动认识，**不用改网关**
 *   · 网关自用字段（display_name 等）不在 yml 里 → 天然被排除
 *   · 拼错/忘了声明的键名 → 不在 yml 里 → 排除并留痕（不静默）
 *
 * 历史注意：本项目过去的「新参数」几乎都塞在 protect_config 这个 JSON
 * 字符串里（网关对它内容无感知），所以从未撞上这个限制。no_lock 是
 * 第一个做成独立 workflow input 的参数，才把问题暴露出来。
 */
function buildDispatchInputs(
  body: BuildRequest,
  declared: ReadonlySet<string> | null,
): Record<string, string> {
  const inputs: Record<string, string> = {};

  // ── 历史三字段：行为逐字节保持不变 ────────────────────────────────
  // protect_config 是永久冻结的 input 键名（沿用 apk-protect-action 时期
  // 的设计约定；仓库已迁移到 artifact-pipeline，但键名不变 —— workflow
  // yml 与 APP 都依赖它）。
  inputs.protect_config = body.protect_config;
  if (body.dpt_extra_args) inputs.dpt_extra_args = body.dpt_extra_args;
  // sign 只在显式请求时下发（workflow 的 input 默认 false = 产物未签名）。
  // APP 不传此字段 → 行为与之前完全一致。
  if (body.sign === true) inputs.sign = "true";

  // ── 其余字段：只转发 workflow 声明过的 ────────────────────────────
  /** 网关自己消费、不作为 workflow input 转发的键 */
  const NOT_INPUTS = new Set([
    "apk_url",           // 由 validateApkUrl() 校验后单独传
    "workflow_file",     // 用于选 workflow，不是 input
    "client_request_id", // 幂等键，网关自用
    "display_name",      // 任务列表展示名，存 KV，不进 workflow
  ]);

  /**
   * 历史三字段已在上面按各自的语义处理完，这里一律跳过。
   *
   * 为什么不能只判断 `key in inputs`：sign=false 时上面**故意没写入**
   * inputs（保持「不下发 sign」的原语义），若只判断 key in inputs，
   * 循环会把它补成 inputs.sign = "false" —— 等于悄悄改掉了历史行为，
   * 让 workflow 的 input 默认值失效。
   */
  const HANDLED = new Set(["protect_config", "dpt_extra_args", "sign"]);

  const raw = body as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (HANDLED.has(key)) continue;       // 历史三字段已处理
    if (NOT_INPUTS.has(key)) continue;
    if (value === undefined || value === null) continue;

    // 非标量先拦：workflow input 只能是 string
    if (typeof value === "object") {
      console.warn(`[build] 跳过非标量 input: ${key} (${typeof value})`);
      continue;
    }

    if (declared === null) continue;      // 拿不到声明 → 只走历史三字段
    if (!declared.has(key)) {
      // 不静默：调用方拼错键名、或 workflow 忘了声明时，这是唯一的线索。
      console.warn(`[build] 跳过 workflow 未声明的 input: ${key}`);
      continue;
    }

    inputs[key] = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  }

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

/**
 * 测试专用薄包装 —— 把内部函数暴露给单测，不改变生产行为。
 *
 * 为什么不在函数本身上加 export：buildDispatchInputs 是路由内部实现细节，
 * 直接 export 会让它成为对外 API 的一部分（有人可能绕过路由直接调）。
 * 这里只在测试文件里用，且**不参与任何路由**。
 */
export const buildDispatchInputsForTest = buildDispatchInputs;
