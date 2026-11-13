import { describe, expect, it } from "vitest";
import { parseDispatchInputs } from "../src/services/github";

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

  it("parses inputs when workflow_dispatch comes AFTER other triggers", () => {
    // 真实场景：artifact-pipeline 的 protect-modules.yml 就是 push /
    // pull_request 排在 workflow_dispatch 之前。
    //
    // 原实现在遇到 push: 时就把 inDispatch 置 false，导致后面的
    // workflow_dispatch 永远解析不到 → inputs 静默变成 []。
    // 后果不只是表单渲染为空：build 路由拿它做 input 准入清单，
    // 于是 sign / no_lock / amice_probe 全被过滤掉，表现为
    // 「参数传了但 workflow 收到默认值」，极难排查。
    const pushFirst = `
on:
  push:
    branches: [main]
    paths:
      - 'scripts/**'
  pull_request:
    branches: [main]
  workflow_dispatch:
    inputs:
      apk_url:
        description: 'APK链接'
        required: true
      no_lock:
        description: '跳过锁箱'
        required: false
        type: boolean
        default: false
jobs:
  build:
    runs-on: ubuntu-24.04
`;
    const inputs = parseDispatchInputs(pushFirst);
    expect(inputs.map((i) => i.name)).toEqual(["apk_url", "no_lock"]);
    expect(inputs[1].type).toBe("boolean");
    expect(inputs[1].default).toBe("false");
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
