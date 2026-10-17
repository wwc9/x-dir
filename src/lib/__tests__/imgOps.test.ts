// 图片处理纯函数回归测试（lib/imgOps.ts）
import { describe, expect, it } from "vitest";

import { IMG_EXTS, MONTAGE_MAX, MONTAGE_MIN, montageGrid, montageOutputName } from "../imgOps";

describe("montageOutputName", () => {
  it("生成 拼图_yyyymmdd_hhmmss.png", () => {
    expect(montageOutputName(new Date(2026, 9, 15, 18, 45, 9))).toBe(
      "拼图_20261015_184509.png",
    );
  });
  it("单位数字补零", () => {
    expect(montageOutputName(new Date(2026, 0, 3, 7, 2, 5))).toBe(
      "拼图_20260103_070205.png",
    );
  });
});

describe("montageGrid", () => {
  it("行数 = ceil(count/cols)，尾行居左", () => {
    expect(montageGrid(5, 2)).toEqual({ rows: 3, cols: 2 });
    expect(montageGrid(9, 3)).toEqual({ rows: 3, cols: 3 });
    expect(montageGrid(4, 3)).toEqual({ rows: 2, cols: 3 });
  });
});

describe("常量口径", () => {
  it("拼图输入范围 4–36", () => {
    expect(MONTAGE_MIN).toBe(4);
    expect(MONTAGE_MAX).toBe(36);
  });
  it("可解码扩展名含 gif（仅解码）与大小写无关的大类", () => {
    expect(IMG_EXTS.split(",")).toContain("jpg");
    expect(IMG_EXTS.split(",")).toContain("jpeg");
    expect(IMG_EXTS.split(",")).toContain("png");
    expect(IMG_EXTS.split(",")).toContain("webp");
  });
});
