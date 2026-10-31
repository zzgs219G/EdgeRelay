import { describe, expect, it, vi } from "vitest";
import {
  LOG_ARTIFACT_NAME,
  fetchArtifactUrl,
  fetchLogArtifactUrl,
  listArtifacts,
} from "../src/services/github";
import type { Env } from "../src/shared/types";

/**
 * artifact 按名字区分。
 *
 * 早期实现只取 artifacts[0]，但流水线会上传两个 artifact
 * （构建日志 + 加固包），返回顺序不保证——可能把日志当成产物链接
 * 给用户，或者反过来。
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

const LOG = {
  name: LOG_ARTIFACT_NAME,
  archive_download_url: "https://api.github.com/repos/x/y/actions/artifacts/1/zip",
  size_in_bytes: 12345,
  expired: false,
};

const APK = {
  name: "模块勾选加固包-未签名",
  archive_download_url: "https://api.github.com/repos/x/y/actions/artifacts/2/zip",
  size_in_bytes: 9_000_000,
  expired: false,
};

function stubArtifacts(artifacts: unknown[]): void {
  vi.stubGlobal("fetch", async () => Response.json({ artifacts }));
}

describe("listArtifacts", () => {
  it("returns all artifacts with metadata", async () => {
    stubArtifacts([LOG, APK]);
    const result = await listArtifacts(env(), 123);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe(LOG_ARTIFACT_NAME);
    expect(result[1].size_in_bytes).toBe(9_000_000);
  });

  it("returns empty on upstream error instead of throwing", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    expect(await listArtifacts(env(), 123)).toEqual([]);
  });
});

describe("fetchLogArtifactUrl", () => {
  it("picks the log artifact regardless of order", async () => {
    // 关键：日志排在第二位也要能选中
    stubArtifacts([APK, LOG]);
    expect(await fetchLogArtifactUrl(env(), 123)).toBe(LOG.archive_download_url);
  });

  it("returns null when log artifact is missing", async () => {
    stubArtifacts([APK]);
    expect(await fetchLogArtifactUrl(env(), 123)).toBeNull();
  });

  it("skips expired artifacts", async () => {
    stubArtifacts([{ ...LOG, expired: true }]);
    expect(await fetchLogArtifactUrl(env(), 123)).toBeNull();
  });
});

describe("fetchArtifactUrl — 产物兜底", () => {
  it("never returns the log artifact as the build output", async () => {
    // 这是原始 bug：artifacts[0] 若是日志，用户点「下载产物」拿到的
    // 是一个 build.log 的 zip。
    stubArtifacts([LOG, APK]);
    expect(await fetchArtifactUrl(env(), 123)).toBe(APK.archive_download_url);
  });

  it("returns null when only the log exists (failed build)", async () => {
    // 失败的任务只有日志，没有加固包——此时不该给一个假产物链接
    stubArtifacts([LOG]);
    expect(await fetchArtifactUrl(env(), 123)).toBeNull();
  });
});
