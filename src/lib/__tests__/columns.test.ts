import { describe, expect, it } from "vitest";

import {
  COL_DEFAULTS,
  COL_LAYOUT,
  COL_MAX,
  COL_MIN,
  GS_COL_DEFAULTS,
  GS_PV_DEFAULT,
  GS_PV_MAX,
  GS_PV_MIN,
  clampColWidth,
  clampGsColWidth,
  clampGsPreviewW,
  detailsContentWidth,
  sanitizeColWidths,
  sanitizeGsColWidths,
  visibleColWidths,
} from "../columns";

describe("clampColWidth", () => {
  it("区间内保持取整原值", () => {
    expect(clampColWidth(130.4, "mtime")).toBe(130);
    expect(clampColWidth(200, "type")).toBe(200);
  });

  it("越界钳制到上下限", () => {
    expect(clampColWidth(10, "size")).toBe(COL_MIN);
    expect(clampColWidth(9999, "loc")).toBe(COL_MAX);
  });

  it("非法值落到该列默认宽", () => {
    expect(clampColWidth(Number.NaN, "mtime")).toBe(COL_DEFAULTS.mtime);
    expect(clampColWidth(Number.POSITIVE_INFINITY, "size")).toBe(COL_DEFAULTS.size);
  });
});

describe("sanitizeColWidths", () => {
  it("合法对象按列钳制保留", () => {
    expect(
      sanitizeColWidths({ name: 300, mtime: 160, type: 999, size: 3, loc: 200 }),
    ).toEqual({
      name: 300,
      mtime: 160,
      type: COL_MAX,
      size: COL_MIN,
      loc: 200,
    });
  });

  it("旧档缺 name 键时补默认宽（列宽体系加入名称列的存量兼容）", () => {
    expect(sanitizeColWidths({ mtime: 160 })).toEqual({
      ...COL_DEFAULTS,
      mtime: 160,
    });
  });

  it("缺省键 / 未知键 / 非对象输入补默认值", () => {
    expect(sanitizeColWidths({ mtime: 150, unknown: 1 })).toEqual({ ...COL_DEFAULTS, mtime: 150 });
    expect(sanitizeColWidths("garbage")).toEqual(COL_DEFAULTS);
    expect(sanitizeColWidths(null)).toEqual(COL_DEFAULTS);
    expect(sanitizeColWidths({ mtime: "x", type: NaN })).toEqual({
      ...COL_DEFAULTS,
      type: COL_DEFAULTS.type,
    });
  });
});

describe("clampGsColWidth", () => {
  it("区间内保持取整原值", () => {
    expect(clampGsColWidth(216.6, "loc")).toBe(217);
    expect(clampGsColWidth(120, "name")).toBe(120);
  });

  it("越界钳制到上下限", () => {
    expect(clampGsColWidth(3, "size")).toBe(COL_MIN);
    expect(clampGsColWidth(9999, "type")).toBe(COL_MAX);
  });

  it("非法值落到该列默认宽", () => {
    expect(clampGsColWidth(Number.NaN, "name")).toBe(GS_COL_DEFAULTS.name);
    expect(clampGsColWidth(Number.NEGATIVE_INFINITY, "loc")).toBe(GS_COL_DEFAULTS.loc);
  });
});

describe("sanitizeGsColWidths", () => {
  it("合法对象按列钳制保留，缺省键补默认", () => {
    // 旧档无 mtime：sanitize 补默认值
    expect(sanitizeGsColWidths({ name: 260, loc: 999, size: 1, type: 90 })).toEqual({
      name: 260,
      loc: COL_MAX,
      size: COL_MIN,
      type: 90,
      mtime: GS_COL_DEFAULTS.mtime,
    });
  });

  it("缺省键 / 未知键 / 非对象输入补默认值", () => {
    expect(sanitizeGsColWidths({ loc: 300, junk: true })).toEqual({
      ...GS_COL_DEFAULTS,
      loc: 300,
    });
    expect(sanitizeGsColWidths("garbage")).toEqual(GS_COL_DEFAULTS);
    expect(sanitizeGsColWidths(undefined)).toEqual(GS_COL_DEFAULTS);
    expect(sanitizeGsColWidths({ name: "x" })).toEqual(GS_COL_DEFAULTS);
  });
});

