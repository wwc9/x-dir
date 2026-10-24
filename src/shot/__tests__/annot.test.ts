// 截图标注纯函数测试（§3.6）：选区归一/调整、手柄命中、箭头头部、窗口命中。
import { describe, expect, it } from "vitest";

import {
  arrowHead,
  handleAt,
  hitWindow,
  normalizeSel,
  resizeSel,
  selHandles,
} from "../annot";

describe("normalizeSel", () => {
  it("负向拖拽翻正为包围盒", () => {
    expect(normalizeSel(100, 80, 40, 30, 1920, 1080)).toEqual({
      x: 40,
      y: 30,
      w: 60,
      h: 50,
    });
  });

  it("钳制到屏幕边界内", () => {
    expect(normalizeSel(-10, -10, 50, 50, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
      w: 50,
      h: 50,
    });
    expect(normalizeSel(1900, 1070, 2000, 1200, 1920, 1080)).toEqual({
      x: 1900,
      y: 1070,
      w: 20,
      h: 10,
    });
  });

  it("小于最小尺寸视为点击返回 null", () => {
    expect(normalizeSel(10, 10, 12, 12, 1920, 1080)).toBeNull();
  });
});

describe("handleAt / resizeSel", () => {
  const sel = { x: 100, y: 100, w: 200, h: 100 };

  it("8 手柄位置与命中", () => {
    expect(selHandles(sel)).toHaveLength(8);
    expect(handleAt(sel, 100, 100)).toBe("nw");
    expect(handleAt(sel, 300, 200)).toBe("se");
    expect(handleAt(sel, 200, 100)).toBe("n");
    expect(handleAt(sel, 150, 150)).toBeNull(); // 选区中心不是手柄
  });

  it("拖角手柄调整并钳制", () => {
    expect(resizeSel(sel, "se", 400, 300, 1920, 1080)).toEqual({
      x: 100,
      y: 100,
      w: 300,
      h: 200,
    });
    // 拖出屏幕右缘：钳制不越界
    const r = resizeSel(sel, "se", 3000, 300, 1920, 1080);
    expect(r.x + r.w).toBeLessThanOrEqual(1920);
    // 拖 nw 到对角另一侧：保持 ≥8 且翻正
    const r2 = resizeSel(sel, "nw", 50, 180, 1920, 1080);
    expect(r2.x).toBe(50);
    expect(r2.h).toBeGreaterThanOrEqual(8);
  });
});

describe("arrowHead", () => {
  it("水平箭头两翼对称", () => {
    const h = arrowHead(0, 0, 100, 0, 20);
    expect(h).not.toBeNull();
    expect(h!.ay).toBeCloseTo(-h!.by, 5);
    expect(h!.ax).toBeLessThan(100);
    expect(h!.bx).toBeLessThan(100);
  });

  it("零长度线段返回 null", () => {
    expect(arrowHead(5, 5, 5, 5, 10)).toBeNull();
  });
});

describe("hitWindow", () => {
  const wins = [
    { x: 0, y: 0, w: 1920, h: 1080 },
    { x: 100, y: 100, w: 400, h: 300 },
  ];

  it("命中内层小窗（面积最小者优先）", () => {
    expect(hitWindow(wins, 150, 150)).toEqual(wins[1]);
    expect(hitWindow(wins, 50, 50)).toEqual(wins[0]);
  });

  it("未命中返回 null", () => {
    expect(hitWindow([], 10, 10)).toBeNull();
  });
});
