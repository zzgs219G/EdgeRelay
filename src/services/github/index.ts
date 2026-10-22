/**
 * GitHub 客户端的统一出口（facade）。
 *
 * 实现按「一个 URL 族一个文件」拆在：
 *   client.ts     — 错误类型 / 鉴权头 / 带超时的 fetch
 *   workflows.ts  — workflow 列表 / dispatch / yml inputs 解析
 *   runs.ts       — run 状态 / 最近 runs / job+step 明细
 *   artifacts.ts  — artifact 清单 / 注解里的 R2 直链 / 日志与产物兜底
 *
 * 调用方从本文件导入即可，不必关心内部拆分。本文件只做 re-export，
 * 不含逻辑，因此不会成为循环依赖的一环。
 */

export { GitHubError, describeGitHubError, ghFetch, repoPath } from "./client";
export {
  dispatchWorkflow,
  fetchWorkflowInputs,
  listWorkflows,
  parseDispatchInputs,
} from "./workflows";
export { getRun, getRunSteps, listRecentRuns, type JobInfo, type RunSnapshot, type StepInfo } from "./runs";
export {
  fetchArtifactUrl,
  fetchDownloadUrlFromAnnotations,
  fetchLogArtifactUrl,
  listArtifacts,
  LOG_ARTIFACT_NAME,
  type AnnotationResult,
  type ArtifactInfo,
} from "./artifacts";
