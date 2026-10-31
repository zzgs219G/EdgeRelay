/**
 * 调用方身份。
 *
 * 现阶段只有两种主体，但**任务归属**必须从现在就建立——否则一旦有多人
 * 使用，任何持有令牌的人都能凭 jobId 读到别人的任务、产物链接和加固配置。
 * jobId 形如 `<逆序时间戳base36>-<8位随机>`，是可枚举的。
 *
 *   panel        面板会话（浏览器），代表"管理员"——能看全部任务
 *   token:<fp>   某个 Bearer 令牌，用令牌指纹标识
 *
 * 为什么用「指纹」而不是直接拿令牌当 ID：令牌是 secret，绝不能出现在
 * 日志、KV 记录、错误响应里。指纹是它的 SHA-256 前 16 位，稳定且不可逆。
 *
 * 将来接入多用户时，只需在 principal 上加 user_id，owner 字段已就位。
 */

import type { Env } from "../shared/types";

/** 主体类型。panel 是特权主体（可读全部），token 只能读自己的。 */
export type PrincipalKind = "panel" | "token";

export interface Principal {
  kind: PrincipalKind;
  /**
   * 归属 ID，写进 BuildJob.owner。
   *
   *   panel       → "panel"（固定值，面板代表管理员）
   *   token:<fp>  → 令牌指纹
   */
  id: string;
}

/** 面板会话的归属 ID。 */
export const PANEL_OWNER = "panel";

/**
 * 令牌指纹：SHA-256 前 16 个十六进制字符。
 *
 * 不可逆，因此可以安全地出现在日志与 KV 记录里；同一个令牌永远算出同一个
 * 值，所以能用来做归属判断。
 */
export async function tokenFingerprint(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `token:${hex.slice(0, 16)}`;
}

/** 该主体能否访问指定归属的任务。面板是管理员，可读全部。 */
export function canAccessJob(principal: Principal, owner: string | undefined): boolean {
  // 面板是管理员：能看全部任务。
  if (principal.kind === "panel") return true;

  // 历史任务没有 owner 字段（本次升级前创建的）。
  //
  // 策略：对任何已认证主体可见，而不是只给面板。
  // 理由：升级前所有令牌本来就能读所有任务，若改成"只有面板能读"，
  // 上线瞬间会让**正在运行**的构建对 APP 全部失联。任务最长活 7 天
  // （KV TTL），这段过渡期结束后自然会全部清干净。
  //
  // 代价：过渡期内多个令牌之间仍可互读旧任务。已知并接受——这是
  // 一次性迁移成本，且比让用户自己的在途任务消失更轻。
  if (!owner) return true;

  // 有 owner 的新任务：严格隔离，只能读自己的。
  return principal.id === owner;
}

/** 供测试与内部使用：构造一个令牌主体的 ID。 */
export async function principalForToken(token: string): Promise<Principal> {
  return { kind: "token", id: await tokenFingerprint(token) };
}

/** 从环境变量里取出所有有效令牌（KV 覆盖 + CF secret 双通道）。 */
export function relayTokens(env: Env & { RAW_RELAY_TOKEN?: string }): string[] {
  return [env.RELAY_TOKEN, (env as { RAW_RELAY_TOKEN?: string }).RAW_RELAY_TOKEN].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}
