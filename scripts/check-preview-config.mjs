/**
 * 预览配置自检：确保 wrangler.toml 能被 `wrangler preview` 用起来。
 *
 * 为什么需要这个脚本：预览构建在 Cloudflare 侧才跑，本机（Termux/无
 * workerd）无法执行 `wrangler preview` 验证。而这条链路已经坏过一次——
 * wrangler 锁在 3.x 时 `wrangler preview` 只是个抛异常的桩，预览构建
 * 直接失败（见 docs/报错.md）。本脚本用纯文本/JSON 层面的检查，把
 * 「配置层面必然失败」的情况提前到 CI 拦住。
 *
 * 检查项：
 *   1. wrangler 版本 >= 4.135.0（Previews 功能的最低要求）
 *   2. wrangler.toml 存在 [previews] 块（Previews 不继承生产配置）
 *   3. [previews] 里声明了 EDGE_RELAY_KV 绑定（否则一碰 KV 就 500）
 *   4. [assets] 留在顶层（官方要求，不应放进 previews）
 *
 * 用法：node scripts/check-preview-config.mjs
 * 退出码非 0 表示配置会让预览构建失败。
 */

import { readFileSync } from "node:fs";

const MIN_WRANGLER = [4, 135, 0];

function fail(msg) {
  console.error(`✘ ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`✔ ${msg}`);
}

// ── 1. wrangler 版本 ────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const rawRange = pkg.devDependencies?.wrangler ?? "";
const m = rawRange.match(/(\d+)\.(\d+)\.(\d+)/);
if (!m) {
  fail(`package.json 里找不到 wrangler 版本（当前值：${JSON.stringify(rawRange)}）`);
} else {
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  const tooOld =
    got[0] < MIN_WRANGLER[0] ||
    (got[0] === MIN_WRANGLER[0] && got[1] < MIN_WRANGLER[1]);
  if (tooOld) {
    fail(
      `wrangler ${got.join(".")} < ${MIN_WRANGLER.join(".")}：` +
        `这个版本没有 Previews 功能，\`wrangler preview\` 只会抛 DeprecationError，` +
        `预览构建必然失败`,
    );
  } else {
    ok(`wrangler ${got.join(".")} >= ${MIN_WRANGLER.join(".")}（支持 Previews）`);
  }
}

// ── 2~4. wrangler.toml 结构 ─────────────────────────────────────────
const toml = readFileSync("wrangler.toml", "utf8");
const lines = toml.split("\n");

/** 该表头之后、下一个表头之前的文本范围。支持 [t] 与 [[t]] 两种表头。 */
function section(name) {
  const start = lines.findIndex(
    (l) => l.trim() === `[${name}]` || l.trim() === `[[${name}]]`,
  );
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]\]?\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

if (section("previews") === null) {
  fail(
    "wrangler.toml 缺少 [previews] 块：Previews 不继承生产配置，" +
      "缺了它预览起来后 env.EDGE_RELAY_KV 是 undefined，每个请求都会 500",
  );
} else {
  ok("wrangler.toml 有 [previews] 块");
}

const previewsKv = section("previews.kv_namespaces");
if (previewsKv === null) {
  fail(
    "[previews] 里没有 [[previews.kv_namespaces]]：预览实例将拿不到 EDGE_RELAY_KV 绑定",
  );
} else if (!/binding\s*=\s*"EDGE_RELAY_KV"/.test(previewsKv)) {
  fail("[[previews.kv_namespaces]] 里没有 binding = \"EDGE_RELAY_KV\"");
} else if (!/id\s*=\s*"[0-9a-f]{32}"/.test(previewsKv)) {
  fail(
    "[[previews.kv_namespaces]] 的 id 不是 32 位十六进制：" +
      "wrangler 会在部署阶段报 code 10042（KV namespace is not valid）",
  );
} else {
  ok("[[previews.kv_namespaces]] 绑定 EDGE_RELAY_KV 且 id 合法");
}

// assets 必须在顶层：官方明确要求，放 previews 里不会生效。
const topLevelAssets = /^\[assets\]\s*$/m.test(toml);
const assetsInPreviews = section("previews.assets") !== null;
if (!topLevelAssets) {
  fail("wrangler.toml 顶层缺少 [assets]");
} else if (assetsInPreviews) {
  fail("[previews.assets] 不应单独声明：assets 必须留在顶层，预览会复用分支上的产物");
} else {
  ok("[assets] 在顶层（预览复用分支构建产物）");
}

// ── 提示：预览与生产是否共用 KV ─────────────────────────────────────
const prodKv = section("kv_namespaces") ?? "";
const prodId = prodKv.match(/id\s*=\s*"([0-9a-f]{32})"/)?.[1];
const previewId = (section("previews.kv_namespaces") ?? "").match(
  /id\s*=\s*"([0-9a-f]{32})"/,
)?.[1];
if (prodId && previewId && prodId === previewId) {
  console.warn(
    "⚠ 预览与生产共用同一个 KV namespace。预览分支上的构建任务会写进生产任务表，" +
      "也会打乱 meta:open_count 信号灯。建议新建独立 namespace：\n" +
      "    npx wrangler kv namespace create EDGE_RELAY_KV_PREVIEW\n" +
      "  然后把 [[previews.kv_namespaces]] 的 id 换成它的 id。",
  );
}

if (process.exitCode) {
  console.error("\n预览配置自检未通过——修好再推，否则预览构建会失败。");
} else {
  console.log("\n预览配置自检通过。");
}
