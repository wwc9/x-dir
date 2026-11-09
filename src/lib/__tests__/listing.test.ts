// lib/listing.ts 文件清单导出行构建回归测试（2026-11-09「导出文件清单 ▸」三格式）：
// CSV 转义与列口径 / Markdown 管道转义与人类可读体积 / 纯文本仅名称。
import { describe, expect, it } from "vitest";

import { buildListing, listingFileName, listingFilter, type ListingFormat } from "../listing";
import type { FileEntry } from "../ipc";

const e = (name: string, size: number, mtimeMs: number, isDir = false): FileEntry => ({
  name,
  path: `E:\\d\\${name}`,
  isDir,
  size,
  mtimeMs,
  ctimeMs: 0,
  attrs: { hidden: false, system: false, readonly: false },
  py: null,
});

const ENTRIES = [
  e("报告.docx", 1234567, Date.UTC(2026, 10, 9, 6, 30)),
  e("子文件夹", 0, Date.UTC(2026, 10, 9, 6, 30), true),
];

describe("buildListing", () => {
  it("CSV：表头 + 原始字节 + 文件夹大小留空 + 时间列", () => {
    const csv = buildListing(ENTRIES, "csv");
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("名称,类型,大小(字节),修改时间");
    expect(lines[1]).toContain("报告.docx"); // 无特殊字符不转义
    expect(lines[1]).toContain("DOCX");
    expect(lines[1]).toContain("1234567");
    expect(lines[2]).toContain("文件夹");
    expect(lines[2]).toContain(",,"); // isDir → 大小列留空
  });

  it("CSV：含逗号/引号的名称按 RFC 4180 转义", () => {
    const csv = buildListing([e('a",b.csv', 1, 0)], "csv");
    expect(csv.split("\r\n")[1]).toContain('"a"",b.csv"');
  });

  it("Markdown：管道转义 + 人类可读体积 + 右对齐分隔行", () => {
    const md = buildListing([e("a|b.txt", 1536, 0)], "md");
    const lines = md.split("\r\n");
    expect(lines[0]).toBe("| 名称 | 类型 | 大小 | 修改时间 |");
    expect(lines[1]).toBe("| --- | --- | ---: | --- |");
    expect(lines[2]).toContain("a｜b.txt"); // 半角管道替换为全角
    expect(lines[2]).toContain("1.5 KB"); // formatBytes 人类可读
  });

  it("纯文本：仅名称一行一个", () => {
    const txt = buildListing(ENTRIES, "txt");
    expect(txt.split("\r\n")).toEqual(["报告.docx", "子文件夹"]);
  });
});

describe("listingFileName / listingFilter", () => {
  it("默认文件名与过滤器随格式", () => {
    const cases: [ListingFormat, string, string][] = [
      ["csv", "文件清单.csv", "CSV"],
      ["md", "文件清单.md", "Markdown"],
      ["txt", "文件清单.txt", "文本"],
    ];
    for (const [fmt, name, label] of cases) {
      expect(listingFileName(fmt)).toBe(name);
      expect(listingFilter(fmt)).toEqual({ name: label, extensions: [fmt] });
    }
  });
});
