# EdgeRelay — APK 构建网关

Cloudflare Worker，作为简盒 APP（jian_box）的后端：把原先散在 APP 里的
GitHub 令牌、仓库地址、流水线轮询逻辑整体搬到 Worker 之后。
APP 只持有网关签发的 `jobId`，不接触任何 GitHub 信息。

## 为什么有这东西

改造前，APP（`jian_box`）自己直连 `api.github.com`：

| APP 原来的行为 | 问题 |
|---|---|
| 云端配置 JSON 里下发 `Github令牌` 到 APP 内存 | 令牌等于硬编码进客户端，反编译即可取 |
| `GitHubDispatcher` 写死 `owner/repo = zzgs219G/apk-protect-action` | 仓库地址暴露，可被直接枚举 |
| `TaskViewModel` 轮询 run 状态、抓 jobs/steps、抓注解拼 R2 链接 | 每条链路 3-4 次 GitHub 请求，全靠 APP 的令牌额度 |

改造后，APP 只跟网关对话。GitHub 令牌与仓库坐标只存在于 Worker secret。

## 保留在 APP 侧的部分（不经过网关）

不是什么都往中转搬——判据是「这个请求是否需要 GitHub 令牌或暴露仓库地址」：

| 操作 | 归属 | 原因 |
|---|---|---|
| 拉取云端配置 JSON（gitee，AES 加密） | **APP 直连** | 不需要令牌；且 CF 中转反而多一跳、更慢 |
| APK 上传 / 产物下载（R2 S3 签名） | **APP 直连** | 用的是 R2 自己的 access key，与 GitHub 无关 |
| 拉 workflow 列表 + 解析 yml inputs | 网关 | 需要令牌，且暴露仓库路径 |
| dispatch 触发构建 | 网关 | 需要令牌 |
| 轮询 run 状态 / jobs / steps | 网关 | 需要令牌 |
| 抓 R2 下载链接（job 注解） | 网关 | 需要令牌 |

## 架构

一个仓库装两层，同源部署在同一个 Worker 后面：

```
frontend/   Vue 3 + Vite + Element Plus + Pinia + vue-router
            npm run build 产出 frontend/dist
                    │
                    ▼
src/        Cloudflare Worker：fetch + scheduled + KV
            [assets] 托管 frontend/dist，/api/* 由 Worker 处理
                    │
                    ▼
             GitHub Actions（apk-protect-action）
```

```
[简盒 APP]                              [Cloudflare Worker]
   │                                            │
   ├─ GET  /api/workflows ──────────────────────┼──> GitHub: 列 workflow + 解析 inputs
   ├─ POST /api/build ──────────────────────────┼──> GitHub: workflow_dispatch
   │      <─ {job_id}                           │    └─ 同步等 run_id（最多 4s）
   ├─ GET  /api/status/:jobId ──────────────────┼──> 读 KV（GitHub 配额零消耗）
   │                                            │
   │                                   [Cron 每分钟] ──> 未完结任务回查 GitHub
   │
[浏览器 · 管理面板]  ──> / (登录页 / SPA)  ──>  /api/jobs 等
                        session cookie（HttpOnly）
```

**同源是关键**：前端由 Worker 的 `[assets]` 托管，`/api/*` 也在同一个
Worker 上，因此零跨域、零 CORS 配置、一个域名搞定。`run_worker_first = true`
让所有请求先进 Worker，`/api/*`、`/login`、`/health` 由 Worker 处理，其余
fall through 到静态资源；`not_found_handling = "single-page-application"`
给 vue-router 的 History 路由兜底。

无 Durable Objects、无 Analytics Engine、无 migration。只有 `fetch` + `scheduled` + KV。

### 目录

**后端（`src/`）**

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口，转出 `router.ts` |
| `router.ts` | fetch 入口：CORS + 双通道鉴权 + 限流 + 路由表 + Cron |
| `http.ts` | 共享响应工具（json / error / CORS / 常量时间比较） |
| `types.ts` | Env 与全部请求/响应类型 |
| `ui.ts` | session cookie 签发校验；`POST /login` `/logout`、`GET /api/session` |
| `config.ts` | 运行时配置：KV 优先、env 兜底；`resolveEnv` 合并 |
| `config_api.ts` | `GET` / `PATCH /api/config` |
| `github.ts` | GitHub REST 客户端 + `parseDispatchInputs` + `getRunSteps` |
| `build.ts` | `POST /api/build`：dispatch + 同步等 run_id |
| `status.ts` | `GET /api/status/:jobId`：读 KV，缺失回查 GitHub |
| `status_steps.ts` | `GET /api/status/:jobId/steps`：job/step 明细 |
| `workflows.ts` | `GET /api/workflows`（只返回 `protect-*` 构建流水线） |
| `jobs.ts` | `GET /api/jobs`：面板任务列表（15s 缓存 + `has_active`） |
| `r2_presign.ts` | `POST /api/r2/presign`：S3 SigV4 预签名上传 |
| `reconcile.ts` | Cron 兜底轮询未完结任务 |
| `kv_store.ts` | 任务表 KV 读写、job_id 生成 |

