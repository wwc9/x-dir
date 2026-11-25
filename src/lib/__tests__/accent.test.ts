import { describe, expect, it } from "vitest";

import { ACCENT_PRESETS, DEFAULT_ACCENT_ID, resolveAccent } from "../accent";

describe("强调色预设（lib/accent，2026-11-25）", () => {
  it("default 取值与 index.css 回退链字面量逐字一致（防漂移）", () => {
    const d = resolveAccent(DEFAULT_ACCENT_ID);
    // index.css: --np-accent: var(--np-accent-user, #3574f0) / var(--np-accent-user-dark, #5c9dff)
    expect(d.light).toBe("#3574f0");
    expect(d.dark).toBe("#5c9dff");
    expect(d.id).toBe("default");
  });

  it("id 唯一且 default 恒在首位；未知 id 回落 default", () => {
    const ids = ACCENT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ACCENT_PRESETS[0]?.id).toBe("default");
    expect(resolveAccent("nope")).toBe(ACCENT_PRESETS[0]);
    expect(resolveAccent("purple")?.light).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("每套预设浅/深成对且为 6 位 hex（深色档偏亮由设计保证，格式在此锁定）", () => {
    for (const p of ACCENT_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.light).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(p.dark).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
