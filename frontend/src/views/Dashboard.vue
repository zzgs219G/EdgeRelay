<template>
  <div class="min-h-screen flex flex-col">
    <!-- ── 吸顶栏 ──────────────────────────────────────────────── -->
    <header class="glass-header sticky top-0 z-30 border-b border-slate-100">
      <div class="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
        <div class="flex items-center min-w-0">
          <div
            class="flex-shrink-0 w-7 h-7 bg-blue-500 rounded-lg flex items-center justify-center mr-2
                   shadow-md shadow-blue-200"
          >
            <i class="ri-shield-keyhole-fill text-white text-sm" />
          </div>
          <span class="font-bold text-lg text-slate-800 tracking-tight truncate-1">EdgeRelay</span>
        </div>
        <div class="flex items-center space-x-1 flex-shrink-0">
          <button
            class="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500
                   active:bg-slate-100 transition"
            :disabled="job.loading"
            @click="refreshAll"
          >
            <i class="ri-refresh-line text-lg" :class="{ 'animate-spin': job.loading }" />
          </button>
          <button
            class="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500
                   active:bg-slate-100 transition"
            @click="router.push({ name: 'config' })"
            aria-label="配置"
          >
            <i class="ri-settings-3-line text-lg" />
          </button>
          <button
            class="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500
                   active:bg-slate-100 transition"
            @click="onLogout"
            aria-label="退出"
          >
            <i class="ri-logout-box-r-line text-lg" />
          </button>
        </div>
      </div>
    </header>

    <main class="flex-grow w-full max-w-2xl mx-auto px-4 py-4 pb-24">
      <!-- 后端告警 -->
      <!-- 致命问题：红色 -->
      <div
        v-if="!healthOk && auth.health?.problems?.length"
        class="mb-4 bg-red-50 border border-red-100 rounded-2xl p-4"
      >
        <div class="flex items-center text-red-600 text-xs font-bold mb-2">
          <i class="ri-error-warning-fill mr-1.5" /> 后端不可用
        </div>
        <ul class="text-[11px] text-red-700/80 space-y-1 leading-relaxed">
          <li v-for="p in auth.health.problems" :key="p">{{ p }}</li>
        </ul>
      </div>
      <!-- 非致命：琥珀色。面板能用，只是某些功能缺配置 -->
      <div
        v-if="auth.health?.warnings?.length"
        class="mb-4 bg-amber-50 border border-amber-100 rounded-2xl p-4"
      >
        <div class="flex items-center text-amber-600 text-xs font-bold mb-2">
          <i class="ri-information-fill mr-1.5" /> 部分功能未就绪
        </div>
        <ul class="text-[11px] text-amber-700/80 space-y-1 leading-relaxed">
          <li v-for="w in auth.health.warnings" :key="w">{{ w }}</li>
        </ul>
      </div>

      <!-- ── 指标卡：渐变主卡 + 2 列 ─────────────────────────── -->
      <div class="grid grid-cols-2 gap-3 mb-4">
        <!-- 主卡：进行中任务 -->
        <div
          class="col-span-2 bg-gradient-to-br from-blue-500 to-blue-600 rounded-[20px] p-5 text-white
                 shadow-[0_8px_20px_rgba(59,130,246,0.3)] relative overflow-hidden"
        >
          <div class="absolute right-0 top-0 opacity-10 translate-x-4 -translate-y-4">
            <i class="ri-rocket-2-fill text-9xl" />
          </div>
          <p class="text-blue-100 text-xs font-bold uppercase tracking-wider mb-1 opacity-90">
            进行中
          </p>
          <div class="flex items-end">
            <span class="text-4xl font-black tracking-tight">{{ running }}</span>
            <span class="text-sm font-bold ml-2 mb-1.5 opacity-80">个任务</span>
          </div>
        </div>

        <!-- 累计成功 -->
        <div
          class="bg-white rounded-[20px] p-4 shadow-[0_4px_12px_rgba(0,0,0,0.03)]
                 flex flex-col justify-between"
        >
          <p class="text-gray-400 text-[11px] font-bold uppercase mb-2">已成功</p>
          <div class="text-xl font-black text-green-500">{{ succeeded }}</div>
        </div>

        <!-- 累计失败 -->
        <div
          class="bg-white rounded-[20px] p-4 shadow-[0_4px_12px_rgba(0,0,0,0.03)]
                 flex flex-col justify-between"
        >
          <p class="text-gray-400 text-[11px] font-bold uppercase mb-2">已失败</p>
          <div class="text-xl font-black text-red-500">{{ failed }}</div>
        </div>

        <!-- 系统状态 -->
        <div
          class="col-span-2 bg-white rounded-[20px] p-4 shadow-[0_4px_12px_rgba(0,0,0,0.03)]
                 flex items-center justify-between"
        >
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 bg-green-50 rounded-full flex items-center justify-center">
              <div
                class="w-3 h-3 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                :class="healthOk ? 'bg-green-500 animate-dot' : 'bg-red-500'"
              />
            </div>
            <div>
              <div class="text-gray-800 font-bold text-sm">
                {{ healthOk ? '系统运行中' : '后端异常' }}
              </div>
              <div class="text-gray-400 text-xs mt-0.5">
                {{ healthOk ? '各项服务正常' : '检查 secret 配置' }}
              </div>
            </div>
          </div>
          <span class="text-[11px] text-gray-400 font-mono">{{ job.jobs.length }} 条记录</span>
        </div>
      </div>

      <!-- ── 发起构建 ────────────────────────────────────────── -->
      <div class="bg-white rounded-[20px] p-5 shadow-[0_4px_12px_rgba(0,0,0,0.03)] mb-4">
        <button class="w-full flex items-center justify-between mb-1" @click="formOpen = !formOpen">
          <div class="text-left">
            <h2 class="font-bold text-slate-800 text-[15px]">发起构建</h2>
            <p class="text-[11px] text-gray-400 mt-0.5">提交 APK 到流水线加固</p>
          </div>
          <i
            class="ri-arrow-down-s-line text-gray-400 text-xl transition-transform"
            :class="{ 'rotate-180': formOpen }"
          />
        </button>

        <div v-show="formOpen" class="pt-3 space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-500 mb-2">APK 下载链接</label>
            <el-input v-model="form.apk_url" placeholder="https://…" clearable />
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-500 mb-2">流水线</label>
            <el-select v-model="form.workflow_file" placeholder="选择流水线" style="width: 100%">
              <el-option
                v-for="w in job.workflows"
                :key="w.file_name"
                :label="w.name"
                :value="w.file_name"
              />
            </el-select>
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-500 mb-2">加固配置 JSON</label>
            <el-input
              v-model="form.protect_config"
              type="textarea"
              :rows="6"
              placeholder='{"modules":[]}'
            />
          </div>

          <el-button
            type="primary"
            class="w-full font-bold !rounded-xl h-12 shadow-[0_4px_14px_0_rgba(59,130,246,0.39)]"
            :loading="job.submitting"
            :disabled="!formValid"
            @click="onBuild"
          >
            发起构建
          </el-button>
        </div>
      </div>

      <!-- ── 任务列表 ────────────────────────────────────────── -->
      <div>
        <h3 class="text-sm font-bold text-gray-800 mb-3 px-1">任务记录</h3>

        <div
          v-if="!job.loading && job.jobs.length === 0"
          class="bg-white rounded-[20px] p-10 text-center shadow-[0_4px_12px_rgba(0,0,0,0.03)]"
        >
          <i class="ri-inbox-2-line text-4xl text-gray-300" />
          <p class="text-sm text-gray-400 mt-2">还没有任务</p>
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="j in job.jobs"
            :key="j.job_id"
            class="bg-white p-4 rounded-[16px] shadow-[0_2px_8px_rgba(0,0,0,0.02)]"
          >
            <div class="flex justify-between items-start mb-3">
              <div class="flex-1 pr-3 min-w-0">
                <div class="text-[15px] font-bold text-gray-800 leading-tight mb-1 truncate-1">
                  {{ j.workflow_file }}
                </div>
                <div class="text-[11px] text-gray-400 font-mono">{{ j.job_id.slice(0, 8) }}</div>
              </div>
              <div class="text-right flex-shrink-0">
                <span
                  class="inline-flex items-center px-2 py-1 rounded text-[10px] font-bold"
                  :class="pillClass(j.app_status)"
                >
                  <i :class="pillIcon(j.app_status)" class="mr-0.5" />
                  {{ statusLabel(j.app_status) }}
                </span>
                <div class="text-[10px] text-gray-400 mt-1.5">{{ fmtTime(j.created_at_ms) }}</div>
              </div>
            </div>

            <div
              v-if="j.download_url || j.error"
              class="flex items-center justify-between pt-3 border-t border-gray-50"
            >
              <a
                v-if="j.download_url"
                :href="j.download_url"
                target="_blank"
                rel="noopener"
                class="inline-flex items-center text-xs font-bold text-blue-600 bg-blue-50
                       px-3 py-2 rounded-lg active:scale-95 transition"
              >
                <i class="ri-download-2-line mr-1 text-base" /> 下载产物
              </a>
              <span v-else class="text-[11px] text-red-500 leading-snug">{{ j.error }}</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore, useJobStore } from '../stores'

