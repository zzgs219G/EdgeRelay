/**
 * 运行时配置：KV 优先，env（CF secret/vars）兜底。
 *
 * 为什么需要这一层：
 *   任何放在 CF secret 里的值，改动都要去后台点一遍，且不在版本控制里。
 *   调试期换个 GitHub token、改个仓库名、调个限流阈值，都得钻控制台。
 *   这里让这些值可以存在 KV 里、由面板 UI 直接改，改完立刻生效。
 *
 * 优先级：KV 有值用 KV，没有才回退 env。因此首次部署仍可用 secret 起
 * 一个初始值，之后 UI 改的覆盖它。
 *
 * 安全底线（很重要）：
 *   - RELAY_PASSWORD 采用「双通道」而非覆盖。KV 里配了密码，env 里的
 *     仍然有效。原因：如果用户在 UI 里改密码时打错或忘记，单通道会
 *     直接把自己锁在门外，只能重开 Cloudflare 控制台。env 是逃生舱。
 *   - RELAY_TOKEN 同理接受两个值，方便 APP 迁移期新旧令牌并存。
 *   - 敏感字段永不回显明文：GET /api/config 只返回 has_value + 遮蔽值。
 */

import type { Env } from "./types";

/** KV 中存放配置的键。带版本号便于将来迁移结构。 */
const CONFIG_KEY = "config:v1";

/** isolate 内缓存，避免每个请求都读 KV（免费额度 10 万读/天）。 */
let cached: { value: RelayConfig; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

/** 可运行时修改的配置（全部可选——缺省即回退 env 或内置默认）。 */
export interface RelayConfig {
  github_token?: string;
  github_owner?: string;
  github_repo?: string;
  github_ref?: string;
  /** R2 公开域（非敏感，公开可读） */
  r2_public_domain?: string;
  /** R2 S3 端点，如 https://<account>.r2.cloudflarestorage.com */
  r2_endpoint?: string;
  r2_bucket_name?: string;
  r2_access_key_id?: string;
  r2_secret_access_key?: string;
  relay_token?: string;
  relay_password?: string;
  rate_limit_per_min?: number;
  job_retention_days?: number;
  run_id_wait_ms?: number;
}

/** 敏感字段清单：读接口一律遮蔽。 */
export const SECRET_FIELDS = [
  "github_token",
  "relay_token",
  "relay_password",
  // R2 的 S3 密钥：原本躺在公开可下载的配置 JSON 里，是本次改造要
  // 收进网关的核心目标，必须按敏感字段处理（遮蔽 + 改需二次确认）。
  "r2_access_key_id",
  "r2_secret_access_key",
] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

export function isSecretField(k: string): k is SecretField {
  return (SECRET_FIELDS as readonly string[]).includes(k);
}

/** 完整字段清单，用于校验 PATCH 的未知键。 */
export const CONFIG_FIELDS = [
  "github_token",
  "github_owner",
  "github_repo",
  "github_ref",
  "r2_public_domain",
  "r2_endpoint",
  "r2_bucket_name",
  "r2_access_key_id",
  "r2_secret_access_key",
  "relay_token",
  "relay_password",
  "rate_limit_per_min",
  "job_retention_days",
  "run_id_wait_ms",
] as const;
export type ConfigField = (typeof CONFIG_FIELDS)[number];

export function isConfigField(k: string): k is ConfigField {
  return (CONFIG_FIELDS as readonly string[]).includes(k);
}

/** 读 KV 配置。失败（未绑 KV / JSON 坏 / 网络抖）一律返回空对象，不抛。 */
export async function loadConfig(env: Env): Promise<RelayConfig> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  if (!env.EDGE_RELAY_KV) return {};

  try {
    const raw = await env.EDGE_RELAY_KV.get(CONFIG_KEY);
    const value = raw ? (JSON.parse(raw) as RelayConfig) : {};
    cached = { value, at: now };
    return value;
  } catch {
    // KV 抖动不该让整个 Worker 挂掉——退回 env 配置继续服务。
    return {};
  }
}

