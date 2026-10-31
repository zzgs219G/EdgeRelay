<template>
  <div class="min-h-screen flex flex-col">
    <!-- ── 顶栏 ────────────────────────────────────────────────── -->
    <header class="glass-header sticky top-0 z-30 border-b border-slate-100">
      <div class="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
        <div class="flex items-center min-w-0">
          <button
            class="w-9 h-9 -ml-2 rounded-xl flex items-center justify-center text-slate-500
                   active:bg-slate-100 transition flex-shrink-0"
            @click="router.back()"
          >
            <i class="ri-arrow-left-s-line text-xl" />
          </button>
          <span class="font-bold text-[16px] text-slate-800 tracking-tight ml-1 truncate-1">
            任务详情
          </span>
        </div>
        <button
          class="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500
                 active:bg-slate-100 transition"
          :disabled="loading"
          @click="load"
        >
          <i class="ri-refresh-line text-lg" :class="{ 'animate-spin': loading }" />
        </button>
      </div>
    </header>

    <main class="flex-grow w-full max-w-2xl mx-auto px-4 py-4 pb-24">
      <!-- 加载骨架 -->
      <div v-if="loading && !ready" class="space-y-3">
        <div class="h-28 bg-white rounded-[14px] animate-pulse" />
        <div class="h-40 bg-white rounded-[14px] animate-pulse" />
      </div>

      <template v-else>
        <div v-if="errorMsg" class="mb-4 bg-red-50 border border-red-100 rounded-2xl p-4">
          <div class="text-[12px] text-red-600 leading-relaxed">{{ errorMsg }}</div>
          <button
            class="mt-3 text-[12px] font-bold text-red-700 bg-white border border-red-200
                   px-3 py-2 rounded-lg active:scale-95 transition"
            @click="load"
          >
            重试
          </button>
        </div>

        <template v-if="jobInfo">
          <!-- ── 任务概览 ─────────────────────────────────────── -->
          <section class="bg-white rounded-[14px] p-5 mb-4 shadow-[0_4px_12px_rgba(0,0,0,0.03)]">
            <div class="flex items-start justify-between mb-4">
              <div class="min-w-0 pr-3">
                <div class="text-[15px] font-bold text-gray-800 leading-tight mb-1 truncate-2">
                  {{ jobInfo.modules?.length ? jobInfo.modules.join(' · ') : jobInfo.workflow_file }}
                </div>
                <div class="text-[11px] text-gray-400 font-mono truncate-1">{{ jobInfo.job_id }}</div>
              </div>
              <span
                class="inline-flex items-center px-2 py-1 rounded text-[10px] font-bold flex-shrink-0"
                :class="pillClass(jobInfo.app_status)"
              >
                <i :class="pillIcon(jobInfo.app_status)" class="mr-0.5" />
                {{ statusLabel(jobInfo.app_status) }}
              </span>
            </div>

            <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-[11px]">
              <div>
                <dt class="text-gray-400 mb-0.5">流水线</dt>
                <dd class="text-slate-700 font-mono truncate-1">{{ jobInfo.workflow_file }}</dd>
              </div>
              <div>
                <dt class="text-gray-400 mb-0.5">创建时间</dt>
                <dd class="text-slate-700">{{ fmtTime(jobInfo.created_at_ms) }}</dd>
              </div>
              <div v-if="jobInfo.elapsed_ms > 0">
                <dt class="text-gray-400 mb-0.5">耗时</dt>
                <dd class="text-slate-700">{{ fmtDuration(jobInfo.elapsed_ms) }}</dd>
              </div>
              <div v-if="steps?.run_started_at">
                <dt class="text-gray-400 mb-0.5">开始时间</dt>
                <dd class="text-slate-700">{{ fmtIso(steps.run_started_at) }}</dd>
              </div>
            </dl>

            <!-- 错误信息 -->
            <p
              v-if="jobInfo.error"
              class="mt-4 pt-3 border-t border-gray-50 text-[11px] text-red-500 leading-relaxed"
            >
              {{ jobInfo.error }}
            </p>

            <!-- 操作 -->
            <div
              v-if="jobInfo.download_url || jobInfo.can_log"
              class="mt-4 pt-3 border-t border-gray-50 flex items-center justify-end gap-2"
            >
              <a
                v-if="jobInfo.can_log"
                :href="`/api/log/${jobInfo.job_id}`"
                class="inline-flex items-center text-xs font-bold text-slate-600 bg-slate-100
                       px-3 py-2 rounded-lg active:scale-95 transition"
              >
                <i class="ri-file-text-line mr-1 text-base" /> 日志
              </a>
              <a
                v-if="jobInfo.download_url"
                :href="artifactHref(jobInfo)"
                target="_blank"
                rel="noopener"
                class="inline-flex items-center text-xs font-bold text-white bg-blue-500
                       px-3 py-2 rounded-lg active:scale-95 transition
                       shadow-[0_1px_2px_rgba(16,24,40,0.08)]"
              >
                <i class="ri-download-2-line mr-1 text-base" /> 下载产物
              </a>
            </div>
          </section>

          <!-- ── 步骤明细 ─────────────────────────────────────── -->
          <section class="bg-white rounded-[14px] p-5 shadow-[0_4px_12px_rgba(0,0,0,0.03)]">
            <h2 class="font-bold text-slate-800 text-[15px] flex items-center mb-1">
              <i class="ri-list-check-2 mr-1.5 text-blue-500" /> 构建步骤
            </h2>

            <!-- 明细不可用：不是错误，服务端降级时也会 200 + reason。
                 典型原因：run_id 还没绑上（queued）、GitHub 瞬时故障。 -->
            <div
              v-if="steps && !steps.available"
              class="mt-3 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5
                     text-[11px] text-amber-700 leading-relaxed"
            >
              <i class="ri-information-fill mr-1" />
              {{ steps.reason || '步骤明细暂不可用' }}
            </div>

            <!-- 加载中 -->
            <div v-else-if="stepsLoading" class="mt-4 space-y-2">
              <div v-for="i in 4" :key="i" class="h-9 bg-slate-50 rounded-lg animate-pulse" />
            </div>

            <!-- 有数据 -->
            <div v-else-if="steps?.jobs?.length" class="mt-3 space-y-5">
              <div v-for="gj in steps.jobs" :key="gj.id">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-[12px] font-bold text-slate-700 flex items-center min-w-0">
                    <i :class="stepIcon(gj.status, gj.conclusion)" class="mr-1.5 text-sm" />
                    <span class="truncate-1">{{ gj.name }}</span>
                  </span>
                  <span class="text-[10px] text-gray-400 flex-shrink-0 ml-2">
                    {{ fmtJobDuration(gj) }}
                  </span>
                </div>

                <ol class="space-y-1.5 pl-1">
                  <li
                    v-for="s in gj.steps"
                    :key="s.number"
                    class="flex items-center justify-between gap-2 text-[11px]
                           px-2.5 py-2 rounded-lg bg-slate-50/70"
                  >
                    <span class="flex items-center min-w-0">
                      <i :class="stepIcon(s.status, s.conclusion)" class="mr-1.5 flex-shrink-0" />
                      <span class="text-slate-600 truncate-1">{{ s.number }}. {{ s.name }}</span>
                    </span>
                    <span class="text-[10px] text-gray-400 font-mono flex-shrink-0">
                      {{ fmtStepDuration(s) }}
                    </span>
                  </li>
                </ol>
              </div>
            </div>

            <!-- 空：run 已完成但 GitHub 没回 steps -->
            <p v-else class="mt-3 text-[11px] text-gray-400">没有可显示的步骤记录</p>
          </section>
        </template>
      </template>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore, useJobStore } from '../stores'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const job = useJobStore()

