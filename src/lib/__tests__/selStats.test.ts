import { describe, expect, it } from "vitest";

import { formatShortTime, selStats } from "../selStats";
import type { FileEntry } from "../ipc";

const f = (name: string, size = 100, mtimeMs = 1_700_000_000_000): FileEntry => ({
  path: "C:\\t\\" + name,
  name,
  isDir: false,
  size,
  mtimeMs,
  ctimeMs: mtimeMs,
  attrs: { readonly: false, hidden: false, system: false },
  ext: "",
} as unknown as FileEntry);
const d = (name: string): FileEntry =>
  ({ ...f(name, 0), isDir: true }) as FileEntry;

describe("选中统计（selStats，2026-11-03）", () => {
  it("单选命中：返回行内属性条数据", () => {
    const e = f("报告.pdf", 2200);
    const s = selStats([e.path], [e]);
    expect(s.count).toBe(1);
    expect(s.single).toBe(e);
    expect(s.size).toBe(2200);
    expect(s.topTypes).toEqual([]);
  });

  it("单选未命中加载页（选择记忆越页）：single 为 null 仍计数", () => {
    const s = selStats(["C:\\t\\别处.txt"], [f("a.txt")]);
    expect(s.single).toBeNull();
    expect(s.count).toBe(1);
    expect(s.resolved).toBe(0);
  });

  it("多选纯文件：大小合计 + 类型 Top2 摘要（无文件夹）", () => {
    const es = [f("a.pdf"), f("b.pdf"), f("c.pdf"), f("d.xlsx"), f("e.xlsx"), f("f.png")];
    const s = selStats(es.map((x) => x.path), es);
    expect(s.count).toBe(6);
    expect(s.size).toBe(600);
    expect(s.hasDir).toBe(false);
    expect(s.topTypes).toEqual([
      { label: "PDF", n: 3 },
      { label: "XLSX", n: 2 },
    ]); // PNG 第三名被截掉
  });

  it("多选含文件夹：hasDir 置位（调用方只显示数量，不含合计/摘要）", () => {
    const es = [d("dir1"), d("dir2"), f("a.txt", 50)];
    const s = selStats(es.map((x) => x.path), es);
    expect(s.hasDir).toBe(true);
    expect(s.size).toBe(50); // 纯文件部分仍计，但调用方不再展示
  });

  it("扩展名大写归并；无扩展名单列", () => {
    const es = [f("a.JPG"), f("b.jpg"), f("noext")];
    const s = selStats(es.map((x) => x.path), es);
    expect(s.topTypes).toEqual([
      { label: "JPG", n: 2 },
      { label: "无扩展名", n: 1 },
    ]);
  });

  it("并列数量按标签字母序稳定排序", () => {
    const es = [f("b.zip"), f("a.pdf")];
    const s = selStats(es.map((x) => x.path), es);
    expect(s.topTypes.map((x) => x.label)).toEqual(["PDF", "ZIP"]);
  });

  it("空选中", () => {
    const s = selStats([], [f("a.txt")]);
    expect(s.count).toBe(0);
    expect(s.topTypes).toEqual([]);
  });
});

describe("短时间格式（formatShortTime）", () => {
  it("MM-dd HH:mm", () => {
    const ms = new Date(2026, 10, 3, 9, 5).getTime();
    expect(formatShortTime(ms)).toBe("11-03 09:05");
  });

  it("0 显示占位符", () => {
    expect(formatShortTime(0)).toBe("—");
  });
});
