<script setup>
/**
 * 登录页。
 *
 * 视觉取向：没有卡片、没有渐变、没有彩色投影。
 * 靠一条居中的竖线（border-l）和一个极简的图标建立视觉锚点，
 * 其余交给留白。这类极简登录页在 Linear / Vercel / Raycast 上都是同款思路。
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
  <div class="flex min-h-dvh flex-col items-center justify-center px-6">
    <div class="w-full max-w-[320px]">
      <!-- 品牌：单色图标 + 细字重，不做渐变方块 -->
      <div class="mb-10 flex items-center gap-2.5">
        <i class="ri-shield-keyhole-line text-xl text-foreground/70" />
        <span class="text-[15px] font-semibold tracking-tight">EdgeRelay</span>
      </div>

      <h1 class="mb-1.5 text-[22px] font-semibold tracking-tight">
        登录
      </h1>
      <p class="mb-7 text-[13px] text-muted-foreground">
        输入管理密码以访问构建网关
      </p>

      <form @submit.prevent="onLogin">
        <label for="pw" class="mb-2 block text-[13px] font-medium text-foreground/80">
          密码
        </label>
        <Input
          id="pw"
          v-model="password"
          type="password"
          show-password
          placeholder="管理密码"
          autocomplete="current-password"
          :disabled="auth.checking"
          @keyup.enter="onLogin"
        />

        <Button
          type="submit"
          class="mt-4 w-full"
          :loading="submitting"
          :disabled="auth.checking || !password"
        >
          继续
        </Button>
      </form>

      <!-- 后端状态：极简一行，不用彩色告警块 -->
      <p
        v-if="auth.health && !auth.health.ok"
        class="mt-5 text-2xs leading-relaxed text-destructive"
      >
        <i class="ri-error-warning-line mr-1" />
        {{ (auth.health.problems || []).join('；') }}
      </p>
      <p
        v-else-if="auth.health?.warnings?.length"
        class="mt-5 text-2xs leading-relaxed text-muted-foreground"
      >
        <i class="ri-information-line mr-1" />
        {{ auth.health.warnings.join('；') }}
      </p>

      <p class="mt-8 font-mono text-2xs text-muted-foreground/70">
        RELAY_PASSWORD
      </p>
    </div>
  </div>
</template>
