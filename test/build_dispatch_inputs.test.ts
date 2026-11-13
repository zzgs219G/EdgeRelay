import { describe, expect, it } from "vitest";

/**
 * buildDispatchInputs 的透传契约。
 *
 * ## 为什么需要这组测试
 *
 * 这个函数改过两次，两次都是被同一个问题逼的：
 *
 * ① 原始实现【逐字段硬编码】三个 input（protect_config / dpt_extra_args /
 *    sign）。workflow 新增 input 时必须同步改网关源码，否则该字段被
 *    **静默丢弃** —— 不报错、不警告。实测踩过：trigger_build.py 传
 *    no_lock=true，workflow 收到的是默认值 0，排查了很久才发现。
 *
 * ② 改成【全量透传】后解决了 ①，但撞上另一个坑：网关自用字段
 *    `display_name`（任务列表展示名，从来不是 workflow input）被一起
 *    发给 GitHub → `HTTP 422: Unexpected inputs provided`。而且失败
 *    发生在 dispatch 阶段，任务已落库，用户看到的是与真实原因无关的
 *    「流水线参数不匹配」。
 *
 * ③ 现在的实现：向 workflow 自己问「你声明了哪些 input」
 *    （`fetchWorkflowInputs()` 解析 yml 的 on.workflow_dispatch.inputs，
 *    同一函数早已用于新建任务页的表单渲染）。yml 是唯一真相源。
 *
 * ## 这组测试钉住什么
 *
 *   · 新参数只要 workflow 声明了就能透传 —— 不用改网关（①的回归防护）
 *   · 网关自用字段永远不转发 —— even if 调用方传了（②的回归防护）
 *   · 未声明的键被排除且留痕，不会静默变成 422（③的核心）
 *   · 拿不到声明时退回历史三字段，不把构建打死
 *
 * ⚠️ 反向验证方式：
 *    · 改回逐字段硬编码     → 「新参数透传」组必须红
 *    · 改回全量透传         → 「网关自用字段」组必须红
 */

// buildDispatchInputs 未导出（内部函数）。这里通过测试专用薄包装拿，
// 若将来不想暴露，可改为导出给测试专用的其他包装。
import { buildDispatchInputsForTest as buildDispatchInputs } from "../src/routes/build";

/** 模拟 workflow yml 里声明的 input 键集合 */
const DECLARED = new Set([
  "apk_url",
  "protect_config",
  "dpt_extra_args",
  "sign",
  "amice_probe",
  "no_lock",
]);

