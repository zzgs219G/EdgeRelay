<script setup>
/**
 * Button — shadcn 风格。
 *
 * 与 Element Plus 的区别：
 *   - 没有渐变、没有彩色投影，靠背景色深浅表达层级
 *   - 没有 size="large" 那种字面量枚举，用高度 class 控制
 *   - 过渡只有 colors，不做 scale 变形
 */
import { computed } from 'vue'
import { cn } from '../../lib/utils'

const props = defineProps({
  variant: { type: String, default: 'primary' },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
})

const variants = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80',
  secondary:
    'bg-muted text-foreground hover:bg-muted/70 active:bg-muted/60',
  outline:
    'border border-border bg-transparent hover:bg-muted/60 active:bg-muted',
  ghost:
    'bg-transparent hover:bg-muted/60 active:bg-muted text-muted-foreground',
  destructive:
    'bg-destructive text-destructive-foreground hover:bg-destructive/90',
}

const classes = computed(() =>
  cn(
    // 基础：高度固定 40px，圆角 8px，字号 14px
    'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4',
    'text-sm font-medium whitespace-nowrap',
    'transition-colors duration-150 select-none',
    'disabled:pointer-events-none disabled:opacity-50',
    variants[props.variant] ?? variants.primary,
  ),
)
</script>

<template>
  <button :type="type" :class="classes" :disabled="disabled || loading">
    <span
      v-if="loading"
      class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    />
    <slot />
  </button>
</template>