/** 写 KV 配置，并让当前 isolate 的缓存立即失效。 */
export async function saveConfig(env: Env, cfg: RelayConfig): Promise<void> {
  const clean: RelayConfig = {};
  // 只保留认识的字段，且跳过空串（空串语义 = 清除该覆盖，回退 env）
  for (const [k, v] of Object.entries(cfg)) {
    if (!isConfigField(k)) continue;
    if (v === "" || v === null || v === undefined) continue;
    (clean as Record<string, unknown>)[k] = v;
  }
  await env.EDGE_RELAY_KV.put(CONFIG_KEY, JSON.stringify(clean));
  cached = { value: clean, at: Date.now() };
}

/** 供 PATCH 后跨 isolate 尽快生效：清空缓存。 */
export function invalidateConfigCache(): void {
  cached = null;
}

/**
 * 合并后的运行环境。
 *
 * 形状与 Env 一致，因此所有既有 handler 无需改动——它们照旧读
 * `env.GITHUB_TOKEN`，只是拿到的已经是合并后的值。
 *
 * 额外带两个「逃生舱」字段：KV 与 env 的密码/令牌同时有效。
 */
export interface ResolvedEnv extends Env {
  /** env 侧的原始值，用于双通道校验（不会被合并覆盖）。 */
  RAW_RELAY_PASSWORD?: string;
  RAW_RELAY_TOKEN?: string;
  /** R2 公开域名（KV 或 env 合并后）。 */
  R2_PUBLIC_DOMAIN?: string;
  /**
   * 未合并的 env 原始快照。
   *
   * 必需：resolveEnv 可能被调用第二次（例如 PATCH 后回显配置时），
   * 那时传入的已经是 ResolvedEnv。若仍用 `env.GITHUB_OWNER` 做兜底，
   * 拿到的就是上一次合并结果，"清除 KV 覆盖回退 env" 会失效。
   */
  RAW_ENV?: Env;
}

function pickNum(kvVal: number | undefined, envVal: string | undefined, fallback: number): string {
  if (typeof kvVal === "number" && Number.isFinite(kvVal)) return String(kvVal);
  if (envVal !== undefined && envVal !== "") return envVal;
  return String(fallback);
}

/**
 * 把 KV 配置合并进 env，得到实际生效的运行时配置。
 *
 * 只做「KV 有值则覆盖」这一件事；密码/令牌的双通道语义由调用方
 * （ui.ts 的校验、router.ts 的鉴权）负责，因为那不是简单的覆盖关系。
 */
export async function resolveEnv(env: Env): Promise<ResolvedEnv> {
  // 若传入的已是合并结果，取它的原始快照重新合并；否则 env 就是原始值。
  // 这样重复调用（PATCH 后回显）时"清除覆盖回退 env"仍然正确。
  const base: Env = (env as ResolvedEnv).RAW_ENV ?? env;
  const cfg = await loadConfig(env);

  return {
    ...base,
    GITHUB_TOKEN: cfg.github_token || base.GITHUB_TOKEN,
    GITHUB_OWNER: cfg.github_owner || base.GITHUB_OWNER,
    GITHUB_REPO: cfg.github_repo || base.GITHUB_REPO,
    GITHUB_REF: cfg.github_ref || base.GITHUB_REF || "main",
    R2_PUBLIC_DOMAIN: cfg.r2_public_domain || base.R2_PUBLIC_DOMAIN,
    R2_ENDPOINT: cfg.r2_endpoint || base.R2_ENDPOINT,
    R2_BUCKET_NAME: cfg.r2_bucket_name || base.R2_BUCKET_NAME,
    R2_ACCESS_KEY_ID: cfg.r2_access_key_id || base.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: cfg.r2_secret_access_key || base.R2_SECRET_ACCESS_KEY,
    // 双通道：KV 值作为「当前生效值」，env 原值另存供兜底校验。
    RELAY_PASSWORD: cfg.relay_password || base.RELAY_PASSWORD,
    RELAY_TOKEN: cfg.relay_token || base.RELAY_TOKEN,
    RAW_RELAY_PASSWORD: base.RELAY_PASSWORD,
    RAW_RELAY_TOKEN: base.RELAY_TOKEN,
    RAW_ENV: base,
    RATE_LIMIT_PER_MIN: pickNum(cfg.rate_limit_per_min, base.RATE_LIMIT_PER_MIN, 120),
    JOB_RETENTION_DAYS: pickNum(cfg.job_retention_days, base.JOB_RETENTION_DAYS, 7),
    RUN_ID_WAIT_MS: pickNum(cfg.run_id_wait_ms, base.RUN_ID_WAIT_MS, 4000),
  };
}

