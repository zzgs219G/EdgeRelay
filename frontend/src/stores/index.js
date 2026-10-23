import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

export const useAuthStore = defineStore('auth', () => {
  const logged = ref(false)
  const checking = ref(true)
  const health = ref(null)
  /** probe() 是否已跑过，避免路由守卫重复请求 */
  const ready = ref(false)

  function toast(msg, type = 'success') {
    ElMessage.closeAll()
    ElMessage({ message: msg, type, duration: 2500, grouping: true })
  }

  /**
   * 探测登录态与后端健康度。
   *   /api/session → {logged}   （不鉴权，永远 200）
   *   /health      → {ok,problems}
   * 两者都不需要已登录，所以页面一打开就能知道该渲染登录页还是控制台、
   * 以及后端缺不缺 secret。
   */
  async function probe() {
    checking.value = true
    try {
      const [s, h] = await Promise.all([
        api.session().catch(() => ({ logged: false })),
        api.health().catch(() => null),
      ])
      logged.value = s?.logged === true
      health.value = h
    } finally {
      checking.value = false
      ready.value = true
    }
  }

  async function login(password) {
    if (!password) {
      toast('请输入管理密码', 'warning')
      return false
    }
    try {
      await api.login(password)
      logged.value = true
      // 登录成功后刷新一次健康状态（可能刚补了 secret）
      api.health().then((h) => (health.value = h)).catch(() => {})
      toast('已进入控制台')
      return true
    } catch (e) {
      toast(e.message || '登录失败', 'error')
      return false
    }
  }

  async function logout() {
    try {
      await api.logout()
    } catch {
      /* 忽略：登出失败也要清前端状态 */
    }
    logged.value = false
  }

  return { logged, checking, health, ready, toast, probe, login, logout }
})

export const useJobStore = defineStore('job', () => {
  const jobs = ref([])
  const loading = ref(false)
  /** 是否存在未完结任务，决定前端要不要继续轮询 */
  const hasActive = ref(false)
  /** 后端的降级提示（如 KV list 额度用尽）。非错误，但空列表需解释 */
  const notice = ref('')

  /**
   * 拉任务列表。
   *
   * onAuthLost：401 时的回调。登录过期后必须把用户送回登录页——
   * 否则轮询每 5 秒失败一次、什么都不显示，用户只会看到一个静止页面，
   * 却在后台持续打请求。
   */
  async function loadJobs({ onAuthLost } = {}) {
    loading.value = true
    try {
      const d = await api.jobs(100)
      jobs.value = d.jobs || []
      // has_active 由后端算：没有在途任务时前端停止轮询，
      // 避免"全天挂着面板 → 打爆 KV 额度"。
      hasActive.value = d.has_active === true
      // 后端降级提示（如 KV list 当日额度用尽）。不是错误，但必须让人
      // 看见——否则空列表会被误解成"没有任务"。
      if (d.notice) {
        notice.value = d.notice
      } else {
        notice.value = ''
      }
      return true
    } catch (e) {
      if (e.status === 401) {
        onAuthLost?.()
        return false
      }
      ElMessage.error(e.message || '任务列表加载失败')
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 拉某个任务的步骤明细。
   *
   * 只在详情页打开时调用——它会打两次 GitHub（jobs + steps），
   * 不能跟着列表轮询走。
   *
   * 失败不弹 toast 也不清空：服务端已把「run_id 还没绑上」「GitHub 抖动」
   * 都降级成 200 + available:false + reason，真正抛错才是异常情况。
   */
  async function loadSteps(jobId) {
    return api.statusSteps(jobId)
  }

  return {
    jobs, loading, hasActive, notice,
    loadJobs, loadSteps,
  }
})
