/**
 * 校验 frontend/dist 与 Vue 源码是否同步。
 *
 * 做法：重新 build 到一个临时目录，与仓库里的 dist 逐字节比对。
 * 不一致说明有人改了源码但没重新 build——此时若直接把 dist 提交进 git，
 * 会静默部署旧前端，所以必须显式失败。
 *
 * 用法：node .local-docs/check-dist.mjs
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = "frontend/dist";
const TMP = "frontend/.dist-check";

if (!existsSync(DIST)) {
  console.error(`❌ ${DIST} 不存在——先跑 npm --prefix frontend run build`);
  process.exit(1);
}

rmSync(TMP, { recursive: true, force: true });

// 用一个独立 outDir 重新构建，避免污染真实 dist。
const pkg = JSON.parse(readFileSync("frontend/package.json", "utf8"));
execSync("npx vite build --outDir .dist-check --emptyOutDir", {
  cwd: "frontend",
  stdio: "inherit",
});

function walk(dir, base = "", out = new Map()) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) walk(full, rel, out);
    else out.set(rel, readFileSync(full).toString("base64"));
  }
  return out;
}

const committed = walk(DIST);
const fresh = walk(TMP);

rmSync(TMP, { recursive: true, force: true });

const diffs = [];
for (const [k, v] of committed) {
  if (!fresh.has(k)) diffs.push(`  仅存在于 dist: ${k}`);
  else if (fresh.get(k) !== v) diffs.push(`  内容不同: ${k}`);
}
for (const k of fresh.keys()) {
  if (!committed.has(k)) diffs.push(`  仅存在于新构建: ${k}`);
}

if (diffs.length > 0) {
  console.error("❌ frontend/dist 与源码不同步：");
  console.error(diffs.slice(0, 10).join("\n"));
  console.error("\n修复：npm --prefix frontend run build && git add frontend/dist");
  process.exit(1);
}
console.log(`✅ frontend/dist 与源码同步（${committed.size} 个文件）`);
