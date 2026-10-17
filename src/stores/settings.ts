import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { api, DEFAULT_SETTINGS, THIS_PC, type Settings } from "../lib/ipc";
import { clampGsPreviewW, sanitizeColWidths, sanitizeGsColWidths } from "../lib/columns";
import { fileNameOf } from "../lib/path";
import {
  builtinToolbarEntry,
  defaultMenuEntries,
  defaultToolbarEntries,
  ensureFixedEntries,
  ensureToolbarAddr,
  stripCustomEntries,
} from "../lib/menuCommands";
import { zoomClamp } from "../lib/zoom";

interface SettingsStore extends Settings {
  loaded: boolean;
  load(): Promise<void>;
  update(p: Partial<Settings>): void;
  addFavorite(path: string, name?: string): void;
  removeFavorite(path: string): void;
  setTagged(path: string, color: Settings["colorTags"][string] | null): void;
}

function toPlain(s: SettingsStore): Settings {
  return {
    theme: s.theme,
    terminal: s.terminal,
    showHidden: s.showHidden,
    defaultView: s.defaultView,
    defaultSort: s.defaultSort,
    confirmDelete: s.confirmDelete,
    toolbarEntries: s.toolbarEntries,
    restoreLastSession: s.restoreLastSession,
    favorites: s.favorites,
    customCommands: s.customCommands,
    menuEntries: s.menuEntries,
    menuedLeftWidth: s.menuedLeftWidth,
    realIcons: s.realIcons,
    nativeFileOps: s.nativeFileOps,
    colorTags: s.colorTags,
    colorRules: s.colorRules,
    uiZoom: s.uiZoom,
    sidebarWidth: s.sidebarWidth,
    sidebarCollapsed: s.sidebarCollapsed,
    colWidths: s.colWidths,
    gsearchColWidths: s.gsearchColWidths,
    gsearchPreview: s.gsearchPreview,
    gsearchPreviewWidth: s.gsearchPreviewWidth,
    navTreeWidth: s.navTreeWidth,
    navTreeVisible: s.navTreeVisible,
    navTreeExpanded: s.navTreeExpanded,
    recentFolders: s.recentFolders,
    recentSearches: s.recentSearches,
    rememberSelection: s.rememberSelection,
    nameIndex: s.nameIndex,
  };
}

/** 旧版 UI 偏好散落 localStorage（2026-10-12 集中化进 settings.json）：
 *  仅当存档缺字段时一次性播种，随后清除旧键 */
function migrateLegacyPrefs(target: Settings, saved: Partial<Settings>) {
  const ls = (k: string) => localStorage.getItem(k);
  const num = (k: string) => {
    const n = Number(ls(k));
    return Number.isFinite(n) ? n : undefined;
  };
  if (saved.sidebarWidth === undefined) {
    const w = num("np.sidebar.width.v3");
    if (w !== undefined && w >= 140 && w <= 340) target.sidebarWidth = w;
  }
  if (saved.sidebarCollapsed === undefined) {
    target.sidebarCollapsed = ls("np.sidebar.collapsed") === "1";
  }
  if (saved.colWidths === undefined) {
    try {
      const raw = ls("x-dir.colw");
      if (raw) target.colWidths = sanitizeColWidths(JSON.parse(raw));
    } catch {
      /* 保留默认 */
    }
  }
  if (saved.navTreeWidth === undefined) {
    const w = num("np.navtree.width.v1");
    if (w !== undefined && w >= 160 && w <= 360) target.navTreeWidth = w;
  }
  if (saved.navTreeVisible === undefined) {
    target.navTreeVisible = ls("np.navtree.visible.v1") !== "0";
  }
  if (saved.navTreeExpanded === undefined) {
    try {
      const raw = ls("np.navtree.expanded.v1");
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        target.navTreeExpanded = arr.filter((x) => typeof x === "string");
      }
    } catch {
      target.navTreeExpanded = [THIS_PC];
    }
  }
  for (const k of [
    "np.sidebar.width.v3",
    "np.sidebar.collapsed",
    "x-dir.colw",
    "np.navtree.width.v1",
    "np.navtree.visible.v1",
    "np.navtree.expanded.v1",
  ]) {
    localStorage.removeItem(k);
  }
}

export function applyTheme(theme: Settings["theme"]) {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  // Blueprint 深色主题经由 bp6-dark 类生效
  document.documentElement.classList.toggle("bp6-dark", dark);
}

