import { describe, expect, it } from "vitest";

import { pdfMenuState } from "../pdfOps";

const f = (name: string) => ({ name, isDir: false });
const d = (name: string) => ({ name, isDir: true });

describe("PDF 菜单条件（pdfMenuState）", () => {
  it("≥2 个 PDF 文件：可合并/水印，不可拆分", () => {
    const s = pdfMenuState([f("a.pdf"), f("b.pdf")]);
    expect(s.canMerge).toBe(true);
    expect(s.canSplit).toBe(false);
    expect(s.canWatermark).toBe(true);
  });

  it("单个 PDF：仅可拆分/水印", () => {
    const s = pdfMenuState([f("a.pdf")]);
    expect(s.canMerge).toBe(false);
    expect(s.canSplit).toBe(true);
    expect(s.canWatermark).toBe(true);
  });

  it("混合非 PDF：合并/水印/拆分均不可", () => {
    const s = pdfMenuState([f("a.pdf"), f("b.txt")]);
    expect(s.canMerge).toBe(false);
    expect(s.canWatermark).toBe(false);
    expect(pdfMenuState([f("b.txt"), f("c.docx")]).canSplit).toBe(false);
  });

  it("文件夹不参与：选中含目录一律不可", () => {
    const s = pdfMenuState([f("a.pdf"), d("dir")]);
    expect(s.canMerge).toBe(false);
    expect(s.canWatermark).toBe(false);
    expect(pdfMenuState([d("dir.pdf")]).canSplit).toBe(false);
  });

  it("扩展名大小写不敏感", () => {
    expect(pdfMenuState([f("A.PDF"), f("b.Pdf")]).canMerge).toBe(true);
  });

  it("空选中：全部不可", () => {
    const s = pdfMenuState([]);
    expect(!s.canMerge && !s.canSplit && !s.canWatermark).toBe(true);
  });
});
