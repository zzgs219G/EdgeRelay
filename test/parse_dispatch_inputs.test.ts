import { describe, expect, it } from "vitest";
import { parseDispatchInputs } from "../src/github";

/**
 * 与 jian_box GitHubDispatcher.parseDispatchInputs 的现有行为对齐。
 * 网关的解析结果必须和 App 旧版一致，否则动态表单会渲染出错。
 */
describe("parseDispatchInputs", () => {
  const yml = `
name: APK加固-模块勾选

on:
  workflow_dispatch:
    inputs:
      apk_url:
        description: 'APK下载链接'
        required: true
      protect_config:
        description: '加固配置JSON'
        required: true
      dpt_extra_args:
        description: '附加 dpt.jar 参数'
        required: false
        default:
      mode:
        description: '构建模式'
        type: choice
        options:
          - fast
          - careful
        required: false
        default: fast
      strip_so:
        description: '是否剔除 x86'
        type: boolean
        required: false
        default: false

jobs:
  protect:
    runs-on: ubuntu-24.04
`;

  it("parses all declared inputs", () => {
    const inputs = parseDispatchInputs(yml);
    expect(inputs.map((i) => i.name)).toEqual([
      "apk_url",
      "protect_config",
      "dpt_extra_args",
      "mode",
      "strip_so",
    ]);
  });

  it("extracts description / required / default", () => {
    const inputs = parseDispatchInputs(yml);
    const protect = inputs.find((i) => i.name === "protect_config");
    expect(protect).toMatchObject({
      description: "加固配置JSON",
      required: true,
      default: "",
      type: "string",
    });
  });

  it("keeps empty-string default distinct from missing", () => {
    const dpt = parseDispatchInputs(yml).find((i) => i.name === "dpt_extra_args");
    expect(dpt?.default).toBe("");
    expect(dpt?.required).toBe(false);
  });

  it("collects choice options and default", () => {
    const mode = parseDispatchInputs(yml).find((i) => i.name === "mode");
    expect(mode?.type).toBe("choice");
    expect(mode?.options).toEqual(["fast", "careful"]);
    expect(mode?.default).toBe("fast");
  });

  it("marks boolean inputs", () => {
    const strip = parseDispatchInputs(yml).find((i) => i.name === "strip_so");
    expect(strip?.type).toBe("boolean");
    expect(strip?.default).toBe("false");
  });

  it("stops at jobs: section", () => {
    // runs-on 位于 jobs: 下，绝不能被误收成 input。
    const inputs = parseDispatchInputs(yml);
    expect(inputs.some((i) => i.name === "runs-on")).toBe(false);
  });

  it("exits inputs collection when a sibling trigger appears", () => {
    const withPush = `
on:
  workflow_dispatch:
    inputs:
      only_one:
        description: 'x'
        required: false
  push:
    branches: [main]
`;
    const inputs = parseDispatchInputs(withPush);
    expect(inputs.map((i) => i.name)).toEqual(["only_one"]);
  });

  it("returns empty for a workflow without inputs", () => {
    const noInputs = `
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
`;
    expect(parseDispatchInputs(noInputs)).toEqual([]);
  });

  it("does not treat block scalars as defaults", () => {
    const blockScalar = `
on:
  workflow_dispatch:
    inputs:
      rules:
        description: '规则'
        required: false
        default: |
          com.test.**
`;
    const rules = parseDispatchInputs(blockScalar).find((i) => i.name === "rules");
    expect(rules?.default).toBe("");
  });

  it("does not collect dash-prefixed lines outside options:", () => {
    // default 块标量里的 "- " 行不应被当成 choice 选项。
    const tricky = `
on:
  workflow_dispatch:
    inputs:
      mode:
        description: '模式'
        type: choice
        options:
          - a
          - b
        default: a
`;
    const mode = parseDispatchInputs(tricky).find((i) => i.name === "mode");
    expect(mode?.options).toEqual(["a", "b"]);
  });
});
