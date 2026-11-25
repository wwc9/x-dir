import { describe, expect, it } from "vitest";

import { etaSeconds, etaText } from "../jobsEta";

describe("长任务 ETA（etaSeconds / etaText，2026-11-25）", () => {
  const start = 1_000_000;
  const at = (sec: number) => start + sec * 1000;

  it("比例外推：elapsed × (1-f) / f，向上取整到整秒", () => {
    // 100s 走了 50% → 剩 100s
    expect(etaSeconds(start, 0.5, "running", at(100))).toBe(100);
    // 60s 走了 20% → 240s
    expect(etaSeconds(start, 0.2, "running", at(60))).toBe(240);
    // 小数向上取整：40s 走 25% → 120s
    expect(etaSeconds(start, 0.25, "running", at(40))).toBe(120);
    // 39.9s 样本 → ceil(119.7)=120
    expect(etaSeconds(start, 0.25, "running", at(39.9))).toBe(120);
  });

  it("不可估算返回 null：非 running / f 过小或完成 / 样本 <2s / 非有限", () => {
    expect(etaSeconds(start, 0.5, "queued", at(100))).toBeNull();
    expect(etaSeconds(start, 0.5, "paused", at(100))).toBeNull();
    expect(etaSeconds(start, 0.02, "running", at(100))).toBeNull();
    expect(etaSeconds(start, 0.01, "running", at(100))).toBeNull();
    expect(etaSeconds(start, 1, "running", at(100))).toBeNull();
    expect(etaSeconds(start, 0.5, "running", at(1.5))).toBeNull();
    expect(etaSeconds(start, null, "running", at(100))).toBeNull();
  });

  it("etaText：< 60s 秒、≥ 60s 分钟向上取整", () => {
    expect(etaText(1)).toBe("约 1 秒");
    expect(etaText(59)).toBe("约 59 秒");
    expect(etaText(60)).toBe("约 1 分钟");
    expect(etaText(61)).toBe("约 2 分钟");
    expect(etaText(240)).toBe("约 4 分钟");
  });
});
