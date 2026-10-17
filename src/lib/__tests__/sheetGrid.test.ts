import { describe, expect, it } from "vitest";

import {
  parseSheetRows,
  sheetColumnCount,
  sheetColumnWidths,
} from "../sheetGrid";

describe("parseSheetRows（制表符文本 → 行矩阵）", () => {
  it("常规解析", () => {
    expect(parseSheetRows("a\tb\tc\n1\t2\t3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("丢弃末尾空行（Rust 端每行以 \\n 结尾）", () => {
    expect(parseSheetRows("a\tb\n")).toEqual([["a", "b"]]);
    expect(parseSheetRows("a\n\n")).toEqual([["a"]]);
  });

  it("空文本 → 空矩阵", () => {
    expect(parseSheetRows("")).toEqual([]);
  });

  it("参差行保留原样", () => {
    expect(parseSheetRows("a\tb\nc")).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });
});

describe("sheetColumnCount", () => {
  it("取最大列数", () => {
    expect(sheetColumnCount([["a"], ["b", "c", "d"], ["e", "f"]])).toBe(3);
    expect(sheetColumnCount([])).toBe(0);
  });
});

describe("sheetColumnWidths（列宽启发式）", () => {
  it("拉丁按 7px、CJK 按 13px 估宽 + 内边距（短内容落回下限 56）", () => {
    const w = sheetColumnWidths([["ab", "中"]], 2);
    expect(w[0]).toBe(56); // 30 < 56 → 下限
    expect(w[1]).toBe(56); // 29 < 56 → 下限
    const w2 = sheetColumnWidths([["abcdefghijkl"]], 1);
    expect(w2[0]).toBe(16 + 12 * 7); // 100
  });

  it("空列取下限 56，超宽列截到上限 360", () => {
    const long = "x".repeat(200);
    const w = sheetColumnWidths([["", long]], 2);
    expect(w[0]).toBe(56);
    expect(w[1]).toBe(360);
  });

  it("多行取最大值，采样不崩于参差行", () => {
    const rows = [["a"], ["bb", "ccc"], []];
    const w = sheetColumnWidths(rows, 2);
    expect(w[0]).toBe(56); // 30 < 56
    expect(w[1]).toBe(56); // 37 < 56
  });
});
