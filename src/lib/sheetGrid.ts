// 表格预览网格数据（纯函数，V2 快速预览）：Rust 端 calamine 产出的制表符分隔文本
// → 行/列矩阵 + 自适应列宽。列宽启发式：CJK 13px、拉丁 7px（13px 字号实测），带上下限。
// 合并单元格（2026-10-17）：锚点 + 跨度 → 查找表（锚点图 / 覆盖集），渲染层据此
// span 展开、跳过被覆盖格。
// 行高（2026-11-03）：多行档（换行/宽松）逐行高度估算（列宽折行启发），
// 单行档维持 CSS auto-rows 恒高。

import { DENSITY } from "./tokens";

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
  /** 被覆盖格 → 所在合并区锚点（2026-11-26 单元格选中态：方向键移进覆盖格
   *  时落到锚点上，与视觉块一致） */
  anchorOf: Map<string, SheetMerge>;
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
  const anchorOf = new Map<string, SheetMerge>();
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
        anchorOf.set(key(r, c), anchors.get(key(m.row, m.col))!);
      }
    }
  }
  return { anchors, covered, anchorOf };
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
  const widths = new Array(colCount).fill(MIN) as number[];
  const sample = rows.length > 500 ? rows.slice(0, 500) : rows;
  for (const row of sample) {
    for (let c = 0; c < colCount && c < row.length; c++) {
      const v = row[c];
      if (!v) continue;
      const px = PAD + textWidthPx(v);
      if (px > widths[c]) widths[c] = Math.min(MAX, px);
    }
  }
  return widths;
}

/** 单行文本像素宽估算（CJK 13px / 拉丁 7px @13px 字号实测，与列宽启发同源；
 *  2026-11-03 抽出共用——多行档行高估算按列宽对文本折行计数） */
export function textWidthPx(v: string): number {
  let px = 0;
  for (const ch of v) px += ch.charCodeAt(0) > 255 ? 13 : 7;
  return px;
}

/** 表格行高模式：single = 单行省略（现状，CSS auto-rows 恒高）；
 *  wrap = 自动换行（按内容折行数估行高）；relaxed = 换行 + 更大留白 */
export type SheetRowMode = "single" | "wrap" | "relaxed";

/** 多行档单格折行数上限（防一格千字把行撑到整屏；超出部分仍换行显示，
 *  行高截停——溢出裁切与省略号兜底同语义） */
export const SHEET_WRAP_MAX_LINES = 6;

/** 行矩阵 + 列宽 → 逐行像素高（多行档）。行内取各格折行数的最大值：
 *  lines = ceil((文本宽 + 内边距 16) / 列宽)；行高 = lines × 行高基线 + 上下留白。
 *  单行结果不低于 --np-row-h（与单行档视觉连续）。 */
export function sheetRowHeights(
  rows: SheetRows,
  colWidths: number[],
  mode: Exclude<SheetRowMode, "single">,
): number[] {
  const LINE_H = DENSITY.sheetLineH;
  const PAD = mode === "relaxed" ? 10 : 4;
  const MIN = mode === "relaxed" ? LINE_H + 20 : DENSITY.rowH;
  const out = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    let lines = 1;
    const row = rows[r];
    for (let c = 0; c < row.length && c < colWidths.length; c++) {
      const v = row[c];
      if (!v) continue;
      const w = colWidths[c];
      if (w <= 0) continue;
      const need = Math.ceil((textWidthPx(v) + 16) / w);
      if (need > lines) lines = need;
    }
    lines = Math.min(lines, SHEET_WRAP_MAX_LINES);
    out[r] = Math.max(MIN, lines * LINE_H + PAD * 2);
  }
  return out;
}

/** 行矩阵的总列数（各行参差时取最大） */
export function sheetColumnCount(rows: SheetRows): number {
  let n = 0;
  for (const row of rows) if (row.length > n) n = row.length;
  return n;
}

export interface SheetTrimResult {
  rows: SheetRows;
  colCount: number;
  merges: SheetMerge[];
  /** 裁掉的顶部/左侧行列数（2026-11-26）：单元格 A1 坐标还原用——
   *  展示坐标 = 网格内索引 + 偏移，与源文件真实坐标一致 */
  rowOffset: number;
  colOffset: number;
}

/** 边缘空行/空列裁剪（纯函数，2026-11-24 表格预览增强）：源文件样式化的
 *  used range 常从 A1 起带装饰性空行空列——顶部空行还会挤掉表头判定
 *  （is-head 指向空行、真实表头按数据行渲染）。裁剪四缘全空行/列，合并区
 *  坐标随裁剪平移、跨度钳回新网格，完全出界的合并丢弃；中段空行/列保留。 */
