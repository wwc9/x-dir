// 表格预览网格数据（纯函数，V2 快速预览）：Rust 端 calamine 产出的制表符分隔文本
// → 行/列矩阵 + 自适应列宽。列宽启发式：CJK 13px、拉丁 7px（13px 字号实测），带上下限。

export type SheetRows = string[][];

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
