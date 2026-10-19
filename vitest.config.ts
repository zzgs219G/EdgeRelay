import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            GITHUB_TOKEN: "test-github-token",
            RELAY_TOKEN: "test-relay-token",
            // GITHUB_OWNER / GITHUB_REPO 由 wrangler.toml [vars] 提供。
          },
          kvNamespaces: ["BUILD_JOBS"],
        },
      },
    },
  },
});