const loading = ref(false)
const stepsLoading = ref(false)
const ready = ref(false)
const errorMsg = ref('')
/** 步骤明细响应：{ available, jobs[], reason }。null = 尚未加载。 */
const steps = ref(null)

const jobId = computed(() => route.params.jobId)

/**
 * 任务概览信息来自列表 store，不额外请求。
 *
 * 为什么不打 /api/status/:jobId：那个接口是 APP 的热路径，而且它会在
 * run 未终态时回查 GitHub 并可能写 KV。详情页已经有列表数据（模块、
 * 状态、错误、下载链接都在里面），再拉一次只是重复消耗。
 *
 * 代价：直接刷新详情页 URL 时列表还是空的，此时会退回打一次列表接口。
 */
const jobInfo = computed(() => job.jobs.find((j) => j.job_id === jobId.value) || null)

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

/** GitHub 的 step/job 状态 → 图标。成功绿勾、失败红叉、进行中转圈、其余灰。 */
function stepIcon(status, conclusion) {
  if (conclusion === 'success') return 'ri-checkbox-circle-fill text-green-500'
  if (conclusion === 'failure' || conclusion === 'cancelled') {
    return 'ri-close-circle-fill text-red-500'
  }
  if (conclusion === 'skipped') return 'ri-forbid-line text-gray-300'
  if (status === 'in_progress') return 'ri-loader-4-line animate-spin text-amber-500'
  return 'ri-circle-line text-gray-300'
}