const router = useRouter()
const auth = useAuthStore()
const job = useJobStore()

const formOpen = ref(true)

const form = reactive({
  apk_url: '',
  workflow_file: 'protect-modules.yml',
  protect_config: '',
})

const healthOk = computed(() => auth.health?.ok === true)
const formValid = computed(
  () => form.apk_url.trim() && form.protect_config.trim() && form.workflow_file
)
const running = computed(
  () => job.jobs.filter((j) => j.app_status === 'PENDING' || j.app_status === 'PROCESSING').length
)
const succeeded = computed(() => job.jobs.filter((j) => j.app_status === 'SUCCESS').length)
const failed = computed(() => job.jobs.filter((j) => j.app_status === 'FAILED').length)

function pillClass(s) {
  return {
    SUCCESS: 'bg-green-50 text-green-600',
    PROCESSING: 'bg-amber-50 text-amber-600',
    PENDING: 'bg-slate-100 text-slate-500',
    FAILED: 'bg-red-50 text-red-500',
  }[s] || 'bg-slate-100 text-slate-500'
}

function pillIcon(s) {
  return {
    SUCCESS: 'ri-check-line',
    PROCESSING: 'ri-loader-4-line animate-spin',
    PENDING: 'ri-time-line',
    FAILED: 'ri-close-line',
  }[s] || 'ri-question-line'
}