export function trimSheetEdges(
  rows: SheetRows,
  colCount: number,
  merges: SheetMerge[],
): SheetTrimResult {
  const rowEmpty = (r: number) => {
    const row = rows[r];
    for (let c = 0; c < colCount && c < row.length; c++) {
      if (row[c]) return false;
    }
    return true;
  };
  let top = 0;
  while (top < rows.length && rowEmpty(top)) top++;
  let bottom = rows.length;
  while (bottom > top && rowEmpty(bottom - 1)) bottom--;
  const colEmpty = (c: number) => {
    for (let r = top; r < bottom; r++) {
      if (rows[r][c]) return false;
    }
    return true;
  };
  let left = 0;
  while (left < colCount && colEmpty(left)) left++;
  let right = colCount;
  while (right > left && colEmpty(right - 1)) right--;
  const cut = rows.slice(top, bottom).map((row) => {
    const out: string[] = [];
    for (let c = left; c < right; c++) out.push(row[c] ?? "");
    return out;
  });
  const newCount = Math.max(0, right - left);
  const newMerges: SheetMerge[] = [];
  for (const m of merges) {
    const row = m.row - top;
    const col = m.col - left;
    const rowSpan = Math.min(m.rowSpan, cut.length - row);
    const colSpan = Math.min(m.colSpan, newCount - col);
    if (row < 0 || col < 0 || rowSpan < 1 || colSpan < 1) continue;
    newMerges.push({ row, col, rowSpan, colSpan });
  }
  return {
    rows: cut,
    colCount: newCount,
    merges: newMerges,
    rowOffset: top,
    colOffset: left,
  };
}

/** 表头行判定（纯函数）：前 5 行内首个非空占比 ≥0.6 的行；跨列合并的装饰
 *  标题行（锚点只占 1 格）占比不足会被跳过——冻结的是列头行而非标题行。
 *  找不到回落 -1（无冻结条）。 */
export function sheetHeaderRow(rows: SheetRows, colCount: number): number {
  const cap = Math.min(5, rows.length);
  for (let r = 0; r < cap; r++) {
    let nonEmpty = 0;
    for (let c = 0; c < colCount; c++) if (rows[r][c]) nonEmpty++;
    if (colCount > 0 && nonEmpty / colCount >= 0.6) return r;
  }
  return -1;
}

/** 数值样文本（纯函数）：可选正负号 + 千分位（半/全角逗号，仅数字组间合法）+
 *  可选小数 + 可选百分号；"3," 与 "1.2.3" 这类非数值不入列 */
export function isNumericLike(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  const body = s.endsWith("%") ? s.slice(0, -1).trim() : s;
  return /^-?(\d{1,3}([,，]\d{3})+|\d+)(\.\d+)?$/.test(body) || /^-?\.\d+$/.test(body);
}

/** 列级数值判定（纯函数）：采样 ≤500 行（跳过表头及上方行），列内非空值
 *  ≥60% 为数值样 → 该列右对齐。返回 colCount 布尔数组。 */
export function sheetNumericCols(
  rows: SheetRows,
  colCount: number,
  skipRows = 1,
): boolean[] {
  const NUM_RATIO = 0.6;
  const body = rows.length > skipRows ? rows.slice(skipRows) : rows;
  const sample = body.length > 500 ? body.slice(0, 500) : body;
  const out: boolean[] = [];
  for (let c = 0; c < colCount; c++) {
    let nonEmpty = 0;
    let numeric = 0;
    for (const row of sample) {
      const v = row[c];
      if (!v) continue;
      nonEmpty++;
      if (isNumericLike(v)) numeric++;
    }
    out.push(nonEmpty > 0 && numeric / nonEmpty >= NUM_RATIO);
  }
  return out;
}

/** 表格搜索命中（纯函数）：逐格大小写不敏感匹配，返回 (行, 列, 该格内序号) 列表，
 *  全局序号由调用方按数组下标推得；上限 2000。 */
export function sheetMatches(
  rows: SheetRows,
  term: string,
  cap = 2000,
): { r: number; c: number; occ: number }[] {
  const out: { r: number; c: number; occ: number }[] = [];
  if (!term) return out;
  const t = term.toLowerCase();
  for (let r = 0; r < rows.length && out.length < cap; r++) {
    for (let c = 0; c < rows[r].length && out.length < cap; c++) {
      const cell = rows[r][c];
      if (!cell) continue;
      const lower = cell.toLowerCase();
      let idx = lower.indexOf(t);
      let occ = 0;
      while (idx >= 0 && out.length < cap) {
        out.push({ r, c, occ });
        occ++;
        idx = lower.indexOf(t, idx + t.length);
      }
    }
  }
  return out;
}