**前端（`frontend/`，独立 npm 工程）**

| 文件 | 职责 |
|---|---|
| `src/views/Login.vue` | 登录页 |
| `src/views/Dashboard.vue` | 任务概览 + 任务列表 + 发起构建（默认折叠） |
| `src/views/Config.vue` | 配置页：卡片分组 + 编辑弹窗 |
| `src/api/index.js` | API 封装，`credentials: same-origin` 带 cookie |
| `src/stores/index.js` | Pinia：`auth`（登录态）、`job`（任务列表 + 轮询信号） |
| `src/router/index.js` | 路由 + 登录态守卫 |
| `src/style.css` | Tailwind + Element Plus 主题对齐 + 玻璃拟态 token |
| `scripts/patch-remixicon.mjs` | 构建期把 RemixIcon 裁到只用 woff2 |

**其它**

| 路径 | 内容 |
|---|---|
| `test/` | Vitest 套件（node 环境，Termux 可跑） |
| `vitest.config.ts` | workers pool 配置（CI 用） |
| `vitest.node.config.ts` | node 环境配置（本机用） |
| `scripts/check-dist.mjs` | 校验 `frontend/dist` 与源码同步 |
| `.github/workflows/ci.yml` | 质量门：tsc + 测试 + 前端构建 + dist 同步（不部署） |

### 鉴权：两条通道

`/api/*` 接受任一：

1. **`Authorization: Bearer <RELAY_TOKEN>`** —— APP / 脚本等机器调用方
2. **`relay_session` cookie（HttpOnly）** —— 浏览器里的管理面板

cookie 由 `POST /login` 种下，HMAC-SHA256 签名，**签名密钥从
`RELAY_PASSWORD` 派生**（不是 `RELAY_TOKEN`）。

早期版本用 `RELAY_TOKEN` 做签名密钥，导致「不配 `RELAY_TOKEN` 就连面板
都登不进去」——这是把两个不同用途的 secret 耦在了一起。现在面板只依赖
密码，`RELAY_TOKEN` 缺失只影响 APP。

好处是前端 JS 碰不到 cookie（XSS 偷不走），改密码即注销所有会话。

## 接口

除 `GET /health`、`OPTIONS`、`POST /login`、`GET /api/session` 外，
其余都需要鉴权（Bearer 或面板 cookie，见上一节）。

| 方法 + 路径 | 用途 |
|---|---|
| `GET /health` | 健康检查（不鉴权，真实探测 KV） |
| `POST /login` | 面板登录，种 session cookie |
| `POST /logout` | 清除 cookie |
| `GET /api/session` | 探测登录态 `{logged}` |
| `GET /api/workflows` | 可用流水线列表（只返回 `protect-*` 构建流水线） |
| `POST /api/build` | 触发构建，返回 `job_id` |
| `GET /api/status/:jobId` | 任务状态（读 KV，不烧 GitHub 配额） |
| `GET /api/status/:jobId/steps` | job/step 级明细（按需拉，详情页用） |
| `POST /api/r2/presign` | R2 预签名上传 URL（密钥不出网关） |
| `GET /api/jobs` | 面板任务列表（15s 服务端缓存） |
| `GET /api/config` | 运行时配置（含敏感字段明文 + 掩码） |
| `PATCH /api/config` | 部分更新配置，立即生效 |

下面详述几个关键接口。

### `GET /api/workflows`

列出可用的流水线。

```
curl -H "Authorization: Bearer $RELAY_TOKEN" \
  https://edge-relay.wu.engineer/api/workflows
```

```json
{
  "workflows": [
    {
      "id": 12345678,
      "name": "APK加固-模块勾选",
      "file_name": "protect-modules.yml",
      "state": "active",
      "inputs": []
    }
  ]
}
```

加 `?with_inputs=1` 会额外拉取每个 workflow 的 `workflow_dispatch.inputs`
元数据（每个 workflow 一次 GitHub 调用，渲染表单时按需开）：

