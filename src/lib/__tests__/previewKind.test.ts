import { describe, expect, it } from "vitest";

import { PREVIEW_LABELS, previewKind } from "../previewKind";

describe("previewKind（扩展名 → 预览类型路由）", () => {
  it("图片族", () => {
    for (const n of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.ico", "h.avif"])
      expect(previewKind(n)).toBe("image");
  });

  it("音视频族", () => {
    expect(previewKind("a.mp4")).toBe("video");
    expect(previewKind("a.mkv")).toBe("video");
    expect(previewKind("a.mp3")).toBe("audio");
    expect(previewKind("a.flac")).toBe("audio");
  });

  it("文本与代码族（HTML 按文本不渲染；CSV/TSV 已改表格预览不在其列）", () => {
    for (const n of ["a.txt", "a.log", "a.json", "a.rs", "a.tsx", "a.html"])
      expect(previewKind(n)).toBe("text");
  });

  it("CSV/TSV 走表格网格预览（2026-10-17）", () => {
    expect(previewKind("a.csv")).toBe("officeSheet");
    expect(previewKind("a.tsv")).toBe("officeSheet");
  });

  it("markdown", () => {
    expect(previewKind("readme.md")).toBe("markdown");
    expect(previewKind("readme.markdown")).toBe("markdown");
  });

  it("office 文本抽取族", () => {
    expect(previewKind("a.docx")).toBe("officeDoc");
    expect(previewKind("a.docm")).toBe("officeDoc");
    for (const n of ["a.xlsx", "a.xlsm", "a.xlsb", "a.xls", "a.ods"])
      expect(previewKind(n)).toBe("officeSheet");
    expect(previewKind("a.pptx")).toBe("officeSlides");
  });

  it("pdf 归独立类型（M2 接 pdf.js 前 UI 回落兜底卡）", () => {
    expect(previewKind("a.pdf")).toBe("pdf");
  });

  it("压缩包清单族（rar 许可证不合 §8 不支持）", () => {
    expect(previewKind("a.zip")).toBe("archive");
    expect(previewKind("a.tar")).toBe("archive");
    expect(previewKind("a.tgz")).toBe("archive");
    expect(previewKind("a.7z")).toBe("archive");
    expect(previewKind("a.tar.gz")).toBe("archive"); // 双重扩展名特判
    expect(previewKind("a.rar")).toBe("fallback");
    // 单文件压缩：清单卡
    expect(previewKind("a.gz")).toBe("archive");
    expect(previewKind("a.xz")).toBe("archive");
    expect(previewKind("a.bz2")).toBe("archive");
  });

  it("TIFF 走图片通道（Rust 解码），avi 试探视频通道", () => {
    expect(previewKind("scan.tif")).toBe("image");
    expect(previewKind("scan.tiff")).toBe("image");
    expect(previewKind("movie.avi")).toBe("video");
  });

  it("epub 电子书", () => {
    expect(previewKind("book.epub")).toBe("epub");
  });

  it("字体族", () => {
    for (const n of ["a.ttf", "a.otf", "a.woff", "a.woff2", "a.ttc"])
      expect(previewKind(n)).toBe("font");
  });

  it("无扩展名/点开头/未知扩展名 → fallback", () => {
    expect(previewKind("README")).toBe("fallback");
    expect(previewKind(".gitignore")).toBe("fallback");
    expect(previewKind("a.xyz")).toBe("fallback");
    expect(previewKind("a.exe")).toBe("fallback");
    // 旧版二进制 office 暂不支持（M1 范围外）
    expect(previewKind("a.doc")).toBe("fallback");
    expect(previewKind("a.ppt")).toBe("fallback");
  });

  it("大小写不敏感", () => {
    expect(previewKind("PHOTO.PNG")).toBe("image");
    expect(previewKind("Doc.DOCX")).toBe("officeDoc");
  });

  it("徽标文案覆盖全部类型", () => {
    for (const k of Object.keys(PREVIEW_LABELS)) {
      expect(PREVIEW_LABELS[k as keyof typeof PREVIEW_LABELS]).toBeTruthy();
    }
  });
});