describe("visibleColWidths / detailsContentWidth（详情视图自然宽）", () => {
  it("宽窗格：四列全可见，自然宽 = 左衬+图标+列宽和+沟槽+右衬", () => {
    const c = COL_DEFAULTS;
    expect(visibleColWidths(600, c, "normal")).toEqual([c.name, c.mtime, c.type, c.size]);
    // 14 + 16 + 4×7 + (240+130+110+80) + 24
    expect(detailsContentWidth(600, c, "normal")).toBe(642);
  });

  it("阈值镜像 index.css 逐级隐藏列：480/380/300 三档", () => {
    const c = COL_DEFAULTS;
    // <480：type/搜索位置列隐藏
    expect(visibleColWidths(479, c, "normal")).toEqual([c.name, c.mtime, c.size]);
    expect(visibleColWidths(479, c, "search")).toEqual([c.name, c.size]);
    // <380：mtime 隐藏；<300：size 隐藏
    expect(visibleColWidths(379, c, "normal")).toEqual([c.name, c.size]);
    expect(visibleColWidths(299, c, "normal")).toEqual([c.name]);
  });

  it("搜索模式第二列为位置列，此电脑模式 size 计双列", () => {
    const c = COL_DEFAULTS;
    expect(visibleColWidths(600, c, "search")).toEqual([c.name, c.loc, c.type, c.size]);
    expect(detailsContentWidth(600, c, "search")).toBe(
      COL_LAYOUT.insetL + COL_LAYOUT.icon + COL_LAYOUT.gap * 4 + c.name + c.loc + c.type + c.size + COL_LAYOUT.insetR,
    );
    expect(visibleColWidths(600, c, "thispc")).toEqual([c.name, c.type, c.size, c.size]);
  });

  it("拖宽任一列只增大该列贡献，其余列贡献不变（列宽互不影响）", () => {
    const c = { ...COL_DEFAULTS };
    const before = detailsContentWidth(600, c, "normal");
    c.mtime += 100;
    expect(detailsContentWidth(600, c, "normal")).toBe(before + 100);
  });

  it("全盘搜索列组：名称/位置/大小/类型恒显，修改时间 <660 隐藏", () => {
    const c = COL_DEFAULTS;
    expect(visibleColWidths(479, c, "gsearch")).toEqual([c.name, c.loc, c.type, c.size]);
    expect(visibleColWidths(299, c, "gsearch")).toEqual([c.name, c.loc, c.type, c.size]);
    // ≥660（如 720 弹窗无预览）mtime 显示；647（1100 弹窗 + 预览）隐藏
    expect(visibleColWidths(670, c, "gsearch")).toEqual([
      c.name, c.loc, c.type, c.size, c.mtime,
    ]);
    expect(visibleColWidths(647, c, "gsearch")).toEqual([c.name, c.loc, c.type, c.size]);
    expect(detailsContentWidth(479, c, "gsearch")).toBe(
      COL_LAYOUT.insetL + COL_LAYOUT.icon + COL_LAYOUT.gap * 4 + c.name + c.loc + c.type + c.size + COL_LAYOUT.insetR,
    );
  });

  it("全盘搜索默认列宽自然宽落在弹窗内容宽内（默认不出横滚）", () => {
    // 720 - 弹窗内边距 32 - 列表侧距 8 - 滚动条槽 10 = 内容可用宽 670；
    // 无预览面板 = 670 ≥ 660，mtime 显示；开预览面板 ~647，mtime 隐藏
    const withMtime = detailsContentWidth(670, GS_COL_DEFAULTS, "gsearch");
    expect(withMtime).toBeLessThanOrEqual(670);
    const noMtime = detailsContentWidth(647, GS_COL_DEFAULTS, "gsearch");
    expect(noMtime).toBeLessThanOrEqual(647);
  });
});

describe("clampGsPreviewW", () => {
  it("区间内保持取整原值", () => {
    expect(clampGsPreviewW(400.4)).toBe(400);
    expect(clampGsPreviewW(520)).toBe(520);
  });

  it("越界钳制到上下限", () => {
    expect(clampGsPreviewW(100)).toBe(GS_PV_MIN);
    expect(clampGsPreviewW(9999)).toBe(GS_PV_MAX);
  });

  it("非法值回落默认宽", () => {
    expect(clampGsPreviewW(Number.NaN)).toBe(GS_PV_DEFAULT);
    expect(clampGsPreviewW(Number.POSITIVE_INFINITY)).toBe(GS_PV_DEFAULT);
  });
});
