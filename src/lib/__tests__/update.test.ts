import { describe, expect, it } from "vitest";

import { compareVersions, groupNotes, isUpdateAvailable, type UpdateCheck } from "../update";

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

describe("groupNotes", () => {
  it("按前缀标签分节且保持出现顺序（✨新增/⚡改进/🐛修复）", () => {
    const secs = groupNotes([
      "✨ 新增 功能A —— 描述",
      "✨ 新增 功能B —— 描述",
      "⚡ 改进 优化C —— 描述",
      "🐛 修复 修复D —— 描述",
      "⚡ 改进 优化E —— 描述",
    ]);
    expect(secs.map((s) => s.title)).toEqual(["✨ 新增", "⚡ 改进", "🐛 修复"]);
    expect(secs[0].items).toEqual(["功能A —— 描述", "功能B —— 描述"]);
    expect(secs[1].items).toEqual(["优化C —— 描述", "优化E —— 描述"]);
    expect(secs[2].items).toEqual(["修复D —— 描述"]);
  });

  it("无前缀条目归入「其他」节（旧清单兼容）", () => {
    const secs = groupNotes(["条目A", "条目B"]);
    expect(secs).toEqual([{ title: "其他", items: ["条目A", "条目B"] }]);
  });

  it("前缀须在开头（描述内出现「新增」字样不误分组），前导空白容忍", () => {
    const secs = groupNotes(["✨ 新增 功能 —— 描述里提到 ⚡ 改进 字样", "  ⚡ 改进 缩进条目"]);
    expect(secs.map((s) => s.title)).toEqual(["✨ 新增", "⚡ 改进"]);
    expect(secs[0].items[0]).toContain("⚡ 改进");
  });

  it("空清单返回空数组", () => {
    expect(groupNotes([])).toEqual([]);
  });
});
