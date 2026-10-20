/**
 * className 合并工具（shadcn 惯例）。
 *
 * clsx 处理条件类名，tailwind-merge 解决冲突——
 * 后者是关键：`cn('px-2', 'px-4')` 会正确输出 `px-4` 而不是两个都留着。
 * 没有它，覆写组件默认样式就得靠 `!important`。
 */
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
