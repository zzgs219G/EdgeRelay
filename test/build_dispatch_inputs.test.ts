import { describe, expect, it } from "vitest";

/**
 * buildDispatchInputs 的透传契约（2026-11-13 重构）。
 *
 * ## 为什么需要这组测试
 *
 * 网关原先【逐字段硬编码】三个 input（protect_config / dpt_extra_args /
 * sign），workflow 每加一个 input 都要改网关源码，否则该字段被
 * **静默丢弃** —— 不报错、不警告。实测踩过：trigger_build.py 传
 * no_lock=true，workflow 里收到的是默认值 0，查了很久才定位到网关。
 *
 * 现在改为【全量透传】，安全性由 GitHub 兜底：未声明的 input 会让
 * dispatch 直接失败（HTTP 422 "Unexpected inputs provided"）。
 *
 * 这组测试钉住三件事：
 *   ① 新增字段能透传（不用改网关）—— 这是本次重构的目的
 *   ② 网关自用字段（apk_url / workflow_file / client_request_id）不转发
 *   ③ 非标量（对象/数组）被跳过，且留痕（不静默）
 *
 * ⚠️ 反向验证：把 buildDispatchInputs 改回逐字段硬编码，
 *    本文件第 ① 组必须红。
 */

// buildDispatchInputs 未导出（内部函数）。这里通过 re-export 拿，
// 若将来不想暴露，可改为导出给测试专用的薄包装。
import { buildDispatchInputsForTest as buildDispatchInputs } from "../src/routes/build";

describe("buildDispatchInputs 全量透传", () => {
  const base = {
    apk_url: "https://r2.example.com/apks/x.apk",
    workflow_file: "protect-modules.yml",
    protect_config: '{"sigcheck":true}',
  };

  it("① 保留三个历史字段的行为", () => {
    const out = buildDispatchInputs({
      ...base,
      dpt_extra_args: "--smaller",
      sign: true,
    });
    expect(out.protect_config).toBe('{"sigcheck":true}');
    expect(out.dpt_extra_args).toBe("--smaller");
    expect(out.sign).toBe("true");
  });

  it("① sign=false 时不下发（保持 workflow 默认值语义）", () => {
    const out = buildDispatchInputs({ ...base });
    expect(out.sign).toBeUndefined();
  });

  it("② 未在网关登记的新字段能透传 —— 这是重构的核心目的", () => {
    // 模拟 workflow 里新加的 input，网关源码一字未改
    const out = buildDispatchInputs({
      ...base,
      no_lock: true,
      some_future_flag: "abc",
      retry_count: 3,
    });
    expect(out.no_lock).toBe("true");
    expect(out.some_future_flag).toBe("abc");
    expect(out.retry_count).toBe("3");
  });

  it("② boolean 一律转成 'true'/'false' 字符串（workflow input 是 string）", () => {
    const out = buildDispatchInputs({
      ...base,
      flag_on: true,
      flag_off: false,
    });
    expect(out.flag_on).toBe("true");
    expect(out.flag_off).toBe("false");
  });

  it("③ apk_url / workflow_file / client_request_id 不转发（网关自用）", () => {
    const out = buildDispatchInputs({
      ...base,
      client_request_id: "uuid-1234",
    });
    expect(out.apk_url).toBeUndefined();
    expect(out.workflow_file).toBeUndefined();
    expect(out.client_request_id).toBeUndefined();
  });

  it("③ undefined / null 不转发（'未指定' 不等于 '传空串'）", () => {
    const out = buildDispatchInputs({
      ...base,
      undef_field: undefined,
      null_field: null,
    });
    expect("undef_field" in out).toBe(false);
    expect("null_field" in out).toBe(false);
  });

  it("③ 非标量（对象/数组）被跳过，不会变成 '[object Object]'", () => {
    const out = buildDispatchInputs({
      ...base,
      obj_field: { a: 1 },
      arr_field: [1, 2, 3],
    });
    expect(out.obj_field).toBeUndefined();
    expect(out.arr_field).toBeUndefined();
  });

  it("④ 空串会被转发 —— 由 workflow 自己的 default 决定语义", () => {
    // 这里不替 workflow 做决定：dpt_extra_args 传空串时，原实现是
    // `if (body.dpt_extra_args)` 跳过；新实现对【已登记字段】保持同样
    // 行为（见 ①），对【未登记字段】则原样转发。
    const out = buildDispatchInputs({ ...base, custom_empty: "" });
    expect(out.custom_empty).toBe("");
  });
});
