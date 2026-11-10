// lib/listing.ts 重复文件清单导出回归测试（2026-11-09「查找重复文件」增强）：
// dupWaste 口径与 CSV 转义。文件清单导出（CSV/MD/TXT 列集）已移至 Rust
// fs/listing.rs，格式口径由 cargo test 锁定（2026-11-10）。
import { describe, expect, it } from "vitest";

import { buildDupCsv, dupWaste } from "../listing";

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
