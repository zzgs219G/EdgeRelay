<template>
  <div class="min-h-screen flex flex-col">
    <!-- ── 顶栏 ────────────────────────────────────────────────── -->
    <header class="glass-header sticky top-0 z-30 border-b border-slate-100">
      <div class="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
        <div class="flex items-center min-w-0">
          <button
            class="w-9 h-9 -ml-2 rounded-xl flex items-center justify-center text-slate-500
                   active:bg-slate-100 transition"
            @click="router.back()"
          >
            <i class="ri-arrow-left-s-line text-xl" />
          </button>
          <span class="font-bold text-[17px] text-slate-800 tracking-tight ml-1">配置</span>
        </div>
        <div class="flex items-center gap-1">
          <button
            class="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500
                   active:bg-slate-100 transition"
            :disabled="loading"
            @click="load"
          >
            <i class="ri-refresh-line text-lg" :class="{ 'animate-spin': loading }" />
          </button>
        </div>
      </div>
    </header>

    <main class="flex-grow w-full max-w-3xl mx-auto px-4 py-4 pb-24">
      <!-- 加载骨架 -->
      <div v-if="loading && !ready" class="settings-grid">
        <div v-for="i in 4" :key="i" class="channel-card h-32 animate-pulse">
          <div class="card-header"><div class="h-4 w-24 bg-slate-200 rounded" /></div>
          <div class="card-body"><div class="h-3 w-40 bg-slate-100 rounded" /></div>
        </div>
      </div>

      <template v-else>
        <!-- 错误 -->
        <div v-if="errorMsg" class="mb-4 bg-red-50 border border-red-100 rounded-2xl p-4">
          <div class="text-[12px] text-red-600 leading-relaxed">{{ errorMsg }}</div>
          <button
            v-if="!ready"
            class="mt-3 text-[12px] font-bold text-red-700 bg-white border border-red-200
                   px-3 py-2 rounded-lg active:scale-95 transition"
            @click="load"
          >
            重试
          </button>
        </div>

        <!-- 保存提示 -->
        <div
          v-if="savedHint"
          class="mb-4 bg-green-50 border border-green-100 rounded-2xl px-4 py-3
                 text-[12px] text-green-700 flex items-center"
        >
          <i class="ri-checkbox-circle-fill mr-1.5" /> {{ savedHint }}
        </div>

        <!-- ── 配置卡片网格 ─────────────────────────────────────── -->
        <div class="settings-grid">
          <article
            v-for="c in cards"
            :key="c.key"
            class="channel-card"
            :class="{ 'needs-attention': c.warn }"
            @click="openEditor(c.key)"
          >
            <div class="card-header">
              <div class="card-title">
                <span class="channel-icon-wrapper" :class="c.tone">
                  <i :class="c.icon" />
                </span>
                <span class="channel-name">{{ c.title }}</span>
              </div>
              <i
                v-if="c.warn"
                class="ri-error-warning-fill text-amber-500 text-sm"
                :title="c.warn"
              />
              <i v-else class="ri-arrow-right-s-line text-slate-300" />
            </div>

            <div class="card-body">
              <div class="card-info">
                <div v-for="row in c.summary" :key="row.label" class="info-item">
                  <i :class="row.icon" class="text-slate-400 flex-shrink-0" />
                  <span class="info-label">{{ row.label }}</span>
                  <span
                    class="info-text"
                    :class="{ 'text-amber-600': row.missing, 'font-mono': row.mono }"
                  >
                    {{ row.value }}
                  </span>
                </div>
              </div>
            </div>

            <div class="card-footer">
              <span class="text-[11px] text-slate-400">{{ c.fields.length }} 项</span>
              <span class="text-[11px] font-bold text-blue-600">编辑</span>
            </div>
          </article>
        </div>

        <p class="mt-5 text-center text-[11px] text-slate-400 leading-relaxed px-4">
          面板配置存 KV，优先于 Cloudflare 的 secret / vars。<br />
          清空某项即回退到 CF 侧配置。
        </p>
      </template>
    </main>

    <!-- ── 编辑弹窗 ────────────────────────────────────────────── -->
    <el-dialog
      v-model="editorOpen"
      :title="activeCard ? activeCard.title : ''"
      width="520px"
      class="channel-dialog"
      align-center
      @closed="onEditorClosed"
    >
      <div v-if="activeCard" class="space-y-4">
        <p class="text-[11px] text-slate-400 leading-relaxed -mt-1">{{ activeCard.desc }}</p>

        <div v-for="f in activeCard.fields" :key="f.key">
          <label class="block text-xs font-bold text-slate-500 mb-1.5">
            {{ f.label }}
            <span v-if="f.optional" class="text-slate-400 font-normal">（可选）</span>
            <span
              v-if="f.secret"
              class="ml-1 text-[10px] font-normal px-1.5 py-0.5 rounded"
              :class="secretMeta[f.key]?.set
                ? 'bg-green-50 text-green-600'
                : 'bg-slate-100 text-slate-400'"
            >
              {{ secretMeta[f.key]?.set ? '已设置' : '未设置' }}
            </span>
          </label>

          <el-input
            v-if="f.type === 'number'"
            v-model="form[f.key]"
            type="number"
            :placeholder="f.placeholder"
          />
          <!-- 敏感字段：直接给明文，可直接编辑、选中、复制。
               show-password 提供小眼睛在「圆点/明文」间切换。
               不再额外加"查看/改新值"按钮——进到编辑页就是为了改它，
               多一层只会让人多点两下。 -->
          <el-input
            v-else-if="f.secret"
            v-model="form[f.key]"
            :type="isRevealed(f.key) ? 'text' : 'password'"
            :placeholder="f.placeholder"
          >
            <template #suffix>
              <i
                class="cursor-pointer text-slate-400"
                :class="isRevealed(f.key) ? 'ri-eye-off-line' : 'ri-eye-line'"
                @click="toggleReveal(f.key)"
              />
            </template>
          </el-input>

          <el-input v-else v-model="form[f.key]" :placeholder="f.placeholder" />

          <p v-if="f.hint" class="text-[10px] text-slate-400 mt-1.5 leading-relaxed">
            {{ f.hint }}
          </p>
        </div>

      </div>

      <template #footer>
        <div class="flex items-center gap-2">
          <el-button
            v-if="activeCard && activeCard.resettable"
            text
            class="!text-slate-400"
            :disabled="saving"
            @click="onResetCard"
          >
            恢复默认
          </el-button>
          <div class="flex-1" />
          <el-button @click="editorOpen = false">取消</el-button>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="!editorDirty"
            @click="onSave"
          >
            保存
          </el-button>
        </div>
      </template>
    </el-dialog>
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
const ready = ref(false)
const errorMsg = ref('')
const savedHint = ref('')
const editorOpen = ref(false)
const activeCardKey = ref('')
/** 哪些敏感字段当前显示明文（眼睛状态）。纯 UI 状态，不涉及请求。 */
const revealed = reactive({})

