<template>
  <div class="login">
    <!-- 背景光斑：给暗色页面一点层次，纯 CSS 无图片 -->
    <div class="glow" aria-hidden="true" />

    <main class="panel">
      <header class="brand">
        <div class="mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-4z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </div>
        <h1>EdgeRelay</h1>
        <p class="tagline">APK 构建网关</p>
      </header>

      <form class="form" @submit.prevent="onLogin">
        <label class="field">
          <span class="field-label">管理密码</span>
          <el-input
            v-model="password"
            type="password"
            placeholder="请输入密码"
            size="large"
            show-password
            :disabled="auth.checking"
            autocomplete="current-password"
            @keyup.enter="onLogin"
          />
        </label>

        <el-button
          type="primary"
          size="large"
          native-type="submit"
          class="submit"
          :loading="submitting"
          :disabled="auth.checking"
        >
          进入控制台
        </el-button>
      </form>

      <!-- 后端配置问题直接摊在登录页：缺 secret 来这里就能看到，
           而不是登进去才发现所有接口都坏。 -->
      <div v-if="auth.health && !auth.health.ok" class="notice notice-warn">
        <div class="notice-head">
          <el-icon><WarningFilled /></el-icon>
          <strong>后端未就绪</strong>
        </div>
        <ul>
          <li v-for="p in auth.health.problems" :key="p">{{ p }}</li>
        </ul>
      </div>
    </main>

    <footer class="foot">
      密码由 <code>RELAY_PASSWORD</code> 提供
    </footer>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { WarningFilled } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores'

const router = useRouter()
const auth = useAuthStore()
const password = ref('')
const submitting = ref(false)

onMounted(async () => {
  await auth.probe()
  if (auth.logged) router.replace('/dashboard')
})

async function onLogin() {
  if (submitting.value) return
  submitting.value = true
  try {
    const ok = await auth.login(password.value)
    if (ok) router.replace('/dashboard')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.login {
  position: relative;
  min-height: 100dvh; /* dvh 避开 iOS 工具栏的高度跳动 */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: calc(24px + var(--er-safe-t)) 20px calc(24px + var(--er-safe-b));
  overflow: hidden;
}

/* 顶部一团 Primary 色光晕 + 底部一团，制造深度 */
.glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(60% 40% at 50% -8%, rgba(79, 140, 255, 0.22), transparent 70%),
    radial-gradient(50% 30% at 50% 108%, rgba(79, 140, 255, 0.08), transparent 70%);
}

.panel {
  position: relative;
  width: 100%;
  max-width: 380px;
}

/* ── 品牌区 ─────────────────────────────────────────────────────── */
.brand {
  text-align: center;
  margin-bottom: 32px;
}
.mark {
  width: 64px;
  height: 64px;
  margin: 0 auto 18px;
  border-radius: 20px;
  display: grid;
  place-items: center;
  color: var(--er-primary);
  background: linear-gradient(160deg, rgba(79, 140, 255, 0.22), rgba(79, 140, 255, 0.06));
  border: 1px solid rgba(79, 140, 255, 0.28);
  box-shadow: 0 12px 32px -12px rgba(79, 140, 255, 0.5);
}
.mark svg {
  width: 30px;
  height: 30px;
}
.brand h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.tagline {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--er-text-3);
}

/* ── 表单 ───────────────────────────────────────────────────────── */
.field {
  display: block;
}
.field-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--er-text-2);
  margin-bottom: 8px;
  padding-left: 2px;
}
.submit {
  width: 100%;
  margin-top: 20px;
  height: 48px;
  font-size: 15px;
  font-weight: 600;
  border-radius: var(--er-r-md);
}

/* ── 告警条 ─────────────────────────────────────────────────────── */
.notice {
  margin-top: 20px;
  padding: 14px 16px;
  border-radius: var(--er-r-md);
  font-size: 13px;
}
.notice-warn {
  background: rgba(210, 153, 34, 0.09);
  border: 1px solid rgba(210, 153, 34, 0.26);
  color: var(--er-warn);
}
.notice-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
  font-size: 13px;
}
.notice ul {
  margin: 0;
  padding-left: 20px;
  color: var(--er-text-2);
  line-height: 1.7;
}

.foot {
  position: relative;
  margin-top: 28px;
  font-size: 12px;
  color: var(--er-text-3);
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--er-surface-2);
  font-size: 11px;
}
</style>
