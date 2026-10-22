# 后端结构（src/）

按**依赖方向**分层。上层可以依赖下层，**下层不得依赖上层**。这条规则
是硬约束，改动后可用文末的检查命令验证。

```
src/
├── index.ts              Wrangler 入口，只做模块转出
├── router.ts             路由表 + fetch/scheduled 入口（薄，不含业务逻辑）
│
├── shared/               叶子层：零内部依赖
│   ├── types.ts          Env / BuildJob / 请求响应类型（全项目唯一类型源头）
│   └── http.ts           json / error / corsHeaders / withCors / timingSafeEqual
│
├── domain/               纯逻辑：不碰网络、不碰 KV，可直接单测
│   └── job.ts            newJobId / toAppStatus / isStalled / stalledMessage
│
├── services/             业务逻辑与外部交互
│   ├── github/           GitHub REST 客户端
│   │   ├── client.ts       GitHubError / ghFetch（含 10s 超时）/ repoPath
│   │   ├── workflows.ts    列表 / dispatch / yml inputs 解析
│   │   ├── runs.ts         run 快照 / 最近 runs / job+step 明细
│   │   ├── artifacts.ts    artifact 清单 / 注解 R2 直链 / 日志与产物兜底
│   │   └── index.ts        facade（只 re-export）
│   ├── kv/               KV 存储
│   │   ├── jobs.ts         单条任务 CRUD（getJob / putJob / patchJob / listOpenJobs）
│   │   ├── signal.ts       未完结任务信号灯（省 list 额度）
│   │   ├── job_index.ts    job_id 索引（面板读它替代 list）
│   │   └── index.ts        facade
│   ├── config.ts        运行时配置（KV 优先，env 兜底）+ describeConfig
│   ├── session.ts       会话 cookie 签发/校验（HMAC，无状态）
│   ├── download.ts      产物链接解析 + explainDownloadFailure
│   ├── modules.ts       protect_config → 模块中文标签（schema 缓存 1h）
│   ├── sigv4.ts         S3 SigV4 预签名算法（纯函数，可用 AWS 向量对拍）
│   ├── job_list_cache.ts 面板列表 isolate 短缓存（15s）
│   └── reconcile.ts     Cron 兜底轮询
│
├── middleware/           横切关注点
│   ├── auth.ts          checkAuth（Bearer 或 session 双通道）
│   ├── rate_limit.ts    checkRateLimit（per-token 令牌桶）
│   └── health.ts        healthCheck（真实探测 KV）
│
└── routes/               HTTP handler：一个文件一个接口族，**互不引用**
    ├── build.ts             POST   /api/build
    ├── status.ts            GET    /api/status/:jobId
    ├── status_steps.ts      GET    /api/status/:jobId/steps
    ├── workflows.ts         GET    /api/workflows
    ├── jobs.ts              GET    /api/jobs
    ├── config.ts            GET/PATCH /api/config
    ├── auth.ts              POST   /login, /logout, GET /api/session
    ├── r2_presign.ts        POST   /api/r2/presign
    ├── log_download.ts      GET    /api/log/:jobId
    └── artifact_download.ts GET    /api/artifact/:jobId
```

## 依赖规则

| 层 | 可以依赖 | 不得依赖 |
|---|---|---|
| `shared/` | 无 | 所有其它层 |
| `domain/` | `shared/` | `services/` `middleware/` `routes/` `router.ts` |
| `services/` | `shared/` `domain/` | `middleware/` `routes/` `router.ts` |
| `middleware/` | `shared/` `services/` | `routes/` `router.ts` |
| `routes/` | `shared/` `domain/` `services/` | 其它 `routes/` `router.ts` |
| `router.ts` | 全部 | — |

**为什么 `routes/` 之间不许互相引用**：这是最容易长出循环依赖的地方。
历史上有两处：`build.ts` 为了 `invalidateJobsCache()` 引 `jobs.ts`，以及
`reconcile.ts`（服务层）为了 `explainDownloadFailure()` 引 `status.ts`。
这两处均已下沉到服务层（`services/job_list_cache.ts`、`services/download.ts`）。

## 加一个接口的步骤

1. 写 `src/routes/<name>.ts`，导出 `handleXxx(env, ...)`；
2. 在 `src/router.ts` 的 `switch (true)` 里加一条 `case`；
3. 若需要新的外部交互，逻辑写进 `src/services/`，不要在 handler 里堆。

## 验证依赖规则

```bash
# 四条都应为空（grep 退出码 1 = 无匹配）
grep -n 'from "\.\./routes/' src/routes/*.ts                    # routes 互引
grep -n 'from "\.\./routes/' src/services/*.ts src/services/*/*.ts  # 服务层反向依赖
grep -n 'from "\.\./routes/' src/middleware/*.ts                # 中间件反向依赖
grep -rn 'from "\.\./router"\|from "\./router"' src/routes/ src/services/ src/middleware/ src/domain/ src/shared/
```

## 前端

`frontend/` 是独立的 Vue 3 + Vite 项目（JavaScript），构建产物
`frontend/dist` 由 Worker 的 `[assets]` 托管，`/api/*` 优先过 Worker
（`run_worker_first = true`）。与后端同仓不同目录，各有自己的
`package.json`。
