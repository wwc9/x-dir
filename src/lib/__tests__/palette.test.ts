// 功能库快速命令面板纯逻辑锁定（lib/palette.ts）：高频清单解析 / 现场可用性 /
// 搜索过滤 / 吸附定位钳制。
import { describe, expect, it } from "vitest";

import type { FileEntry } from "../ipc";
import { builtinByKey, BUILTIN_FNS } from "../menuCommands";
import {
  clampPalettePos,
  filterPalette,
  PALETTE_QUICK_KEYS,
  paletteAvailable,
  paletteItems,
} from "../palette";

const fe = (name: string, isDir: boolean): FileEntry => ({
  name,
  path: `E:\\t\\${name}`,
  isDir,
  size: 1,
  mtimeMs: 0,
  ctimeMs: 0,
  attrs: { hidden: false, system: false, readonly: false },
  py: null,
});

describe("PALETTE_QUICK_KEYS", () => {
  it("高频 12 项全部能在注册表解析", () => {
    for (const k of PALETTE_QUICK_KEYS) expect(builtinByKey(k)).toBeDefined();
  });
  it("高频键互不重复且都在注册表内", () => {
    expect(new Set(PALETTE_QUICK_KEYS).size).toBe(PALETTE_QUICK_KEYS.length);
  });
});

describe("paletteItems", () => {
  it("可用项稳定置顶、不可用沉底，两块各自保持高频 12 项 → 注册表原序", () => {
    const sel = [fe("a.pdf", false)];
    const quickSet = new Set<string>(PALETTE_QUICK_KEYS);
    const base = [
      ...PALETTE_QUICK_KEYS.map((k) => builtinByKey(k)!),
      ...BUILTIN_FNS.filter(
        (f) =>
          f.key !== "palette" &&
          !quickSet.has(f.key) &&
          (f.supportsSel || f.supportsBlank),
      ),
    ];
    const avail = base
      .filter((f) => paletteAvailable(f, sel))
      .map((f) => f.key);
    const off = base
      .filter((f) => !paletteAvailable(f, sel))
      .map((f) => f.key);
    expect(off.length).toBeGreaterThan(0);
    expect(paletteItems(sel).map((i) => i.fn.key)).toEqual([...avail, ...off]);
  });
  it("窗格工具（双能力位皆 false）不入面板", () => {
    const keys = paletteItems([]).map((i) => i.fn.key);
    for (const tool of ["up", "view", "addr", "search", "splitH", "splitV", "swap"]) {
      expect(keys).not.toContain(tool);
    }
  });
  it("功能库入口自身不入面板（builtin:palette 是面板的唤起入口，自列无意义）", () => {
    const keys = paletteItems([fe("a.txt", false)]).map((i) => i.fn.key);
    expect(keys).not.toContain("palette");
  });
  it("可用性随现场变化：空白右键仅 supportsBlank 项可用", () => {
    const blank = paletteItems([]);
    const byKey = (k: string) => blank.find((i) => i.fn.key === k)!;
    expect(byKey("open").available).toBe(false);
    expect(byKey("exportList").available).toBe(true);
    expect(byKey("newFolder").available).toBe(true);
  });
  it("可用性随现场变化：选中 PDF 时 pdfMerge 可用、xlsxMerge 置灰", () => {
    const items = paletteItems([fe("doc.pdf", false)]);
    const byKey = (k: string) => items.find((i) => i.fn.key === k)!;
    expect(byKey("pdfMerge").available).toBe(true);
    expect(byKey("xlsxMerge").available).toBe(false);
    expect(byKey("findDuplicates").available).toBe(false); // target=dir
  });
  it("选中目录时 findDuplicates 可用", () => {
    const items = paletteItems([fe("资料", true)]);
    expect(items.find((i) => i.fn.key === "findDuplicates")!.available).toBe(true);
  });
});

describe("filterPalette", () => {
  const items = paletteItems([]);
  it("空 query 原样返回", () => {
    expect(filterPalette(items, "  ")).toBe(items);
  });
  it("按名称/说明/分组小写子串过滤", () => {
    expect(filterPalette(items, "PDF 合并").length).toBeGreaterThan(0);
    expect(filterPalette(items, "校验").some((i) => i.fn.key === "hashCalc")).toBe(true);
    expect(filterPalette(items, "整理").every((i) => i.fn.group === "整理")).toBe(true);
  });
  it("无命中返回空", () => {
    expect(filterPalette(items, "不存在的功能xyz")).toEqual([]);
  });
});

describe("paletteAvailable", () => {
  it("空白语境走 supportsBlank，entryVisible blank 恒过", () => {
    expect(paletteAvailable(builtinByKey("exportList")!, [])).toBe(true);
    expect(paletteAvailable(builtinByKey("open")!, [])).toBe(false);
  });
  it("maxCount 条件拦截多选", () => {
    const props = builtinByKey("properties")!;
    expect(paletteAvailable(props, [fe("a.txt", false)])).toBe(true);
    expect(paletteAvailable(props, [fe("a.txt", false), fe("b.txt", false)])).toBe(false);
  });
});

describe("clampPalettePos", () => {
  it("视口内原样落下", () => {
    expect(clampPalettePos(100, 100, 440, 356, 1920, 1080)).toEqual({ x: 100, y: 100 });
  });
  it("右溢出回推到边距内", () => {
    expect(clampPalettePos(1900, 100, 440, 356, 1920, 1080)).toEqual({ x: 1472, y: 100 });
  });
  it("下溢出上移到底边距内", () => {
    expect(clampPalettePos(100, 900, 440, 356, 1920, 1080)).toEqual({ x: 100, y: 716 });
  });
  it("极小视口钳在边距处不越界", () => {
    const p = clampPalettePos(-50, -50, 440, 356, 300, 200);
    expect(p.x).toBe(8);
    expect(p.y).toBe(8);
  });
});
