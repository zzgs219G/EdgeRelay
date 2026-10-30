import { beforeEach, describe, expect, it } from "vitest";
import {
  WORKFLOWS_CACHE_TTL_MS,
  clearWorkflowsCache,
  readWorkflowsCache,
  writeWorkflowsCache,
} from "../src/services/workflows_cache";
import type { WorkflowMeta } from "../src/shared/types";

/**
 * workflow 列表缓存。
 *
 * 背景（2026-10-30 用户日志）：
 *   [04:33] /api/workflows?with_inputs=1  16708ms
 *   [04:48] /api/workflows                32068ms
 * 同一份静态数据被反复向上游拉取，加 isolate 级短缓存吸收。
 *
 * 这里钉住三件最容易写错的事：
 *   1. with_inputs 与不带 inputs 必须**分桶**，否则表单会渲染成空的
 *   2. 返回的是副本，调用方就地改不会污染缓存
 *   3. TTL 过期后必须失效，不能返回陈旧数据
 */

function wf(id: number, inputs: WorkflowMeta["inputs"] = []): WorkflowMeta {
  return {
    id,
    name: `wf-${id}`,
    file_name: `wf-${id}.yml`,
    state: "active",
    inputs,
  };
}

describe("workflows_cache", () => {
  beforeEach(() => {
    clearWorkflowsCache();
  });

  it("初始状态为空", () => {
    expect(readWorkflowsCache(false)).toBeNull();
    expect(readWorkflowsCache(true)).toBeNull();
  });

  it("写入后可读回", () => {
    writeWorkflowsCache(false, [wf(1), wf(2)]);
    const got = readWorkflowsCache(false);
    expect(got).toHaveLength(2);
    expect(got?.[0].file_name).toBe("wf-1.yml");
  });

  it("with_inputs 与不带 inputs 分桶，互不覆盖", () => {
    // 这是最关键的约束：若共用一桶，不带 inputs 的请求会把结果写进去，
    // 随后带 inputs 的请求命中该桶，拿到的却是 inputs: [] —— 表单空着，
    // 而且请求返回 200，看起来"成功"。这种静默错误极难排查。
    writeWorkflowsCache(false, [wf(1)]);
    expect(readWorkflowsCache(true)).toBeNull();

    writeWorkflowsCache(true, [
      wf(1, [{ name: "apk_url", description: "APK链接", required: true } as never]),
    ]);
    expect(readWorkflowsCache(true)?.[0].inputs).toHaveLength(1);
    expect(readWorkflowsCache(false)?.[0].inputs).toHaveLength(0);
  });

  it("返回副本：调用方就地修改不会污染缓存", () => {
    writeWorkflowsCache(false, [wf(1)]);
    const first = readWorkflowsCache(false)!;
    first[0].name = "被改了";
    first.push(wf(99));

    const second = readWorkflowsCache(false)!;
    expect(second).toHaveLength(1);
    expect(second[0].name).toBe("wf-1");
  });

  it("深度副本：改 inputs 数组也不影响缓存", () => {
    writeWorkflowsCache(true, [
      wf(1, [{ name: "a", description: "", required: false } as never]),
    ]);
    const first = readWorkflowsCache(true)!;
    first[0].inputs.push({ name: "b" } as never);
    expect(readWorkflowsCache(true)?.[0].inputs).toHaveLength(1);
  });

  it("TTL 过期后失效", () => {
    const realNow = Date.now;
    try {
      const t0 = 1_000_000_000_000;
      Date.now = () => t0;
      writeWorkflowsCache(false, [wf(1)]);
      expect(readWorkflowsCache(false)).not.toBeNull();

      // 未过期
      Date.now = () => t0 + WORKFLOWS_CACHE_TTL_MS - 1;
      expect(readWorkflowsCache(false)).not.toBeNull();

      // 过期
      Date.now = () => t0 + WORKFLOWS_CACHE_TTL_MS + 1;
      expect(readWorkflowsCache(false)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("clear 后两个桶都清空", () => {
    writeWorkflowsCache(false, [wf(1)]);
    writeWorkflowsCache(true, [wf(1, [{ name: "x" } as never])]);
    clearWorkflowsCache();
    expect(readWorkflowsCache(false)).toBeNull();
    expect(readWorkflowsCache(true)).toBeNull();
  });
});