function isRevealed(key) {
  return revealed[key] === true
}

function toggleReveal(key) {
  revealed[key] = !revealed[key]
}

/** 每个敏感字段的状态（是否设置过 + 遮蔽值），永不含明文。 */
const secretMeta = reactive({
  github_token: null,
  relay_token: null,
  relay_password: null,
  r2_access_key_id: null,
  r2_secret_access_key: null,
})

const form = reactive({
  github_token: '',
  github_owner: '',
  github_repo: '',
  github_ref: '',
  r2_public_domain: '',
  r2_endpoint: '',
  r2_bucket_name: '',
  r2_access_key_id: '',
  r2_secret_access_key: '',
  relay_token: '',
  relay_password: '',
  rate_limit_per_min: 120,
  job_retention_days: 7,
  run_id_wait_ms: 4000,
  cf_api_token: '',
  cf_account_id: '',
})

let baseline = null

/**
 * 卡片分组。
 *
 * 为什么按「域」分组而不是平铺全部字段：14 个字段一次性铺开会造成
 * 视觉疲劳、找东西困难。按 GitHub / R2 / 访问凭证 / 运行时 分成四张
 * 卡片，每张只展示摘要，点开才编辑——这是参考 CloudFlare-ImgBed 的
 * 渠道管理面板得出的结构。
 */
