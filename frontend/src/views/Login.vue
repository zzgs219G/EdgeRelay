<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand">
        <div class="logo">
          <el-icon :size="32"><Lock /></el-icon>
        </div>
        <h1>EdgeRelay</h1>
        <p>APK 构建网关 · 管理控制台</p>
      </div>

      <el-input
        v-model="password"
        type="password"
        placeholder="请输入管理密码"
        size="large"
        show-password
        :disabled="auth.checking"
        @keyup.enter="onLogin"
      >
        <template #prefix><el-icon><Key /></el-icon></template>
      </el-input>

      <el-button
        type="primary"
        size="large"
        class="submit"
        :loading="submitting"
        :disabled="auth.checking"
        @click="onLogin"
      >
        进入控制台
      </el-button>

      <!-- 后端配置问题直接显示在登录页：缺 secret 时来这里就能看到，
           而不是登进去才发现所有接口都坏。 -->
      <div v-if="auth.health && !auth.health.ok" class="backend-warn">
        <el-icon><WarningFilled /></el-icon>
        <span>后端未就绪</span>
        <ul>
          <li v-for="p in auth.health.problems" :key="p">{{ p }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
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
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b0e14;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 360px;
  background: #141922;
  border: 1px solid #232a36;
  border-radius: 16px;
  padding: 32px 28px;
}
.brand {
  text-align: center;
  margin-bottom: 28px;
}
.logo {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: rgba(79, 140, 255, 0.12);
  color: #4f8cff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}
h1 {
  font-size: 22px;
  margin: 0;
  color: #e6e9ef;
}
.brand p {
  color: #8b94a7;
  font-size: 13px;
  margin: 6px 0 0;
}
.submit {
  width: 100%;
  margin-top: 16px;
  height: 44px;
  font-weight: 600;
}
.backend-warn {
  margin-top: 20px;
  padding: 12px 14px;
  background: rgba(210, 153, 34, 0.1);
  border: 1px solid rgba(210, 153, 34, 0.3);
  border-radius: 8px;
  color: #d29922;
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.backend-warn ul {
  flex-basis: 100%;
  margin: 4px 0 0;
  padding-left: 18px;
  color: #8b94a7;
}
</style>