/** 界面缩放走 WebView2 原生 ZoomFactor（与浏览器缩放同源） */
export function applyZoom(zoom: number) {
  getCurrentWebview()
    .setZoom(zoomClamp(zoom))
    .catch(() => undefined);
}

/** 主题切换圆形扩散特效（2026-10-15 定案）：View Transitions 从触发点圆形揭示
 *  新主题；浏览器不支持 / 用户偏好减少动效时直接切换。
 *  origin = 触发点视口坐标，缺省从屏幕中心扩散。 */
export function setThemeWithFx(
  theme: Settings["theme"],
  origin?: { x: number; y: number },
): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> };
  };
  const reduce =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const apply = () => useSettings.getState().update({ theme });
  if (!doc.startViewTransition || reduce) {
    apply();
    return;
  }
  const vt = doc.startViewTransition(apply);
  const o = origin ?? { x: innerWidth / 2, y: innerHeight / 2 };
  vt.ready
    .then(() => {
      const r = Math.hypot(
        Math.max(o.x, innerWidth - o.x),
        Math.max(o.y, innerHeight - o.y),
      );
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${o.x}px ${o.y}px)`,
            `circle(${r}px at ${o.x}px ${o.y}px)`,
          ],
        },
        {
          duration: 450,
          easing: "ease-in-out",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => undefined);
}

export const useSettings = create<SettingsStore>()((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,

  async load() {
    // 后端在 settings.json 缺失/损坏时返回 null（IPC 契约），以默认值兜底
    let saved: Partial<Settings> | null = null;
    try {
      saved = await api.getSettings();
    } catch {
      // 首次启动无配置文件
    }
    const merged: Settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
    // 列宽补全/钳制：旧 settings.json 缺新列键（如 name）时补默认，防 undefinedpx 进 CSS 变量
    merged.colWidths = sanitizeColWidths(merged.colWidths);
    merged.gsearchColWidths = sanitizeGsColWidths(merged.gsearchColWidths);
    merged.gsearchPreviewWidth = clampGsPreviewW(merged.gsearchPreviewWidth);
    // 图标视图已删除（2026-10-13）：旧档存过 icons 时回落详细信息
    if ((merged.defaultView as string) === "icons") merged.defaultView = "details";
    // 右键菜单迁移：旧档缺 menuEntries 字段时生成出厂布局（用户刻意清空的
    // 空数组不被重置）。命令模板功能已下线（2026-10-14）：引用自定义命令的
    // 条目一律剔除——模板数据（customCommands）留档但不再渲染/可编辑
    if (saved?.menuEntries === undefined) merged.menuEntries = defaultMenuEntries();
    merged.menuEntries = stripCustomEntries(merged.menuEntries ?? []);
    // 基础固定功能归一化（2026-10-15）：任何旧档/导入档都保证七项基础功能常驻
    merged.menuEntries = ensureFixedEntries(merged.menuEntries ?? []);
    // 窗格工具栏迁移（2026-10-15）：旧 paneTools（key 表）→ toolbarEntries（MenuEntry）；
    // 缺失时用出厂布局（全部内置功能均可入工具栏，未知 key 由渲染端按注册表过滤）
    if ((saved as { toolbarEntries?: unknown } | null)?.toolbarEntries === undefined) {
      const legacy = (saved as { paneTools?: unknown } | null)?.paneTools;
      merged.toolbarEntries = Array.isArray(legacy)
        ? (legacy as string[]).map((k) => builtinToolbarEntry(k))
        : defaultToolbarEntries();
    }
    // 地址框固定常驻（不可移除、可排序）：任何来源的配置都保证存在
    merged.toolbarEntries = ensureToolbarAddr(merged.toolbarEntries ?? []);
    migrateLegacyPrefs(merged, saved ?? {});
    set({ ...merged, loaded: true });
    applyTheme(get().theme);
    applyZoom(get().uiZoom);
  },

  update(p) {
    set(p);
    if (p.theme) applyTheme(p.theme);
    if (p.uiZoom !== undefined) applyZoom(p.uiZoom);
    api.saveSettings(toPlain(get())).catch(() => undefined);
  },

  addFavorite(path, name) {
    const favs = get().favorites.filter((f) => f.path !== path);
    get().update({
      favorites: [...favs, { name: name ?? fileNameOf(path), path }],
    });
  },

  removeFavorite(path) {
    get().update({ favorites: get().favorites.filter((f) => f.path !== path) });
  },

  setTagged(path, color) {
    const colorTags = { ...get().colorTags };
    if (color) {
      colorTags[path] = color;
    } else {
      delete colorTags[path];
    }
    get().update({ colorTags });
  },
}));