/** 遮蔽敏感值：保留首尾各若干字符，中间用 * 填充。 */
export function maskSecret(v: string | undefined): string | null {
  if (!v) return null;
  if (v.length <= 8) return "*".repeat(v.length);
  const head = v.slice(0, 4);
  const tail = v.slice(-4);
  return `${head}${"*".repeat(Math.min(12, v.length - 8))}${tail}`;
}

/**
 * 生成供 UI 展示的配置视图。
 *
 * 敏感字段绝不返回明文——只给 has_value 与遮蔽值，够操作者确认
 * 「配过没 / 是哪个」而不泄漏。
 */
export async function describeConfig(
  env: Env,
): Promise<{ config: Record<string, unknown>; sources: Record<string, string> }> {
  const kvCfg = await loadConfig(env);
  const merged = await resolveEnv(env);

  const sources: Record<string, string> = {};
  const config: Record<string, unknown> = {};

  const secretOrPlain = (field: ConfigField, effective: string | undefined, kvHas: boolean) => {
    sources[field] = kvHas ? "kv" : effective ? "env" : "unset";
    if (isSecretField(field)) {
      config[field] = undefined; // 占位，下面统一处理
      (config as Record<string, unknown>)[`${field}_set`] = Boolean(effective);
      (config as Record<string, unknown>)[`${field}_masked`] = maskSecret(effective);
    } else {
      config[field] = effective ?? "";
    }
  };

  secretOrPlain("github_token", merged.GITHUB_TOKEN, Boolean(kvCfg.github_token));
  secretOrPlain("github_owner", merged.GITHUB_OWNER, Boolean(kvCfg.github_owner));
  secretOrPlain("github_repo", merged.GITHUB_REPO, Boolean(kvCfg.github_repo));
  secretOrPlain("github_ref", merged.GITHUB_REF, Boolean(kvCfg.github_ref));
  secretOrPlain("r2_public_domain", merged.R2_PUBLIC_DOMAIN, Boolean(kvCfg.r2_public_domain));
  secretOrPlain("r2_endpoint", merged.R2_ENDPOINT, Boolean(kvCfg.r2_endpoint));
  secretOrPlain("r2_bucket_name", merged.R2_BUCKET_NAME, Boolean(kvCfg.r2_bucket_name));
  secretOrPlain("r2_access_key_id", merged.R2_ACCESS_KEY_ID, Boolean(kvCfg.r2_access_key_id));
  secretOrPlain("r2_secret_access_key", merged.R2_SECRET_ACCESS_KEY, Boolean(kvCfg.r2_secret_access_key));
  secretOrPlain("relay_token", merged.RELAY_TOKEN, Boolean(kvCfg.relay_token));
  secretOrPlain("relay_password", merged.RELAY_PASSWORD, Boolean(kvCfg.relay_password));

  // 数值型：直接回显生效值
  config.rate_limit_per_min = Number(merged.RATE_LIMIT_PER_MIN ?? 120);
  config.job_retention_days = Number(merged.JOB_RETENTION_DAYS ?? 7);
  config.run_id_wait_ms = Number(merged.RUN_ID_WAIT_MS ?? 4000);
  sources.rate_limit_per_min = kvCfg.rate_limit_per_min !== undefined ? "kv" : "env";
  sources.job_retention_days = kvCfg.job_retention_days !== undefined ? "kv" : "env";
  sources.run_id_wait_ms = kvCfg.run_id_wait_ms !== undefined ? "kv" : "env";

  // 清掉占位 key
  for (const f of SECRET_FIELDS) delete config[f];

  return { config, sources };
}
