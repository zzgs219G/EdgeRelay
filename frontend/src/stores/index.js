import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

export const useAuthStore = defineStore('auth', () => {
  const logged = ref(false)
  const checking = ref(true)
  const health = ref(null)

  function toast(msg, type = 'success') {
    ElMessage.closeAll()
    ElMessage({ message: msg, type, duration: 2500, grouping: true })
  }

  /**
   * 探测登录态与后端健康度。
   *
   * 用一个需要鉴权的接口（/api/jobs）判断是否已登录：
   *   200 → 已登录
   *   401 → 未登录（正常，转登录页）
   *   其它 → 后端异常，把 problems 显示出来
   * 这样打开页面就能直接知道后端缺不缺 secret，而不是等点登录才报错。
   */
  async function probe() {
    checking.value = true
    try {
      const h = await api.health().catch(() => null)
      health.value = h
      await api.jobs(1)
      logged.value = true
    } catch (e) {
      logged.value = e.status !== 401
    } finally {
      checking.value = false
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

  return { logged, checking, health, toast, probe, login, logout }
})

export const useJobStore = defineStore('job', () => {
  const jobs = ref([])
  const loading = ref(false)
  const workflows = ref([])
  const submitting = ref(false)

  async function loadJobs() {
    loading.value = true
    try {
      const d = await api.jobs(100)
      jobs.value = d.jobs || []
    } catch (e) {
      // 401 由路由守卫处理，这里只提示非鉴权错误
      if (e.status !== 401) ElMessage.error(e.message || '任务列表加载失败')
    } finally {
      loading.value = false
    }
  }

  async function loadWorkflows() {
    try {
      const d = await api.workflows(true)
      workflows.value = d.workflows || []
    } catch {
      workflows.value = []
    }
  }

  async function submit(payload) {
    submitting.value = true
    try {
      const d = await api.build(payload)
      ElMessage.success(`已发起构建：${d.job_id.slice(0, 8)}`)
      await loadJobs()
      return d
    } catch (e) {
      ElMessage.error(e.message || '发起构建失败')
      return null
    } finally {
      submitting.value = false
    }
  }

  return { jobs, loading, workflows, submitting, loadJobs, loadWorkflows, submit }
})