const CARDS = [
  {
    key: 'github',
    title: 'GitHub',
    icon: 'ri-github-fill',
    tone: 'tone-slate',
    desc: '网关代替 APP 调用 GitHub。令牌只存网关，APP 从不接触。',
    fields: [
      {
        key: 'github_token', label: 'Token', secret: true, placeholder: 'ghp_...',
        hint: '需要 apk-protect-action 的 Actions: Read & Write 权限',
      },
      { key: 'github_owner', label: 'Owner', placeholder: 'zzgs219G' },
      { key: 'github_repo', label: '仓库名', placeholder: 'apk-protect-action' },
      { key: 'github_ref', label: '分支', placeholder: 'main', optional: true },
    ],
  },
  {
    key: 'r2',
    title: 'R2 存储',
    icon: 'ri-database-2-fill',
    tone: 'tone-orange',
    desc: 'APP 上传前向网关要一个 10 分钟有效的预签名 URL，拿它直传。密钥不出网关。',
    fields: [
      {
        key: 'r2_endpoint', label: 'S3 端点',
        placeholder: 'https://<account>.r2.cloudflarestorage.com',
        hint: 'Cloudflare 控制台 R2 页面右上角可见',
      },
      { key: 'r2_bucket_name', label: '存储桶名', placeholder: 'my-bucket' },
      {
        key: 'r2_access_key_id', label: 'Access Key ID', secret: true,
        placeholder: 'Access Key',
        hint: '原本随公开配置 JSON 下发，等于泄漏；现已收进网关',
      },
      {
        key: 'r2_secret_access_key', label: 'Secret Access Key', secret: true,
        placeholder: 'Secret Key',
      },
      {
        key: 'r2_public_domain', label: '公开域名', optional: true,
        placeholder: 'https://r2.example.com',
        hint: '用于拼产物下载链接。留空时只能退回 GitHub artifact，而 APP 已无令牌',
      },
    ],
  },
  {
    key: 'analytics',
    title: '用量监控（可选）',
    icon: 'ri-line-chart-line',
    tone: 'tone-blue',
    desc:
      '仪表盘的「Workers 请求数」需要 Cloudflare API Token 才能读。KV 用量由网关自己记账，无需此项。',
    fields: [
      {
        key: 'cf_api_token',
        label: 'Cloudflare API Token',
        secret: true,
        optional: true,
        placeholder: '权限：Account → Account Analytics → Read',
        hint: '只读用量，不改任何资源。留空则仪表盘显示「未接入」，不会显示错误的 0',
      },
      {
        key: 'cf_account_id',
        label: 'Account ID',
        optional: true,
        placeholder: '32 位十六进制',
        hint: 'Cloudflare 控制台右侧栏可见（Account ID）',
      },
    ],
  },
  {
    key: 'access',
    title: '访问凭证',
    icon: 'ri-shield-keyhole-fill',
    tone: 'tone-blue',
    desc: 'APP 调网关用的令牌与面板登录密码。改动需验证当前密码。',
    fields: [
      {
        key: 'relay_token', label: 'RELAY_TOKEN', secret: true,
        placeholder: 'openssl rand -hex 32',
        hint: 'APP 调 /api/* 的 Bearer 令牌。换新后旧值仍有效，方便迁移',
      },
      {
        key: 'relay_password', label: '管理密码', secret: true,
        placeholder: '面板登录密码',
        hint: '改完 CF secret 里的旧密码仍可用，避免把自己锁在门外',
      },
    ],
  },
  {
    key: 'runtime',
    title: '运行时参数',
    icon: 'ri-equalizer-fill',
    tone: 'tone-teal',
    desc: '影响限流、任务保留与构建响应时间。',
    resettable: true,
    fields: [
      {
        key: 'rate_limit_per_min', label: '请求限流（次/分钟）', type: 'number',
        placeholder: '120', hint: '填 0 关闭限流',
      },
      {
        key: 'job_retention_days', label: '任务保留天数', type: 'number',
        placeholder: '7', hint: '范围 1-365',
      },
      {
        key: 'run_id_wait_ms', label: '等待 run_id 上限（毫秒）', type: 'number',
        placeholder: '4000', hint: '越大越可能绑上 run_id，但构建接口响应更慢',
      },
    ],
  },
]

const activeCard = computed(() =>
  CARDS.find((c) => c.key === activeCardKey.value) || null
)

