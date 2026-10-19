<template>
  <div class="dashboard">
    <header class="topbar">
      <div class="title">
        <h1>EdgeRelay</h1>
        <el-tag :type="healthOk ? 'success' : 'danger'" size="small" effect="dark">
          {{ healthOk ? '运行正常' : '后端异常' }}
        </el-tag>
      </div>
      <div class="actions">
        <el-button text @click="refreshAll" :loading="job.loading">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button text @click="onLogout">
          <el-icon><SwitchButton /></el-icon>
          退出
        </el-button>
      </div>
    </header>

    <!-- 后端配置告警：/health 报的问题直接摊开，不用去翻日志 -->
    <el-alert
      v-if="!healthOk"
      :title="'后端未就绪：' + (auth.health?.problems || []).join('；')"
      type="warning"
      show-icon
      :closable="false"
      class="mb"
    />

    <div class="grid">
      <!-- 发起构建 -->
      <section class="card">
        <h2>发起构建</h2>
        <el-form label-position="top" @submit.prevent>
          <el-form-item label="APK 下载链接（R2 公开直链）">
            <el-input v-model="form.apk_url" placeholder="https://..." clearable />
          </el-form-item>

          <el-form-item label="流水线">
            <el-select v-model="form.workflow_file" placeholder="选择流水线" style="width:100%">
              <el-option
                v-for="w in job.workflows"
                :key="w.file_name"
                :label="w.name"
                :value="w.file_name"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="加固配置 JSON">
            <el-input
              v-model="form.protect_config"
              type="textarea"
              :rows="6"
              placeholder='{"modules":[]}'
            />
          </el-form-item>

          <el-button
            type="primary"
            :loading="job.submitting"
            :disabled="!formValid"
            @click="onBuild"
          >
            发起构建
          </el-button>
        </el-form>
      </section>

      <!-- 任务列表 -->
      <section class="card">
        <div class="card-head">
          <h2>任务列表</h2>
          <el-tag size="small" type="info">{{ job.jobs.length }}</el-tag>
        </div>

        <el-table :data="job.jobs" v-loading="job.loading" style="width:100%" max-height="520">
          <el-table-column label="Job ID" width="110">
            <template #default="{ row }">
              <span class="mono">{{ row.job_id.slice(0, 8) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="statusType(row.app_status)" size="small">
                {{ row.app_status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="流水线" min-width="140">
            <template #default="{ row }">
              <span class="mono small">{{ row.workflow_file }}</span>
            </template>
          </el-table-column>
          <el-table-column label="产物 / 错误" min-width="160">
            <template #default="{ row }">
              <a v-if="row.download_url" :href="row.download_url" target="_blank" rel="noopener">
                下载
              </a>
              <span v-else-if="row.error" class="err-text">{{ row.error }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="170">
            <template #default="{ row }">
              <span class="mono small">{{ fmtTime(row.created_at_ms) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore, useJobStore } from '../stores'

const router = useRouter()
const auth = useAuthStore()
const job = useJobStore()

const form = reactive({
  apk_url: '',
  workflow_file: 'protect-modules.yml',
  protect_config: '',
})

const healthOk = computed(() => auth.health?.ok === true)
const formValid = computed(
  () => form.apk_url.trim() && form.protect_config.trim() && form.workflow_file
)

function statusType(s) {
  return { SUCCESS: 'success', PROCESSING: 'warning', PENDING: 'info', FAILED: 'danger' }[s] || 'info'
}

function fmtTime(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function refreshAll() {
  await Promise.all([auth.probe(), job.loadJobs()])
}

async function onBuild() {
  let cfg = form.protect_config.trim()
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
}

async function onLogout() {
  await auth.logout()
  router.replace('/')
}

// 轮询在途任务：5 秒一次，只读 KV，不烧 GitHub 配额
let timer = null
onMounted(async () => {
  await refreshAll()
  timer = setInterval(() => job.loadJobs(), 5000)
})
onUnmounted(() => timer && clearInterval(timer))
</script>

<style scoped>
.dashboard {
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px 20px 48px;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.title h1 {
  font-size: 20px;
  margin: 0;
  color: #e6e9ef;
}
.mb { margin-bottom: 16px; }
.grid {
  display: grid;
  grid-template-columns: minmax(320px, 400px) 1fr;
  gap: 16px;
  align-items: start;
}
@media (max-width: 900px) {
  .grid { grid-template-columns: 1fr; }
}
.card {
  background: #141922;
  border: 1px solid #232a36;
  border-radius: 12px;
  padding: 20px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card h2 {
  font-size: 15px;
  margin: 0 0 16px;
  color: #e6e9ef;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.small { font-size: 12px; }
.muted { color: #8b94a7; }
.err-text { color: #f85149; font-size: 12px; }

/* Element Plus 暗色适配 */
:deep(.el-input__wrapper),
:deep(.el-textarea__inner),
:deep(.el-select__wrapper) {
  background: #0b0e14;
  box-shadow: 0 0 0 1px #232a36;
}
:deep(.el-table) {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: #0b0e14;
  --el-table-row-hover-bg-color: #1a2029;
  --el-table-border-color: #232a36;
  --el-text-color-regular: #e6e9ef;
}
</style>
