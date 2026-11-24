import { describe, expect, it } from "vitest";

import {
  buildMergeMap,
  parseSheetRows,
  isNumericLike,
  sheetNumericCols,
  sheetMatches,
  sheetRowHeights,
  sheetHeaderRow,
  textWidthPx,
  trimSheetEdges,
} from "../sheetGrid";

describe("表格预览网格（parseSheetRows）", () => {
  it("制表符分行分列，末尾空行丢弃", () => {
    expect(parseSheetRows("a\tb\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseSheetRows("")).toEqual([]);
  });
});

describe("边缘空行空列裁剪（trimSheetEdges）", () => {
  it("裁顶部空行 + 最左空列 + 尾部空列，中段空行保留", () => {
    // 源文件样式化 used range：首行空、首列空、尾部多出一列
    const rows = [
      ["", "", "", ""],
      ["", "名称", "数量", ""],
      ["", "苹果", "3", ""],
      ["", "", "", ""],
      ["", "梨", "5", ""],
    ];
    const r = trimSheetEdges(rows, 4, []);
    expect(r.rows).toEqual([
      ["名称", "数量"],
      ["苹果", "3"],
      ["", ""],
      ["梨", "5"],
    ]);
    expect(r.colCount).toBe(2);
  });

  it("全空网格裁成空", () => {
    const r = trimSheetEdges(
      [
        ["", ""],
        ["", ""],
      ],
      2,
      [],
    );
    expect(r.rows).toEqual([]);
    expect(r.colCount).toBe(0);
  });

  it("合并区坐标随裁剪平移，出界丢弃", () => {
    // 首行空被裁 → 行 -1；锚点 (2,2) → (1,1)；跨度钳回新网格
    const rows = [
      ["", "", "", ""],
      ["", "a", "b", ""],
      ["", "c", "d", ""],
    ];
    const r = trimSheetEdges(rows, 4, [{ row: 2, col: 2, rowSpan: 2, colSpan: 3 }]);
    expect(r.merges).toEqual([{ row: 1, col: 1, rowSpan: 1, colSpan: 1 }]);
  });
});

describe("表头行判定（sheetHeaderRow）", () => {
  it("跨列合并标题行被跳过，首个高占比行为表头", () => {
    const rows = [
      ["代持并表企业收益情况表", "", "", "", "", ""], // 合并锚点占 1/6 格
      ["企业名称", "项目", "2018年", "2019年", "2020年", "2021年"], // 6/6
      ["建工集团", "营业收入", "4,426,586.20", "", "", ""], // 2/6
    ];
    expect(sheetHeaderRow(rows, 6)).toBe(1);
  });

  it("首行即表头返回 0；全空/低占比回落 -1", () => {
    expect(sheetHeaderRow([["a", "b", "c"]], 3)).toBe(0);
    expect(sheetHeaderRow([["", "", ""], ["x"]], 3)).toBe(-1);
    expect(sheetHeaderRow([], 3)).toBe(-1);
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

describe("sheetNumericCols / sheetMatches（2026-10-18）", () => {
  it("isNumericLike：数字样文本判定", () => {
    expect(isNumericLike("123")).toBe(true);
    expect(isNumericLike("-12.5")).toBe(true);
    expect(isNumericLike("1,234.56")).toBe(true);
    expect(isNumericLike("3,")).toBe(false);
    expect(isNumericLike("45%")).toBe(true);
    expect(isNumericLike("abc")).toBe(false);
    expect(isNumericLike("")).toBe(false);
    expect(isNumericLike("1.2.3")).toBe(false);
  });

  it("sheetNumericCols：≥60% 数值样列右对齐", () => {
    const rows = [
      ["名称", "数量", "备注"],
      ["甲", "10", "x"],
      ["乙", "20", "y"],
      ["丙", "三十", "z"],
    ];
    const cols = sheetNumericCols(rows, 3);
    expect(cols).toEqual([false, true, false]);
  });

  it("sheetMatches：逐格大小写不敏感计数", () => {
    const rows = [
      ["Total", "10"],
      ["total price", "20"],
    ];
    const hits = sheetMatches(rows, "total");
    expect(hits).toEqual([
      { r: 0, c: 0, occ: 0 },
      { r: 1, c: 0, occ: 0 },
    ]);
    expect(sheetMatches(rows, "")).toEqual([]);
  });
});

describe("行高估算（textWidthPx / sheetRowHeights，2026-11-03）", () => {
  it("textWidthPx：CJK 13px、拉丁 7px", () => {
    expect(textWidthPx("中")).toBe(13);
    expect(textWidthPx("ab")).toBe(14);
    expect(textWidthPx("中a")).toBe(20);
    expect(textWidthPx("")).toBe(0);
  });

  it("wrap 档：单行文本 = 行基线高（与单行档视觉连续）", () => {
    const rows = [["短文本", "abc"]];
    expect(sheetRowHeights(rows, [120, 120], "wrap")).toEqual([28]);
  });

  it("wrap 档：按列宽折行估高（行内取各格最大折行数）", () => {
    // 列宽 100：8 个 CJK = 104px + 内边距 16 = 120 → 2 行 → 2×20+8 = 48
    const rows = [["短", "八个汉字八个汉字"]];
    expect(sheetRowHeights(rows, [100, 100], "wrap")).toEqual([48]);
  });

  it("wrap 档：单格折行数上限 6（防一格千字撑爆）", () => {
    const rows = [["这是一段非常长的文本会反复折行超过六行上限被截停".repeat(6)]];
    const h = sheetRowHeights(rows, [80], "wrap")[0];
    expect(h).toBe(6 * 20 + 8);
  });

  it("relaxed 档：留白更大、最小行高更高", () => {
    expect(sheetRowHeights([["短"]], [120], "relaxed")).toEqual([40]);
    const h = sheetRowHeights([["八个汉字八个汉字"]], [100], "relaxed")[0];
    expect(h).toBe(2 * 20 + 20);
  });

  it("空单元格不参与估高", () => {
    const rows = [["a", "", undefined as unknown as string]];
    expect(sheetRowHeights(rows, [100, 100, 100], "wrap")).toEqual([28]);
  });
});
