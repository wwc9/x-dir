import { describe, expect, it } from "vitest";

import {
  compareVersions,
  isUpdateAvailable,
  parseManifest,
  type UpdateCheck,
} from "../update";

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

describe("parseManifest", () => {
  it("合法清单解析（notes 非 string 项剔除）", () => {
    const m = parseManifest({
      version: "0.2.0",
      pubDate: "2026-10-20",
      notes: ["新增 X", 42, null, "修复 Y"],
    });
    expect(m).toEqual({ version: "0.2.0", pubDate: "2026-10-20", notes: ["新增 X", "修复 Y"] });
  });

  it("缺 version / 非 string version / 非对象一律 null", () => {
    expect(parseManifest({ notes: [] })).toBeNull();
    expect(parseManifest({ version: 12 })).toBeNull();
    expect(parseManifest("0.2.0")).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest(undefined)).toBeNull();
  });

  it("可选字段缺省时不出现在结果里", () => {
    expect(parseManifest({ version: "1.0" })).toEqual({ version: "1.0" });
  });
});

describe("isUpdateAvailable", () => {
  const check = (current: string, version: string | null): UpdateCheck | null =>
    version === null
      ? { current, manifest: null, source: null }
      : { current, manifest: parseManifest({ version }), source: "gitee" };

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