describe("buildDispatchInputs", () => {
  const base = {
    apk_url: "https://r2.example.com/apks/x.apk",
    workflow_file: "protect-modules.yml",
    protect_config: '{"sigcheck":true}',
  };

  // ── ① 历史三字段：行为不能变 ──────────────────────────────────────
  describe("历史三字段", () => {
    it("protect_config 总是转发", () => {
      const out = buildDispatchInputs({ ...base }, DECLARED);
      expect(out.protect_config).toBe('{"sigcheck":true}');
    });

    it("dpt_extra_args 非空才转发", () => {
      expect(buildDispatchInputs({ ...base, dpt_extra_args: "--smaller" }, DECLARED).dpt_extra_args)
        .toBe("--smaller");
      expect(buildDispatchInputs({ ...base }, DECLARED).dpt_extra_args).toBeUndefined();
    });

    it("sign 只在 true 时下发（保持 workflow 默认值语义）", () => {
      expect(buildDispatchInputs({ ...base, sign: true }, DECLARED).sign).toBe("true");
      expect(buildDispatchInputs({ ...base, sign: false }, DECLARED).sign).toBeUndefined();
      expect(buildDispatchInputs({ ...base }, DECLARED).sign).toBeUndefined();
    });
  });

  // ── ② 新参数透传：本次修复的核心目的 ──────────────────────────────
  describe("workflow 声明过的参数能透传（不用改网关）", () => {
    it("no_lock —— 就是它暴露了这个 bug", () => {
      const out = buildDispatchInputs({ ...base, no_lock: true }, DECLARED);
      expect(out.no_lock).toBe("true");
    });

    it("boolean 一律转成 'true'/'false'（workflow input 是 string）", () => {
      const out = buildDispatchInputs({ ...base, no_lock: true, amice_probe: false }, DECLARED);
      expect(out.no_lock).toBe("true");
      expect(out.amice_probe).toBe("false");
    });

    it("前端将来加的任何 input 都能过 —— 只要 workflow 声明了", () => {
      const declared = new Set([...DECLARED, "trace_mode", "retry_count"]);
      const out = buildDispatchInputs(
        { ...base, trace_mode: "verbose", retry_count: 3 },
        declared,
      );
      expect(out.trace_mode).toBe("verbose");
      expect(out.retry_count).toBe("3");
    });
  });

  // ── ③ 网关自用字段：绝不能进 dispatch ─────────────────────────────
  describe("网关自用字段不转发", () => {
    it("display_name 不转发 —— 全量透传时就是它导致 422", () => {
      const out = buildDispatchInputs({ ...base, display_name: "样本.apk" }, DECLARED);
      expect(out.display_name).toBeUndefined();
    });

    it("display_name 即使 workflow 声明了也不转发（它在 yml 里没意义）", () => {
      const declared = new Set([...DECLARED, "display_name"]);
      const out = buildDispatchInputs({ ...base, display_name: "样本.apk" }, declared);
      expect(out.display_name).toBeUndefined();
    });

    it("apk_url / workflow_file / client_request_id 不转发", () => {
      const out = buildDispatchInputs(
        { ...base, client_request_id: "uuid-1234" },
        DECLARED,
      );
      expect(out.apk_url).toBeUndefined();
      expect(out.workflow_file).toBeUndefined();
      expect(out.client_request_id).toBeUndefined();
    });
  });

  // ── ④ 未声明的键：排除，但不静默 ──────────────────────────────────
  describe("workflow 未声明的键", () => {
    it("被排除 —— 否则 GitHub 会 422，且错误信息误导", () => {
      const out = buildDispatchInputs({ ...base, typo_field: "x" }, DECLARED);
      expect(out.typo_field).toBeUndefined();
    });

    it("会打 warn，不是静默丢弃", () => {
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (msg: string) => warns.push(String(msg));
      try {
        buildDispatchInputs({ ...base, typo_field: "x" }, DECLARED);
      } finally {
        console.warn = orig;
      }
      expect(warns.some((w) => w.includes("typo_field"))).toBe(true);
    });

    it("非标量（对象/数组）被跳过，不会变成 '[object Object]'", () => {
      const out = buildDispatchInputs(
        { ...base, obj_field: { a: 1 }, arr_field: [1, 2] },
        new Set([...DECLARED, "obj_field", "arr_field"]),
      );
      expect(out.obj_field).toBeUndefined();
      expect(out.arr_field).toBeUndefined();
    });

    it("undefined / null 不转发（'未指定' 不等于 '传空串'）", () => {
      const out = buildDispatchInputs(
        { ...base, undef_field: undefined, null_field: null },
        new Set([...DECLARED, "undef_field", "null_field"]),
      );
      expect("undef_field" in out).toBe(false);
      expect("null_field" in out).toBe(false);
    });
  });

  // ── ⑤ 降级路径：拿不到 yml 声明时不把构建打死 ───────────────────
  describe("declared === null（yml 读取失败）", () => {
    it("退回历史三字段，构建仍能发起", () => {
      const out = buildDispatchInputs(
        { ...base, dpt_extra_args: "--x", sign: true, no_lock: true },
        null,
      );
      expect(out.protect_config).toBe('{"sigcheck":true}');
      expect(out.dpt_extra_args).toBe("--x");
      expect(out.sign).toBe("true");
      // 代价：可选参数传不进去（失败面被限定在这里，而不是整条构建）
      expect(out.no_lock).toBeUndefined();
    });

    it("空串在声明过的情况下会转发 —— 由 workflow 自己的 default 决定语义", () => {
      const out = buildDispatchInputs({ ...base, amice_probe: "" }, DECLARED);
      expect(out.amice_probe).toBe("");
    });
  });
});
