<template>
  <div class="min-h-screen flex flex-col">
    <header class="glass-header sticky top-0 z-30 border-b border-slate-100">
      <div class="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
        <div class="flex items-center min-w-0">
          <button
            class="w-9 h-9 -ml-2 rounded-xl flex items-center justify-center text-slate-500
                   active:bg-slate-100 transition"
            @click="router.back()"
          >
            <i class="ri-arrow-left-s-line text-xl" />
          </button>
          <span class="font-bold text-lg text-slate-800 tracking-tight ml-1">配置</span>
        </div>
        <button
          class="text-sm font-bold text-blue-600 px-3 py-2 rounded-xl active:bg-blue-50 transition"
          :disabled="!dirty || saving"
          :class="{ 'opacity-40': !dirty || saving }"
          @click="onSave"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </header>

    <main class="flex-grow w-full max-w-2xl mx-auto px-4 py-4 pb-24 space-y-4">
      <!-- 加载态 -->
      <div v-if="loading" class="bg-white rounded-[20px] p-10 text-center shadow-[0_4px_12px_rgba(0,0,0,0.03)]">
        <i class="ri-loader-4-line animate-spin text-2xl text-blue-500" />
        <p class="text-sm text-gray-400 mt-2">读取中…</p>
      </div>

      <template v-else>
        <div
          v-if="errorMsg"
          class="bg-red-50 border border-red-100 rounded-2xl p-4 text-[12px] text-red-600 leading-relaxed"
        >
          {{ errorMsg }}
        </div>

        <!-- ── 敏感字段（需当前密码）───────────────────────── -->
        <section class="bg-white rounded-[20px] p-5 shadow-[0_4px_12px_rgba(0,0,0,0.03)]">
          <div class="flex items-center mb-1">
            <i class="ri-lock-2-line text-blue-500 mr-2" />
            <h2 class="font-bold text-slate-800 text-[15px]">凭证</h2>
          </div>
          <p class="text-[11px] text-gray-400 mb-4 leading-relaxed">
            改动需输入当前密码。CF secret 中的旧值始终有效，可作应急入口。
          </p>

          <div class="space-y-4">
            <div v-for="f in secretFields" :key="f.key">
              <label class="flex items-center justify-between text-xs font-bold text-slate-500 mb-2">
                <span>{{ f.label }}</span>
                <span
                  class="text-[10px] font-normal px-1.5 py-0.5 rounded"
                  :class="f.set ? 'bg-green-50 text-green-600' : 'bg-slate-100 text-slate-400'"
                >
                  {{ f.set ? '已设置' : '未设置' }}
                </span>
              </label>
              <el-input
                v-model="form[f.key]"
                type="password"
                show-password
                :placeholder="f.masked ? `当前 ${f.masked}（留空不改）` : '未设置'"
              />
              <p class="text-[10px] text-gray-400 mt-1.5 leading-relaxed">{{ f.hint }}</p>
            </div>
          </div>

          <div class="mt-5 pt-4 border-t border-slate-100">
            <label class="block text-xs font-bold text-slate-500 mb-2">
              当前密码 <span class="text-red-500">*</span>
            </label>
            <el-input
              v-model="currentPassword"
              type="password"
              show-password
              placeholder="修改上面的凭证时必须填写"
            />
          </div>
        </section>

        <!-- ── 仓库 ──────────────────────────────────────── -->
        <section class="bg-white rounded-[20px] p-5 shadow-[0_4px_12px_rgba(0,0,0,0.03)]">
          <div class="flex items-center mb-4">
            <i class="ri-github-line text-slate-700 mr-2" />
            <h2 class="font-bold text-slate-800 text-[15px]">目标仓库</h2>
          </div>

          <div class="space-y-4">
            <div>
              <label class="block text-xs font-bold text-slate-500 mb-2">Owner</label>
              <el-input v-model="form.github_owner" placeholder="zzgs219G" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-500 mb-2">仓库名</label>
              <el-input v-model="form.github_repo" placeholder="apk-protect-action" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-500 mb-2">分支</label>
              <el-input v-model="form.github_ref" placeholder="main" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-500 mb-2">
                R2 公开域名 <span class="text-gray-400 font-normal">（可选）</span>
              </label>
              <el-input v-model="form.r2_public_domain" placeholder="https://r2.example.com" />
              <p class="text-[10px] text-gray-400 mt-1.5">
                用于把 GitHub 注解里被打码的产物链接补全
              </p>
            </div>
          </div>
        </section>

        <!-- ── 运行时参数 ────────────────────────────────── -->
        <section class="bg-white rounded-[20px] p-5 shadow-[0_4px_12px_rgba(0,0,0,0.03)]">
          <div class="flex items-center mb-4">
            <i class="ri-equalizer-line text-slate-700 mr-2" />
            <h2 class="font-bold text-slate-800 text-[15px]">运行时参数</h2>
          </div>

          <div class="space-y-4">
            <div>
              <label class="block text-xs font-bold text-slate-500 mb-2">请求限流（次/分钟）</label>
              <el-input v-model.number="form.rate_limit_per_min" type="number" placeholder="120" />
              <p class="text-[10px] text-gray-400 mt-1.5">填 0 关闭限流</p>
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-500 mb-2">任务保留天数</label>
              <el-input v-model.number="form.job_retention_days" type="number" placeholder="7" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-500 mb-2">等待 run_id 上限（毫秒）</label>
              <el-input v-model.number="form.run_id_wait_ms" type="number" placeholder="4000" />
            </div>
          </div>
        </section>

        <!-- 图例：来源说明 -->
        <p class="text-center text-[11px] text-gray-400 leading-relaxed px-4">
          面板修改的值存在 KV，优先于 Cloudflare 的 secret / vars。
          清空某项即回退到 CF 侧配置。
        </p>
      </template>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useAuthStore } from '../stores'

