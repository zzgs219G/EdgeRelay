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
 * ── compatibilityDate 为什么在这里覆盖 ──────────────────────────────
 *
 * wrangler.toml 写的是 2026-10-19（生产部署用，配顶层 wrangler@4.152 的
 * workerd 1.20261019.1 正好支持）。但测试跑的是 pool-workers 内置的
 * wrangler@4.124 → workerd 1.20260815.1，它只支持到 2026-08-22。直接继承
 * 会报：
 *   This Worker requires compatibility date "2026-10-19", but the newest
 *   date supported by this server binary is "2026-08-22".
 * 然后 13 个测试文件全部 Failed to start cloudflare-pool worker。
 *
 * 不能为了测试去降 wrangler.toml 的 date——那会把生产运行时行为一起锁死
 * 在旧语义上。测试该用的上限是「它自己的 workerd 支持到哪天」，所以在这里
 * 单独声明。
 *
 * 维护提示：升级 pool-workers 时，把它内置 wrangler 的 workerd 版本查一下
 * （npm view @cloudflare/vitest-pool-workers@X dependencies.wrangler，再查
 * 那个 wrangler 的 dependencies.workerd），本值应 ≤ 它的日期部分。
 * 若哪天两边 workerd 对齐了，这个覆盖就可以删掉。
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
        compatibilityDate: "2026-08-22",
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
