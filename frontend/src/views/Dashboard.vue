<template>
  <div class="app">
    <!-- ── 顶栏：移动端吸顶 + 安全区 ──────────────────────────── -->
    <header class="bar">
      <div class="bar-title">
        <h1>EdgeRelay</h1>
        <span class="dot" :class="healthOk ? 'ok' : 'bad'" />
      </div>
      <div class="bar-actions">
        <button class="icon-btn" :disabled="job.loading" @click="refreshAll" aria-label="刷新">
          <el-icon :class="{ spin: job.loading }"><Refresh /></el-icon>
        </button>
        <button class="icon-btn" @click="onLogout" aria-label="退出">
          <el-icon><SwitchButton /></el-icon>
        </button>
      </div>
    </header>

    <!-- 后端配置告警 -->
    <div v-if="!healthOk" class="notice notice-warn">
      <div class="notice-head">
        <el-icon><WarningFilled /></el-icon>
        <strong>后端未就绪</strong>
      </div>
      <ul>
        <li v-for="p in auth.health?.problems || []" :key="p">{{ p }}</li>
      </ul>
    </div>

    <!-- ── 发起构建（默认折叠，移动端省空间）──────────────────── -->
    <section class="card">
      <button class="card-head" @click="formOpen = !formOpen">
        <div>
          <h2>发起构建</h2>
          <p class="card-sub">提交 APK 到流水线加固</p>
        </div>
        <el-icon :class="{ flip: formOpen }"><ArrowDown /></el-icon>
      </button>

      <div v-show="formOpen" class="card-body">
        <label class="field">
          <span class="field-label">APK 下载链接</span>
          <el-input v-model="form.apk_url" placeholder="https://…" clearable />
        </label>

        <label class="field">
          <span class="field-label">流水线</span>
          <el-select v-model="form.workflow_file" placeholder="选择流水线" style="width:100%">
            <el-option
              v-for="w in job.workflows"
              :key="w.file_name"
              :label="w.name"
              :value="w.file_name"
            />
          </el-select>
        </label>

        <label class="field">
          <span class="field-label">加固配置 JSON</span>
          <el-input
            v-model="form.protect_config"
            type="textarea"
            :rows="6"
            placeholder='{"modules":[]}'
          />
        </label>

        <el-button
          type="primary"
          class="submit"
          :loading="job.submitting"
          :disabled="!formValid"
          @click="onBuild"
        >
          发起构建
        </el-button>
      </div>
    </section>

    <!-- ── 任务列表：移动端用卡片，桌面端才上表格 ───────────────── -->
    <section class="card">
      <div class="card-head static">
        <div>
          <h2>任务</h2>
          <p class="card-sub">共 {{ job.jobs.length }} 条，5 秒自动刷新</p>
        </div>
        <span v-if="running > 0" class="badge">{{ running }} 进行中</span>
      </div>

      <!-- 空态 -->
      <div v-if="!job.loading && job.jobs.length === 0" class="empty">
        <el-icon :size="28"><FolderOpened /></el-icon>
        <p>还没有任务</p>
      </div>

      <!-- 卡片列表（移动优先） -->
      <ul v-else class="jobs">
        <li v-for="j in job.jobs" :key="j.job_id" class="job">
          <div class="job-top">
            <span class="pill" :class="pillClass(j.app_status)">{{ j.app_status }}</span>
            <span class="job-id mono">{{ j.job_id.slice(0, 8) }}</span>
          </div>
          <div class="job-meta">
            <span class="mono truncate">{{ j.workflow_file }}</span>
            <span class="mono dim">{{ fmtTime(j.created_at_ms) }}</span>
          </div>
          <div v-if="j.download_url || j.error" class="job-foot">
            <a v-if="j.download_url" :href="j.download_url" target="_blank" rel="noopener" class="dl">
              <el-icon><Download /></el-icon> 下载产物
            </a>
            <span v-else-if="j.error" class="err">{{ j.error }}</span>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowDown, Download, FolderOpened, Refresh, SwitchButton, WarningFilled,
} from '@element-plus/icons-vue'
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

function pillClass(s) {
  return {
    SUCCESS: 'ok', PROCESSING: 'run', PENDING: 'idle', FAILED: 'bad',
  }[s] || 'idle'
}