/** 卡片摘要：在卡片上直接显示关键信息，不必点开。 */
const cards = computed(() =>
  CARDS.map((c) => {
    const summary = []
    const warn = []

    if (c.key === 'github') {
      const hasToken = secretMeta.github_token?.set
      summary.push({
        icon: 'ri-key-2-line', label: 'Token',
        value: hasToken ? secretMeta.github_token.masked : '未设置',
        missing: !hasToken, mono: true,
      })
      const repo = form.github_owner && form.github_repo
        ? `${form.github_owner}/${form.github_repo}`
        : '未设置'
      summary.push({
        icon: 'ri-git-repository-line', label: '仓库',
        value: repo, missing: repo === '未设置', mono: true,
      })
      if (!hasToken) warn.push('缺少 GitHub Token，构建接口不可用')
    }

    if (c.key === 'r2') {
      const hasKey = secretMeta.r2_access_key_id?.set
      summary.push({
        icon: 'ri-hard-drive-2-line', label: '存储桶',
        value: form.r2_bucket_name || '未设置',
        missing: !form.r2_bucket_name, mono: true,
      })
      summary.push({
        icon: 'ri-key-2-line', label: '密钥',
        value: hasKey ? secretMeta.r2_access_key_id.masked : '未设置',
        missing: !hasKey, mono: true,
      })
      summary.push({
        icon: 'ri-global-line', label: '公开域名',
        value: form.r2_public_domain || '未设置（产物仅 GitHub artifact）',
        missing: !form.r2_public_domain,
      })
      if (!hasKey) warn.push('缺少 R2 密钥，APP 无法上传 APK')
    }

    if (c.key === 'access') {
      summary.push({
        icon: 'ri-robot-2-line', label: 'APP 令牌',
        value: secretMeta.relay_token?.set ? secretMeta.relay_token.masked : '未设置',
        missing: !secretMeta.relay_token?.set, mono: true,
      })
      summary.push({
        icon: 'ri-lock-password-line', label: '面板密码',
        value: secretMeta.relay_password?.set ? secretMeta.relay_password.masked : '未设置',
        missing: !secretMeta.relay_password?.set, mono: true,
      })
      if (!secretMeta.relay_token?.set) warn.push('RELAY_TOKEN 未配置，APP 无法调用网关')
    }

    if (c.key === 'runtime') {
      summary.push({
        icon: 'ri-speed-up-line', label: '限流',
        value: `${form.rate_limit_per_min} 次/分`, mono: true,
      })
      summary.push({
        icon: 'ri-time-line', label: '保留',
        value: `${form.job_retention_days} 天`, mono: true,
      })
    }

    return {
      ...c,
      summary,
      warn: warn[0] || '',
    }
  })
)

/** 当前卡片内是否有改动（仅与 baseline 比对本卡片字段）。 */
const editorDirty = computed(() => {
  if (!activeCard.value || !baseline) return false
  return activeCard.value.fields.some(
    (f) => String(form[f.key] ?? '') !== String(baseline[f.key] ?? '')
  )
})

