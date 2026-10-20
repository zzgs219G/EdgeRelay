/**
 * 运行时配置接口：面板 UI 直接读写，不必回 Cloudflare 控制台。
 *
 *   GET   /api/config  → 当前生效配置（敏感字段只给遮蔽值 + 是否已设置）
 *   PATCH /api/config  → 部分更新，写入 KV，立即生效
 *
 * 安全设计：两个接口都走 /api/* 的统一鉴权（Bearer 或面板 session）。
 *
 * 不做二次密码确认，也不对 GET 遮蔽明文。早期版本两者都做了，被判定
 * 为过度设计：能进这个面板的用户已经通过登录验证，而"能改"本身就
 * 意味着能让网关用任意凭证——给"读"再加一道门挡不住实质风险，只是让
 * 「查看/复制自己的 key」这件正常操作变麻烦。密码是唯一防线，在登录
 * 处把住即可。
 */

import type { ResolvedEnv } from "./config";
import {
  CONFIG_FIELDS,
  describeConfig,
  invalidateConfigCache,
  isConfigField,
  isSecretField,
  saveConfig,
  loadConfig,
  type RelayConfig,
} from "./config";
import { json, timingSafeEqual } from "./http";

const MAX_FIELD_LEN = 4096;

/** GET /api/config */
export async function handleGetConfig(env: ResolvedEnv): Promise<Response> {
  const { config, sources } = await describeConfig(env);
  return json({
    ok: true,
    config,
    // sources 告诉 UI 每个值是来自 KV（面板改过）还是 env（CF secret）。
    // 操作者因此能看懂"为什么我在 UI 改的和生效的不一致"。
    sources,
    fields: CONFIG_FIELDS,
  });
}

interface PatchBody {
  values?: Record<string, unknown>;
  /** 显式声明要清除的敏感字段，防止误删凭证。 */
  clear?: unknown;
}

/** PATCH /api/config */
export async function handlePatchConfig(
  request: Request,
  env: ResolvedEnv,
): Promise<Response> {
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return json({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  const values = body.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return json({ ok: false, error: "缺少 values 对象" }, 400);
  }

  const entries = Object.entries(values);
  if (entries.length === 0) {
    return json({ ok: false, error: "values 为空" }, 400);
  }

  // ── 未知键一律拒绝，避免打错字段名却静默成功 ──
  const unknown = entries.map(([k]) => k).filter((k) => !isConfigField(k));
  if (unknown.length > 0) {
    return json(
      {
        ok: false,
        error: `未知配置项：${unknown.join(", ")}`,
        fields: CONFIG_FIELDS,
      },
      400,
    );
  }

  // ── 逐字段校验并转成正确的类型 ──
  const next: RelayConfig = { ...(await loadConfig(env)) };
  const problems: string[] = [];

  /**
   * 清除敏感字段需要显式意图。
   *
   * 空串的语义是「清除 KV 覆盖，回退 env」，这是有意设计（面板的
   * 「恢复默认」、以及清空回退 CF secret 都靠它）。但它太容易误触：
   * 前端曾经的 bug 把敏感输入框清成 '' 后又判成"改过了"，于是一次
   * 手滑就把 KV 里的 GITHUB_TOKEN 删掉，之后每次构建都是 401。
   *
   * 折衷：普通字段照旧接受空串；**敏感字段**要清必须显式带
   * `_clear: true`，例如 {"github_token": "", "github_token_clear": true}。
   * 这样既保留清除能力，又让误清不可能发生。
   */
  const explicitClear = (body as { clear?: unknown }).clear;
  const cleared = new Set<string>();
  if (Array.isArray(explicitClear)) {
    for (const k of explicitClear) {
      if (typeof k === "string" && isConfigField(k)) cleared.add(k);
    }
  }

  for (const [key, rawVal] of entries) {
    const field = key as keyof RelayConfig;

    // 空串 / null 语义 = 清除该覆盖，回退 env
    if (rawVal === "" || rawVal === null || rawVal === undefined) {
      if (isSecretField(key) && !cleared.has(key)) {
        problems.push(
          `清除敏感字段 ${key} 需要显式确认：请传 {"clear":["${key}"]}`,
        );
        continue;
      }
      delete next[field];
      continue;
    }

    if (typeof rawVal !== "string" && typeof rawVal !== "number") {
      problems.push(`${key} 必须是字符串或数字`);
      continue;
    }

    const str = String(rawVal);
    if (str.length > MAX_FIELD_LEN) {
      problems.push(`${key} 超过 ${MAX_FIELD_LEN} 字符`);
      continue;
    }

    // 数值型字段做范围校验
    if (key === "rate_limit_per_min" || key === "job_retention_days" || key === "run_id_wait_ms") {
      const n = Number.parseInt(str, 10);
      if (!Number.isFinite(n) || n < 0) {
        problems.push(`${key} 必须是非负整数`);
        continue;
      }
      if (key === "rate_limit_per_min" && n > 100_000) problems.push("rate_limit_per_min 上限 100000");
      if (key === "job_retention_days" && (n < 1 || n > 365)) problems.push("job_retention_days 范围 1-365");
      if (key === "run_id_wait_ms" && n > 60_000) problems.push("run_id_wait_ms 上限 60000");
      if (problems.length > 0) continue;
      (next as Record<string, unknown>)[key] = n;
      continue;
    }

    // github_ref 做基本格式校验，避免拼出奇怪的 URL
    if (key === "github_ref" && !/^[\w./-]+$/.test(str)) {
      problems.push("github_ref 只能包含字母数字与 . _ - /");
      continue;
    }

    (next as Record<string, unknown>)[key] = str;
  }

  if (problems.length > 0) {
    return json({ ok: false, error: problems.join("；") }, 400);
  }

  await saveConfig(env, next);
  invalidateConfigCache();

  // 回读生效配置，让 UI 立刻反映结果
  const { config, sources } = await describeConfig(env);
  return json({ ok: true, config, sources });
}
