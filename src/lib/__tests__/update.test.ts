import { describe, expect, it } from "vitest";

import { compareVersions, isUpdateAvailable, type UpdateCheck } from "../update";

describe("compareVersions", () => {
  it("相等判定（含 v 前缀与缺段补 0）", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.0.0")).toBe(0);
  });

  it("逐段比较：major > minor > patch", () => {
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.1", "0.1.0")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
    expect(compareVersions("0.1.0", "1.0.0")).toBe(-1);
  });

  it("非数字段字符串兜底（不抛错；字典序，非 semver 预发布语义）", () => {
    expect(compareVersions("0.1.0-beta", "0.1.0-beta")).toBe(0);
    expect(compareVersions("0.1.0-beta", "0.1.0")).toBe(1); // "0-beta" > "0"
    expect(compareVersions("0.1.0", "0.1.0-beta")).toBe(-1);
  });
});

describe("isUpdateAvailable", () => {
  const check = (current: string, version: string | null): UpdateCheck | null =>
    version === null
      ? { current, manifest: null, source: null, errors: ["Gitee：HTTP 403"] }
      : {
          current,
          manifest: { version, pubDate: null, notes: [], source: "Gitee" },
          source: "Gitee",
          errors: [],
        };

  it("远端更新 → true；相等/更旧 → false", () => {
    expect(isUpdateAvailable(check("0.1.0", "0.2.0"))).toBe(true);
    expect(isUpdateAvailable(check("0.1.0", "0.1.0"))).toBe(false);
    expect(isUpdateAvailable(check("0.2.0", "0.1.9"))).toBe(false);
  });

  it("未检查 / 拉取失败 / 当前版本未知 → false（防误报）", () => {
    expect(isUpdateAvailable(null)).toBe(false);
    expect(isUpdateAvailable(check("0.1.0", null))).toBe(false);
    expect(isUpdateAvailable(check("", "9.9.9"))).toBe(false);
  });
});
