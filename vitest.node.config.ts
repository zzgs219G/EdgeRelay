import { defineConfig } from "vitest/config";

/**
 * Node 直跑用的 vitest 配置。
 *
 * 为什么不直接用 vitest.config.ts：@cloudflare/vitest-pool-workers 依赖
 * workerd 原生二进制，而 workerd 没有 Android arm64 构建，本机（Termux）
 * 跑不起来。
 *
 * 被测代码只使用 Web 标准 API（fetch / Request / Response /
 * crypto.randomUUID / TextEncoder），Node 26 全部原生提供，因此切到
 * node environment 即可真实执行。CI（ubuntu-latest）上仍用
 * vitest.config.ts 走 workers pool。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
  },
});
