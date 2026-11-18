// 性能模式判定纯函数回归（2026-11-17 性能 tab 定案）：远程会话一票低配 /
// 硬件信号命中 ≥2 / 仅核显与独显关键词识别 / 模式解析 / 两档预设形状
import { describe, expect, it } from "vitest";

import {
  detectTier,
  integratedOnly,
  PERF_PRESET,
  resolvePerf,
} from "../perf";

const info = (patch: {
  cpuThreads?: number;
  memoryGb?: number;
  gpus?: string[];
}) => ({
  cpuThreads: 16,
  memoryGb: 32,
  gpus: ["NVIDIA GeForce RTX 5070 Ti"],
  ...patch,
});

describe("detectTier（硬件档位判定）", () => {
  it("远程会话一票低配（不看硬件）", () => {
    expect(detectTier(info({}), true)).toBe("low");
  });

  it("强机 = 高配（无线程/内存/核显命中）", () => {
    expect(detectTier(info({}), false)).toBe("high");
  });

  it("命中 ≥2 条 = 低配：线程 2 + 内存 8G（核显）", () => {
    const r = detectTier(
      info({ cpuThreads: 2, memoryGb: 8, gpus: ["Intel(R) UHD Graphics 770"] }),
      false,
    );
    expect(r).toBe("low");
  });

  it("命中 1 条 = 高配：仅线程少但独显大内存", () => {
    const r = detectTier(info({ cpuThreads: 2 }), false);
    expect(r).toBe("high");
  });

  it("cpuThreads 0（不可得）不参与计数；内存 0 同理", () => {
    const r = detectTier(
      info({ cpuThreads: 0, memoryGb: 0, gpus: ["Intel(R) UHD Graphics"] }),
      false,
    );
    // 仅核显 1 条命中 → 高配
    expect(r).toBe("high");
  });
});

describe("integratedOnly（核显识别）", () => {
  it("独显关键词命中 = 非仅核显", () => {
    expect(integratedOnly(["NVIDIA GeForce RTX 5070 Ti"])).toBe(false);
    expect(integratedOnly(["AMD Radeon RX 7900"])).toBe(false);
    expect(integratedOnly(["Intel(R) Arc(TM) Graphics"])).toBe(false);
  });
  it("核显 / 空表（软件渲染已滤）= 仅核显", () => {
    expect(integratedOnly(["Intel(R) UHD Graphics 770"])).toBe(true);
    expect(integratedOnly(["AMD Radeon(TM) Graphics"])).toBe(true);
    expect(integratedOnly([])).toBe(true);
  });
});

describe("resolvePerf 与两档预设", () => {
  it("auto 取判定档，显式档直通", () => {
    expect(resolvePerf("auto", "low")).toBe("low");
    expect(resolvePerf("high", "low")).toBe("high");
    expect(resolvePerf("low", "high")).toBe("low");
  });
  it("预设联动项：高性能全开，低配全关；窗口毛玻璃两档对称切换（2026-11-18 用户定案）", () => {
    const highKeys = Object.keys(PERF_PRESET.high);
    for (const k of highKeys) {
      const key = k as keyof typeof PERF_PRESET.high;
      // windowGlass 为三值字段（"on"/"off"）：高性能开、低配关
      if (key === "windowGlass") {
        expect(PERF_PRESET.high.windowGlass).toBe("on");
        expect(PERF_PRESET.low.windowGlass).toBe("off");
        continue;
      }
      expect(PERF_PRESET.high[key]).toBe(true);
      expect(PERF_PRESET.low[key]).toBe(false);
    }
    // 窗口毛玻璃：低配强制关（系统合成器开销）；高性能开——档位点击切换相应设置项
    expect(PERF_PRESET.high.windowGlass).toBe("on");
    expect(PERF_PRESET.low.windowGlass).toBe("off");
  });
});
