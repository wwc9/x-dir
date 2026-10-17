import { describe, expect, it } from "vitest";

import type { FileEntry } from "../ipc";
import {
  EMPTY_STREAM,
  applyBatch,
  composeTypeFilterQuery,
  GSEARCH_TYPE_PRESETS,
  highlightParts,
  naturalCompare,
  nextGlobalSearchReq,
  nextPaneSearchReq,
  pinyinHighlightRange,
  pushSearchHistory,
  sortResults,
} from "../searchStream";

function entry(partial: Partial<FileEntry>): FileEntry {
  return {
    name: "a.txt",
    path: "C:\\a.txt",
    isDir: false,
    size: 1,
    mtimeMs: 1000,
    ctimeMs: 0,
    attrs: { hidden: false, system: false, readonly: false },
    py: null,
    ...partial,
  };
}

describe("reqId", () => {
  it("每次取号唯一递增", () => {
    const a = nextGlobalSearchReq();
    const b = nextPaneSearchReq("pane-a");
    const c = nextPaneSearchReq("pane-a");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("applyBatch", () => {
  const mk = (reqId: number, names: string[], scanned: number) => ({
    reqId,
    entries: names.map((n) => entry({ name: n, path: `C:\\${n}` })),
    scanned,
  });

  it("累积归属当前请求的批次并更新 scanned", () => {
    let st = EMPTY_STREAM;
    st = applyBatch(st, mk(3, ["a", "b"], 100), 3);
    st = applyBatch(st, mk(3, ["c"], 150), 3);
    expect(st.entries.map((e) => e.name)).toEqual(["a", "b", "c"]);
    expect(st.scanned).toBe(150);
  });

  it("丢弃过期请求批次（不污染本窗格流）", () => {
    let st = EMPTY_STREAM;
    st = applyBatch(st, mk(3, ["a"], 10), 3);
    st = applyBatch(st, mk(9, ["x"], 999), 3);
    expect(st.entries.map((e) => e.name)).toEqual(["a"]);
    expect(st.scanned).toBe(10);
    // 无活跃请求时全部丢弃
    expect(applyBatch(st, mk(3, ["y"], 1), null).entries).toHaveLength(1);
  });
});

describe("naturalCompare", () => {
  it("数字按值比较", () => {
    expect(naturalCompare("a2", "a10")).toBeLessThan(0);
    expect(naturalCompare("a10", "a2")).toBeGreaterThan(0);
    expect(naturalCompare("A2", "a2")).toBe(0);
  });
  it("多段数字", () => {
    expect(naturalCompare("v1.2", "v1.10")).toBeLessThan(0);
    expect(naturalCompare("2026-1-2", "2026-1-10")).toBeLessThan(0);
  });
});

describe("sortResults", () => {
  const files = [
    entry({ name: "b10.txt", path: "C:\\z\\b10.txt", mtimeMs: 300 }),
    entry({ name: "b2.txt", path: "C:\\a\\b2.txt", mtimeMs: 100 }),
    entry({ name: "目录", path: "C:\\dir", isDir: true, mtimeMs: 50 }),
  ];
  it("名称自然序 + 文件夹恒在前", () => {
    const out = sortResults(files, "name");
    expect(out[0].isDir).toBe(true);
    expect(out.slice(1).map((e) => e.name)).toEqual(["b2.txt", "b10.txt"]);
  });
  it("路径序", () => {
    const out = sortResults(files.filter((f) => !f.isDir), "path");
    expect(out.map((e) => e.name)).toEqual(["b2.txt", "b10.txt"]);
  });
  it("时间序", () => {
    const out = sortResults(files.filter((f) => !f.isDir), "mtime");
    expect(out.map((e) => e.mtimeMs)).toEqual([100, 300]);
  });
  it("大小序", () => {
    const files = [
      entry({ name: "big.bin", size: 900 }),
      entry({ name: "small.bin", size: 2 }),
    ];
    const out = sortResults(files, "size");
    expect(out.map((e) => e.name)).toEqual(["small.bin", "big.bin"]);
  });
  it("desc 反向；文件夹仍恒在前", () => {
    const files = [
      entry({ name: "b.txt", size: 10 }),
      entry({ name: "a.txt", size: 20 }),
      entry({ name: "目录", isDir: true, size: 1 }),
    ];
    const out = sortResults(files, "size", "desc");
    expect(out.map((e) => e.name)).toEqual(["目录", "a.txt", "b.txt"]);
  });
});

describe("highlightParts", () => {
  it("命中段与非命中段交替", () => {
    expect(highlightParts("2026年度报表.xlsx", "报表")).toEqual([
      { text: "2026年度", hit: false },
      { text: "报表", hit: true },
      { text: ".xlsx", hit: false },
    ]);
  });
  it("多词都高亮；大小写不敏感", () => {
    const parts = highlightParts("Report-2026.txt", "report 2026");
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["Report", "2026"]);
  });
  it("通配符/路径词跳过（不高亮）", () => {
    expect(highlightParts("a.txt", "*.txt")).toEqual([{ text: "a.txt", hit: false }]);
  });
  it("排除词与属性过滤词跳过；引号短语剥壳后高亮", () => {
    expect(highlightParts("报表-旧.xlsx", "报表 !旧")).toEqual([
      { text: "报表", hit: true },
      { text: "-旧.xlsx", hit: false },
    ]);
    expect(highlightParts("报告.pdf", "报告 dm:today size:>1mb")).toEqual([
      { text: "报告", hit: true },
      { text: ".pdf", hit: false },
    ]);
    expect(highlightParts("报表 2026版.docx", '"报表 2026"')).toEqual([
      { text: "报表 2026", hit: true },
      { text: "版.docx", hit: false },
    ]);
  });
  it("拼音首字母词标记对应汉字（py 命中）", () => {
    // 全串命中：wwc ↔ 王文铖
    expect(highlightParts("13489_王文铖", "wwc", "13489_wwc")).toEqual([
      { text: "13489_", hit: false },
      { text: "王文铖", hit: true },
    ]);
    // 部分命中：wc = 文铖（py 第 2~3 位）
    expect(highlightParts("13489_王文铖", "wc", "13489_wwc")).toEqual([
      { text: "13489_王", hit: false },
      { text: "文铖", hit: true },
    ]);
    // 混排：ascii 前缀 py 透传，词命中汉字段
    expect(highlightParts("forge请下这个txt文件", "qxz", "forgeqxzgtxtwj")).toEqual([
      { text: "forge", hit: false },
      { text: "请下这", hit: true },
      { text: "个txt文件", hit: false },
    ]);
    // 词已字面命中（13749 等）不再走拼音通道；py 不含该词也不额外标记
    expect(highlightParts("王文铖", "文", "wwc")).toEqual([
      { text: "王", hit: false },
      { text: "文", hit: true },
      { text: "铖", hit: false },
    ]);
    expect(highlightParts("13489_王文铖", "wwc", null)).toEqual([
      { text: "13489_王文铖", hit: false },
    ]);
  });

  describe("pinyinHighlightRange", () => {
    it("返回 py 命中对应的名称字符区间", () => {
      expect(pinyinHighlightRange("13489_王文铖", "13489_wwc", "wwc")).toEqual([6, 9]);
      expect(pinyinHighlightRange("王文铖", "wwc", "wc")).toEqual([1, 3]);
      expect(pinyinHighlightRange("王文铖", "wwc", "zz")).toBeNull();
      expect(pinyinHighlightRange("王文铖", "", "wwc")).toBeNull();
    });
  });
  it("无命中返回整段原文", () => {
    expect(highlightParts("abc", "xyz")).toEqual([{ text: "abc", hit: false }]);
  });
});

describe("pushSearchHistory", () => {
  it("去重置顶", () => {
    expect(pushSearchHistory(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(pushSearchHistory(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });
  it("空查询不记录；上限截断", () => {
    expect(pushSearchHistory(["a"], "  ")).toEqual(["a"]);
    const full = Array.from({ length: 20 }, (_, i) => `q${i}`);
    expect(pushSearchHistory(full, "new")).toHaveLength(20);
    expect(pushSearchHistory(full, "new")[0]).toBe("new");
  });
});

describe("composeTypeFilterQuery", () => {
  it("预设追加 ext: 属性词；any 原样返回", () => {
    expect(composeTypeFilterQuery("报表", "docs")).toBe(
      `报表 ext:${GSEARCH_TYPE_PRESETS.find((p) => p.key === "docs")?.exts}`,
    );
    expect(composeTypeFilterQuery("报表", "any")).toBe("报表");
  });
  it("用户自带查询词保留（预设词与用户词 AND 叠加）", () => {
    const q = composeTypeFilterQuery("发票 ext:pdf", "images");
    expect(q.startsWith("发票 ext:pdf ext:")).toBe(true);
  });
  it("预设表结构：key 唯一且 any 无扩展名表", () => {
    const keys = GSEARCH_TYPE_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(GSEARCH_TYPE_PRESETS[0].exts).toBe("");
  });
});
