import { describe, expect, it } from "vitest";

import { treemap } from "../treemap";

describe("矩形树图布局（treemap，2026-11-09 空间分析 WizTree 式改版）", () => {
  it("边角输入：空表/非正尺寸/全零尺寸 → 空布局", () => {
    expect(treemap([], 400, 300)).toEqual([]);
    expect(treemap([{ key: "a", size: 10 }], 0, 300)).toEqual([]);
    expect(treemap([{ key: "a", size: 10 }], 400, 0)).toEqual([]);
    expect(
      treemap(
        [
          { key: "a", size: 0 },
          { key: "b", size: -5 },
        ],
        400,
        300,
      ),
    ).toEqual([]);
  });

  it("单项铺满全图", () => {
    const [r] = treemap([{ key: "a", size: 7 }], 400, 300);
    expect(r.key).toBe("a");
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.w).toBeCloseTo(400, 6);
    expect(r.h).toBeCloseTo(300, 6);
  });

  it("两项均分：沿长边对半（400×300 → 左右各 200×300）", () => {
    const rs = treemap(
      [
        { key: "a", size: 1 },
        { key: "b", size: 1 },
      ],
      400,
      300,
    );
    expect(rs).toHaveLength(2);
    const a = rs.find((r) => r.key === "a")!;
    const b = rs.find((r) => r.key === "b")!;
    expect(a.x).toBe(0);
    expect(b.x).toBeCloseTo(200, 5);
    expect(a.w).toBeCloseTo(200, 5);
    expect(a.h).toBeCloseTo(300, 5);
    expect(b.w).toBeCloseTo(200, 5);
  });

  it("面积守恒与在界：混合体积全部落图、不越容器、面积和 ≈ 容器面积", () => {
    const items = [
      { key: "big", size: 900 },
      { key: "mid", size: 300 },
      { key: "s1", size: 120 },
      { key: "s2", size: 60 },
      { key: "s3", size: 40 },
      { key: "tiny", size: 5 },
    ].sort(() => Math.random() - 0.5); // 输入乱序 → 函数内排序归位
    const W = 640;
    const H = 360;
    const rs = treemap(items, W, H);
    expect(rs).toHaveLength(items.length);
    const areaSum = rs.reduce((s, r) => s + r.w * r.h, 0);
    expect(areaSum).toBeCloseTo(W * H, -1); // 容差 10（浮点钳制）
    for (const r of rs) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(W + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(H + 1e-6);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
    // 面积 ∝ 体积：最大项面积 ≈ 最大项理论占比
    const big = rs.find((r) => r.key === "big")!;
    expect(big.w * big.h).toBeCloseTo((900 / 1425) * W * H, -1);
  });

  it("0 字节项不出色块（列表侧承载），有效项照常布局", () => {
    const rs = treemap(
      [
        { key: "a", size: 100 },
        { key: "zero", size: 0 },
        { key: "b", size: 50 },
      ],
      400,
      300,
    );
    expect(rs.map((r) => r.key).sort()).toEqual(["a", "b"]);
  });
});

