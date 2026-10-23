/**
 * EdgeRelay — APK 构建网关
 *
 * 把 jian_box APP 原先直连 GitHub API 的那条链路（拉 workflow 列表 /
 * 解析 yml inputs / dispatch / 轮询 run 状态 / 抓 jobs+steps / 抓注解拼 R2
 * 下载链接）整体搬到 Cloudflare Worker 后面。APP 只持有网关签发的 jobId，
 * 不再接触 GitHub Token 与仓库地址。
 *
 * 目录职责（按依赖方向分层，上层可依赖下层，反之不可）：
 *
 *   shared/     叶子层，零内部依赖
 *     types.ts             — Env / 请求 / 响应类型
 *     http.ts              — JSON / 错误 / CORS / 常量时间比较
 *
 *   domain/     纯逻辑，不碰网络与 KV，可直接单测
 *     job.ts               — job_id 生成 / 状态映射 / 停滞判定
 *
 *   services/   业务与外部交互（GitHub / KV / R2）
 *     github/              — GitHub REST 客户端（client / workflows / runs / artifacts）
 *     kv/                  — 任务记录、信号灯、job_id 索引
 *     config.ts            — 运行时配置（KV 优先，env 兜底）
 *     download.ts          — 产物链接解析 + 兜底原因
 *     modules.ts           — protect_config → 模块中文标签
 *     sigv4.ts             — R2 预签名（SigV4）
 *     job_list_cache.ts    — 面板任务列表的 isolate 短缓存
 *     reconcile.ts         — Cron 兜底轮询
 *
 *   middleware/ 横切关注点
 *     auth.ts / rate_limit.ts / health.ts
 *
 *   routes/     HTTP handler，一个文件一个接口族，**互不引用**
 *     build / status / status_steps / workflows / jobs / config /
 *     auth / r2_presign / log_download / artifact_download
 *
 *   router.ts   路由表与 fetch/scheduled 入口
 *   index.ts    Wrangler 入口（只做转出）
 */

/** 单个任务的持久化记录（KV value，JSON 序列化）。 */
export interface BuildJob {
  /** 网关签发的任务 ID，与 GitHub 无任何可推断关系。 */
  job_id: string;
  /**
   * 任务归属：`panel`（管理员）或 `token:<指纹>`。
   *
   * 为什么必须有：jobId 可枚举（逆序时间戳 + 8 位随机），没有归属时任何
   * 持有令牌的调用方都能读到别人的任务、产物链接与加固配置。
   * 见 services/principal.ts 的 canAccessJob。
   *
   * 本次升级前创建的旧任务没有这个字段——它们只对面板可见（保守策略），
   * 7 天后随 KV TTL 自然消失。
   */
  owner?: string;
  /** GitHub Actions 的 run id；补绑成功前为 null。 */
  run_id: number | null;
  /** workflow 文件名，如 protect-modules.yml。 */
  workflow_file: string;
  /** workflow 显示名，供 APP 展示。 */
  workflow_name: string;
  /** APP 传入的加固配置 JSON 原文（回显用，含 build.log 排查需求）。 */
  protect_config: string;
  /** 附加 dpt 参数原文。 */
  dpt_extra_args: string;
  /** APP 侧的展示名（如「简盒·v1.2.3」），不参与 GitHub 调用。 */
  display_name: string;
  /**
   * 从 protect_config 解析出的已启用模块标签，如 ["签名校验","Dex2C"]。
   * 供任务列表直接展示——否则只看到 workflow 文件名，看不出勾了什么。
   * 解析失败时为空数组，前端退回显示 workflow_file。
   */
  modules?: string[];
  /** 任务状态机：queued → in_progress → completed。 */
  status: JobStatus;
  /** run 的 conclusion：success / failure / cancelled / ...；未完成为 null。 */
  conclusion: string | null;
  /** 产物下载链接（R2 公开直链）；未产出为 null。 */
  download_url: string | null;
  /**
   * 构建日志 artifact 的下载地址。
   * 日志是 `if: always()` 上传的，失败的任务也有——排障最需要它。
   * 下载需 GitHub 令牌，所以面板通过网关代理下载（见 routes/log_download.ts）。
   */
  log_url?: string | null;
  /** 失败时的人类可读原因。 */
  error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  /** 已尝试过的 run_id 候选（补绑时去重用）。 */
  run_id_candidates?: number[];
}

export type JobStatus = "queued" | "in_progress" | "completed";

