import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * CI / 本地（能跑 workerd 的机器）用的 vitest 配置。
 *
 * 迁移说明（vitest-pool-workers 0.15+ 的官方 codemod 路径）：
 *   旧：defineWorkersConfig({ test: { poolOptions: { workers: {...} } } })
 *       import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"
 *   新：defineConfig({ plugins: [cloudflareTest({...})] })
 *       import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
 *
 * 为什么必须改：0.15 起 `/config` 子路径导出被移除，`defineWorkersConfig`
 * 整个删掉。留着旧写法时 CI 的 `npx vitest run` 直接挂在加载配置：
 *   Error: Missing "./config" specifier in "@cloudflare/vitest-pool-workers"
 *
 * 注意本文件只在有 workerd 二进制的平台上可用（CI 的 ubuntu、PC）。
 * Termux/Android arm64 没有 workerd 构建，本机跑测试请用：
 *   npx vitest run --config vitest.node.config.ts
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          GITHUB_TOKEN: "test-github-token",
          RELAY_TOKEN: "test-relay-token",
          // GITHUB_OWNER / GITHUB_REPO 由 wrangler.toml [vars] 提供。
        },
        kvNamespaces: ["EDGE_RELAY_KV"],
      },
    }),
  ],
});
