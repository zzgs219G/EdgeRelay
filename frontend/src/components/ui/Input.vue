<script setup>
/**
 * Input — shadcn 风格。
 *
 * 密码框的「显示/隐藏」由 showPassword 控制，图标用 RemixIcon。
 * 对比 Element Plus：EP 的 show-password 是内置的但外观不可控，
 * 这里样式完全可调，代价是要自己写十几行状态代码。
 */
import { computed, ref } from 'vue'
import { cn } from '../../lib/utils'

const props = defineProps({
  modelValue: { type: String, default: '' },
  type: { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  showPassword: { type: Boolean, default: false },
  autocomplete: { type: String, default: 'off' },
  id: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'keyup'])

const revealed = ref(false)

const actualType = computed(() => {
  if (!props.showPassword) return props.type
  return revealed.value ? 'text' : 'password'
})

const inputClasses = computed(() =>
  cn(
    'flex h-10 w-full rounded-md border border-input bg-background',
    'px-3 py-2 text-sm text-foreground',
    'placeholder:text-muted-foreground/60',
    // 2026：聚焦用 ring 而非彩色边框发光
    'transition-colors duration-150',
    'focus-visible:outline-none focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/20',
    'disabled:cursor-not-allowed disabled:opacity-50',
    // 有眼睛图标时右侧留位
    props.showPassword && 'pr-10',
  ),
)

function onInput(e) {
  emit('update:modelValue', e.target.value)
}
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      :type="actualType"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :autocomplete="autocomplete"
      :class="inputClasses"
      @input="onInput"
      @keyup="$emit('keyup', $event)"
    />
    <button
      v-if="showPassword"
      type="button"
      class="absolute right-1 top-1/2 -translate-y-1/2 grid h-8 w-8 place-items-center
             rounded text-muted-foreground transition-colors hover:text-foreground"
      :aria-label="revealed ? '隐藏密码' : '显示密码'"
      @click="revealed = !revealed"
    >
      <i :class="revealed ? 'ri-eye-off-line' : 'ri-eye-line'" class="text-base" />
    </button>
  </div>
</template>
