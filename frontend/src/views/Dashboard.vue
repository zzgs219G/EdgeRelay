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

      <!-- ── 额度仪表盘：这张卡替代了原来占最大面积的「任务概览」 ────
           为什么换：任务概览（进行中/已成功/已失败）只在有任务时有信息量，
           而本网关一天几个构建，绝大多数时间三个数字都是同一个值。
           真正天天要看、且看晚了会出事的是 **额度** —— KV 免费档只有
           读 10 万/天、写 1000/天、list 1000/天，写和 list 打满就直接
           503，比"任务成功几个"重要得多。

           数据口径（必须诚实标注，否则会被当成权威数字）：
             - KV 用量：网关自己记账（Cloudflare 无 KV 用量 API）
             - Workers 请求数：需配 CF_API_TOKEN，未配则显示"未接入"
             - 构建次数：来自网关任务索引，是近似值
           见 frontend/src/views/Dashboard.vue 顶部注释与 /api/usage 实现。 -->
      <section
        class="rounded-[14px] bg-white p-5 mb-4
               shadow-[0_1px_2px_rgba(16,24,40,0.06),0_8px_24px_-12px_rgba(16,24,40,0.18)]"
      >
        <div class="flex items-start justify-between mb-4">
          <div>
            <h2 class="font-bold text-slate-800 text-[15px] flex items-center">
              <i class="ri-dashboard-3-line mr-1.5 text-blue-500" /> 额度用量
            </h2>
            <p class="text-[11px] text-gray-400 mt-0.5">
              UTC {{ usage?.date || '—' }} · 每日 00:00 UTC 重置
            </p>
          </div>
          <span
            v-if="worstPct >= 80"
            class="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full"
            :class="worstPct >= 95 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'"
          >
            <i class="ri-alert-line" /> {{ worstPct >= 95 ? '即将耗尽' : '用量偏高' }}
          </span>
        </div>

        <!-- 未加载：给骨架而不是假数字 -->
        <div v-if="!usage" class="space-y-3">
          <div v-for="i in 3" :key="i" class="h-8 bg-slate-50 rounded-lg animate-pulse" />
        </div>

        <div v-else class="space-y-3">
          <!-- KV 写与 list 是最稀缺的两项（1000/天），排在最前并用更醒目的色 -->
          <div v-for="row in kvRows" :key="row.key">
            <div class="flex items-baseline justify-between mb-1">
              <span class="text-[11px] font-semibold text-slate-600 flex items-center">
                {{ row.label }}
                <span v-if="row.critical" class="ml-1 text-[9px] text-red-500 font-bold">最稀缺</span>
              </span>
              <span class="text-[11px] text-gray-400 font-mono">
                {{ fmtNum(row.used) }} / {{ fmtNum(row.limit) }}
                <span class="ml-1" :class="row.pct >= 80 ? 'text-red-500 font-bold' : ''">
                  {{ row.pct }}%
                </span>
              </span>
            </div>
            <div class="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="barClass(row.pct, row.critical)"
                :style="{ width: Math.max(row.pct, row.used > 0 ? 2 : 0) + '%' }"
              />
            </div>
          </div>

          <!-- Workers 请求数：需要额外 token，未接入时明确说"未接入" -->
          <div class="pt-2 border-t border-slate-50">
            <div class="flex items-baseline justify-between mb-1">
              <span class="text-[11px] font-semibold text-slate-600">Workers 请求</span>
              <span v-if="usage.workers.source === 'graphql'" class="text-[11px] text-gray-400 font-mono">
                {{ fmtNum(usage.workers.requests.used) }} / {{ fmtNum(usage.workers.requests.limit) }}
                <span class="ml-1" :class="usage.workers.requests.pct >= 80 ? 'text-red-500 font-bold' : ''">
                  {{ usage.workers.requests.pct }}%
                </span>
              </span>
              <button
                v-else
                class="text-[10px] text-blue-500 font-semibold flex items-center"
                @click="showUsageHint = !showUsageHint"
              >
                <i class="ri-question-line mr-0.5" /> 未接入
              </button>
            </div>
            <div v-if="usage.workers.source === 'graphql'" class="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="barClass(usage.workers.requests.pct, false)"
                :style="{ width: Math.max(usage.workers.requests.pct, 1) + '%' }"
              />
            </div>
            <p v-else-if="showUsageHint" class="text-[10px] text-gray-400 leading-relaxed mt-1">
              {{ usage.workers.hint }}
            </p>
          </div>
        </div>

        <!-- 底部一行小字：原来任务概览的三个计数挪到这里，不占版面 -->
        <div class="mt-4 pt-3 border-t border-slate-50 flex items-center justify-between text-[11px]">
          <div class="flex items-center gap-3 text-gray-400">
            <span><b class="text-slate-600">{{ running }}</b> 进行中</span>
            <span><b class="text-green-600">{{ succeeded }}</b> 成功</span>
            <span><b class="text-red-500">{{ failed }}</b> 失败</span>
          </div>
          <span class="text-gray-300 flex items-center">
            <i class="ri-refresh-line mr-0.5" :class="{ 'animate-spin': job.loading }" />
            {{ job.hasActive ? '自动刷新' : '已暂停' }}
          </span>
        </div>
      </section>

      <!-- ── 发起构建 ────────────────────────────────────────── -->
      <div class="bg-white rounded-[14px] p-5 shadow-[0_4px_12px_rgba(0,0,0,0.03)] mb-4">
        <button class="w-full flex items-center justify-between mb-1" @click="formOpen = !formOpen">
          <div class="text-left">
            <h2 class="font-bold text-slate-800 text-[15px]">发起构建</h2>
            <p class="text-[11px] text-gray-400 mt-0.5">
              {{ formOpen ? '提交 APK 到流水线加固' : '点击展开新建构建' }}
            </p>
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
            class="w-full font-semibold !rounded-lg h-11 shadow-[0_1px_2px_rgba(16,24,40,0.08)]"
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

        <!-- 后端降级提示：不是错误。最典型的是 KV list 当日额度用尽，
             此时列表是空的，不解释会被误读成"没有任务"。 -->
        <div
          v-if="job.notice"
          class="mb-3 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3
                 text-[11px] text-amber-700 leading-relaxed"
        >
          <i class="ri-information-fill mr-1" /> {{ job.notice }}
        </div>

        <div
          v-if="!job.loading && job.jobs.length === 0"
          class="bg-white rounded-[14px] p-10 text-center shadow-[0_4px_12px_rgba(0,0,0,0.03)]"
        >
          <i class="ri-inbox-2-line text-4xl text-gray-300" />
          <p class="text-sm text-gray-400 mt-2">还没有任务</p>
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="j in visibleJobs"
            :key="j.job_id"
            class="bg-white p-4 rounded-[16px] shadow-[0_2px_8px_rgba(0,0,0,0.02)]"
          >
            <div class="flex justify-between items-start mb-3">
              <div class="flex-1 pr-3 min-w-0">
                <!-- 主行显示「勾了哪些模块」——那才是用户关心的。
                     workflow 文件名只作副信息，因为 protect-modules.yml
                     这种名字看不出勾选内容。 -->
                <div class="text-[15px] font-bold text-gray-800 leading-tight mb-1 truncate-1">
                  {{ j.modules?.length ? j.modules.join(' · ') : j.workflow_file }}
                </div>
                <div class="text-[11px] text-gray-400 font-mono truncate-1">
                  <!-- 这是网关签发的任务 ID，不是 GitHub 的 run_id。
                       APP 和网关都用它定位任务；run_id 只存服务端。 -->
                  <span
                    class="cursor-help"
                    title="任务 ID（网关签发，非 GitHub run_id）"
                  >{{ j.job_id.slice(0, 8) }}</span>
                  <span v-if="j.modules?.length" class="opacity-70">
                    · {{ j.workflow_file }}
                  </span>
                </div>
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

            <!-- 错误信息独占一行（可能较长） -->
            <p
              v-if="j.error"
              class="text-[11px] text-red-500 leading-relaxed pt-3 border-t border-gray-50"
            >
              {{ j.error }}
            </p>

            <!-- 操作按钮：右对齐，产物与日志并排 -->
            <div
              v-if="j.download_url || j.can_log"
              class="flex items-center justify-end gap-2 pt-3"
              :class="j.error ? 'mt-2' : 'border-t border-gray-50'"
            >
              <a
                v-if="j.can_log"
                :href="`/api/log/${j.job_id}`"
                class="inline-flex items-center text-xs font-bold text-slate-600 bg-slate-100
                       px-3 py-2 rounded-lg active:scale-95 transition"
                title="构建日志（失败的任务也有）"
              >
                <i class="ri-file-text-line mr-1 text-base" /> 日志
              </a>
              <a
                v-if="j.download_url"
                :href="artifactHref(j)"
                target="_blank"
                rel="noopener"
                class="inline-flex items-center text-xs font-bold text-white bg-blue-500
                       px-3 py-2 rounded-lg active:scale-95 transition
                       shadow-[0_1px_2px_rgba(16,24,40,0.08)]"
              >
                <i class="ri-download-2-line mr-1 text-base" /> 下载产物
              </a>
            </div>
          </div>
          <!-- 展开/收起：默认只显示最近 3 条，其余折叠 -->
          <button
            v-if="hiddenJobCount > 0 || jobsExpanded"
            class="w-full py-3 text-xs font-bold text-slate-500 bg-white rounded-[14px]
                   shadow-[0_2px_8px_rgba(0,0,0,0.02)] active:scale-[0.99] transition"
            @click="jobsExpanded = !jobsExpanded"
          >
            <i :class="jobsExpanded ? 'ri-arrow-up-s-line' : 'ri-arrow-down-s-line'" class="mr-1" />
            {{ jobsExpanded ? '收起' : `展开其余 ${hiddenJobCount} 条` }}
          </button>
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

