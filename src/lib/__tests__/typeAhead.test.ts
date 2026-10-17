import { describe, expect, it } from "vitest";

import { pickTypeAhead } from "../typeAhead";

const items = ["a.txt", "ab.txt", "b.md", "AB2.txt", "c"].map((name, i) => ({
  name,
  path: `C:\\${name}-${i}`,
}));

describe("首字母跳转匹配（pickTypeAhead）", () => {
  it("无选中时从头部开始匹配前缀", () => {
    expect(pickTypeAhead(items, "a", -1)).toBe(0);
  });

  it("大小写不敏感", () => {
    expect(pickTypeAhead(items, "AB", -1)).toBe(1);
  });

  it("从当前项之后循环查找", () => {
    // 当前在第 0 项（a.txt），敲 "a" 应到下一个 a 前缀（ab.txt）
    expect(pickTypeAhead(items, "a", 0)).toBe(1);
    // 第 3 项之后回绕到第 0 项
    expect(pickTypeAhead(items, "a", 3)).toBe(0);
  });

  it("无命中返回 null", () => {
    expect(pickTypeAhead(items, "zz", -1)).toBeNull();
  });

  it("空列表/空缓冲安全", () => {
    expect(pickTypeAhead([], "a", -1)).toBeNull();
    expect(pickTypeAhead(items, "", 0)).toBeNull();
  });
});

// 中文条目：py = Rust 下发的拼音首字母串（名称小写、汉字逐个取首字母）
const cnItems = [
  { name: "forge请下这个txt文件", path: "E:\\a\\1", py: "forgeqxzgtxtwj" },
  { name: "modules", path: "E:\\a\\2", py: null },
  { name: "预算表.xlsx", path: "E:\\a\\3", py: "ysb.xlsx" },
];

describe("拼音首字母跳转（py 匹配串）", () => {
  it("敲拼音首字母命中中文名（预算表 → ysb）", () => {
    expect(pickTypeAhead(cnItems, "ysb", -1)).toBe(2);
  });

  it("混合名：ASCII 段原样、汉字段按首字母（从名称开头逐字符走）", () => {
    expect(pickTypeAhead(cnItems, "forgeq", -1)).toBe(0);
    expect(pickTypeAhead(cnItems, "forgeqxzg", -1)).toBe(0);
  });

  it("英文名不受影响，py 为 null 时回落名称前缀", () => {
    expect(pickTypeAhead(cnItems, "mod", -1)).toBe(1);
  });

  it("前缀语义与英文名一致：不能跳过开头直达中段", () => {
    expect(pickTypeAhead(cnItems, "qxzg", -1)).toBeNull();
    expect(pickTypeAhead(cnItems, "txt", -1)).toBeNull();
  });
});