```json
{
  "inputs": [
    {
      "name": "protect_config",
      "description": "加固配置JSON",
      "required": true,
      "default": "",
      "type": "string",
      "options": []
    },
    {
      "name": "strip_so",
      "description": "是否剔除 x86",
      "required": false,
      "default": "false",
      "type": "boolean",
      "options": []
    }
  ]
}
```

### `POST /api/build`

触发一次构建。返回网关签发的 `job_id`——**APP 不需要也不应该知道 run_id**。

| 字段 | 必填 | 说明 |
|---|---|---|
| `apk_url` | 是 | APK 的公开下载链接（APP 上传 R2 后生成） |
| `workflow_file` | 是 | 无路径的 yml 文件名，如 `protect-modules.yml` |
| `protect_config` | 是 | 加固配置 JSON 原文（字符串，≤64KB） |
| `dpt_extra_args` | 否 | 附加 dpt 参数，≤4KB |
| `display_name` | 否 | APP 侧展示名，仅回显 |

```bash
curl -X POST https://edge-relay.wu.engineer/api/build \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "apk_url": "https://r2.example.com/apks/123_app.apk",
    "workflow_file": "protect-modules.yml",
    "protect_config": "{\"modules\":[]}",
    "display_name": "简盒·v1.2.3"
  }'
```

```json
{ "success": true, "job_id": "b3f1...", "run_id": 987654321, "status": "in_progress" }
```

**关于 `run_id`**：GitHub 的 `workflow_dispatch` 返回 204 且不带 run_id。
网关在返回前会主动列出 runs 匹配到刚触发的那一个（通常 1-2 秒内可见），
最多等 `RUN_ID_WAIT_MS`（默认 4s）。超时不失败——任务以 `queued` 返回，
由 `/api/status` 的读缺失回查与 Cron 兜底补绑。响应里带上 `run_id`
只为方便调试，APP 不需要用它。

### `GET /api/status/:jobId`

查询任务状态。**只读 KV，不消耗 GitHub 配额。**

| `app_status` | 含义 |
|---|---|
| `PENDING` | 已受理，尚未拿到 run_id |
| `PROCESSING` | 流水线执行中 |
| `SUCCESS` | 构建成功，`download_url` 可用 |
| `FAILED` | 构建失败或被拒绝，`error` 有原因 |

```bash
curl -H "Authorization: Bearer $RELAY_TOKEN" \
  https://edge-relay.wu.engineer/api/status/b3f1...
```

```json
{
  "job_id": "b3f1...",
  "status": "completed",
  "app_status": "SUCCESS",
  "conclusion": "success",
  "download_url": "https://r2.example.com/apks/987654321_模块勾选包.apk",
  "error": null,
  "elapsed_ms": 412000,
  "server_time": 1760000000000
}
```

状态推进有两个来源，取先到者：

1. APP 轮询 `/api/status` 时，若 run 已完成，网关顺手抓下载链接并写回 KV；
2. Cron 每分钟兜底轮询所有未完结任务。

因此即使 APP 不轮询，任务也会在 1 分钟内收敛到终态。

### `GET /health`

不鉴权、不计流。**做真实探测**（KV 写入后读回 + 检查 secret 是否齐全），
不是恒为 `ok:true`：

```bash
curl https://edge-relay.wu.engineer/health
```

健康时返回 200：

```json
{ "ok": true, "service": "edge-relay", "kv": "ok", "missing": [], "problems": [] }
```

不健康时返回 **503**，并指明原因：

```json
{
  "ok": false,
  "kv": "error",
  "missing": ["GITHUB_TOKEN"],
  "problems": ["EDGE_RELAY_KV 写入后读回为空", "未配置的 secret/vars: GITHUB_TOKEN"]
}
```

之所以不做成恒真：否则 KV 未绑或 namespace id 填错时，`/health` 是全绿的，
而每个真实请求才在 KV 上炸掉，排障时会被"健康检查明明正常"误导。

## 部署

**部署由 Cloudflare Workers Builds 负责**（CF 控制台连 Git，push 自动部署）。
GitHub Actions 只做质量门，不部署。

### 首次部署要做三件事

