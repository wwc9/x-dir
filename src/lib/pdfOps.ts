// PDF 右键菜单条件纯函数：按选中集判定合并/拆分/水印可见性。
// 规则：全部条目均为 PDF 文件才可合并/水印；拆分仅限"恰一个 PDF 文件"。
import { extOf } from "./fileIcons";

export interface PdfMenuTarget {
  name: string;
  isDir: boolean;
}

export interface PdfMenuState {
  canMerge: boolean;
  canSplit: boolean;
  canWatermark: boolean;
}

export function isPdfName(name: string): boolean {
  return extOf(name) === "pdf";
}

export function pdfMenuState(items: PdfMenuTarget[]): PdfMenuState {
  const files = items.filter((i) => !i.isDir);
  const allPdfFiles =
    files.length === items.length && files.every((f) => isPdfName(f.name));
  return {
    canMerge: allPdfFiles && items.length >= 2,
    canSplit: items.length === 1 && files.length === 1 && isPdfName(files[0].name),
    canWatermark: allPdfFiles && items.length >= 1,
  };
}

// ── 页码范围表达式（PDF 提取页/删除页对话框，2026-11-03）──
// 语义与 Rust pdf::parse_page_ranges 逐字对齐（提交前预演；Rust 端仍是最终校验）：
// 逗号/全角逗号分隔、段内空格剔除、"3" 单页、"1-3" 区间、"5-" 到末页、去重升序。

export type PageSpecResult =
  | { pages: number[]; error: undefined }
  | { pages: []; error: string };

function pageNum(s: string, total: number): number | string {
  if (!/^\d+$/.test(s)) return `页码无效：${s}`;
  const n = Number(s);
  if (n === 0 || n > total) return `页码超出范围（共 ${total} 页）：${n}`;
  return n;
}

/** 解析页码范围表达式；错误文案与 Rust 端同口径（用户预演看到的即提交后
 *  可能收到的报错），首错即返 */
export function parsePageSpec(spec: string, total: number): PageSpecResult {
  const out = new Set<number>();
  for (const raw of spec.split(/[,，]/)) {
    const part = raw.replace(/[ \t]/g, "");
    if (!part) continue;
    // 仅首个 "-" 为区间分隔（Rust split_once）：再出现即整段按页码解析报错
    const dash = part.indexOf("-");
    const sTxt = dash < 0 ? part : part.slice(0, dash);
    const eTxt = dash < 0 ? part : part.slice(dash + 1);
    const s = pageNum(sTxt, total);
    if (typeof s !== "number") return { pages: [], error: s };
    const e = eTxt === "" ? total : pageNum(eTxt, total);
    if (typeof e !== "number") return { pages: [], error: e };
    if (s > e) return { pages: [], error: `页码范围无效：${part}（起始大于结束）` };
    for (let i = s; i <= e; i++) out.add(i);
  }
  if (!out.size) return { pages: [], error: "页码范围不能为空" };
  return { pages: [...out].sort((a, b) => a - b), error: undefined };
}

/** 页号集合 → 最短区间表达式（1,2,3,8,9 → "1-3,8-9"），解析预览回显用 */
export function pagesToSpec(pages: number[]): string {
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return parts.join(",");
}
