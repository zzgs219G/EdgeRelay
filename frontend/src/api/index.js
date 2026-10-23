/**
 * API 封装。
 *
 * 同源部署：前端由 Cloudflare Worker 托管，/api/* 也由同一个 Worker 处理，
 * 因此用相对路径，不写死域名。
 *
 * 登录态：session cookie（HttpOnly，由 Worker 在 POST /login 时种下）。
 * 浏览器自动携带，前端代码碰不到 cookie 内容——XSS 读不到，且服务端
 * 旋转密码即可logout 所有会话。
 *
 * 所有接口都返回 JSON（包括 /login、/logout），不再有 HTML 响应，
 * 因此这里统一 res.json()。
 */

async function request(path, options = {}) {
  const opts = { ...options }
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body)
  }
  opts.headers = {
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...opts.headers,
  }

  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
  })

  let data = {}
  try {
    data = await res.json()
  } catch {
    // 理论上不会发生；非 JSON 响应（如反代返回 HTML 错误页）时兜底
  }

  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`)
    err.status = res.status
    err.code = data.code
    throw err
  }
  return data
}

export const api = {
  /** 探测登录态。不鉴权，永远返回 {logged:boolean}。 */
  session() {
    return request('/api/session')
  },

  /** 登录。成功时 Worker 种下 session cookie。 */
  login(password) {
    return request('/login', { method: 'POST', body: { password } })
  },

  logout() {
    return request('/logout', { method: 'POST' })
  },

  /** 健康检查（不鉴权）。 */
  health() {
    return request('/health')
  },

  /** 流水线列表。withInputs=1 时附带动态表单元数据。 */
  workflows(withInputs = false) {
    return request(`/api/workflows${withInputs ? '?with_inputs=1' : ''}`)
  },

  /** 发起构建。 */
  build(payload) {
    return request('/api/build', { method: 'POST', body: payload })
  },

  /** 查询任务状态。 */
  status(jobId) {
    return request(`/api/status/${encodeURIComponent(jobId)}`)
  },

  /** 任务列表（管理台用）。 */
  jobs(limit = 50) {
    return request(`/api/jobs?limit=${limit}`)
  },

  /**
   * 额度用量（KV 读/写/list、Workers 请求数、构建统计）。
   *
   * 数据来源分两类，前端必须区别展示：
   *   - kv：网关自己记账（Cloudflare 无 KV 用量 API）
   *   - workers：GraphQL Analytics，未配 token 时为 null
   * 拿 null 时要显示"未接入"，绝不显示 0。
   */
  usage() {
    return request('/api/usage')
  },

  /** 运行时配置。敏感字段返回明文 + 掩码（掩码仅供摘要卡片展示）。 */
  getConfig() {
    return request('/api/config')
  },

  /** 部分更新配置。 */
  patchConfig(body) {
    return request('/api/config', { method: 'PATCH', body })
  },
}