```bash
# 1. 建 KV namespace，把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]]
#    （namespace id 不是 secret，可直接提交；wrangler 不支持 ${VAR} 语法）
npx wrangler kv namespace create EDGE_RELAY_KV

# 2. 设 secrets。最小可用只需前两个：
#      RELAY_PASSWORD → 面板登录。缺它 /login 报 500
#      GITHUB_TOKEN   → 调 GitHub。缺它 /api/workflows、/api/build 失败
#    生成随机值：openssl rand -hex 32
npx wrangler secret put RELAY_PASSWORD    # 面板登录密码
npx wrangler secret put GITHUB_TOKEN      # apk-protect-action 的 Actions:Read+Write 令牌
npx wrangler secret put RELAY_TOKEN       # APP 调 /api/* 的 Bearer（接 APP 时才需要）

# 3. 其余配置（R2 四项、仓库坐标、限流）可以在面板填，见下一节
```

三个 secret 各管一段，互不牵连：

| Secret | 管什么 | 缺了会怎样 |
|---|---|---|
| `RELAY_PASSWORD` | 浏览器登录面板 | `/login` 500，面板用不了；APP 不受影响 |
| `RELAY_TOKEN` | APP 调 `/api/*` 的 Bearer | `/api/*` 401，APP 用不了；**面板照常能登** |
| `GITHUB_TOKEN` | 网关代调 GitHub | `/api/workflows`、`/api/build` 失败 |

session cookie 的签名密钥从 `RELAY_PASSWORD` 派生，不依赖 `RELAY_TOKEN`。
**只配 `RELAY_PASSWORD` 就能把面板跑起来**——这是最小可用状态。

配完用 `curl https://<域名>/health` 自检，`missing` / `warnings` 会告诉你还缺什么。

### CF 控制台的 Build 配置

Worker → Settings → Build：

| 字段 | 值 |
|---|---|
| Build command | **留空** |
| Deploy command | `npm run deploy` |

`npm run deploy` 内部按顺序做：装前端依赖 → `vite build` → `wrangler deploy`。

**为什么 Build command 必须留空**：CF 只装根目录依赖，不装 `frontend/` 的。
若 Build command 填 `npm --prefix frontend run build`，它会在没装前端依赖
的情况下跑 vite，报 `Cannot find package '@vitejs/plugin-vue'`。

四个常见错法（都真实踩过）：

1. **Build command 填了前端构建** → 前端依赖没装，`Cannot find package '@vitejs/plugin-vue'`
2. **Build command 留空但 Deploy command 填 `npx wrangler deploy`** → 不构建前端，
   报 `The directory specified by the "assets.directory" field ... does not exist`
3. **Deploy command 填 `npx run deploy`** → `npm error could not determine executable to run`。
   `run` 不是可执行文件，`npx` 后面只能跟包名
4. **两个字段都填** → 前端构建跑两遍，浪费一分多钟

Root directory 留空（仓库根就是根）。

### GitHub Actions（`ci.yml`）

push 到 main / PR 时跑：

```
npm ci → tsc --noEmit → vitest（99 个）→ 前端 build → dist 同步校验
```

**只做质量门，不部署**——不需要任何 secret，48 秒跑完。

早期这里也有一个 deploy job，但它需要 `CF_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` 两个从未配置的 secret，导致每次 push 都红并
邮件通知，而部署其实早就在 CF 那边正常跑着。两套部署并存还有实际风险：
两边 wrangler/依赖版本不同步时会互相覆盖。

要改用 GitHub Actions 部署，需要：配那两个 secret → 去 CF 关掉
Workers Builds → 把 `ci.yml` 里注释说明的 deploy job 加回来。

### 为什么 `frontend/dist` 提交进 git

因为 CF 的 Build command 可能被配错（见上面四个错法），提交 dist 让
`wrangler deploy` 至少有目录可用，不至于直接失败。

代价是「改了 Vue 忘了 build 会静默部署旧前端」，所以 `ci.yml` 里有一步
`node scripts/check-dist.mjs` 校验 dist 与源码同步——不一致就显式失败。

### 注意

`package-lock.json` 和 `frontend/package-lock.json` 都必须提交。CI 用
`npm ci`，锁文件缺失或不同步会直接失败——这是有意的，用来挡住装不出
依赖的部署。

## 运行时配置（面板可改）

配置不再只能去 Cloudflare 控制台改。打开面板右上角**设置**图标
（`/config`），GitHub token、仓库坐标、R2 域名、限流阈值都可以直接
填、直接生效。

**优先级**：KV（面板改的）> CF secret / vars > 内置默认。
清空某一项即回退到 CF 侧的值。

### 接口

| 方法 + 路径 | 说明 |
|---|---|
| `GET /api/config` | 当前生效配置。敏感字段返回明文 + `*_set` + `*_masked` |
| `PATCH /api/config` | 部分更新。body `{values:{...}, clear?:[...]}`；未知键返回 400 |

