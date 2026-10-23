// 设置守卫回归（2026-10-22）：load 完成前的 update 仅内存生效、不写盘——
// 防启动早期的默认态（menuEntries/toolbarEntries 空数组）覆盖用户方案，
// 即"重启后菜单/工具栏方案丢失"的根因。vi.mock 拦截 saveSettings 记录写盘次数
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveSettings = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../../lib/ipc", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...orig,
    DEFAULT_SETTINGS: orig.DEFAULT_SETTINGS,
    api: { ...orig.api, saveSettings, getSettings: () => Promise.resolve(null) },
  };
});

import { useSettings } from "../../stores/settings";

// migrateLegacyPrefs 触碰 localStorage：node 环境补桩
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});
// load() 末尾 applyTheme 触碰 window.matchMedia/document：node 环境补桩
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ metadata: { label: "main" } }),
}));
vi.stubGlobal("window", {
  ...globalThis.window,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
});
vi.stubGlobal("document", {
  ...globalThis.document,
  documentElement: {
    classList: { toggle: () => {}, contains: () => false },
  },
});

describe("设置守卫：load 前不写盘", () => {
  beforeEach(() => {
    saveSettings.mockClear();
    useSettings.setState({
      ...useSettings.getInitialState(),
      loaded: false,
      menuEntries: [],
      toolbarEntries: [],
    });
  });

  it("load 前的 update 仅内存生效，不触发 saveSettings", () => {
    useSettings.getState().update({ uiZoom: 1.1 });
    expect(useSettings.getState().uiZoom).toBe(1.1); // 内存生效（缩放等功能可用）
    expect(saveSettings).not.toHaveBeenCalled(); // 但不写盘（用户档不受默认态污染）
  });

  it("load 完成后恢复落盘", async () => {
    await useSettings.getState().load();
    useSettings.getState().update({ uiZoom: 1.1 });
    expect(saveSettings).toHaveBeenCalled();
  });

  it("极快任务的 lateDone 路径同样不写盘", async () => {
    // 模拟：未 load 时暂存区变更（staging 恢复竞态）也不得写盘
    useSettings.getState().update({ staging: [] });
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
