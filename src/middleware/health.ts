/**
 * GET /health — 真实健康检查。
 *
 * 必须做真实探测，不能只回 ok:true —— 否则 KV 未绑 / namespace id
 * 填错时，/health 是全绿的，而每个真实请求才在 KV 上炸掉，排障时
 * 会被"健康检查明明正常"误导。
 *
 * 判断标准 = 「管理面板与构建接口能不能正常用」，而不是「所有 secret
 * 都配了」。
 *
 * 曾经把 RELAY_TOKEN 列为必填，导致一个自相矛盾的体验：文档说"接 APP
 * 时才需要 RELAY_TOKEN"，但前台一直显示"后端未就绪"——因为健康检查
 * 把它当硬性条件。RELAY_TOKEN 只影响 APP 的 Bearer 鉴权，面板用
 * session cookie，不受影响。
 *
 * 现在的分级：
 *   fatal  （503）：KV 不可用 —— 面板和所有接口都会挂
 *   degraded（200）：缺 GITHUB_TOKEN 等 —— 面板能进，但构建会失败，
 *                    用 warnings 告诉操作者哪部分不可用
 */

import type { Env } from "../shared/types";
import { loadConfig } from "../services/config";
import { json } from "../shared/http";

export async function healthCheck(env: Env): Promise<Response> {
  const problems: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  // 判断"配没配"必须用合并后的配置：用户在面板里填了 GitHub Token 但
  // 没在 CF 里设 secret，光看 env 会误报缺失。
  // loadConfig 有 30s isolate 缓存，与下面的 KV 探针不冲突。
  const kvCfg = await loadConfig(env);
  const hasToken = Boolean(kvCfg.github_token || env.GITHUB_TOKEN);
  const hasOwner = Boolean(kvCfg.github_owner || env.GITHUB_OWNER);
  const hasRepo = Boolean(kvCfg.github_repo || env.GITHUB_REPO);
  const hasRelayToken = Boolean(kvCfg.relay_token || env.RELAY_TOKEN);

  // ── 致命：KV 不可用则整个网关无法工作 ──
  let kvOk = false;
  try {
    if (!env.EDGE_RELAY_KV) {
      problems.push("EDGE_RELAY_KV 未绑定（wrangler.toml 的 [[kv_namespaces]]）");
    } else {
      const probeKey = "health:probe";
      await env.EDGE_RELAY_KV.put(probeKey, String(Date.now()), { expirationTtl: 60 });
      const back = await env.EDGE_RELAY_KV.get(probeKey);
      kvOk = back !== null;
      if (!kvOk) problems.push("EDGE_RELAY_KV 写入后读回为空");
    }
  } catch (err) {
    problems.push(
      `EDGE_RELAY_KV 不可用: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 非致命：缺失只会让部分功能不可用，不该挡住面板 ──
  if (!hasToken) missing.push("GITHUB_TOKEN");
  if (!hasOwner) missing.push("GITHUB_OWNER");
  if (!hasRepo) missing.push("GITHUB_REPO");

  if (missing.length > 0) {
    warnings.push(`构建接口不可用（/api/workflows、/api/build 会失败）：缺 ${missing.join(", ")}`);
  }
  // RELAY_TOKEN 缺失只影响 APP，明确说出来而不是算作故障
  if (!hasRelayToken) {
    warnings.push("RELAY_TOKEN 未配置：APP 无法调用 /api/*（面板不受影响）");
  }

  const healthy = kvOk;
  return json(
    {
      ok: healthy,
      service: "edge-relay",
      server_time: Date.now(),
      kv: kvOk ? "ok" : "error",
      // missing 保留给"会导致构建失败"的项，语义与 warnings 一致
      missing,
      problems,
      warnings,
    },
    healthy ? 200 : 503,
  );
}