```bash
# 改仓库坐标（非敏感）
curl -X PATCH https://<域名>/api/config \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"values":{"github_repo":"my-repo"}}'

# 设置 GitHub token
curl -X PATCH https://<域名>/api/config \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"values":{"github_token":"ghp_xxx"}}'

# 清除非敏感项的覆盖，回退到 CF secret
curl -X PATCH https://<域名>/api/config \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"values":{"github_repo":""}}'

# 清除敏感项必须显式声明意图——空串单独传来回被拒（400）
curl -X PATCH https://<域名>/api/config \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"values":{"github_token":""},"clear":["github_token"]}'
```

### 为什么清除敏感字段要多带一个 `clear`

空串的语义是「清除 KV 覆盖，回退 env」，这是有意设计。但它太容易误触：
前端曾经有个 bug——关闭配置弹窗时把敏感输入框清成 `''`，而基线值仍是旧值，
于是「空 ≠ 旧值」被判定为改动、保存按钮亮起；此时点保存就会把空串提交上来。
若 CF 侧没有对应的 secret，**KV 里那份令牌就被删光了**，之后每次构建都是
GitHub 401，而用户明明"设置过 token"（`docs/报错.md` 报的就是这个）。

所以清除 `github_token` / `relay_token` / `relay_password` /
`r2_access_key_id` / `r2_secret_access_key` 必须在 `clear` 数组里点名。
误删从此变成一句可读的 400，而不是静默删掉凭证。

### 两条安全底线

**1. 进面板即已登录，改凭证不再二次确认密码。** 能打开配置页说明已持有
有效 session，而"能改"本身就意味着能让网关用任意凭证——给"写"再加一道
密码挡不住实质风险，只是让「换自己的 key」这件正常操作变麻烦。防线在登录处。

**2. env 里的密码和令牌始终有效（逃生舱）。** 这条很关键：

- `RELAY_PASSWORD`：面板改了密码，CF secret 里的旧密码**仍然能登录**。
  否则一旦你在 UI 里打错或忘了新密码，就彻底锁在门外，只能重开 CF 控制台。
- `RELAY_TOKEN`：新旧令牌同时有效，APP 迁移期不会因为换令牌立刻断掉。

逃生舱有测试钉死（`test/config_api.test.ts` 的
`escape hatch: env password stays valid after KV override`），
误删防护有 `test/config_secret_guard.test.ts`。

### 可配置项

| 字段 | 类型 | 说明 |
|---|---|---|
| `github_token` | 敏感 | Actions: Read+Write 令牌 |
| `github_owner` / `github_repo` | 文本 | 目标仓库坐标 |
| `github_ref` | 文本 | 触发分支 |
| `r2_public_domain` | 文本 | 补全被打码的产物链接 |
| `relay_token` | 敏感 | APP 的 Bearer 令牌 |
| `relay_password` | 敏感 | 面板登录密码 |
| `rate_limit_per_min` | 数字 | 请求限流，0 关闭 |
| `job_retention_days` | 数字 | 任务保留天数，1-365 |
| `run_id_wait_ms` | 数字 | 等 run_id 上限，≤60000 |

## 配置项速查

所有项都可在面板 `/config` 修改（存 KV，立即生效），KV 优先于 CF 侧：

| 字段 | 默认 | 面板可改 | 说明 |
|---|---|---|---|
| `github_token` | — | ✅ | Actions: Read+Write |
| `github_owner` / `github_repo` | `zzgs219G` / `apk-protect-action` | ✅ | 仓库坐标 |
| `github_ref` | `main` | ✅ | 触发分支 |
| `r2_endpoint` | — | ✅ | S3 端点，`https://<account>.r2.cloudflarestorage.com` |
| `r2_bucket_name` | — | ✅ | 桶名 |
| `r2_access_key_id` | — | ✅ | R2 密钥（敏感） |
| `r2_secret_access_key` | — | ✅ | R2 密钥（敏感） |
| `r2_public_domain` | — | ✅ | 拼产物链接 + 补全被打码域名 |
| `relay_token` | — | ✅ | APP 的 Bearer 令牌（敏感） |
| `relay_password` | — | ✅ | 面板登录密码（敏感） |
| `rate_limit_per_min` | `120` | ✅ | 令牌桶，`0` 关闭 |
| `job_retention_days` | `7` | ✅ | 任务 KV 保留天数，1-365 |
| `run_id_wait_ms` | `4000` | ✅ | dispatch 后等 run_id 上限 |

