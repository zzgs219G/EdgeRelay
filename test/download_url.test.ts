import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDownloadUrl } from "../src/services/download";
import { explainDownloadFailure } from "../src/services/download";
import type { Env } from "../src/shared/types";

/**
 * 产物链接解析：R2 直链优先，artifact 兜底，兜底原因必须可观测。
 *
 * 线上故障：用户点下载，APP 弹「只有 GitHub Artifact 链接（需令牌）」。
 * 根因是网关从未配 R2_PUBLIC_DOMAIN——GitHub 把注解里的域名打码成 *** ，
 * 网关补不回来，于是静默退回 artifact 链接，而那个链接 APP 用不了
 * （它早就不持有 GitHub 令牌）。
 *
 * 最难受的是网关侧零痕迹：只有 APP 知道出错了，控制台、日志、任务
 * 记录里什么都没有。下面这些测试钉住「原因必须能被拿到」。
 */

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: "tok",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    GITHUB_REF: "main",
    EDGE_RELAY_KV: {} as KVNamespace,
    RELAY_TOKEN: "rt",
    ...overrides,
  };
}

/** 造一个 GitHub 响应序列：jobs → annotations。 */
function stubGitHub(opts: {
  annotations: { title?: string; message?: string }[];
  artifacts?: { name: string; archive_download_url: string; expired: boolean }[];
}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/jobs")) {
      return new Response(JSON.stringify({ jobs: [{ id: 42 }] }), { status: 200 });
    }
    if (url.includes("/annotations")) {
      return new Response(JSON.stringify(opts.annotations), { status: 200 });
    }
    if (url.includes("/artifacts")) {
      return new Response(
        JSON.stringify({ artifacts: opts.artifacts ?? [] }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveDownloadUrl — R2 direct link wins", () => {
  it("returns the reconstructed R2 url when the annotation is masked and the domain is configured", async () => {
    // 典型场景：GitHub 把域名打码成 ***，网关用 R2_PUBLIC_DOMAIN 补全
    stubGitHub({
      annotations: [
        { message: "::notice title=产物::***/apks/jianhe_signed.apk" },
      ],
    });

    const r = await resolveDownloadUrl(env({ R2_PUBLIC_DOMAIN: "https://r2.example.com" }), 1);

    expect(r.url).toBe("https://r2.example.com/apks/jianhe_signed.apk");
    expect(r.reason).toBeNull();
    expect(r.isArtifactFallback).toBe(false);
  });

  it("passes through an unmasked http url untouched", async () => {
    // 域名不是 Actions secret 时 GitHub 不打码，原文就在注解里
    stubGitHub({
      annotations: [{ message: "见 https://r2.example.com/apks/x.apk 下载" }],
    });

    const r = await resolveDownloadUrl(env(), 1);

    expect(r.url).toBe("https://r2.example.com/apks/x.apk");
    expect(r.isArtifactFallback).toBe(false);
  });
});

describe("resolveDownloadUrl — the failure that took down downloads", () => {
  it("reports r2_public_domain_missing when the url is masked but the domain is not configured", async () => {
    // 这正是线上故障：R2_PUBLIC_DOMAIN 从未配置，注解被打码，补不回来。
    // 线上之所以表现为「APP 说需令牌」，是因为兜底拿到了 artifact 链接。
    stubGitHub({
      annotations: [{ message: "::notice::***/apks/x.apk" }],
      artifacts: [
        { name: "signed.apk.zip", archive_download_url: "https://api.github.com/x", expired: false },
      ],
    });

    const r = await resolveDownloadUrl(env(), 1); // 无 R2_PUBLIC_DOMAIN

    // 兜底给出了 artifact 链接，且原因说清楚了——这两点缺一不可
    expect(r.isArtifactFallback).toBe(true);
    expect(r.url).toContain("api.github.com");
    expect(r.reason).toBe("r2_public_domain_missing");
  });

  it("still reports the reason even when the artifact fallback also comes up empty", async () => {
    // 注解被打码 + 没有任何 artifact：比线上故障更糟一点的情形。
    // 此时 url 为 null，但 reason 必须保留——否则「为什么没有链接」再度不可知。
    stubGitHub({ annotations: [{ message: "::notice::***/apks/x.apk" }] });

    const r = await resolveDownloadUrl(env(), 1);

    expect(r.url).toBeNull();
    expect(r.isArtifactFallback).toBe(false);
    expect(r.reason).toBe("r2_public_domain_missing");
  });

  it("explains that reason in human terms", () => {
    const hint = explainDownloadFailure("r2_public_domain_missing");
    expect(hint).toContain("R2_PUBLIC_DOMAIN");
    // 要能点出"APP 下不了"这个后果，否则提示毫无指向性
    expect(hint).toContain("APP");
  });

  it("distinguishes 'no url in annotations' from 'domain missing'", async () => {
    // 两种完全不同的故障，曾经都静默退回 artifact、无法区分
    stubGitHub({ annotations: [{ message: "构建成功，无链接" }] });
    const noUrl = await resolveDownloadUrl(env(), 1);
    expect(noUrl.reason).toBe("no_apks_url_in_annotations");

    stubGitHub({ annotations: [{ message: "::notice::***/apks/x.apk" }] });
    const masked = await resolveDownloadUrl(env(), 1);
    expect(masked.reason).toBe("r2_public_domain_missing");
    expect(masked.reason).not.toBe(noUrl.reason);
  });

  it("returns null when neither annotations nor artifacts yield anything", async () => {
    stubGitHub({ annotations: [] });
    const r = await resolveDownloadUrl(env(), 1);
    expect(r.url).toBeNull();
    expect(r.isArtifactFallback).toBe(false);
  });
});

describe("explainDownloadFailure — every reason has a message", () => {
  it("covers all known reasons", () => {
    for (const reason of [
      "r2_public_domain_missing",
      "no_apks_url_in_annotations",
      "github_error",
      "no_artifact_either",
    ]) {
      const hint = explainDownloadFailure(reason);
      expect(hint).toBeTruthy();
      expect((hint ?? "").length).toBeGreaterThan(10);
    }
  });

  it("returns null for unknown/null reasons rather than throwing", () => {
    expect(explainDownloadFailure(null)).toBeNull();
    expect(explainDownloadFailure(undefined)).toBeNull();
    expect(explainDownloadFailure("something_new")).toBeNull();
  });
});
