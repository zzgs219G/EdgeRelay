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

```
[简盒 APP]                       [Cloudflare Worker]
   │                                     │
   ├─ GET  /api/workflows ───────────────┼──> GitHub: 列 workflow + 解析 inputs
   │                                     │
   ├─ POST /api/build ───────────────────┼──> GitHub: workflow_dispatch
   │      {apk_url, workflow_file,       │    └─ 同步等 run_id（最多 4s）
   │       protect_config, ...}          │    └─ 写 KV: job:<uuid>
   │      <─ {job_id}                    │
   │                                     │
   ├─ GET  /api/status/:jobId ───────────┼──> 读 KV（GitHub 配额零消耗）
   │      <─ {app_status, download_url}  │
   │                                     │
   │                          [Cron 每分钟] ──> 未完结任务回查 GitHub + 抓下载链接
```

无 Durable Objects、无 Analytics Engine、无 migration。只有 `fetch` + `scheduled` + KV。

## 接口

所有接口（除 `GET /health` 与 `OPTIONS`）要求：

```
Authorization: Bearer <RELAY_TOKEN>
```

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

不鉴权、不计流。返回 `{"ok":true,...}`。

## 部署

两条路，选一条（别同时开，否则 push 会触发两次部署）：

**A. Cloudflare Workers Builds（控制台配，push 自动 `npx wrangler deploy`）**
在 CF 控制台 Workers → 你的 Worker → Settings → Build 里连 Git 仓库。
部署命令填 `npx wrangler deploy`，Node 版本 22。

**B. GitHub Actions（`.github/workflows/deploy.yml`，配置可见可 review）**
push 到 main 自动跑：类型检查 → 单元测试 → 部署。
需要 repo secrets：`CF_API_TOKEN`（权限 Workers Scripts: Edit）和
`CLOUDFLARE_ACCOUNT_ID`。

两条路之前都要做一次：

```bash
# 1. 建 KV namespace，把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]]
#    （namespace id 不是 secret，可以直接提交；wrangler 不支持 ${VAR} 语法）
npx wrangler kv namespace create BUILD_JOBS

# 2. 设 secrets（绝不进 git、绝不下发到 APP）
npx wrangler secret put GITHUB_TOKEN      # apk-protect-action 的 Actions:Read+Write 令牌
npx wrangler secret put RELAY_TOKEN       # 网关调用方令牌，APP 与后台面板共用
npx wrangler secret put R2_PUBLIC_DOMAIN  # 可选，注解打码补全用
```

`wrangler.toml` 里 `GITHUB_OWNER` / `GITHUB_REPO` 放在 `[vars]` 而非 secret：
仓库坐标本身不敏感，敏感的是令牌。

**注意**：`package-lock.json` 必须提交。CI 用 `npm ci`，锁文件缺失或与
`package.json` 不同步会直接失败——这是有意的，用来挡住装不出依赖的部署。

## 配置项

| 变量 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `GITHUB_TOKEN` | secret | — | 必填。Actions: Read+Write |
| `RELAY_TOKEN` | secret | — | 必填。APP 调用网关的 Bearer 令牌 |
| `R2_PUBLIC_DOMAIN` | secret | — | 可选。注解里域名被 GitHub 打码为 `***` 时补全 |
| `GITHUB_OWNER` | vars | `zzgs219G` | 仓库 owner |
| `GITHUB_REPO` | vars | `apk-protect-action` | 仓库名 |
| `GITHUB_REF` | vars | `main` | 触发分支 |
| `RATE_LIMIT_PER_MIN` | vars | `120` | per-token 令牌桶（次/分钟），`0` 关闭 |
| `JOB_RETENTION_DAYS` | vars | `7` | 任务记录 KV 保留天数 |
| `RUN_ID_WAIT_MS` | vars | `4000` | dispatch 后等 run_id 的上限 |

## 安全模型

- **令牌不落地**：`GITHUB_TOKEN` 只存在于 Worker secret。响应体经测试断言
  不含令牌、不含仓库坐标（见 `test/edge_relay.test.ts` 的
  `never sends the GitHub token back to the client`）。
- **APP 无 run_id 概念**：`job_id` 是网关自己生成的 UUID，与 GitHub 无
  可推断关系，即使泄露也推不出仓库地址。
- **限流**：per-token 令牌桶，默认 120 次/分钟。状态在 isolate 内，冷启动
- 重置——定位是防突发滥用，不是严格 SLO。
- **CORS 全开**：APP 是原生客户端，不用 cookie，无需收紧。

## 本地开发

```bash
npm install --ignore-scripts   # workerd 无 Android 构建，必须 --ignore-scripts
npx tsc --noEmit               # 类型检查
npx vitest run --config vitest.node.config.ts   # 本机（Node 环境）跑测试
npx wrangler dev               # 起本地 Worker（需要 PC，本机跑不了 workerd）
```

> `vitest.config.ts`（workers pool）给 CI / PC 用；
> `vitest.node.config.ts`（node environment）给 Termux 用。
> 被测代码只用 Web 标准 API，两个环境跑的是同一批断言。

## 文件

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 入口，转出 `src/router.ts` |
| `src/router.ts` | fetch 入口：CORS + 鉴权 + 限流 + 路由表 + Cron |
| `src/types.ts` | Env / 请求 / 响应类型 |
| `src/github.ts` | GitHub REST 最小客户端 + yml inputs 解析 |
| `src/build.ts` | `POST /api/build`：dispatch + 同步等 run_id |
| `src/status.ts` | `GET /api/status/:jobId`：读 KV + 读缺失回查 |
| `src/workflows.ts` | `GET /api/workflows` |
| `src/reconcile.ts` | Cron 兜底轮询 |
| `src/kv_store.ts` | 任务表 KV 读写 |

## 已知边界

- **KV 最终一致性**：写入后全球生效有约 10-60s 延迟。已用两层兜底抵消：
  `/api/build` 同步等 run_id、`/api/status` 读缺失即回查 GitHub。
  极端情况下 APP 前几次查询可能拿到旧状态，但绝不会「跑完了还显示处理中」
  ——因为终态一旦写入就不会被覆盖回非终态。
- **GitHub Actions 并发额度**：免费账户有限。网关把 APP 轮询与 GitHub
  调用解耦（APP 只读 KV），但构建本身仍受 GitHub 侧并发限制。
- **单仓库**：当前 `GITHUB_OWNER`/`GITHUB_REPO` 是单一坐标。多仓库需要
  按 workflow 路由，属于后续扩展。
