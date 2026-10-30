import { describe, expect, it } from "vitest";

import { captureHotkey, type HotkeyEventLike } from "../hotkey";

/** 快捷构造：默认无修饰键 */
const ev = (key: string, mods: Partial<HotkeyEventLike> = {}): HotkeyEventLike => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("captureHotkey 全局热键录制判定", () => {
  it("完整组合产出热键串", () => {
    expect(captureHotkey(ev("a", { ctrlKey: true, altKey: true }))).toEqual({
      state: "ok",
      combo: "Ctrl+Alt+A",
    });
    expect(captureHotkey(ev("S", { ctrlKey: true, shiftKey: true }))).toEqual({
      state: "ok",
      combo: "Ctrl+Shift+S",
    });
  });

  it("修饰键序固定为 Ctrl+Alt+Shift（与按键时序无关）", () => {
    expect(captureHotkey(ev("k", { altKey: true, ctrlKey: true, shiftKey: true }))).toEqual({
      state: "ok",
      combo: "Ctrl+Alt+Shift+K",
    });
  });

  it("数字与标点主键", () => {
    expect(captureHotkey(ev("1", { ctrlKey: true }))).toEqual({ state: "ok", combo: "Ctrl+1" });
    expect(captureHotkey(ev(".", { altKey: true }))).toEqual({ state: "ok", combo: "Alt+." });
  });

  it("F1-F12 可不带修饰键（全局热键惯例）", () => {
    expect(captureHotkey(ev("F7"))).toEqual({ state: "ok", combo: "F7" });
    expect(captureHotkey(ev("F12", { shiftKey: true }))).toEqual({
      state: "ok",
      combo: "Shift+F12",
    });
  });

  it("方向键/空格/回车/Tab 映射为解析名", () => {
    expect(captureHotkey(ev("ArrowUp", { ctrlKey: true }))).toEqual({
      state: "ok",
      combo: "Ctrl+Up",
    });
    expect(captureHotkey(ev(" ", { ctrlKey: true }))).toEqual({
      state: "ok",
      combo: "Ctrl+Space",
    });
    expect(captureHotkey(ev("Enter", { altKey: true }))).toEqual({
      state: "ok",
      combo: "Alt+Enter",
    });
    expect(captureHotkey(ev("Tab", { ctrlKey: true }))).toEqual({
      state: "ok",
      combo: "Ctrl+Tab",
    });
  });

  it("纯修饰键与组合键中间态保持等待", () => {
    expect(captureHotkey(ev("Shift"))).toEqual({ state: "pending" });
    expect(captureHotkey(ev("Control"))).toEqual({ state: "pending" });
    expect(captureHotkey(ev("Alt"))).toEqual({ state: "pending" });
    expect(captureHotkey(ev("Meta"))).toEqual({ state: "pending" });
    expect(captureHotkey(ev("Dead"))).toEqual({ state: "pending" });
  });

  it("裸字母/数字/标点拒绝（会吞全局输入）", () => {
    const r = captureHotkey(ev("a"));
    expect(r.state).toBe("invalid");
    if (r.state === "invalid") expect(r.reason).toContain("修饰键");
    expect(captureHotkey(ev("5")).state).toBe("invalid");
    expect(captureHotkey(ev("/")).state).toBe("invalid");
  });

  it("crate 不支持的按键拒绝（F13+ / 功能杂键）", () => {
    expect(captureHotkey(ev("F13")).state).toBe("invalid");
    expect(captureHotkey(ev("AudioVolumeDown")).state).toBe("invalid");
    expect(captureHotkey(ev("CapsLock")).state).toBe("invalid");
  });
});
