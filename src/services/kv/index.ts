/**
 * KV 子模块的统一出口（facade）。
 *
 *   jobs.ts       — 单条任务的增删改查
 *   signal.ts     — 未完结任务信号灯（省 list 额度）
 *   job_index.ts  — job_id 索引（面板读它替代 list）
 *
 * 调用方从本文件导入即可。本文件只做 re-export，不含逻辑。
 */

export {
  getJob,
  getJobsByIds,
  listOpenJobs,
  patchJob,
  putJob,
  putNewJob,
} from "./jobs";
export {
  bumpOpenCount,
  dropOpenCount,
  markSignalLightReconciled,
  readOpenCount,
  reconcileSignalLight,
  shouldReconcileSignalLight,
  SIGNAL_RECONCILE_MS,
  writeOpenCount,
} from "./signal";
export {
  appendJobId,
  INDEX_REBUILD_THROTTLE_MS,
  JOB_IDS_MAX,
  markIndexRebuildAttempt,
  readJobIds,
  rebuildJobIds,
  shouldAttemptIndexRebuild,
} from "./job_index";
