import { describe, expect, it } from "vitest";

import {
  pagesToSpec,
  parsePageSpec,
  pdfMenuState,
  pdfSplitParts,
  renderPdfSplitName,
} from "../pdfOps";

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

describe("页码范围解析（parsePageSpec，与 Rust parse_page_ranges 同口径）", () => {
  it("段间去重升序", () => {
    expect(parsePageSpec("3,1-2", 10).pages).toEqual([1, 2, 3]);
    expect(parsePageSpec("2,2，1", 5).pages).toEqual([1, 2]);
  });

  it("开区间到末页", () => {
    expect(parsePageSpec("5-", 6).pages).toEqual([5, 6]);
  });

  it("段内空格剔除", () => {
    expect(parsePageSpec(" 1 - 3 ", 5).pages).toEqual([1, 2, 3]);
  });

  it("空表达式 / 空段跳过后为空均报错", () => {
    expect(parsePageSpec("", 5).error).toBe("页码范围不能为空");
    expect(parsePageSpec(" , ，", 5).error).toBe("页码范围不能为空");
  });

  it("越界与非法页码报错（文案与 Rust 一致）", () => {
    expect(parsePageSpec("0", 5).error).toBe("页码超出范围（共 5 页）：0");
    expect(parsePageSpec("6", 5).error).toBe("页码超出范围（共 5 页）：6");
    expect(parsePageSpec("a", 5).error).toBe("页码无效：a");
    expect(parsePageSpec("1-x", 5).error).toBe("页码无效：x");
  });

  it("起始大于结束报错", () => {
    expect(parsePageSpec("3-1", 5).error).toBe("页码范围无效：3-1（起始大于结束）");
  });

  it("仅首个连字符为分隔（第二个连字符按页码报错，同 Rust split_once）", () => {
    expect(parsePageSpec("1-3-5", 10).error).toBe("页码无效：3-5");
  });
});

describe("页号集合 → 区间表达式（pagesToSpec）", () => {
  it("连续段折叠", () => {
    expect(pagesToSpec([1, 2, 3, 8, 9])).toBe("1-3,8-9");
    expect(pagesToSpec([4])).toBe("4");
    expect(pagesToSpec([])).toBe("");
  });

  it("乱序输入先排序", () => {
    expect(pagesToSpec([9, 1, 2, 3, 8])).toBe("1-3,8-9");
  });

  it("与 parsePageSpec 往返一致", () => {
    const spec = "1-3,5,8-";
    const r = parsePageSpec(spec, 10);
    expect(r.error).toBeUndefined();
    expect(parsePageSpec(pagesToSpec(r.pages), 10).pages).toEqual(r.pages);
  });
});

// ── PDF 拆分命名渲染（与 Rust pdf::render_split_name 同口径镜像）──
describe("renderPdfSplitName / pdfSplitParts", () => {
  it("默认规则：[原文件名]-[序号] + 自动补 .pdf", () => {
    expect(renderPdfSplitName("[原文件名]-[序号]", "测试", 2, 5, 6)).toBe("测试-2.pdf");
  });
  it("[页码] 起始-结束，单页只写一数字", () => {
    expect(renderPdfSplitName("[原文件名]-[页码]", "测试", 1, 1, 3)).toBe("测试-1-3.pdf");
    expect(renderPdfSplitName("[原文件名]-[页码]", "测试", 3, 3, 3)).toBe("测试-3.pdf");
  });
  it("已带 .pdf 后缀不双补；未知占位符原样保留", () => {
    expect(renderPdfSplitName("清单.pdf", "x", 1, 1, 1)).toBe("清单.pdf");
    expect(renderPdfSplitName("报告 [序号] 号", "x", 2, 1, 1)).toBe("报告 2 号.pdf");
  });
  it("pdfSplitParts = ceil(total / nPages)", () => {
    expect(pdfSplitParts(7, 3)).toBe(3);
    expect(pdfSplitParts(4, 1)).toBe(4);
    expect(pdfSplitParts(3, 10)).toBe(1);
  });
});
