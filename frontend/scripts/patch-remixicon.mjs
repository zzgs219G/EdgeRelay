/**
 * 构建期预处理：生成只含 woff2 的 RemixIcon 样式。
 *
 * 官方 remixicon.css 的 @font-face 同时声明 eot/woff2/woff/ttf/svg
 * 五种格式，vite 会把它们全都当资源拷贝出去——合计 ~4.7MB，其中
 * svg 单个就 3MB。现代浏览器只下载 woff2（189KB），其余是纯死重量。
 *
 * 这里读取官方 CSS，替换 @font-face 块为只指向 woff2 的版本，
 * 图标类名定义原样保留。产物写到 src/generated/remixicon.css，
 * 由 style.css @import。
 *
 * 为什么不在 vite.config 里过滤 assetFileNames：那只改输出路径，
 * 文件照样产出、照样进 dist 并提交进 git。必须从 CSS 源头去掉引用。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../node_modules/remixicon/fonts/remixicon.css')
const out = resolve(here, '../src/generated/remixicon.css')

const css = readFileSync(src, 'utf8')

// 官方文件里的 @font-face 是第一个块，从 "@font-face {" 到匹配的 "}"。
const start = css.indexOf('@font-face')
if (start === -1) {
  throw new Error('remixicon.css 结构变了：找不到 @font-face')
}
const end = css.indexOf('}', start)
if (end === -1) {
  throw new Error('remixicon.css 结构变了：@font-face 没有闭合')
}

// 用相对 node_modules 的路径，让 vite 能解析到真实文件并把 woff2
// 作为资源拷进 dist/assets。注意必须是相对该 CSS 文件所在位置的路径。
const woff2Only = `@font-face {
  font-family: "remixicon";
  src: url("../../node_modules/remixicon/fonts/remixicon.woff2") format("woff2");
  font-display: swap;
}`

const patched = css.slice(0, start) + woff2Only + css.slice(end + 1)

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, patched, 'utf8')
console.log(`[remixicon] 已生成 woff2-only 样式 → ${out}`)
