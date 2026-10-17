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