function statusLabel(s) {
  return {
    SUCCESS: '已成功', PROCESSING: '构建中', PENDING: '排队中', FAILED: '已失败',
  }[s] || s
}

function fmtTime(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 登录过期统一处理：清状态 + 回登录页。 */
function onAuthLost() {
  auth.logged = false
  router.replace({ name: 'login' })
}

async function refreshAll() {
  await Promise.all([
    auth.probe(),
    job.loadJobs({ onAuthLost }),
    // 流水线下拉的数据源。之前从没调用过，导致下拉框一直是空的。
    job.loadWorkflows(),
  ])
}

async function onBuild() {
  const cfg = form.protect_config.trim()
  // 前端预校验：非法 JSON 直接拦下，别浪费一次 GitHub dispatch 额度
  try {
    JSON.parse(cfg)
  } catch {
    auth.toast('加固配置不是合法 JSON', 'error')
    return
  }
  await job.submit({
    apk_url: form.apk_url.trim(),
    workflow_file: form.workflow_file,
    protect_config: cfg,
  })
  form.apk_url = ''
  form.protect_config = ''
  formOpen.value = false
}

async function onLogout() {
  await auth.logout()
  router.replace({ name: 'login' })
}

// 轮询在途任务：5 秒一次，只读 KV，不烧 GitHub 配额。
// 页面不可见时暂停——移动端切后台不该继续打请求。
let timer = null
function startPolling() {
  stopPolling()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') job.loadJobs({ onAuthLost })
  }, 5000)
}
function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
}

onMounted(async () => {
  await refreshAll()
  startPolling()
  document.addEventListener('visibilitychange', startPolling)
})
onUnmounted(() => {
  stopPolling()
  document.removeEventListener('visibilitychange', startPolling)
})
</script>
