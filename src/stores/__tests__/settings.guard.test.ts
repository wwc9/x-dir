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

import { useSettings, settlePendingSave } from "../../stores/settings";

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
  // setBackgroundColor 为 applyTheme 窗口底色跟随（2026-11-06）补桩
  getCurrentWindow: () => ({
    metadata: { label: "main" },
    setBackgroundColor: () => Promise.resolve(),
  }),
}));
vi.stubGlobal("window", {
  ...globalThis.window,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  // 落盘 800ms 防抖（2026-11-01）的同步桩：setTimeout 立即执行回调，
  // 测试里 update 后 saveSettings 即刻可断言；clearTimeout 空操作
  setTimeout: (fn: () => void, _ms?: number) => {
    fn();
    return 0;
  },
  clearTimeout: () => undefined,
});
vi.stubGlobal("document", {
  ...globalThis.document,
  documentElement: {
    classList: { toggle: () => {}, contains: () => false },
    // load() 末尾 applyMetrics 写 CSS 变量（:root 内联覆写）：node 环境补桩
    style: { setProperty: () => undefined, removeProperty: () => undefined },
    // applyGlassBg 写 data-glassbg（2026-11-18 玻璃背景图案）：node 环境补桩
    dataset: {},
  },
  // applyTheme 双锚点（2026-11-05 加固）在 body 镜像挂主题类：同步补桩
  body: { classList: { toggle: () => {}, contains: () => false } },
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

describe("settlePendingSave：防抖批量冲刷/丢弃（配置导出/导入前置，2026-11-26）", () => {
  // 文件级 setTimeout 桩是同步触发（update 后批量即刻落盘），本组用例换
  // 非触发的计时器桩让批量真正挂起，再验证冲刷/丢弃两种口径
  function withPendingTimer(fn: () => void) {
    const syncStub = window.setTimeout;
    window.setTimeout = ((_cb: () => void) => 7) as typeof window.setTimeout;
    return Promise.resolve(fn()).finally(() => {
      window.setTimeout = syncStub;
      // 清掉挂起批量，防泄漏进后续用例
      return settlePendingSave(true);
    });
  }

  beforeEach(() => {
    saveSettings.mockClear();
    useSettings.setState({
      ...useSettings.getInitialState(),
      loaded: true,
    });
  });

  it("冲刷口径：挂起批量立即落盘一次，无挂起时不重复写", () =>
    withPendingTimer(() => {
      useSettings.getState().update({ uiZoom: 1.2 });
      expect(saveSettings).not.toHaveBeenCalled();
      void settlePendingSave();
      expect(saveSettings).toHaveBeenCalledTimes(1);
      expect(useSettings.getState().uiZoom).toBe(1.2);
      // 批量已清（saveTimer 复位）：再次冲刷不产生第二次写盘
      void settlePendingSave();
      expect(saveSettings).toHaveBeenCalledTimes(1);
    }));

  it("丢弃口径（cancel=true）：挂起批量作废不写盘", () =>
    withPendingTimer(() => {
      useSettings.getState().update({ uiZoom: 1.3 });
      void settlePendingSave(true);
      expect(saveSettings).not.toHaveBeenCalled();
      // 批量已清：后续冲刷同样无写盘
      void settlePendingSave();
      expect(saveSettings).not.toHaveBeenCalled();
    }));
});
