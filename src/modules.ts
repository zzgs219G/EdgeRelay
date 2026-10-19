/**
 * 把 protect_config 解析成「勾了哪些模块」的中文标签。
 *
 * 为什么需要：任务列表原本只显示 workflow 文件名（`protect-modules.yml`），
 * 看不出这次勾了什么。而 protect_config 里其实有完整信息，只是 key 是
 * 英文（sigcheck / dex2c / packer），中文名只在 schema 里。
 *
 * 成本控制：schema 变更频率极低（加模块才改），缓存 1 小时。
 * 只在 POST /api/build 时解析一次，不进任何轮询路径。
 */

import type { Env } from "./types";

/**
 * schema 缓存 1 小时。
 *
 * 与 /api/schema 那种 60 秒缓存不同：这里只是拿它翻译模块名，
 * 1 小时的陈旧最多导致「刚加的模块显示英文 key」，不影响功能。
 */
const SCHEMA_TTL_MS = 60 * 60 * 1000;

interface CachedSchema {
  at: number;
  /** key → 中文 label */
  labels: Record<string, string>;
}

const cache = new Map<number, CachedSchema>();

export function invalidateModuleLabelCache(): void {
  cache.clear();
}

/**
 * 从 schema 提取 key → label 映射。
 *
 * schema 结构（apk-protect-action/configs/v{N}/config-schema.json）：
 *   { modules: [ { key, label, children?: [ { key, label } ] } ] }
 */
async function loadLabels(
  env: Env,
  version: number,
): Promise<Record<string, string> | null> {
  const now = Date.now();
  const hit = cache.get(version);
  if (hit && now - hit.at < SCHEMA_TTL_MS) return hit.labels;

  try {
    // 复用 workflows.ts 的取文件逻辑？不行——那只取 workflow yml。
    // 这里直接走 Contents API 读 schema 文件。
    const path =
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/` +
      `configs/v${version}/config-schema.json`;
    const resp = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github.raw",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "edge-relay",
      },
    });
    if (!resp.ok) return null;

    const text = await resp.text();
    if (!text.trimStart().startsWith("{")) return null;

    const schema = JSON.parse(text) as {
      modules?: {
        key?: string;
        label?: string;
        children?: { key?: string; label?: string }[];
      }[];
    };

    const labels: Record<string, string> = {};
    for (const m of schema.modules ?? []) {
      if (m.key && m.label) labels[m.key] = m.label;
      for (const c of m.children ?? []) {
        // 子项用 "父.子" 作为 key，避免不同父模块下同名子项冲突
        if (m.key && c.key && c.label) labels[`${m.key}.${c.key}`] = c.label;
      }
    }

    cache.set(version, { at: now, labels });
    return labels;
  } catch {
    // 解析失败不该挡住构建——退回显示英文 key。
    return null;
  }
}

/**
 * 解析 protect_config → 已启用模块的展示标签。
 *
 * @returns 形如 ["签名校验", "Dex2C", "基础加壳"]；解析不出时返回 []。
 */
export async function describeModules(
  env: Env,
  protectConfig: string,
): Promise<string[]> {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(protectConfig) as Record<string, unknown>;
  } catch {
    return [];
  }

  const versionRaw = cfg.schema_version;
  const version = typeof versionRaw === "number" ? versionRaw : 1;

  const labels = await loadLabels(env, version);

  const out: string[] = [];

  for (const [key, value] of Object.entries(cfg)) {
    // schema_version 是元数据，不是模块
    if (key === "schema_version") continue;

    const label = labels?.[key] ?? key;

    // leaf 模块：值是布尔
    if (typeof value === "boolean") {
      if (value) out.push(label);
      continue;
    }

    // parent 模块：{enabled: bool, 子项...}
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (obj.enabled !== true) continue;

      // 勾了父模块但没勾子项 → 只显示父名
      const children = Object.entries(obj)
        .filter(([k, v]) => k !== "enabled" && (v === true || (typeof v === "string" && v.length > 0)))
        .map(([k]) => labels?.[`${key}.${k}`] ?? k);

      out.push(children.length > 0 ? `${label}(${children.join("/")})` : label);
    }
  }

  return out;
}

/** 供测试与调试：把标签数组压成一行。 */
export function formatModules(tags: string[]): string {
  return tags.join(" · ");
}
