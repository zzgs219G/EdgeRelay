/**
 * 校验 frontend/dist 与 Vue 源码是否同步。
 *
 * 做法：重新 build 到一个临时目录，与仓库里的 dist 逐字节比对。
 * 不一致说明有人改了源码但没重新 build——此时若直接把 dist 提交进 git，
 * 会静默部署旧前端，所以必须显式失败。
 *
 * 走正式的 npm run build 而不是裸 vite build：后者会跳过
 * scripts/patch-remixicon.mjs，生成的 CSS 与 dist 里的不一致，误报。
 *
 * 用法：node scripts/check-dist.mjs
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
// --outDir 覆盖 dist，--emptyOutDir 允许清空它。
execSync("npm run build -- --outDir .dist-check --emptyOutDir", {
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

/**
 * 关键守卫：index.html 引用的资源必须真实存在且已被 git 跟踪。
 *
 * 为什么需要（线上白屏的直接教训）：
 *   .gitignore 曾有两条冲突规则，导致 index.html 被提交、但它引用的
 *   index-<hash>.js/.css 被静默忽略。平时看不出问题——因为本地构建后
 *   文件就在磁盘上，wrangler dev 也正常。一旦 hash 变化并部署到 CF，
 *   生产上就是 404 → 整页白屏，而 CI 全绿。
 *
 *   前面的"与源码同步"检查也拦不住：它比的是磁盘上的文件，被 gitignore
 *   的文件照样在磁盘上。
 *
 * 所以这里显式验证两件事：
 *   1. index.html 里 src/href 指向的文件在 dist 里存在
 *   2. 这些文件已被 git 跟踪（否则部署时不会带上）
 */
const html = readFileSync(join(DIST, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);

if (refs.length === 0) {
  console.error("❌ index.html 里没找到任何 assets/ 引用——构建产物异常");
  process.exit(1);
}

const missingOnDisk = [];
const notTracked = [];
for (const ref of refs) {
  const full = join(DIST, ref);
  if (!existsSync(full)) {
    missingOnDisk.push(ref);
    continue;
  }
  // git ls-files 在非 git 环境（如打包后的 tarball）会失败，此时跳过该检查，
  // 避免误报。存在 .git 才做这项校验。
  try {
    const tracked = execSync(`git ls-files --error-unmatch "${join(DIST, ref)}"`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (!tracked) notTracked.push(ref);
  } catch {
    if (existsSync(".git")) notTracked.push(ref);
  }
}

if (missingOnDisk.length > 0) {
  console.error("❌ index.html 引用的文件在 dist 里不存在（部署后会 404 白屏）：");
  console.error(missingOnDisk.map((f) => `  ${f}`).join("\n"));
  console.error("\n修复：npm --prefix frontend run build");
  process.exit(1);
}

if (notTracked.length > 0) {
  console.error("❌ index.html 引用的文件未被 git 跟踪（部署时不会带上，会白屏）：");
  console.error(notTracked.map((f) => `  ${f}`).join("\n"));
  console.error(
    "\n这是 .gitignore 规则冲突的典型症状。检查是否有 dist/ 规则把" +
      " frontend/dist/assets/ 重新忽略了（negation 只放行目录本身，不递归放行子项）。" +
      "\n修复：git add -f frontend/dist 并修正 .gitignore。",
  );
  process.exit(1);
}

console.log(
  `✅ frontend/dist 与源码同步（${committed.size} 个文件，index.html 引用的 ${refs.length} 个资源存在且已跟踪）`,
);
