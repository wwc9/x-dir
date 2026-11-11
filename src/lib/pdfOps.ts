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

// ── PDF 拆分参数化（2026-11-10）：面板选项结构 + 命名规则渲染预演。
//    输出落名的权威实现在 Rust pdf::render_split_name（cargo test 锁定），
//    此处同口径镜像仅供面板预演与校验，改占位符两处必须同改 ──

export type PdfSplitMethod = "pages" | "bookmarks";

export interface PdfSplitOptions {
  method: PdfSplitMethod;
  /** 每 N 页一份（仅按页数拆分；≥1） */
  nPages: number;
  /** 书签层级（仅按书签拆分；0 = 顶级，层级为空后端自动取最深） */
  bookmarkLevel: number;
  /** 命名规则（不含扩展名；占位符 [原文件名] [序号] [页码]） */
  namingRule: string;
  /** 结果存进源文件名子文件夹 */
  saveToFolder: boolean;
}

export const PDF_SPLIT_DEFAULT_RULE = "[原文件名]-[序号]";

/** 命名规则渲染预演（与 Rust render_split_name 同口径）：[原文件名]/[序号]/
 *  [页码]（起始-结束，单页只写一数字），自动补 .pdf；未知占位符原样保留 */
export function renderPdfSplitName(
  rule: string,
  stem: string,
  seq: number,
  start: number,
  end: number,
): string {
  const page = start === end ? String(start) : `${start}-${end}`;
  const name = rule
    .split("[原文件名]")
    .join(stem)
    .split("[序号]")
    .join(String(seq))
    .split("[页码]")
    .join(page);
  return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
}

/** 按页数拆分的份数预演 */
export function pdfSplitParts(total: number, nPages: number): number {
  const n = Math.max(1, Math.floor(nPages));
  return total <= 0 ? 0 : Math.ceil(total / n);
}

// ── 插入空白页（2026-11-11）：12 种模式对话框选项与联动 ──

/** 插入模式选项（与 Rust blank_positions 1–12 一一对应） */
export const BLANK_MODES: { value: number; label: string }[] = [
  { value: 1, label: "末尾补页凑偶数" },
  { value: 2, label: "开头补页凑偶数" },
  { value: 3, label: "第一页前插一页" },
  { value: 4, label: "第一页后插一页" },
  { value: 5, label: "最后一页后插一页" },
  { value: 6, label: "每页前各插一页" },
  { value: 7, label: "每页后各插一页" },
  { value: 8, label: "指定页码前各插一页" },
  { value: 9, label: "指定页码后各插一页" },
  { value: 10, label: "开头补页凑 N 的倍数" },
  { value: 11, label: "末尾补页凑 N 的倍数" },
  { value: 12, label: "每隔 N 页插一页" },
];

/** 模式 8/9 需要指定页码表达式 */
export const blankModeNeedsSpec = (m: number): boolean => m === 8 || m === 9;

/** 模式 10/11/12 需要间隔 N */
export const blankModeNeedsN = (m: number): boolean => m >= 10 && m <= 12;

// ── PDF 转图片（2026-11-11）：命名与目录口径 ──

export interface PdfToPngOptions {
  /** 起始页（1-based；0 = 第 1 页） */
  startPage: number;
  /** 结束页（1-based；0 = 末页） */
  endPage: number;
  /** 渲染分辨率 DPI（72–600，默认 150） */
  dpi: number;
  /** 加密 PDF 的用户口令（开箱密码，可空） */
  userPassword: string;
  /** 加密 PDF 的所有者口令（权限密码，可空；两密码任填其一即可） */
  ownerPassword: string;
  /** true = 每个源 PDF 的图片存进独立子文件夹（默认） */
  saveToFolder: boolean;
}

/** PNG 输出名：<stem>_p<页号>.png，页号按总页数宽度补零（资源管理器排序友好） */
export function pdfPngFileName(stem: string, page: number, total: number): string {
  const width = Math.max(1, String(Math.max(total, 1)).length);
  return `${stem}_p${String(page).padStart(width, "0")}.png`;
}

/** 转图片独立子文件夹名：<stem>_图片 */
export function pdfPngDirName(stem: string): string {
  return `${stem}_图片`;
}
