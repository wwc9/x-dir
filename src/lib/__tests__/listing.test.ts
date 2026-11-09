// lib/listing.ts 文件清单导出行构建回归测试（2026-11-09「导出文件清单 ▸」三格式）：
// CSV 转义与列口径 / Markdown 管道转义与人类可读体积 / 纯文本仅名称。
import { describe, expect, it } from "vitest";

import {
  buildDupCsv,
  buildListing,
  dupWaste,
  listingFileName,
  listingFilter,
  type ListingFormat,
} from "../listing";
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

// ── 重复文件清单导出（2026-11-09「查找重复文件」增强）──
describe("buildDupCsv / dupWaste", () => {
  const GROUPS = [
    { hash: "aa".repeat(32), size: 100, paths: ["E:\\d\\a.xlsx", "E:\\d\\副本\\a.xlsx"] },
    { hash: "bb".repeat(32), size: 7, paths: ["E:\\d\\b.bin", "E:\\d\\b(2).bin", "E:\\d\\b(3).bin"] },
  ];

  it("dupWaste = 各组体积 × (份数-1) 合计", () => {
    expect(dupWaste(GROUPS)).toBe(100 + 7 * 2); // 114
    expect(dupWaste([])).toBe(0);
    expect(dupWaste([{ hash: "cc".repeat(32), size: 50, paths: ["only"] }])).toBe(0); // 单份无浪费
  });

  it("CSV：组号连续、组内逐行路径、原始字节列", () => {
    const csv = buildDupCsv(GROUPS);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("组号,文件路径,大小(字节),SHA-256");
    expect(lines[1]).toBe(`1,E:\\d\\a.xlsx,100,${"aa".repeat(32)}`);
    expect(lines[2]).toBe(`1,E:\\d\\副本\\a.xlsx,100,${"aa".repeat(32)}`);
    expect(lines[3]).toBe(`2,E:\\d\\b.bin,7,${"bb".repeat(32)}`);
    expect(lines).toHaveLength(1 + 2 + 3); // 表头 + 2 + 3
  });

  it("CSV：含逗号的路径按 RFC 4180 转义", () => {
    const csv = buildDupCsv([
      { hash: "dd".repeat(32), size: 1, paths: ['E:\\d\\a",b.txt'] },
    ]);
    expect(csv.split("\r\n")[1]).toContain('"E:\\d\\a"",b.txt"');
  });
});
