/**
 * API 封装。
 *
 * 同源部署：前端由 Cloudflare Worker 托管，/api/* 也由同一个 Worker 处理，
 * 因此用相对路径，不写死域名。
 *
 * 登录态：session cookie（HttpOnly，由 Worker 在 POST /login 时种下）。
 * 浏览器自动携带，前端代码碰不到 cookie 内容——比 vue-faka 那种把密码
 * 存 localStorage 再每次请求直传的做法安全：XSS 读不到 HttpOnly cookie，
 * 且令牌可被服务端随时吊销。
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
    // 非 JSON 响应（如 303 重定向）保持空对象
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
  /** 登录。Worker 会种下 session cookie，无需前端处理令牌。 */
  login(password) {
    return request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password }),
    })
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
}
