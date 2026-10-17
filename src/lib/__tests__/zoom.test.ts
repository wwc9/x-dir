import { describe, expect, it } from "vitest";

import { zoomClamp, zoomStep } from "../zoom";

describe("zoomStep（界面缩放步进）", () => {
  it("档位间步进", () => {
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
    expect(zoomStep(1.25, 1)).toBe(1.5);
    expect(zoomStep(0.67, -1)).toBe(0.5);
  });

  it("边界保持不变", () => {
    expect(zoomStep(3, 1)).toBe(3);
    expect(zoomStep(0.5, -1)).toBe(0.5);
  });

  it("非档位现值（旧配置）向相邻档靠拢", () => {
    expect(zoomStep(1.05, 1)).toBe(1.1);
    expect(zoomStep(1.05, -1)).toBe(1);
    expect(zoomStep(1.4, 1)).toBe(1.5);
  });
});

describe("zoomClamp（缩放钳制）", () => {
  it("钳到 0.5~3 区间", () => {
    expect(zoomClamp(0.2)).toBe(0.5);
    expect(zoomClamp(1)).toBe(1);
    expect(zoomClamp(9)).toBe(3);
  });
});