function fmtTime(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function refreshAll() {
  await Promise.all([auth.probe(), job.loadJobs()])
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
  router.replace('/')
}

// 轮询在途任务：5 秒一次，只读 KV，不烧 GitHub 配额。
// 页面不可见时暂停——移动端切后台不该继续打请求。
let timer = null
function startPolling() {
  stopPolling()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') job.loadJobs()
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

<style scoped>
.app {
  max-width: 720px; /* 移动优先：内容区窄，桌面上也不会拉成一条长条 */
  margin: 0 auto;
  padding: 0 16px calc(32px + var(--er-safe-b));
}

/* ── 顶栏 ───────────────────────────────────────────────────────── */
.bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  /* 负 margin + 内 padding，让吸顶背景铺满宽度 */
  margin: 0 -16px 16px;
  padding: calc(10px + var(--er-safe-t)) 16px 10px;
  background: rgba(11, 14, 20, 0.82);
  backdrop-filter: saturate(180%) blur(12px);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--er-border);
}
.bar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.bar-title h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: var(--er-r-full);
  flex: none;
}
.dot.ok { background: var(--er-ok); box-shadow: 0 0 0 3px rgba(63, 185, 80, 0.18); }
.dot.bad { background: var(--er-err); box-shadow: 0 0 0 3px rgba(248, 81, 73, 0.18); }

.bar-actions { display: flex; gap: 4px; }
.icon-btn {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--er-r-sm);
  background: transparent;
  color: var(--er-text-2);
  font-size: 18px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.icon-btn:active { background: var(--er-surface-2); color: var(--er-text); }
.icon-btn:disabled { opacity: 0.5; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── 卡片 ───────────────────────────────────────────────────────── */
.card {
  background: var(--er-surface);
  border: 1px solid var(--er-border);
  border-radius: var(--er-r-lg);
  margin-bottom: 14px;
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.card-head.static { cursor: default; }
.card-head .el-icon { color: var(--er-text-3); transition: transform 0.2s; }
.card-head .el-icon.flip { transform: rotate(180deg); }
.card-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.card-sub {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--er-text-3);
}
.card-body { padding: 4px 16px 16px; }

/* ── 表单 ───────────────────────────────────────────────────────── */
.field { display: block; margin-bottom: 14px; }
.field-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--er-text-2);
  margin-bottom: 7px;
  padding-left: 2px;
}
.submit { width: 100%; height: 46px; font-weight: 600; border-radius: var(--er-r-md); }

/* ── 任务卡片 ───────────────────────────────────────────────────── */
.jobs {
  list-style: none;
  margin: 0;
  padding: 0;
}
.job {
  padding: 13px 16px;
  border-top: 1px solid var(--er-border);
}
.job-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.job-id { font-size: 12px; color: var(--er-text-3); }
.job-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--er-text-2);
  min-width: 0;
}
.job-foot { margin-top: 9px; }
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dim { color: var(--er-text-3); flex: none; }
.err { font-size: 12px; color: var(--er-err); }
.dl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 500;
  padding: 7px 13px;
  border-radius: var(--er-r-sm);
  background: var(--er-primary-soft);
}

/* 状态 pill */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: var(--er-r-full);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.pill::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: var(--er-r-full);
  background: currentColor;
}
.pill.run::before { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }

.pill.ok   { background: rgba(63, 185, 80, 0.14);  color: var(--er-ok); }
.pill.run  { background: rgba(210, 153, 34, 0.14); color: var(--er-warn); }
.pill.bad  { background: rgba(248, 81, 73, 0.14);  color: var(--er-err); }
.pill.idle { background: rgba(139, 148, 167, 0.14); color: var(--er-text-3); }

.badge {
  padding: 3px 9px;
  border-radius: var(--er-r-full);
  font-size: 11px;
  font-weight: 600;
  background: var(--er-primary-soft);
  color: var(--er-primary);
}

/* ── 空态 ───────────────────────────────────────────────────────── */
.empty {
  padding: 36px 16px;
  text-align: center;
  color: var(--er-text-3);
}
.empty p { margin: 8px 0 0; font-size: 13px; }

/* ── 告警 ───────────────────────────────────────────────────────── */
.notice {
  margin: 0 0 14px;
  padding: 13px 15px;
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
  margin-bottom: 5px;
}
.notice ul {
  margin: 0;
  padding-left: 20px;
  color: var(--er-text-2);
  line-height: 1.7;
}

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

/* ── 桌面增强（渐进增强，不是降级）──────────────────────────────── */
@media (min-width: 720px) {
  .app { padding: 24px 24px 48px; max-width: 880px; }
  .bar {
    position: static;
    margin: 0 0 20px;
    padding: 0;
    background: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-bottom: none;
  }
  .icon-btn { width: 44px; height: 44px; font-size: 19px; }
  .icon-btn:hover { background: var(--er-surface-2); color: var(--er-text); }
}
</style>