/** ── 列虚拟化（2026-11-26 表格预览八项增强）：行虚拟化只覆盖纵向，宽表
 *  （百列级）仍全量渲染格子——DOM = 可见行 × 全列，横向重绘全量 diff。
 *  列窗口与行虚拟化同机制：显式轨道不产生 DOM，只渲染视窗内格子。── */

/** 列宽 → 前缀和（px，长度 n+1，prefix[0]=0）：窗口定位与横向滚动跟随共用 */
export function sheetColPrefix(colWidths: number[]): number[] {
  const out = new Array(colWidths.length + 1).fill(0) as number[];
  for (let i = 0; i < colWidths.length; i++) out[i + 1] = out[i] + colWidths[i];
  return out;
}

/** 前缀和 + 滚动偏移 + 视口宽 → 可见列窗口（含首尾，闭区间）。
 *  start = 右缘越过 scrollLeft 的首列；end = 右缘到达视口右缘的列；
 *  overscan = 两侧外扩列数（横向斜读预渲染，滚动不出白）。 */
export function sheetColumnWindow(
  prefix: number[],
  scrollLeft: number,
  viewW: number,
  overscan = 3,
): { start: number; end: number } {
  const n = prefix.length - 1;
  if (n <= 0) return { start: 0, end: -1 };
  const right = scrollLeft + Math.max(0, viewW);
  // 二分：首个右缘 > scrollLeft 的列
  let lo = 0;
  let hi = n - 1;
  let start = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid + 1] > scrollLeft) {
      start = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  let end = start;
  while (end + 1 < n && prefix[end + 1] < right) end++;
  return {
    start: Math.max(0, start - overscan),
    end: Math.min(n - 1, end + overscan),
  };
}

/** 多行档截断格集合（纯函数）：与 sheetRowHeights 同源折行启发——格内需要
 *  的行数超过该行实际分配行数（= 行内最大折行数钳 SHEET_WRAP_MAX_LINES）
 *  即被静默裁切，渲染层据此打截断角标。key = "row:col"。 */
export function sheetTruncatedCells(
  rows: SheetRows,
  colWidths: number[],
  mode: Exclude<SheetRowMode, "single">,
): Set<string> {
  const LINE_H = DENSITY.sheetLineH;
  const PAD = mode === "relaxed" ? 10 : 4;
  const MIN = mode === "relaxed" ? LINE_H + 20 : DENSITY.rowH;
  const out = new Set<string>();
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let maxNeed = 1;
    const needs: number[] = [];
    for (let c = 0; c < row.length && c < colWidths.length; c++) {
      const v = row[c];
      const w = colWidths[c];
      const need = v && w > 0 ? Math.ceil((textWidthPx(v) + 16) / w) : 1;
      needs.push(need);
      if (need > maxNeed) maxNeed = need;
    }
    const allotted = Math.min(maxNeed, SHEET_WRAP_MAX_LINES);
    if (allotted * LINE_H + PAD * 2 <= MIN) continue; // 行高被 MIN 托底且未达折行数，无截断
    for (let c = 0; c < needs.length; c++) {
      if (needs[c] > allotted) out.add(key(r, c));
    }
  }
  return out;
}

/** 合并锚点视窗过滤（纯函数）：列/行双向虚拟化后，锚点行或列任一端在窗口
 *  外即整块消失、覆盖格又必须跳过 → 网格出现空洞。凡矩形与可见窗口相交的
 *  锚点都返回，渲染层按原跨度放置（轨道始终全量存在，放置不依赖窗口）。 */
export function mergesInView(
  anchors: Map<string, SheetMerge>,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
): [string, SheetMerge][] {
  const out: [string, SheetMerge][] = [];
  for (const [k, m] of anchors) {
    if (
      m.row <= r1 &&
      m.row + m.rowSpan - 1 >= r0 &&
      m.col <= c1 &&
      m.col + m.colSpan - 1 >= c0
    ) {
      out.push([k, m]);
    }
  }
  return out;
}

/** 网格内索引 → A1 坐标（纯函数）：列字母 A..Z、AA..（Excel 同款 26 进制
 *  无零表示），行号 1 起；配合裁剪偏移还原源文件真实坐标。 */
export function sheetA1(row: number, col: number): string {
  let n = col + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

/** 手拖列宽钳制（纯函数）：下限保一个汉字 + 边距可辨，上限放开到长文本
 *  可读（远超启发式 360 上限——手动拉开就是为看全文）；脏值回落 120。 */
export function clampSheetColWidth(w: number): number {
  if (!Number.isFinite(w)) return 120;
  return Math.min(1000, Math.max(48, Math.round(w)));
}
