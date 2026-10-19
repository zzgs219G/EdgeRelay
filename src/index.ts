/**
 * EdgeRelay — APK 构建网关入口。
 *
 * 实现细节在 router.ts；这里只做模块转出，让 wrangler 找到
 * Durable Object 之外的 fetch/scheduled 处理器。
 */

import worker from "./router";

export default worker;
