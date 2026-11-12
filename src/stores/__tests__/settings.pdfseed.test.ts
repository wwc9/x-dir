// PDF 功能族入驻迁移（2026-11-11，版本化补种）：menuSeedV 低于
// PDF_MENU_SEED_VERSION 即补种缺失的 PDF 组条目（新功能入库升版本一次性
// 送达存量档），补种后编辑器删减不回填。getSettings 可按用例投喂不同存档；
// saveSettings 桩拦截防真写盘
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

import {
  MENU_SEED_VERSION,
  PDF_MENU_KEYS,
  PDF_MENU_SEED_VERSION,
} from "../../lib/menuCommands";
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

describe("菜单补种迁移（menuSeedV 版本化：v2=PDF 功能族 / v3=功能库入口）", () => {
  beforeEach(() => {
    getSettings.mockReset();
    getSettings.mockImplementation(() => Promise.resolve(null));
    useSettings.setState({ ...useSettings.getInitialState(), loaded: false });
  });

  it("无存档：出厂默认（2026-11-12 现用方案收编）不再自带 PDF 组，含功能库入口尾段，版本升到当前", async () => {
    await useSettings.getState().load();
    const ids = useSettings.getState().menuEntries.map((e) => e.id);
    for (const key of PDF_MENU_KEYS) expect(ids).not.toContain(`builtin:${key}`);
    expect(ids[ids.length - 1]).toBe("builtin:palette");
    expect(useSettings.getState().menuSeedV).toBe(MENU_SEED_VERSION);
  });

  it("存量档 v0：缺失的 PDF 键补种在末尾、功能库入口随后补种，已有键原位不动", async () => {
    // 模拟旧档：手动拖入过 pdfSplit（条件与注册表不同也保留）
    const legacy: MenuEntry[] = [
      en("builtin:open", { ...cond, maxCount: 1 }),
      en("builtin:pdfSplit", { ...cond, target: "file", exts: "pdf", maxCount: 1 }),
    ];
    getSettings.mockImplementation(() => Promise.resolve({ menuEntries: legacy }));
    await useSettings.getState().load();
    const ids = useSettings.getState().menuEntries.map((e) => e.id);
    // 原布局两条原序原位（pdfSplit 已存在 → 不补）；缺失的 11 键补在中段，
    // 功能库入口（sep + palette）补在最末
    expect(ids.slice(0, 2)).toEqual(legacy.map((e) => e.id));
    expect(ids.slice(-13, -2)).toEqual(
      PDF_MENU_KEYS.filter((k) => k !== "pdfSplit").map((k) => `builtin:${k}`),
    );
    expect(ids[ids.length - 1]).toBe("builtin:palette");
    expect(useSettings.getState().menuEntries[ids.length - 2]?.kind).toBe("sep");
    expect(ids.filter((id) => id === "builtin:pdfSplit").length).toBe(1);
    expect(useSettings.getState().menuSeedV).toBe(MENU_SEED_VERSION);
  });

  it("存量档 v1（九件已送达、布尔标记时代）：升 v2 补新增四键 + 功能库入口，imgToPdf 同步剔除", async () => {
    // 历史布局：v1 九键字面量（含当日已下线的 imgToPdf——它是当时的注册表键）
    const V1_KEYS = [
      "pdfMerge",
      "pdfMergeFolders",
      "imgToPdf",
      "pdfSplit",
      "pdfExtract",
      "pdfRemove",
      "pdfRotate",
      "pdfCompress",
      "pdfWatermark",
    ];
    const entries: MenuEntry[] = V1_KEYS.map((k) => en(`builtin:${k}`, cond));
    getSettings.mockImplementation(() =>
      Promise.resolve({ menuEntries: entries, pdfMenuSeeded: true }),
    );
    await useSettings.getState().load();
    const ids = useSettings.getState().menuEntries.map((e) => e.id);
    // 新四键补进；imgToPdf 已下线（注册表无此键）→ 存量条目被剔除；
    // 功能库入口补在最末
    for (const k of ["pdfInsertBlank", "pdfToPng", "pdfEncrypt", "pdfDecrypt"]) {
      expect(ids).toContain(`builtin:${k}`);
    }
    expect(ids).not.toContain("builtin:imgToPdf");
    expect(ids[ids.length - 1]).toBe("builtin:palette");
    expect(useSettings.getState().menuSeedV).toBe(MENU_SEED_VERSION);
  });

  it("存量档 v2：PDF 组不回填（补种窗口已过），仅补功能库入口", async () => {
    // 刻意清空的空数组仍按既有「清空语义」补固定七项；PDF 组条目不回填，
    // 功能库入口（sep + palette）一次性送达
    getSettings.mockImplementation(() =>
      Promise.resolve({ menuEntries: [], menuSeedV: PDF_MENU_SEED_VERSION }),
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
      expect.any(String), // sep
      "builtin:palette",
    ]);
    expect(useSettings.getState().menuSeedV).toBe(MENU_SEED_VERSION);
  });

  it("存量档已到当前版本（v3）：编辑器删减后的布局重启完全不回填", async () => {
    getSettings.mockImplementation(() =>
      Promise.resolve({ menuEntries: [], menuSeedV: MENU_SEED_VERSION }),
    );
    await useSettings.getState().load();
    const ids = useSettings.getState().menuEntries.map((e) => e.id);
    expect(ids).toEqual([
      "builtin:open",
      "builtin:cut",
      "builtin:copy",
      "builtin:paste",
      "builtin:rename",
      "builtin:delete",
      "builtin:properties",
    ]);
    expect(useSettings.getState().menuSeedV).toBe(MENU_SEED_VERSION);
  });
});