`wrangler.toml` 的 `[vars]` 里的值作为 env 兜底，面板清空某项即回退到它。

详细操作见 [`docs/运维流程.md`](docs/运维流程.md)。

## 安全模型

**核心原则：所有凭证只在网关，APP 和公开 JSON 里都拿不到。**

| 凭证 | 存在哪 | APP 能拿到吗 |
|---|---|---|
| `GITHUB_TOKEN` | Worker secret 或面板 KV | ❌ |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Worker secret 或面板 KV | ❌ |
| `RELAY_PASSWORD` | 仅 Worker secret / KV | ❌ |
| `RELAY_TOKEN` | Worker secret 或面板 KV | ✅（APP 需要它调网关） |

`RELAY_TOKEN` 是唯一下发到 APP 的凭证——它只能调网关接口，拿不到
GitHub / R2。泄漏后轮换它即可止损。

其它设计：

- **APP 无 run_id 概念**：`job_id` 由网关生成，形如 `mvfn7uzx-a1b2c3d4`
  （base36 时间前缀 + 随机），推不出仓库信息。
- **R2 上传走预签名**：APP 向网关要一个 10 分钟有效、只能往 `apks/` 下
  某个 key PUT 的 URL。URL 泄漏也只能覆盖那一个文件，读不到已有内容。
- **限流**：per-token 令牌桶，默认 120 次/分钟。状态在 isolate 内，
  冷启动重置——定位是防突发滥用，不是严格 SLO。
- **CORS 全开**：APP 是原生客户端，不用 cookie 跨域，无需收紧。

响应体经测试断言不含 GitHub 令牌、不含仓库坐标（见
`test/edge_relay.test.ts` 的 `never sends the GitHub token back to the client`）。

## 本地开发

```bash
# 后端（Termux 上可跑：tsc / vitest 不依赖 workerd）
npm install --ignore-scripts        # --ignore-scripts 必须加，workerd 无 Android 构建
npm run typecheck                   # tsc --noEmit
npm test                            # 99 个测试（node environment）
npm run build:frontend              # 构建 Vue 前端
npx wrangler dev                    # 起本地 Worker（需要 PC，本机跑不了 workerd）
```

> `vitest.config.ts`（workers pool）给 CI / PC 用；
> `vitest.node.config.ts`（node environment）给 Termux 用。
> 被测代码只用 Web 标准 API，两个环境跑同一批断言。

## 已知边界

- **KV 免费额度很紧**：读 100k/天，**list 仅 1k/天**。面板 5 秒轮询挂
  8 小时会打爆 5 倍。已做三层缓解：`/api/jobs` 15 秒服务端缓存、
  前端只在有在途任务时轮询（间隔 20 秒）、后端返回 `has_active`
  让前端知道何时停。改这块时务必重算额度。
- **KV 最终一致性**：写入后全球生效约 10-60s。已用两层兜底抵消：
  `/api/build` 同步等 run_id、`/api/status` 读缺失即回查 GitHub。
  终态一旦写入不会被覆盖回非终态，所以不会「跑完了还显示处理中」。
- **run_id 匹配有极低概率绑错**：GitHub 的 dispatch 不返回 run_id，只能
  按 `created_at` 匹配。同名 workflow 并发触发时可能绑到别人的 run 上。
  cron 每分钟重试，且用 `created_at`（不是 `updated_at`）过滤以缩小窗口。
- **只返回 `protect-*` 流水线**：`src/github.ts` 的 `BUILD_WORKFLOW_PREFIX`
  是白名单。`apk-protect-action` 里新增辅助 workflow（如
  `notify-json-mirror.yml`，负责 schema 镜像同步）不会出现在 APP 的下拉框里
  ——它没有 `apk_url` 输入，不是加固流水线。改成多种命名时改这个常量。
- **单仓库**：`github_owner`/`github_repo` 是单一坐标。多仓库需按 workflow
  路由，属于后续扩展。
- **GitHub Actions 并发额度**：免费账户有限。网关把 APP 轮询与 GitHub
  调用解耦（APP 只读 KV），但构建本身仍受 GitHub 侧并发限制。
- **本机（Termux）跑不了 `assembleDebug`**：`aapt2` 是 x86-64 二进制，
  在 aarch64 上执行报 `Syntax error: word unexpected`。jian_box 侧只能
  验证到 `compileDebugKotlin`，资源打包与 APK 产物需在 CI 或 PC 验证。