const router = useRouter()
const auth = useAuthStore()

const loading = ref(true)
const saving = ref(false)
const errorMsg = ref('')
const currentPassword = ref('')
const sources = ref({})

/** 敏感字段：只接受新值，不回显明文 */
const secretMeta = reactive({
  github_token: null,
  relay_token: null,
  relay_password: null,
})

const form = reactive({
  github_token: '',
  github_owner: '',
  github_repo: '',
  github_ref: '',
  r2_public_domain: '',
  relay_token: '',
  relay_password: '',
  rate_limit_per_min: 120,
  job_retention_days: 7,
  run_id_wait_ms: 4000,
})

/** 保存时的原始快照，用于算 dirty */
let baseline = null

const secretFields = computed(() => [
  {
    key: 'github_token',
    label: 'GitHub Token',
    set: secretMeta.github_token?.set === true,
    masked: secretMeta.github_token?.masked || '',
    hint: '需要 apk-protect-action 的 Actions: Read & Write 权限',
  },
  {
    key: 'relay_token',
    label: 'RELAY_TOKEN',
    set: secretMeta.relay_token?.set === true,
    masked: secretMeta.relay_token?.masked || '',
    hint: 'APP 调 /api/* 的 Bearer 令牌。换新后旧值仍有效，方便迁移',
  },
  {
    key: 'relay_password',
    label: '管理密码',
    set: secretMeta.relay_password?.set === true,
    masked: secretMeta.relay_password?.masked || '',
    hint: '面板登录密码。改完 CF secret 里的旧密码仍可用',
  },
])

const dirty = computed(() => {
  if (!baseline) return false
  if (currentPassword.value) return true
  return (
    form.github_owner !== baseline.github_owner ||
    form.github_repo !== baseline.github_repo ||
    form.github_ref !== baseline.github_ref ||
    form.r2_public_domain !== baseline.r2_public_domain ||
    Number(form.rate_limit_per_min) !== Number(baseline.rate_limit_per_min) ||
    Number(form.job_retention_days) !== Number(baseline.job_retention_days) ||
    Number(form.run_id_wait_ms) !== Number(baseline.run_id_wait_ms) ||
    // 敏感字段只要填了就 dirty
    Boolean(form.github_token) ||
    Boolean(form.relay_token) ||
    Boolean(form.relay_password)
  )
})

function applyConfig(data) {
  form.github_owner = data.config.github_owner ?? ''
  form.github_repo = data.config.github_repo ?? ''
  form.github_ref = data.config.github_ref ?? ''
  form.r2_public_domain = data.config.r2_public_domain ?? ''
  form.rate_limit_per_min = data.config.rate_limit_per_min ?? 120
  form.job_retention_days = data.config.job_retention_days ?? 7
  form.run_id_wait_ms = data.config.run_id_wait_ms ?? 4000

  secretMeta.github_token = {
    set: data.config.github_token_set === true,
    masked: data.config.github_token_masked || '',
  }
  secretMeta.relay_token = {
    set: data.config.relay_token_set === true,
    masked: data.config.relay_token_masked || '',
  }
  secretMeta.relay_password = {
    set: data.config.relay_password_set === true,
    masked: data.config.relay_password_masked || '',
  }

  sources.value = data.sources || {}
  baseline = {
    github_owner: form.github_owner,
    github_repo: form.github_repo,
    github_ref: form.github_ref,
    r2_public_domain: form.r2_public_domain,
    rate_limit_per_min: form.rate_limit_per_min,
    job_retention_days: form.job_retention_days,
    run_id_wait_ms: form.run_id_wait_ms,
  }
}

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const data = await api.getConfig()
    applyConfig(data)
  } catch (e) {
    errorMsg.value = e.message || '读取配置失败'
  } finally {
    loading.value = false
  }
}

async function onSave() {
  saving.value = true
  errorMsg.value = ''
  try {
    const values = {}

    // 只在真的改动时才提交，避免把未改的字段写成 KV 覆盖
    if (form.github_owner !== baseline.github_owner) values.github_owner = form.github_owner
    if (form.github_repo !== baseline.github_repo) values.github_repo = form.github_repo
    if (form.github_ref !== baseline.github_ref) values.github_ref = form.github_ref
    if (form.r2_public_domain !== baseline.r2_public_domain) values.r2_public_domain = form.r2_public_domain
    if (Number(form.rate_limit_per_min) !== Number(baseline.rate_limit_per_min)) {
      values.rate_limit_per_min = Number(form.rate_limit_per_min)
    }
    if (Number(form.job_retention_days) !== Number(baseline.job_retention_days)) {
      values.job_retention_days = Number(form.job_retention_days)
    }
    if (Number(form.run_id_wait_ms) !== Number(baseline.run_id_wait_ms)) {
      values.run_id_wait_ms = Number(form.run_id_wait_ms)
    }
    // 敏感字段：留空表示不改
    if (form.github_token) values.github_token = form.github_token
    if (form.relay_token) values.relay_token = form.relay_token
    if (form.relay_password) values.relay_password = form.relay_password

    if (Object.keys(values).length === 0) {
      ElMessage.info('没有改动')
      return
    }

    const body = { values }
    if (currentPassword.value) body.current_password = currentPassword.value

    const data = await api.patchConfig(body)
    applyConfig(data)
    form.github_token = ''
    form.relay_token = ''
    form.relay_password = ''
    currentPassword.value = ''
    ElMessage.success('已保存并生效')

    // 改了密码就以新密码为准，刷新一次健康状态
    auth.probe()
  } catch (e) {
    errorMsg.value = e.message || '保存失败'
    ElMessage.error(e.message || '保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>
