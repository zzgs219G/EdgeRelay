<script setup>
/**
 * 登录页。
 *
 * 视觉取向：白底容器浮在极淡的冷灰背景上，顶部一层品牌色光晕给纵深。
 * 早前一版把所有装饰都去掉（纯白 + 黑按钮），结果像 Bootstrap 默认样式
 * ——极简不等于没有设计。这一版保留克制，但补齐三样东西：
 *   1. 品牌色（靛蓝）用于唯一的主操作
 *   2. 容器：12px 圆角 + 细边框 + 极淡阴影，让表单有落点
 *   3. 字重层次：品牌名/标题/正文/辅助文字四个级别
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import { useAuthStore } from '../stores'

const router = useRouter()
const auth = useAuthStore()
const password = ref('')
const submitting = ref(false)

async function onLogin() {
  if (submitting.value) return
  submitting.value = true
  try {
    const ok = await auth.login(password.value)
    if (ok) router.replace({ name: 'dashboard' })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="bg-aurora flex min-h-dvh flex-col items-center justify-center px-5 py-10">
    <div class="w-full max-w-[360px]">
      <!-- 品牌区：图标用品牌色的淡底，不是纯灰 -->
      <div class="mb-8 flex flex-col items-center text-center">
        <div
          class="mb-4 grid h-12 w-12 place-items-center rounded-xl
                 bg-primary/10 ring-1 ring-primary/15"
        >
          <i class="ri-shield-keyhole-fill text-[22px] text-primary" />
        </div>
        <h1 class="text-[19px] font-semibold tracking-tight">EdgeRelay</h1>
        <p class="mt-1 text-[13px] text-muted-foreground">APK 构建网关</p>
      </div>

      <!-- 表单容器 -->
      <div
        class="rounded-lg border border-border bg-card p-6
               shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_-12px_rgba(16,24,40,0.12)]"
      >
        <label for="pw" class="mb-2 block text-[13px] font-medium text-foreground/85">
          管理密码
        </label>
        <Input
          id="pw"
          v-model="password"
          type="password"
          show-password
          placeholder="请输入密码"
          autocomplete="current-password"
          :disabled="auth.checking"
          @keyup.enter="onLogin"
        />

        <Button
          type="submit"
          class="mt-5 w-full"
          :loading="submitting"
          :disabled="auth.checking || !password"
          @click="onLogin"
        >
          进入控制台
        </Button>

        <!-- 后端状态：贴在容器内，不额外造告警块 -->
        <div
          v-if="auth.health && !auth.health.ok"
          class="mt-4 rounded-md bg-destructive/10 px-3 py-2.5
                 text-2xs leading-relaxed text-destructive"
        >
          <i class="ri-error-warning-fill mr-1" />
          {{ (auth.health.problems || []).join('；') }}
        </div>
        <div
          v-else-if="auth.health?.warnings?.length"
          class="mt-4 rounded-md bg-muted px-3 py-2.5
                 text-2xs leading-relaxed text-muted-foreground"
        >
          <i class="ri-information-fill mr-1" />
          {{ auth.health.warnings.join('；') }}
        </div>
      </div>

      <p class="mt-5 text-center font-mono text-2xs text-muted-foreground/60">
        RELAY_PASSWORD
      </p>
    </div>
  </div>
</template>
