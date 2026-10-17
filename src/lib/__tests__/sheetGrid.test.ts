import { describe, expect, it } from "vitest";

import { buildMergeMap, parseSheetRows } from "../sheetGrid";

describe("表格预览网格（parseSheetRows）", () => {
  it("制表符分行分列，末尾空行丢弃", () => {
    expect(parseSheetRows("a\tb\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseSheetRows("")).toEqual([]);
  });
});

describe("合并单元格查找表（buildMergeMap）", () => {
  it("锚点入图、覆盖格入集，锚点自身不覆盖", () => {
    const m = buildMergeMap([{ row: 0, col: 0, rowSpan: 2, colSpan: 3 }], 4, 4);
    expect(m.anchors.get("0:0")).toEqual({
      row: 0,
      col: 0,
      rowSpan: 2,
      colSpan: 3,
    });
    expect(m.covered.has("0:0")).toBe(false);
    expect([...m.covered].sort()).toEqual(["0:1", "0:2", "1:0", "1:1", "1:2"]);
  });

  it("越界裁剪到网格内；跨度全 1 忽略", () => {
    // 网格 3×3，合并从 (1,1) 跨 5×5 → 裁成 2×2
    const m = buildMergeMap([{ row: 1, col: 1, rowSpan: 5, colSpan: 5 }], 3, 3);
    expect(m.anchors.get("1:1")).toEqual({
      row: 1,
      col: 1,
      rowSpan: 2,
      colSpan: 2,
    });
    expect(m.covered.size).toBe(3);
    // 单格合并无视觉意义
    const m2 = buildMergeMap([{ row: 0, col: 0, rowSpan: 1, colSpan: 1 }], 2, 2);
    expect(m2.anchors.size).toBe(0);
    expect(m2.covered.size).toBe(0);
  });
});
