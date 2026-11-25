import { describe, expect, it } from "vitest";

import { searchSettings, SETTINGS_INDEX } from "../settingsSearch";

const LABELS: Record<string, string> = {
  appearance: "外观",
  perf: "性能",
  browse: "浏览",
  ops: "文件操作",
  search: "全盘搜索",
  shot: "截图",
  clip: "剪贴板",
  calendar: "日历",
  rules: "着色规则",
  keys: "快捷键",
  config: "配置",
};

describe("设置页搜索（lib/settingsSearch，2026-11-25）", () => {
  it("空查询 = 全部不展示（返回空表由调用方回退导航）", () => {
    expect(searchSettings("", LABELS)).toEqual([]);
    expect(searchSettings("   ", LABELS)).toEqual([]);
  });

  it("标题子串匹配（大小写不敏感）", () => {
    const hits = searchSettings("热键", LABELS);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.every((h) => h.title.includes("热键") || h.title.includes("快捷键"))).toBe(true);
    // 英文大小写：中文源串不含英文时仅分类标签参与
    expect(searchSettings("回收", LABELS)).toEqual([]);
  });

  it("分类名匹配：查「外观」返回外观页全部行", () => {
    const hits = searchSettings("外观", LABELS);
    expect(hits.length).toBeGreaterThan(5);
    expect(hits.every((h) => h.tab === "appearance")).toBe(true);
  });

  it("索引覆盖全部 11 个分类", () => {
    const tabs = new Set(SETTINGS_INDEX.map((e) => e.tab));
    expect(tabs.size).toBe(11);
    for (const e of SETTINGS_INDEX) expect(e.title.length).toBeGreaterThan(0);
  });
});
