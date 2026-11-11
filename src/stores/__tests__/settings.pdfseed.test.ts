// PDF 功能族入驻迁移（2026-11-11）：存量档一次性补种缺失的 PDF 组条目 +
// pdfMenuSeeded 标记持久化（补种后编辑器删减不回填）。getSettings 可按用例
// 投喂不同存档；saveSettings 桩拦截防真写盘
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettings = vi.hoisted(() =>
  vi.fn((): Promise<Record<string, unknown> | null> => Promise.resolve(null)),
);

vi.mock("../../lib/ipc", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...orig,
    DEFAULT_SETTINGS: orig.DEFAULT_SETTINGS,
    api: {
      ...orig.api,
      saveSettings: () => Promise.resolve(),
      getSettings: getSettings as () => Promise<Record<string, unknown> | null>,
    },
  };
});

import { PDF_MENU_KEYS } from "../../lib/menuCommands";
import type { MenuEntry } from "../../lib/ipc";
import { useSettings } from "../../stores/settings";

// migrateLegacyPrefs 触碰 localStorage；load() 末尾 applyTheme/applyMetrics
// 触碰 window.matchMedia/document：node 环境补桩（同 settings.guard.test.ts）
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    metadata: { label: "main" },
    setBackgroundColor: () => Promise.resolve(),
  }),
}));
vi.stubGlobal("window", {
  ...globalThis.window,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  setTimeout: (fn: () => void) => {
    fn();
    return 0;
  },
  clearTimeout: () => undefined,
});
vi.stubGlobal("document", {
  ...globalThis.document,
  documentElement: {
    classList: { toggle: () => {}, contains: () => false },
    style: { setProperty: () => undefined },
  },
  body: { classList: { toggle: () => {}, contains: () => false } },
});

const en = (id: string, cond: MenuEntry["cond"]): MenuEntry => ({
  id,
  kind: "builtin",
  area: "sel",
  cond,
});
const cond = {
  target: "all" as const,
  minCount: 1,
  maxCount: 0,
  exts: "",
};

describe("PDF 补种迁移（pdfMenuSeeded，2026-11-11 定案）", () => {
  beforeEach(() => {
    getSettings.mockReset();
    getSettings.mockImplementation(() => Promise.resolve(null));
    useSettings.setState({ ...useSettings.getInitialState(), loaded: false });
  });

  it("无存档：出厂布局整组自带 PDF 九键，标记翻真", async () => {
    await useSettings.getState().load();
    const ids = useSettings.getState().menuEntries.map((e) => e.id);
    for (const key of PDF_MENU_KEYS) expect(ids).toContain(`builtin:${key}`);
    expect(useSettings.getState().pdfMenuSeeded).toBe(true);
  });

  it("存量档无标记：缺失的 PDF 键按注册表默认补种在末尾，已有键原位不动", async () => {
    // 模拟 2026-11-10 的存量档：手动拖入过 pdfSplit（条件与注册表不同也保留）
    const legacy: MenuEntry[] = [
      en("builtin:open", { ...cond, maxCount: 1 }),
      en("builtin:pdfSplit", { ...cond, target: "file", exts: "pdf", maxCount: 1 }),
    ];
    getSettings.mockImplementation(() => Promise.resolve({ menuEntries: legacy }));
    await useSettings.getState().load();
    const ids = useSettings.getState().menuEntries.map((e) => e.id);
    // 原布局两条原序原位（固定项归一化补固定七项是既有语义，排其后）
    expect(ids.slice(0, 2)).toEqual(legacy.map((e) => e.id));
    expect(ids.slice(-8)).toEqual(
      PDF_MENU_KEYS.filter((k) => k !== "pdfSplit").map((k) => `builtin:${k}`),
    );
    expect(useSettings.getState().pdfMenuSeeded).toBe(true);
  });

  it("存量档已标记：编辑器删减后的布局重启不回填 PDF 条目", async () => {
    // 刻意清空的空数组仍按既有「清空语义」补固定七项，但 PDF 九键不回填——
    // 标记已真 = 补种窗口已过，其余布局完全交给用户
    getSettings.mockImplementation(() =>
      Promise.resolve({ menuEntries: [], pdfMenuSeeded: true }),
    );
    await useSettings.getState().load();
    const ids = useSettings.getState().menuEntries.map((e) => e.id);
    expect(ids.some((id) => PDF_MENU_KEYS.includes(id.slice("builtin:".length)))).toBe(false);
    expect(ids).toEqual([
      "builtin:open",
      "builtin:cut",
      "builtin:copy",
      "builtin:paste",
      "builtin:rename",
      "builtin:delete",
      "builtin:properties",
    ]);
  });
});