function applyConfig(data) {
  form.github_owner = data.config.github_owner ?? ''
  form.github_repo = data.config.github_repo ?? ''
  form.github_ref = data.config.github_ref ?? ''
  form.r2_public_domain = data.config.r2_public_domain ?? ''
  form.r2_endpoint = data.config.r2_endpoint ?? ''
  form.r2_bucket_name = data.config.r2_bucket_name ?? ''
  form.rate_limit_per_min = data.config.rate_limit_per_min ?? 120
  form.job_retention_days = data.config.job_retention_days ?? 7
  form.run_id_wait_ms = data.config.run_id_wait_ms ?? 4000

  // 敏感字段：明文直接填充到编辑框（后端已在 GET 里返回），
  // 掩码只用于摘要卡片展示。
  for (const k of ['github_token', 'relay_token', 'relay_password', 'r2_access_key_id', 'r2_secret_access_key']) {
    secretMeta[k] = {
      set: data.config[`${k}_set`] === true,
      masked: data.config[`${k}_masked`] || '',
    }
    form[k] = data.config[k] || ''
  }

  baseline = {
    // 敏感字段也要进 baseline：现在 form 里是明文，
    // 不记录基线的话每个敏感字段都会被判成"改过了"。
    github_token: form.github_token,
    relay_token: form.relay_token,
    relay_password: form.relay_password,
    r2_access_key_id: form.r2_access_key_id,
    r2_secret_access_key: form.r2_secret_access_key,
    github_owner: form.github_owner,
    github_repo: form.github_repo,
    github_ref: form.github_ref,
    r2_public_domain: form.r2_public_domain,
    r2_endpoint: form.r2_endpoint,
    r2_bucket_name: form.r2_bucket_name,
    rate_limit_per_min: form.rate_limit_per_min,
    job_retention_days: form.job_retention_days,
    run_id_wait_ms: form.run_id_wait_ms,
  }
  ready.value = true
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

function openEditor(key) {
  if (!ready.value) {
    errorMsg.value = '配置尚未加载成功，请先重试'
    return
  }
  activeCardKey.value = key
  editorOpen.value = true
}

function onEditorClosed() {
  const closingKey = activeCardKey.value
  activeCardKey.value = ''
  // 眼睛状态复位：下次打开默认隐藏
  for (const k of Object.keys(revealed)) delete revealed[k]

  // 回滚未保存的编辑：把本卡片的字段还原成 baseline（上次成功加载或
  // 保存的值），而不是清空。
  //
  // 曾经在这里把敏感字段一律清成 ''，本意是「避免明文短暂滞留」，
  // 却引出两个连带 bug：
  //   1. 再打开编辑框时 Token 等显示为空——用户以为没保存成功
  //      （docs/报错.md 报的就是这个）；
  //   2. baseline 仍是旧值，于是「空 ≠ 旧值」被 editorDirty 判定为改动，
  //      保存按钮亮起。此时点保存会把空串提交给 PATCH——而空串的语义
  //      是「清除 KV 覆盖，回退 env」。若 CF 侧没配 GITHUB_TOKEN，
  //      令牌就被删光了，之后每次构建都是 401 Requires authentication。
  //
  // 明文驻留的顾虑不成立：baseline 里本来就存着同一份值，load() 也会
  // 重新填回来。真正的敏感面是「别把未保存的编辑当成保存」。
  const card = CARDS.find((c) => c.key === closingKey)
  if (card && baseline) {
    for (const f of card.fields) {
      form[f.key] = baseline[f.key] ?? ''
    }
  }
}

/** 数值字段：清空输入框时 v-model 给空串，Number('') === 0。
 *  rate_limit_per_min 的 0 表示「关闭限流」，直接提交会拔掉手刹，
 *  因此空值一律不提交。 */
function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function onSave() {
  if (!baseline || !activeCard.value) return

  const values = {}
  for (const f of activeCard.value.fields) {
    // 敏感字段现在也是明文在编辑框里，同样做值比对：
    // 没改就不提交，避免把未变的令牌重复写进 KV。
    if (f.secret) {
      if (String(form[f.key] ?? '') !== String(baseline[f.key] ?? '')) {
        values[f.key] = form[f.key]
      }
      continue
    }
    if (f.type === 'number') {
      const n = numOrNull(form[f.key])
      if (n !== null && n !== Number(baseline[f.key])) values[f.key] = n
      continue
    }
    if (String(form[f.key] ?? '') !== String(baseline[f.key] ?? '')) {
      values[f.key] = form[f.key]
    }
  }

  if (Object.keys(values).length === 0) {
    ElMessage.info('没有改动')
    return
  }

  saving.value = true
  errorMsg.value = ''
  try {
    const data = await api.patchConfig({ values })
    applyConfig(data)
    editorOpen.value = false
    savedHint.value = '已保存并生效'
    setTimeout(() => (savedHint.value = ''), 3000)
    auth.probe()
  } catch (e) {
    errorMsg.value = e.message || '保存失败'
    ElMessage.error(e.message || '保存失败')
  } finally {
    saving.value = false
  }
}

/** 恢复默认：把本卡片的数值字段清空覆盖，回退到 env / 内置默认。 */
async function onResetCard() {
  if (!activeCard.value) return
  const values = {}
  for (const f of activeCard.value.fields) {
    if (f.type === 'number') values[f.key] = ''
  }
  if (Object.keys(values).length === 0) return

  saving.value = true
  try {
    const data = await api.patchConfig({ values })
    applyConfig(data)
    savedHint.value = '已恢复默认'
    setTimeout(() => (savedHint.value = ''), 3000)
  } catch (e) {
    ElMessage.error(e.message || '恢复失败')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
/* 卡片网格：自动填充，窄屏单列，宽屏多列 */
.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}

/* 玻璃拟态卡片（参考 CloudFlare-ImgBed 的渠道卡片） */
.channel-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
}
.channel-card:active {
  transform: scale(0.985);
}
.channel-card:hover {
  border-color: rgba(59, 130, 246, 0.28);
  box-shadow: 0 8px 28px -10px rgba(37, 99, 235, 0.22);
}
.channel-card.needs-attention {
  border-color: rgba(245, 158, 11, 0.32);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: var(--glass-header-bg);
  border-bottom: 1px solid var(--glass-header-border);
}
.card-title {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.channel-icon-wrapper {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 15px;
  flex-shrink: 0;
}
.tone-slate { background: rgba(51, 65, 85, 0.09); color: #334155; }
.tone-orange { background: rgba(249, 115, 22, 0.1); color: #ea580c; }
.tone-blue { background: rgba(59, 130, 246, 0.1); color: #2563eb; }
.tone-teal { background: rgba(20, 184, 166, 0.1); color: #0d9488; }

.channel-name {
  font-weight: 600;
  font-size: 14px;
  color: #1e293b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-body {
  padding: 12px 14px;
  flex: 1;
}
.card-info {
  display: flex;
  flex-direction: column;
  gap: 7px;
  overflow: hidden;
}
.info-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: #64748b;
  min-width: 0;
}
.info-label {
  flex-shrink: 0;
  color: #94a3b8;
}
.info-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-align: right;
  color: #475569;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
}

/* 弹窗宽度：手机上不要顶满 */
:deep(.channel-dialog) {
  max-width: 92vw;
}
</style>