function fmtTime(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtIso(iso) {
  if (!iso) return '—'
  const t = Date.parse(iso)
  return Number.isFinite(t) ? fmtTime(t) : '—'
}

/** 毫秒 → 「12分34秒」。构建最快也就几十秒，不需要小时级精度。 */
function fmtDuration(ms) {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}分${s}秒` : `${s}秒`
}

/** 起止时间字符串 → 毫秒差。缺任一端时返回 null（进行中的 job 只有 started_at）。 */
function spanMs(startIso, endIso) {
  if (!startIso || !endIso) return null
  const a = Date.parse(startIso)
  const b = Date.parse(endIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.max(0, b - a)
}

function fmtJobDuration(gj) {
  const ms = spanMs(gj.started_at, gj.completed_at)
  if (ms === null) return gj.status === 'in_progress' ? '进行中' : '—'
  return fmtDuration(ms)
}

function fmtStepDuration(s) {
  const ms = spanMs(s.started_at, s.completed_at)
  if (ms === null) {
    if (s.status === 'in_progress') return '进行中'
    // 没有起止时间的步骤（未执行/跳过）不显示假的 0 秒
    return ''
  }
  return fmtDuration(ms)
}

/**
 * 产物下载地址。与 Dashboard 同一规则：
 * GitHub artifact 链接必须走网关代理，否则浏览器直连是不带令牌的跨域
 * 请求，会撞未认证限额（60 次/小时/IP）。
 */
function artifactHref(j) {
  const url = j.download_url || ''
  const isGithub = url.includes('api.github.com') || url.includes('/actions/artifacts/')
  return isGithub ? `/api/artifact/${j.job_id}` : url
}

/** 拉步骤明细。每次进页面/刷新拉一次——它会打两次 GitHub，不能轮询。 */
async function loadSteps() {
  if (!jobId.value) return
  stepsLoading.value = true
  try {
    steps.value = await job.loadSteps(jobId.value)
  } catch (e) {
    if (e.status === 401) {
      auth.logged = false
      router.replace({ name: 'login' })
      return
    }
    steps.value = { available: false, jobs: [], reason: e.message || '步骤明细加载失败' }
  } finally {
    stepsLoading.value = false
  }
}

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    // 直接刷新详情页 URL 时列表为空，补拉一次，否则概览区无数据可显示。
    if (!jobInfo.value) {
      await job.loadJobs({
        onAuthLost: () => {
          auth.logged = false
          router.replace({ name: 'login' })
        },
      })
    }
    if (!jobInfo.value) {
      errorMsg.value = `任务 ${jobId.value} 不存在或已过期`
      return
    }
    ready.value = true
    await loadSteps()
  } finally {
    loading.value = false
  }
}

// 同页内切换任务（极少数情况，如浏览器前进后退）要重新拉。
watch(jobId, () => {
  steps.value = null
  load()
})

onMounted(load)
</script>