// 默认折叠：发起构建不是高频操作，日常主要看任务列表。
const formOpen = ref(false)

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

// ── 额度仪表盘 ──────────────────────────────────────────────────────
const usage = computed(() => job.usage)
/** 未接入 Workers 请求数时展开提示 */
const showUsageHint = ref(false)

/**
 * KV 四行指标。顺序按「稀缺程度」排，不是按字母或读写顺序：
 *   写 1000/天、list 1000/天  ← 最稀缺，打满就 503
 *   读 10 万/天              ← 宽松 100 倍
 * delete 放在最后，通常为 0（本项目只有 TTL 自然过期，极少显式删）。
 */
const kvRows = computed(() => {
  const k = usage.value?.kv
  if (!k) return []
  return [
    { key: 'writes', label: 'KV 写入', critical: true, ...k.writes },
    { key: 'lists', label: 'KV 列表', critical: true, ...k.lists },
    { key: 'reads', label: 'KV 读取', critical: false, ...k.reads },
  ]
})

/** 最紧张的那一项的百分比，用于卡片右上角的总告警。 */
const worstPct = computed(() => {
  const rows = kvRows.value
  if (!rows.length) return 0
  return Math.max(...rows.map((r) => r.pct || 0))
})

/**
 * 进度条配色。
 *
 * 稀缺项（写/list）用红→橙→绿，因为它们的 100% 意味着服务直接不可用；
 * 宽松项（读）用蓝，避免满屏红色造成告警疲劳。
 */
