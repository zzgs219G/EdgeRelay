<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 py-10 relative">
    <!-- 顶部一团蓝色光晕，给浅色页面一点层次，纯 CSS 无图片 -->
    <div
      class="absolute inset-x-0 top-0 h-72 pointer-events-none"
      style="background: radial-gradient(70% 100% at 50% 0%, rgba(59,130,246,0.13), transparent 70%)"
      aria-hidden="true"
    />

    <div class="w-full max-w-[340px] relative animate-fade-in">
      <!-- 品牌 -->
      <div class="text-center mb-9">
        <div
          class="w-20 h-20 bg-white rounded-3xl mx-auto flex items-center justify-center mb-5
                 shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
        >
          <i class="ri-shield-keyhole-fill text-4xl text-blue-500" />
        </div>
        <h1 class="text-3xl font-black text-slate-800 tracking-tight">EdgeRelay</h1>
        <p class="text-slate-400 text-sm mt-2 font-medium">APK 构建网关控制台</p>
      </div>

      <!-- 表单卡片 -->
      <div class="bg-white p-6 rounded-[24px] shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
        <label class="block text-xs font-bold text-slate-500 mb-2">管理密码</label>
        <el-input
          v-model="password"
          type="password"
          placeholder="请输入管理密码"
          show-password
          size="large"
          :disabled="auth.checking"
          @keyup.enter="onLogin"
        />

        <el-button
          type="primary"
          size="large"
          class="w-full font-bold !rounded-xl h-12 mt-4
                 shadow-[0_4px_14px_0_rgba(59,130,246,0.39)]"
          :loading="submitting"
          :disabled="auth.checking"
          @click="onLogin"
        >
          进入控制台
        </el-button>
      </div>

      <!-- 后端配置问题直接摊在登录页：缺 secret 来这里就能看到，
           而不是登进去才发现所有接口都坏。 -->
      <!--
        problems = 致命（KV 挂了，面板不可用）→ 红色
        warnings = 非致命（缺 token 只影响构建 / APP）→ 琥珀色
        分级展示，避免"只是还没配 APP 令牌"被渲染成整站故障。
      -->
      <div
        v-if="auth.health && !auth.health.ok"
        class="mt-4 bg-red-50 border border-red-100 rounded-2xl p-4"
      >
        <div class="flex items-center text-red-600 text-xs font-bold mb-2">
          <i class="ri-error-warning-fill mr-1.5" /> 后端不可用
        </div>
        <ul class="text-[11px] text-red-700/80 space-y-1 leading-relaxed">
          <li v-for="p in auth.health.problems || []" :key="p">{{ p }}</li>
        </ul>
      </div>
      <div
        v-else-if="auth.health && auth.health.warnings?.length"
        class="mt-4 bg-amber-50 border border-amber-100 rounded-2xl p-4"
      >
        <div class="flex items-center text-amber-600 text-xs font-bold mb-2">
          <i class="ri-information-fill mr-1.5" /> 部分功能未就绪
        </div>
        <ul class="text-[11px] text-amber-700/80 space-y-1 leading-relaxed">
          <li v-for="w in auth.health.warnings" :key="w">{{ w }}</li>
        </ul>
      </div>

      <p class="text-center text-[11px] text-slate-400 mt-6">
        密码由 <code class="font-mono bg-slate-100 px-1.5 py-0.5 rounded">RELAY_PASSWORD</code> 提供
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores'

const router = useRouter()
const auth = useAuthStore()
const password = ref('')
const submitting = ref(false)

// 登录态探测与跳转由 router.beforeEach 统一处理——这里只管提交表单。
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
