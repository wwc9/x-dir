// 表格预览网格数据（纯函数，V2 快速预览）：Rust 端 calamine 产出的制表符分隔文本
// → 行/列矩阵 + 自适应列宽。列宽启发式：CJK 13px、拉丁 7px（13px 字号实测），带上下限。
// 合并单元格（2026-10-17）：锚点 + 跨度 → 查找表（锚点图 / 覆盖集），渲染层据此
// span 展开、跳过被覆盖格。

export type SheetRows = string[][];
export type SheetMerge = {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
};

export interface SheetMergeMap {
  /** 锚点（合并区左上角）→ 跨度 */
  anchors: Map<string, SheetMerge>;
  /** 被合并区覆盖的非锚点格（渲染时跳过），key = "row:col" */
  covered: Set<string>;
}

const key = (r: number, c: number) => `${r}:${c}`;

/** 合并清单 → 查找表。越界部分裁剪到网格内；跨度为 1 的合并忽略（无视觉意义）。 */
export function buildMergeMap(
  merges: SheetMerge[],
  rowCount: number,
  colCount: number,
): SheetMergeMap {
  const anchors = new Map<string, SheetMerge>();
  const covered = new Set<string>();
  for (const m of merges) {
    const rowSpan = Math.min(m.rowSpan, rowCount - m.row);
    const colSpan = Math.min(m.colSpan, colCount - m.col);
    if (rowSpan <= 1 && colSpan <= 1) continue;
    if (rowSpan < 1 || colSpan < 1) continue;
    anchors.set(key(m.row, m.col), { ...m, rowSpan, colSpan });
    for (let r = m.row; r < m.row + rowSpan; r++) {
      for (let c = m.col; c < m.col + colSpan; c++) {
        if (r === m.row && c === m.col) continue;
        covered.add(key(r, c));
      }
    }
  }
  return { anchors, covered };
}

/** 制表符分隔文本 → 行矩阵；丢弃末尾空行（Rust 端每行以 \n 结尾） */
export function parseSheetRows(text: string): SheetRows {
  if (!text) return [];
  const lines = text.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

/** 行矩阵 → 列宽（px）。采样前 500 行足矣；空列取下限；超宽列截到上限（省略号兜底） */
export function sheetColumnWidths(rows: SheetRows, colCount: number): number[] {
  const PAD = 16;
  const MIN = 56;
  const MAX = 360;
  const LATIN = 7;
  const CJK = 13;
  const widths = new Array(colCount).fill(MIN) as number[];
  const sample = rows.length > 500 ? rows.slice(0, 500) : rows;
  for (const row of sample) {
    for (let c = 0; c < colCount && c < row.length; c++) {
      const v = row[c];
      if (!v) continue;
      let px = PAD;
      for (const ch of v) px += ch.charCodeAt(0) > 255 ? CJK : LATIN;
      if (px > widths[c]) widths[c] = Math.min(MAX, px);
    }
  }
  return widths;
}

/** 行矩阵的总列数（各行参差时取最大） */
export function sheetColumnCount(rows: SheetRows): number {
  let n = 0;
  for (const row of rows) if (row.length > n) n = row.length;
  return n;
}
