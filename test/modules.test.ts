import { describe, expect, it, vi } from "vitest";
import { describeModules, formatModules, invalidateModuleLabelCache } from "../src/modules";
import type { Env } from "../src/types";

/**
 * protect_config → 模块中文标签。
 *
 * 背景：任务列表原本只显示 workflow 文件名（`protect-modules.yml`），
 * 看不出这次勾了什么。真正的信息在 protect_config 里，但 key 是英文。
 */

function env(): Env {
  return {
    GITHUB_TOKEN: "tok",
    GITHUB_OWNER: "zzgs219G",
    GITHUB_REPO: "apk-protect-action",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: {} as KVNamespace,
    RELAY_TOKEN: "rt",
    RELAY_PASSWORD: "pw",
  };
}

/** apk-protect-action 的真实 schema 结构（简化）。 */
const SCHEMA = {
  schema_version: 1,
  modules: [
    { key: "sigcheck", label: "签名校验", type: "leaf" },
    {
      key: "dex2c",
      label: "Dex2C",
      type: "parent",
      children: [{ key: "rules_file", label: "类名规则" }],
    },
    {
      key: "stringenc",
      label: "字符串加密",
      type: "parent",
      children: [
        { key: "rules_file", label: "类名规则" },
        { key: "dex2c_stub", label: "解密桩也抽进 so" },
      ],
    },
    { key: "antidiff", label: "防对比混淆", type: "leaf" },
    { key: "envcheck", label: "环境检测", type: "leaf" },
    {
      key: "packer",
      label: "基础加壳",
      type: "parent",
      children: [
        { key: "smaller", label: "体积优化" },
        { key: "exclude_x86", label: "排除模拟器架构" },
      ],
    },
  ],
};

function stubSchema(body: unknown = SCHEMA): void {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200 }));
}

describe("describeModules — leaf 模块", () => {
  it("maps enabled leaf keys to Chinese labels", async () => {
    invalidateModuleLabelCache();
    stubSchema();
    const tags = await describeModules(
      env(),
      JSON.stringify({ schema_version: 1, sigcheck: true, antidiff: false, envcheck: true }),
    );
    expect(tags).toEqual(["签名校验", "环境检测"]);
  });

  it("drops schema_version — it is metadata, not a module", async () => {
    invalidateModuleLabelCache();
    stubSchema();
    const tags = await describeModules(env(), JSON.stringify({ schema_version: 1, sigcheck: true }));
    expect(tags).not.toContain("schema_version");
    expect(tags).toHaveLength(1);
  });
});

describe("describeModules — parent 模块", () => {
  it("skips disabled parents entirely", async () => {
    invalidateModuleLabelCache();
    stubSchema();
    const tags = await describeModules(
      env(),
      JSON.stringify({ schema_version: 1, dex2c: { enabled: false, rules_file: "com.x.**" } }),
    );
    expect(tags).toEqual([]);
  });

  it("shows only the parent name when no child is set", async () => {
    invalidateModuleLabelCache();
    stubSchema();
    const tags = await describeModules(
      env(),
      JSON.stringify({ schema_version: 1, packer: { enabled: true } }),
    );
    expect(tags).toEqual(["基础加壳"]);
  });

  it("appends checked children in parentheses", async () => {
    invalidateModuleLabelCache();
    stubSchema();
    const tags = await describeModules(
      env(),
      JSON.stringify({
        schema_version: 1,
        packer: { enabled: true, smaller: true, exclude_x86: false },
      }),
    );
    expect(tags).toEqual(["基础加壳(体积优化)"]);
  });

  it("treats non-empty strings as set (rules_file)", async () => {
    invalidateModuleLabelCache();
    stubSchema();
    const tags = await describeModules(
      env(),
      JSON.stringify({
        schema_version: 1,
        dex2c: { enabled: true, rules_file: "com.test.**" },
      }),
    );
    expect(tags).toEqual(["Dex2C(类名规则)"]);
  });

  it("ignores empty-string children", async () => {
    invalidateModuleLabelCache();
    stubSchema();
    const tags = await describeModules(
      env(),
      JSON.stringify({ schema_version: 1, dex2c: { enabled: true, rules_file: "" } }),
    );
    expect(tags).toEqual(["Dex2C"]);
  });
});

describe("describeModules — 降级行为", () => {
  it("falls back to raw keys when schema cannot be fetched", async () => {
    invalidateModuleLabelCache();
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));
    const tags = await describeModules(
      env(),
      JSON.stringify({ schema_version: 1, sigcheck: true, dex2c: { enabled: true } }),
    );
    // 拿不到中文名就用 key，至少能看出勾了什么
    expect(tags).toEqual(["sigcheck", "dex2c"]);
  });

  it("returns empty for malformed protect_config", async () => {
    invalidateModuleLabelCache();
    stubSchema();
    expect(await describeModules(env(), "{oops")).toEqual([]);
    expect(await describeModules(env(), "")).toEqual([]);
  });

  it("caches the schema — second call does not hit the network", async () => {
    invalidateModuleLabelCache();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify(SCHEMA), { status: 200 });
    });

    await describeModules(env(), JSON.stringify({ schema_version: 1, sigcheck: true }));
    await describeModules(env(), JSON.stringify({ schema_version: 1, envcheck: true }));
    await describeModules(env(), JSON.stringify({ schema_version: 1, antidiff: true }));

    // 关键成本控制：3 次解析只拉 1 次 schema
    expect(calls).toBe(1);
  });
});

describe("formatModules", () => {
  it("joins with a middle dot for display", () => {
    expect(formatModules(["签名校验", "Dex2C", "基础加壳(体积优化)"])).toBe(
      "签名校验 · Dex2C · 基础加壳(体积优化)",
    );
    expect(formatModules([])).toBe("");
  });
});