/** GET /api/status/:jobId 的响应体。 */
export interface JobStatusResponse {
  job_id: string;
  status: JobStatus;
  /** 兼容 APP 现有的状态词映射：PENDING / PROCESSING / SUCCESS / FAILED。 */
  app_status: AppStatus;
  conclusion: string | null;
  download_url: string | null;
  error: string | null;
  /** 任务已运行毫秒数；未开始为 0。 */
  elapsed_ms: number;
  /** 网关视角的服务端时间，便于 APP 校准本地时钟漂移。 */
  server_time: number;
}

export type AppStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED";

/** GET /api/workflows 的响应体。 */
export interface WorkflowListResponse {
  workflows: WorkflowMeta[];
}

export interface WorkflowMeta {
  id: number;
  name: string;
  file_name: string;
  state: string;
  /** workflow_dispatch.inputs 元数据（App 已移除 apk_url 内部项）。 */
  inputs: WorkflowInputMeta[];
}

export interface WorkflowInputMeta {
  name: string;
  description: string;
  required: boolean;
  default: string;
  type: "string" | "boolean" | "choice";
  options: string[];
}

/** POST /api/build 的请求体。 */
export interface BuildRequest {
  /** APK 的公开可下载 URL（R2 直链，由 APP 上传后生成）。 */
  apk_url: string;
  workflow_file: string;
  protect_config: string;
  dpt_extra_args?: string;
  display_name?: string;
}

/** POST /api/build 的响应体。 */
export interface BuildResponse {
  success: boolean;
  job_id: string;
  status: JobStatus;
  error?: string;
}

/** 统一错误响应。 */
export interface ErrorResponse {
  success: false;
  error: string;
  /** 机器可读的错误码，便于 APP 分流处理。 */
  code: ErrorCode;
}

export type ErrorCode =
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "internal_error";

/** Worker 运行时环境。 */
export interface Env {
  /** GitHub fine-grained / classic token，仅存在于 Worker secret。 */
  GITHUB_TOKEN: string;
  /** 仓库 owner，如 zzgs219G。 */
  GITHUB_OWNER: string;
  /** 仓库名，如 apk-protect-action。 */
  GITHUB_REPO: string;
  /** 触发分支，默认 main。 */
  GITHUB_REF?: string;
  /** R2 公开域名，用于把 GitHub 注解里被打码的 URL 补全，也用于拼产物链接。 */
  R2_PUBLIC_DOMAIN?: string;
  /** R2 S3 API 端点，形如 https://<account>.r2.cloudflarestorage.com */
  R2_ENDPOINT?: string;
  /** R2 存储桶名。 */
  R2_BUCKET_NAME?: string;
  /** R2 Access Key ID（仅存网关，绝不下发 APP）。 */
  R2_ACCESS_KEY_ID?: string;
  /** R2 Secret Access Key（仅存网关，绝不下发 APP）。 */
  R2_SECRET_ACCESS_KEY?: string;
  /** 任务表 KV namespace。 */
  EDGE_RELAY_KV: KVNamespace;
  /** Vue 构建产物托管（wrangler.toml 的 [assets]）。 */
  ASSETS?: Fetcher;
  /** 网关调用方令牌（APP 与后台面板共用同一值）。 */
  RELAY_TOKEN: string;
  /** 管理面板登录密码（仅后端，绝不下发到 APP）。 */
  RELAY_PASSWORD?: string;
  /** 管理面板会话 TTL（秒），默认 8 小时，clamp 到 [60, 30天]。 */
  RELAY_SESSION_TTL_SEC?: string;
  /** 每分钟令牌桶容量，默认 120；"0" 关闭限流。 */
  RATE_LIMIT_PER_MIN?: string;
  /** KV 中任务记录的保留天数，默认 7。 */
  JOB_RETENTION_DAYS?: string;
  /** queued 任务停滞多久后判死（分钟），默认 10。0 或非法值回落默认。 */
  JOB_STALL_TIMEOUT_MIN?: string;
  /** dispatch 后等待 run_id 出现的最大毫秒数，默认 4000。 */
  RUN_ID_WAIT_MS?: string;
  /**
   * 设为 "1" 时，POST /api/build 会同步等 run_id 再返回（旧行为）。
   *
   * 默认不走这条：dispatch 成功后立刻返回 queued，run_id 由
   * ctx.waitUntil 后台补绑。同步等待会让请求最长挂 4 秒，Worker 有墙钟上限。
   * 保留开关是为了排查「run_id 到底绑上没有」，也让原有测试语义不变。
   */
  BUILD_SYNC_RUN_ID?: string;
}
