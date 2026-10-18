import { describe, expect, it } from "vitest";

import { findMatches, mapRanges } from "../previewSearch";

describe("previewSearch（预览内查找纯函数）", () => {
  it("findMatches：大小写不敏感、重叠跳过、空词与上限", () => {
    expect(findMatches("Abc abc ABC", "abc")).toEqual([0, 4, 8]);
    expect(findMatches("aaa", "aa")).toEqual([0]); // 贪心不重叠
    expect(findMatches("hello", "")).toEqual([]);
    expect(findMatches("", "x")).toEqual([]);
    // 上限封顶
    expect(findMatches("a".repeat(50), "a", 10)).toHaveLength(10);
  });

  it("mapRanges：单节点命中区间", () => {
    const ranges = mapRanges(["hello world"], [6], "world");
    expect(ranges).toEqual([{ node: 0, start: 6, end: 11, match: 0 }]);
  });

  it("mapRanges：跨节点命中拆段（同 match 序号）", () => {
    // 节点边界落在词中间：" wo" | "rld"（拼接后 "hello world"）
    const ranges = mapRanges(["hello wo", "rld"], [6], "world");
    expect(ranges).toEqual([
      { node: 0, start: 6, end: 8, match: 0 },
      { node: 1, start: 0, end: 3, match: 0 },
    ]);
  });

  it("mapRanges：多命中按序号展开；空词返回空", () => {
    const ranges = mapRanges(["ab cd ab"], [0, 6], "ab");
    expect(ranges.map((r) => r.match)).toEqual([0, 1]);
    expect(mapRanges(["abc"], [0], "")).toEqual([]);
  });
});
