/**
 * 运行时配置接口：面板 UI 直接读写，不必回 Cloudflare 控制台。
 *
 *   GET   /api/config  → 当前生效配置（敏感字段只给遮蔽值 + 是否已设置）
 *   PATCH /api/config  → 部分更新，写入 KV，立即生效
 *
 * 安全设计：
 *   1. 两个接口都走 /api/* 的统一鉴权（Bearer 或面板 session）。
 *   2. PATCH 若涉及敏感字段（github_token / relay_token / relay_password），
 *      额外要求 body 里带 current_password 并通过校验。理由：session
 *      cookie 可能被 XSS 之外的途径（共享设备、误开的窗口）拿到，而改
 *      密码/令牌是能直接劫持整个后端的操作，值得再确认一次。
 *   3. GET 永不返回明文——敏感字段只给 masked + set 标记。
 */

import type { ResolvedEnv } from "./config";
import {
  CONFIG_FIELDS,
  SECRET_FIELDS,
  describeConfig,
  invalidateConfigCache,
  isConfigField,
  isSecretField,
  saveConfig,
  loadConfig,
  resolveEnv,
  type RelayConfig,
  type ResolvedEnv as _ResolvedEnv,
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
  /** 改敏感字段时必须提供；校验当前密码。 */
  current_password?: string;
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

  // ── 改敏感字段需二次确认当前密码 ──
  const touchesSecret = entries.some(([k]) => isSecretField(k));
  if (touchesSecret) {
    const candidates = [env.RELAY_PASSWORD, env.RAW_RELAY_PASSWORD].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    const provided = typeof body.current_password === "string" ? body.current_password : "";
    let ok = false;
    for (const c of candidates) {
      if (timingSafeEqual(provided, c)) ok = true;
    }
    if (!ok) {
      return json(
        { ok: false, error: "修改敏感配置需要提供当前密码（current_password）" },
        403,
      );
    }
  }

  // ── 逐字段校验并转成正确的类型 ──
  const next: RelayConfig = { ...(await loadConfig(env)) };
  const problems: string[] = [];

  for (const [key, rawVal] of entries) {
    const field = key as keyof RelayConfig;

    // 空串 / null 语义 = 清除该覆盖，回退 env
    if (rawVal === "" || rawVal === null || rawVal === undefined) {
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

// ── 按需查看明文 ─────────────────────────────────────────────────────

/**
 * POST /api/config/reveal  { field, current_password }
 *
 * 为什么需要这个接口而不是让 GET /api/config 直接回显明文：
 *   GET 会把「读」的门槛降到和「写」一样——任何拿到 session cookie 的
 *   人都能一次性读走全部凭证去别处使用。而 reveal 要求：
 *     1. 只能一个一个字段看（不能批量拖库）
 *     2. 必须验证当前密码（cookIE 本身不足以读明文）
 *     3. 只回显该字段，不留缓存
 *
 * 这样「自己能看能复制」与「cookie 泄漏不等于凭证泄漏」两者兼得。
 */
export async function handleRevealConfig(
  request: Request,
  env: ResolvedEnv,
): Promise<Response> {
  let body: { field?: string; current_password?: string };
  try {
    body = (await request.json()) as { field?: string; current_password?: string };
  } catch {
    return json({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  const field = typeof body.field === "string" ? body.field.trim() : "";
  if (!isSecretField(field)) {
    return json(
      { ok: false, error: `只能查看敏感字段：${SECRET_FIELDS.join(", ")}` },
      400,
    );
  }

  // 必须验证当前密码。双通道：KV 里配的与 CF secret 里的都认。
  const candidates = [env.RELAY_PASSWORD, env.RAW_RELAY_PASSWORD].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (candidates.length === 0) {
    return json({ ok: false, error: "服务端未配置管理密码，无法验证" }, 500);
  }
  const provided = typeof body.current_password === "string" ? body.current_password : "";
  let ok = false;
  for (const c of candidates) {
    if (timingSafeEqual(provided, c)) ok = true;
  }
  if (!ok) {
    // 与登录一致地放慢，压制暴力猜密码
    await new Promise((r) => setTimeout(r, 400));
    return json({ ok: false, error: "密码不正确" }, 403);
  }

  const merged = await resolveEnv(env);
  const map: Record<string, string | undefined> = {
    github_token: merged.GITHUB_TOKEN,
    relay_token: merged.RELAY_TOKEN,
    relay_password: merged.RELAY_PASSWORD,
    r2_access_key_id: merged.R2_ACCESS_KEY_ID,
    r2_secret_access_key: merged.R2_SECRET_ACCESS_KEY,
  };
  const value = map[field];
  if (!value) {
    return json({ ok: false, error: "该字段未设置" }, 404);
  }

  return json({ ok: true, field, value });
}