function barClass(pct, critical) {
  if (pct >= 95) return 'bg-red-500'
  if (pct >= 80) return 'bg-amber-500'
  return critical ? 'bg-orange-400' : 'bg-blue-500'
}

/** 数字缩写：12000 → 12.0k。额度面板只看量级，不需要精确到个位。 */
function fmtNum(n) {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// ── 任务列表折叠 ────────────────────────────────────────────────────
/**
 * 任务列表默认只显示最近 3 条。
 *
 * 为什么：这个面板一屏能放的东西有限，而"看全部历史"不是日常操作——
 * 真要看的人会点开。默认展开 100 条会把额度卡和发起构建挤出首屏。
 */
const JOBS_PREVIEW = 3
const jobsExpanded = ref(false)
const visibleJobs = computed(() =>
  jobsExpanded.value ? job.jobs : job.jobs.slice(0, JOBS_PREVIEW)
)
const hiddenJobCount = computed(() => Math.max(0, job.jobs.length - JOBS_PREVIEW))

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

/**
 * 产物下载地址。
 *
 * 为什么不能一律直跳 download_url：当它是 GitHub artifact 链接时（R2 直链
 * 没拿到时的兜底），`<a>` 标签点下去是一次**不带 Authorization 头**的跨域
 * 请求，GitHub 按未认证计费——未认证限额只有 60 次/小时/IP，用户看到的是
 * "API rate limit exceeded for <IP>"。而网关明明持有令牌。
 *
 * 所以：R2 公开直链（http、非 github）直连，快且不耗网关流量；
 * 其余一律走 /api/artifact/:jobId，由网关带令牌取回后转发。
 */
function artifactHref(j) {
  const url = j.download_url || ''
  const isGithub = url.includes('api.github.com') || url.includes('/actions/artifacts/')
  return isGithub ? `/api/artifact/${j.job_id}` : url
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
    job.loadUsage(),
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
  // 新任务产生在途状态，重新开启轮询
  pollCount = 0
  startPolling()
}

async function onLogout() {
  await auth.logout()
  router.replace({ name: 'login' })
}

/**
 * 轮询策略：间隔线性递增（5s、10s、15s…，上限 60s）。
 *
 * 为什么递增而不是固定：
 *   提交后的前几分钟变化最快（排队 → 分配 runner → 开始执行），值得盯紧；
 *   进入 Dex2C 转译之类长步骤后，几十秒和一分钟看一次没差别。
 *
 * 40 分钟构建的次数对比：
 *   固定 5s（最早实现）  480 次
 *   固定 20s（上一版）   120 次
 *   递增 + 上限 60s       46 次   ← 现在
 *
 * 加上限是因为不封顶的话间隔会无限增长：跑 40 分钟时间隔已到 200 秒，
 * 那时"看进度"已无意义，而用户回来的第一件事是切前台（会补一次）。
 *
 * 另三条约束（KV 免费额度：读 100k/天、list 仅 1k/天）：
 *   1. 只在 has_active 为真时轮询，全部完成立即停
 *   2. 页面不可见不轮；回前台立刻补一次并重置间隔
 *   3. 后端 15 秒列表缓存兜底，即使多点几次也不落 KV
 */
const POLL_STEP_MS = 5_000
const POLL_MAX_MS = 60_000
/** 安全上限：约 60 分钟。防某个 run 永久卡住时无限刷。 */
const POLL_HARD_LIMIT = 120

let timer = null
let pollCount = 0

/** 第 n 次轮询的间隔：5s、10s、15s… 封顶 60s。 */
function nextIntervalMs(n) {
  return Math.min(POLL_STEP_MS * n, POLL_MAX_MS)
}

function stopPolling() {
  if (timer) clearTimeout(timer)
  timer = null
}

/**
 * 用 setTimeout 递归而非 setInterval——间隔每次都要变，
 * setInterval 固定周期做不到递增。
 */
function scheduleNext() {
  stopPolling()
  if (!job.hasActive) return
  if (pollCount >= POLL_HARD_LIMIT) return

  timer = setTimeout(async () => {
    // 页面在后台：不计次、不发请求，等 visibilitychange 唤醒
    if (document.visibilityState !== 'visible') return

    pollCount++
    await job.loadJobs({ onAuthLost })

    // 额度刷新比任务状态慢得多：它每分钟最多变几十次，而 /api/usage
    // 自己也要读 KV。跟着 5 秒轮询打只会白耗额度——这正是面板要监控的
    // 东西，不能反过来成为消耗主力。每 12 次轮询（约 1-2 分钟）刷一次。
    if (pollCount % 12 === 0) job.loadUsage()

    // 全部完成就停，不再排下一次
    if (!job.hasActive) {
      stopPolling()
      // 停止轮询时补一次额度：构建刚结束，这正是用量变化最明显的时刻
      job.loadUsage()
      return
    }
    scheduleNext()
  }, nextIntervalMs(pollCount + 1))
}

function startPolling() {
  stopPolling()
  if (!job.hasActive) return
  scheduleNext()
}

function onVisibility() {
  if (document.visibilityState === 'visible') {
    // 回前台立刻补一次并把间隔重置回 5s——用户此刻正想看最新状态
    job.loadJobs({ onAuthLost }).then(() => {
      pollCount = 0
      startPolling()
    })
  } else {
    // 后台期间不再排下一次；定时器已触发的那次会在回调里自查可见性
    stopPolling()
  }
}

onMounted(async () => {
  await refreshAll()
  pollCount = 0
  startPolling()
  document.addEventListener('visibilitychange', onVisibility)
})
onUnmounted(() => {
  stopPolling()
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>
