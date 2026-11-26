import { describe, expect, it } from "vitest";

import {
  buildMergeMap,
  clampSheetColWidth,
  mergesInView,
  parseSheetRows,
  isNumericLike,
  sheetNumericCols,
  sheetColumnWidths,
  sheetMatches,
  sheetRowHeights,
  sheetHeaderRow,
  sheetA1,
  sheetColPrefix,
  sheetColumnWindow,
  sheetTruncatedCells,
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

describe("裁剪偏移（trimSheetEdges rowOffset/colOffset，2026-11-26）", () => {
  it("返回裁掉的顶部/左侧行列数，A1 坐标还原用", () => {
    const rows = [
      ["", "", ""],
      ["", "名称", "数量"],
      ["", "苹果", "3"],
    ];
    const r = trimSheetEdges(rows, 3, []);
    expect(r.rowOffset).toBe(1);
    expect(r.colOffset).toBe(1);
  });

  it("无裁剪时偏移为 0", () => {
    const r = trimSheetEdges([["a", "b"]], 2, []);
    expect(r.rowOffset).toBe(0);
    expect(r.colOffset).toBe(0);
  });
});

describe("列前缀和与列窗口（sheetColPrefix/sheetColumnWindow，2026-11-26 列虚拟化）", () => {
  it("前缀和：长度 n+1，首项 0", () => {
    expect(sheetColPrefix([100, 80, 60])).toEqual([0, 100, 180, 240]);
    expect(sheetColPrefix([])).toEqual([0]);
  });

  it("列窗口：视口落在首列内", () => {
    const prefix = sheetColPrefix([100, 100, 100, 100]);
    expect(sheetColumnWindow(prefix, 0, 250, 1)).toEqual({ start: 0, end: 3 });
  });

  it("列窗口：横向滚动到中段，两侧外扩 overscan", () => {
    const prefix = sheetColPrefix(Array.from({ length: 50 }, () => 100));
    // scrollLeft=2000 → 视口覆盖列 20..29，外扩 1 列 → 19..30
    expect(sheetColumnWindow(prefix, 2000, 1000, 1)).toEqual({ start: 19, end: 30 });
  });

  it("列窗口：滚动到最右端不越界", () => {
    const prefix = sheetColPrefix(Array.from({ length: 10 }, () => 100));
    expect(sheetColumnWindow(prefix, 900, 400, 3)).toEqual({ start: 6, end: 9 });
  });

  it("列窗口：空表返回空窗口", () => {
    expect(sheetColumnWindow([0], 0, 500, 3)).toEqual({ start: 0, end: -1 });
  });
});

describe("截断格集合（sheetTruncatedCells，2026-11-26 截断角标）", () => {
  it("超过行内分配行数的格被标记，同行的矮格不标", () => {
    // 列宽 100：48 个 CJK = 624px → 折 7 行（>上限 6 被截停 allot=6），短格 1 行不标
    const long = "十个汉字".repeat(12);
    const rows = [["短", long]];
    const trunc = sheetTruncatedCells(rows, [100, 100], "wrap");
    expect(trunc.has("0:1")).toBe(true);
    expect(trunc.has("0:0")).toBe(false);
  });

  it("行内全部格都装得下 → 空集合", () => {
    const trunc = sheetTruncatedCells([["短文本", "abc"]], [120, 120], "wrap");
    expect(trunc.size).toBe(0);
  });

  it("恰好装满分配行数的格不标（无视觉裁切）", () => {
    // 列宽 100：20 个汉字 = 260px + 16 → ceil = 3 行；allotted = 3 → 不标
    const v = "十个汉字十个汉字";
    const trunc = sheetTruncatedCells([[v]], [100], "wrap");
    expect(trunc.size).toBe(0);
  });
});

describe("合并锚点视窗过滤（mergesInView，2026-11-26 合并区视窗可见）", () => {
  const anchors = buildMergeMap(
    [
      { row: 0, col: 0, rowSpan: 2, colSpan: 2 },
      { row: 10, col: 10, rowSpan: 3, colSpan: 3 },
    ],
    100,
    100,
  ).anchors;

  it("锚点矩形与窗口相交即返回（含锚点在窗口外的跨界块）", () => {
    // 锚点 (0,0) 跨 2×2，窗口行 1..3 / 列 1..3 与其相交（锚点本体在窗外）
    const hit = mergesInView(anchors, 1, 3, 1, 3);
    expect(hit.map(([k]) => k)).toEqual(["0:0"]);
  });

  it("不相交的合并区被滤掉", () => {
    const hit = mergesInView(anchors, 0, 5, 0, 5);
    expect(hit.map(([k]) => k)).toEqual(["0:0"]);
  });
});

describe("A1 坐标（sheetA1，2026-11-26 单元格选中态）", () => {
  it("列字母进位与行号 1 起", () => {
    expect(sheetA1(0, 0)).toBe("A1");
    expect(sheetA1(9, 25)).toBe("Z10");
    expect(sheetA1(0, 26)).toBe("AA1");
    expect(sheetA1(11, 701)).toBe("ZZ12");
    expect(sheetA1(0, 702)).toBe("AAA1");
  });
});

describe("手拖列宽钳制（clampSheetColWidth，2026-11-26 列宽手拖）", () => {
  it("钳到 48..1000 并取整；脏值回落 120", () => {
    expect(clampSheetColWidth(10)).toBe(48);
    expect(clampSheetColWidth(5000)).toBe(1000);
    expect(clampSheetColWidth(120.6)).toBe(121);
    expect(clampSheetColWidth(Number.NaN)).toBe(120);
  });
});

describe("合并区感知估算（2026-11-26 标题行/列虚肥修复）", () => {
  it("列宽：跨列合并锚点与覆盖格不参与逐列累计（46 列信息行不撑肥首列）", () => {
    // 43 个 CJK = 559px + 16 → 参与累计首列 = 240 上限；跳过后按普通格算
    const rows = [["跨列合并的超长信息行内容跨列合并的超长信息行内容跨列合并的超长信息行内容跨列合并的超长", "普通格"]];
    const noMerge = sheetColumnWidths(rows, 2);
    const withMerge = sheetColumnWidths(rows, 2, [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }]);
    expect(noMerge[0]).toBe(240);
    expect(withMerge[0]).toBe(96); // 回落 MIN（无其他贡献）
    expect(withMerge[1]).toBe(96);
  });

  it("列宽：P90 分位——单格离局长文本不撑宽整列（2026-11-26 列宽优化）", () => {
    // 9 个普通格（15 CJK = 195px）+ 1 个离局格（60 CJK = 780px）→ P90 取 195
    const short = "十五个汉字十五个字"; // 9 CJK = 117px → 16+117 = 133
    const rows: string[][] = [];
    for (let i = 0; i < 9; i++) rows.push([short]);
    rows.push(["离局长文本".repeat(10)]); // 50 CJK = 650px
    const w = sheetColumnWidths(rows, 1);
    expect(w[0]).toBe(133); // 不是 650+16 的离局值
  });

  it("列宽：P90 不误伤均匀列——全部同长文本仍按该宽度取", () => {
    const rows = Array.from({ length: 20 }, () => ["十个汉字十个汉字"]); // 8 CJK = 104px
    const w = sheetColumnWidths(rows, 1);
    expect(w[0]).toBe(120); // 16+104 = 120（P90 = 该均匀宽度）
  });

  it("行高：跨列锚点按跨度总宽折行（标题行一行放得下就不再误折 6 行）", () => {
    // 文本 400px（约 30 CJK），跨 4 列总宽 400 → 1 行；若按单列 100 宽则折 5 行
    const text = "跨列标题行内容跨列标题行内容跨列标题行内容跨列";
    const rows = [[text, "", "", ""], ["数据", "", "", ""]];
    const merges = [{ row: 0, col: 0, rowSpan: 1, colSpan: 4 }];
    const h = sheetRowHeights(rows, [100, 100, 100, 100], "wrap", merges);
    expect(h[0]).toBe(28); // 单行基线（relaxed 才是 40）
  });

  it("行高：跨行锚点按行Span 均摊文本行数需求", () => {
    // 文本 800px（60 CJK），跨 2 行 × 总宽 400：need=3 → 每行承担 ceil(3/2)=2 行
    const text = "跨行合并块内容".repeat(10); // 70 CJK = 910px
    const rows = [[text], [""], ["数据"]];
    const merges = [{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }];
    const h = sheetRowHeights(rows, [400], "wrap", merges);
    // need = ceil((910+16)/400) = 3；均摊 ceil(3/2) = 2 → 每行 2×20+8 = 48
    expect(h[0]).toBe(48);
    expect(h[1]).toBe(48);
    expect(h[2]).toBe(28);
  });

  it("截断集合：合并感知后与行高一致（跨列锚点装得下不打标）", () => {
    const text = "跨列标题行内容跨列标题行内容跨列标题行内容跨列";
    const rows = [[text, "", "", ""]];
    const trunc = sheetTruncatedCells(rows, [100, 100, 100, 100], "wrap", [
      { row: 0, col: 0, rowSpan: 1, colSpan: 4 },
    ]);
    expect(trunc.size).toBe(0);
  });
});

describe("列宽表头兜底（2026-11-26 P90 配套）", () => {
  it("稀疏列 P90 缩到下限时，表头一行宽兜底（表头不破碎）", () => {
    // 稠密表头行（非空占比 1.0 ≥ 0.6 成立）+ 40 行短代码（28px）：P90 →
    // 16+28 = 44 → MIN 96；表头兜底 16+78 = 94 → 列宽 96
    const rows: string[][] = [["具体问题描述", "列二", "列三"]];
    for (let i = 0; i < 40; i++) rows.push(["1-3", "", ""]);
    const w = sheetColumnWidths(rows, 3);
    expect(w[0]).toBe(96);
  });

  it("表头超宽仍被 MAX 钳住", () => {
    const rows: string[][] = [["跨列合并的超长信息行内容跨列合并的超长信息行内容跨列合并的超长信息行内容跨列合并的超长"]];
    const w = sheetColumnWidths(rows, 1);
    expect(w[0]).toBe(240);
  });
});
