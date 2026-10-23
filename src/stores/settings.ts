import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { api, DEFAULT_SETTINGS, THIS_PC, type Settings } from "../lib/ipc";
import { clampGsPreviewW, sanitizeColWidths, sanitizeGsColWidths } from "../lib/columns";
import { fileNameOf } from "../lib/path";
import { shelfAdd, shelfRemove } from "../lib/shelf";
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
  /** 暂存区：追加（去重 + 上限截断），返回实际新增数（0 = 全部重复或已满） */
  addShelf(paths: string[]): number;
  removeShelf(path: string): void;
  clearShelf(): void;
}

function toPlain(s: SettingsStore): Settings {
  return {
    theme: s.theme,
    lang: s.lang,
    terminal: s.terminal,
    showHidden: s.showHidden,
    defaultView: s.defaultView,
    defaultSort: s.defaultSort,
    stagingMode: s.stagingMode,
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
    sideSplitRatio: s.sideSplitRatio,
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
    staging: s.staging,
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

/** 原生窗缘底色当前值（RGB 0xRRGGBB）：渐变动画的插值基准，初始 = 浅色画布 */
let borderCur = 0xe9ecf1;
let borderFadeTimer: number | null = null;

const toColorref = (rgb: number): number =>
  ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);

/** 原生窗缘底色（顶缘 1px 非客户区 + DWM 窗框，WebView 之外）与画布同色，
 *  取当前 DOM 主题类计算（COLORREF = 0x00BBGGRR；#e9ecf1 / #131519 与
 *  index.css --np-bg 同值；Rust 侧默认浅色，深色由本函数同步） */
function syncBorderColor() {
  if (borderFadeTimer !== null) {
    clearInterval(borderFadeTimer);
    borderFadeTimer = null;
  }
  const canvas = document.documentElement.classList.contains("dark")
    ? 0x131519
    : 0xe9ecf1;
  borderCur = canvas;
  api.setBorderColor(toColorref(canvas)).catch(() => undefined);
}

/** 原生窗缘色随揭示时长平行渐变（约 8 步插值 + ease-in-out，与圆形揭示同
 *  时长同缓动）：边框是整窗一色，圆形揭示是径向动画，二值翻色无论放起点
 *  （领先成"先变黑"）还是终点（滞后成割裂）都会与页面脱节，平行渐变让
 *  边框与页面同步过渡。borderCur 全程跟踪插值，新切换以当前值为起点 */
function fadeBorderColor(target: number, duration: number) {
  const from = borderCur;
  if (from === target) return;
  if (borderFadeTimer !== null) clearInterval(borderFadeTimer);
  const fr = (from >> 16) & 0xff;
  const fg = (from >> 8) & 0xff;
  const fb = from & 0xff;
  const tr = (target >> 16) & 0xff;
  const tg = (target >> 8) & 0xff;
  const tb = target & 0xff;
  const t0 = Date.now();
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  borderFadeTimer = window.setInterval(() => {
    const p = Math.min(1, (Date.now() - t0) / duration);
    const k = ease(p);
    borderCur =
      (Math.round(fr + (tr - fr) * k) << 16) |
      (Math.round(fg + (tg - fg) * k) << 8) |
      Math.round(fb + (tb - fb) * k);
    api.setBorderColor(toColorref(borderCur)).catch(() => undefined);
    if (p >= 1 && borderFadeTimer !== null) {
      clearInterval(borderFadeTimer);
      borderFadeTimer = null;
    }
  }, 55);
}

/** 主题圆形扩散在飞标记：揭示期间原生边色由 fadeBorderColor 接管渐变，
 *  applyTheme 不再即时写（避免与渐变互相覆盖）；直切路径（无 VT/减少动效）
 *  不置位，仍走 syncBorderColor 瞬切 */
let themeFxInFlight = false;

export function applyTheme(theme: Settings["theme"]) {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  // Blueprint 深色主题经由 bp6-dark 类生效
  document.documentElement.classList.toggle("bp6-dark", dark);
  if (!themeFxInFlight) syncBorderColor();
}

/** 界面缩放走 WebView2 原生 ZoomFactor（与浏览器缩放同源） */
export function applyZoom(zoom: number) {
  getCurrentWebview()
    .setZoom(zoomClamp(zoom))
    .catch(() => undefined);
}

/** 主题圆形揭示时长（ms，2026-10-21 由 450 放缓）：页面揭示动画与原生边色
 *  渐变共用同一常量保证同步，调速只改这里 */
const THEME_FX_MS = 650;

/** 主题圆形扩散特效（2026-10-15 定案）：View Transitions 从触发点圆形揭示
 *  新主题；浏览器不支持 / 用户偏好减少动效时直接切换。
 *  origin = 触发点视口坐标，缺省从屏幕中心扩散。 */
export function setThemeWithFx(
  theme: Settings["theme"],
  origin?: { x: number; y: number },
): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => {
      ready: Promise<void>;
      finished?: Promise<void>;
    };
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
  // 原生边色与揭示平行渐变（applyTheme 内被 themeFxInFlight 抑制即时写）：
  // 二值翻色无论在起点（边框领先，"先变黑"）还是终点（边框滞后，割裂）
  // 都与径向揭示脱节；渐变结束再以 syncBorderColor 落精确终值兜底
  if (vt.finished) {
    themeFxInFlight = true;
    const dark =
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    fadeBorderColor(dark ? 0x131519 : 0xe9ecf1, THEME_FX_MS);
    void vt.finished
      .catch(() => undefined)
      .then(() => {
        themeFxInFlight = false;
        syncBorderColor();
      });
  }
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
          duration: THEME_FX_MS,
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
    // 边栏上下分割比例：脏数据/越界回落默认（布局方案卡占比，钳 0.2–0.8）
    merged.sideSplitRatio =
      typeof merged.sideSplitRatio === "number" && Number.isFinite(merged.sideSplitRatio)
        ? Math.min(0.8, Math.max(0.2, merged.sideSplitRatio))
        : DEFAULT_SETTINGS.sideSplitRatio;
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
    // 暂存区：旧档缺字段发空数组；脏数据（非字符串项）过滤
    merged.staging = Array.isArray(merged.staging)
      ? merged.staging.filter((x): x is string => typeof x === "string")
      : [];
    migrateLegacyPrefs(merged, saved ?? {});
    set({ ...merged, loaded: true });
    applyTheme(get().theme);
    applyZoom(get().uiZoom);
  },

  update(p) {
    // 未完成 load 前仅内存生效、不写盘（2026-10-22 修复）：启动早期（会话恢复
    // 等）的 update 会把未加载的默认态（menuEntries/toolbarEntries 为空数组）
    // 写盘覆盖用户方案，下一次 load 固化——表现为重启后菜单/工具栏方案"丢失"。
    // load() 自身走 set 直写不经此处；load 完成后（loaded=true）恢复落盘
    set(p);
    if (!get().loaded) return;
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

  addShelf(paths) {
    if (!paths.length) return 0;
    const r = shelfAdd(get().staging, paths);
    if (r.added) get().update({ staging: r.items });
    return r.added;
  },

  removeShelf(path) {
    get().update({ staging: shelfRemove(get().staging, path) });
  },

  clearShelf() {
    get().update({ staging: [] });
  },
}));
