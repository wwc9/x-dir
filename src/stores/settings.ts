import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";


import { api, DEFAULT_SETTINGS, THIS_PC, type MenuEntry, type Settings } from "../lib/ipc";
import { clampGsPreviewW, sanitizeColWidths, sanitizeGsColWidths } from "../lib/columns";
import { sanitizeDialogPrefs } from "../lib/dialogPrefs";
import { fileNameOf } from "../lib/path";
import { shelfAdd, shelfRemove } from "../lib/shelf";
import {
  builtinToolbarEntry,
  defaultMenuEntries,
  defaultToolbarEntries,
  ensureFixedEntries,
  ensureToolbarAddr,
  PDF_MENU_SEED_VERSION,
  seedPdfEntries,
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

/** settings.json 落盘防抖定时器：连续 update（recentFolders 随每次导航触发）
 *  只落最后一次；页面卸载前冲刷，窗口期内退出不丢末次改动 */
let saveTimer: number | undefined;

function toPlain(s: SettingsStore): Settings {  return {
    theme: s.theme,
    lang: s.lang,
    terminal: s.terminal,
    showHidden: s.showHidden,
    defaultView: s.defaultView,
    defaultSort: s.defaultSort,
    stagingMode: s.stagingMode,
    dialogPrefs: s.dialogPrefs,
    workspaceOrder: s.workspaceOrder,
    confirmDelete: s.confirmDelete,
    toolbarEntries: s.toolbarEntries,
    restoreLastSession: s.restoreLastSession,
    favorites: s.favorites,
    customCommands: s.customCommands,
    menuEntries: s.menuEntries,
    menuSeedV: s.menuSeedV,
    renameSchemes: s.renameSchemes,
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
    extractDestDir: s.extractDestDir,
    rememberSelection: s.rememberSelection,
    staging: s.staging,
    nameIndex: s.nameIndex,
    shotEnabled: s.shotEnabled,
    shotHotkey: s.shotHotkey,
    cliphistEnabled: s.cliphistEnabled,
    cliphistHotkey: s.cliphistHotkey,
    cliphistDirectPaste: s.cliphistDirectPaste,
    cliphistCapacity: s.cliphistCapacity,
    cliphistKeepDays: s.cliphistKeepDays,
    cliphistExcludeApps: s.cliphistExcludeApps,
    cliphistRichText: s.cliphistRichText,
    cliphistWinW: s.cliphistWinW,
    cliphistWinH: s.cliphistWinH,
    shotShadowW: s.shotShadowW,
    shotBorderW: s.shotBorderW,
    shotBorderColor: s.shotBorderColor,
    uiRadius: s.uiRadius,
    uiGap: s.uiGap,
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
  // 双锚点（2026-11-05 加固）：html 与 body 同时挂类。token 块选择器 `.dark`
  // 匹配任意元素，body 自身成为 token/Blueprint 暗色类的第二挂载点——即使
  // 异机上 html→body 的变量继承链被环境破坏（扩展注入重置样式/驱动异常），
  // body 之下整棵应用树仍能解析到暗色 token；正常环境两条链同值幂等
  document.body.classList.toggle("dark", dark);
  document.body.classList.toggle("bp6-dark", dark);
  // 窗口原生底色随主题 = 画布色（2026-11-06）：拖拽调宽等高频重排的长帧里
  // WebView 合成器来不及绘制的新区域会露出窗口底色（默认黑——用户实测
  // 侧栏拖宽时右缘黑条）；钉成画布色后即使露底也与界面同色不可见。
  // ?. 防御：guard 测试桩的 getCurrentWindow 不含本方法
  getCurrentWindow()
    .setBackgroundColor?.(dark ? "#131519" : "#e9ecf1")
    .catch(() => undefined);
  if (!themeFxInFlight) syncBorderColor();
}

/** 界面缩放走 WebView2 原生 ZoomFactor（与浏览器缩放同源） */
export function applyZoom(zoom: number) {
  getCurrentWebview()
    .setZoom(zoomClamp(zoom))
    .catch(() => undefined);
}

/** 界面度量（2026-11-03 统一规范）：面板统一圆角与组件间隔都以 :root 内联
 *  覆写 CSS token（style 属性优先级高于 index.css 的 :root 规则），全部
 *  引用点（窗格/侧栏/导航树/Dialog/分隔条/画布留白…）即时跟随，无需重渲染 */
export function applyMetrics(radius: number, gap: number) {
  const root = document.documentElement.style;
  root.setProperty("--np-radius-pane", `${radius}px`);
  root.setProperty("--np-gutter", `${gap}px`);
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
    // 界面度量钳制：圆角 0–24 / 间隔 4–24（分隔条可拖热区依赖间隔，下限 4）；
    // 脏数据（非有限数/越界）回落默认
    const clampMetric = (v: number | undefined, lo: number, hi: number, dflt: number) =>
      typeof v === "number" && Number.isFinite(v)
        ? Math.min(hi, Math.max(lo, Math.round(v)))
        : dflt;
    merged.uiRadius = clampMetric(merged.uiRadius, 0, 24, DEFAULT_SETTINGS.uiRadius);
    merged.uiGap = clampMetric(merged.uiGap, 4, 24, DEFAULT_SETTINGS.uiGap);
    // 图标视图已删除（2026-10-13）：旧档存过 icons 时回落详细信息
    if ((merged.defaultView as string) === "icons") merged.defaultView = "details";
    // 右键菜单迁移：旧档缺 menuEntries 字段时生成出厂布局（用户刻意清空的
    // 空数组不被重置）。命令模板功能已下线（2026-10-14）：引用自定义命令的
    // 条目一律剔除——模板数据（customCommands）留档但不再渲染/可编辑
    if (saved?.menuEntries === undefined) merged.menuEntries = defaultMenuEntries();
    merged.menuEntries = stripCustomEntries(merged.menuEntries ?? []);
    // 「图片合并转 PDF」下线清理（2026-11-11 用户定案：能力由「合并为 PDF」
    // 单选覆盖）：注册表已无此键，存量菜单/工具栏条目剔除（渲染端本会跳过
    // 未知键，此处清掉防编辑器残留死行——同命令模板下线的 stripCustomEntries 口径）
    const stripOffline = (es: MenuEntry[]) => es.filter((en) => en.id !== "builtin:imgToPdf");
    merged.menuEntries = stripOffline(merged.menuEntries ?? []);
    merged.toolbarEntries = stripOffline(merged.toolbarEntries ?? []);
    // 基础固定功能归一化（2026-10-15）：任何旧档/导入档都保证七项基础功能常驻
    merged.menuEntries = ensureFixedEntries(merged.menuEntries ?? []);
    // 导出文件清单升级迁移（2026-11-10）：启用时机 sel → both——空白处右键
    // 整树递归导出随本版新增，存量条目停留在 sel 则新能力永远不可见；
    // 渲染端 supportsBlank 已开，此处仅翻启用时机
    merged.menuEntries = (merged.menuEntries ?? []).map((en) =>
      en.kind === "builtin" && en.id === "builtin:exportList" && en.area === "sel"
        ? { ...en, area: "both" as const }
        : en,
    );
    // PDF 功能族入驻迁移（2026-11-11，版本化补种）：menuSeedV 低于
    // PDF_MENU_SEED_VERSION 即补种缺失的 PDF 组条目（注册表默认区域/条件，
    // 追加在末尾）——新功能入库升版本一次性送达存量档；补种过后编辑器里
    // 删减的 PDF 条目重启不回填（尊重自定义，出厂布局本身已整组自带）。
    // 旧档仅存上午的布尔标记 pdfMenuSeeded=true 时视为 v1（九件已送达）
    const legacySeeded = (saved as { pdfMenuSeeded?: unknown } | null)?.pdfMenuSeeded === true;
    const seedV =
      typeof merged.menuSeedV === "number" && merged.menuSeedV >= 0
        ? merged.menuSeedV
        : legacySeeded
          ? 1
          : 0;
    if (seedV < PDF_MENU_SEED_VERSION) {
      merged.menuEntries = seedPdfEntries(merged.menuEntries ?? []);
      merged.menuSeedV = PDF_MENU_SEED_VERSION;
    }
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
    // 批量重命名方案：旧档缺字段发空数组；脏数据（缺 name/ops）过滤
    merged.extractDestDir = typeof merged.extractDestDir === "string" && merged.extractDestDir
      ? merged.extractDestDir
      : null;
    // 「启用菜单」栏宽一次性迁移（2026-11-09 上限 480→720 / 默认 520）：旧档
    // 等于旧上限 480 的值几乎都是「拖到头仍嫌窄」，提为新默认 520；其余存值
    // （含刻意拖窄的）不动，用户仍可在新上限内自由拖拽
    merged.menuedLeftWidth = merged.menuedLeftWidth === 480 ? 520 : merged.menuedLeftWidth;
    // 对话框参数记忆（2026-11-09）：仅收 string/number/boolean 值的对象表，
    // 脏值（嵌套对象/数组/null）整键剔除，防坏档污染对话框初始态
    merged.dialogPrefs = sanitizeDialogPrefs(merged.dialogPrefs);
    merged.renameSchemes = Array.isArray(merged.renameSchemes)
      ? merged.renameSchemes.filter((sc) => !!sc && typeof sc.name === "string" && Array.isArray(sc.ops))
      : [];
    merged.staging = Array.isArray(merged.staging)
      ? merged.staging.filter((x): x is string => typeof x === "string")
      : [];
    migrateLegacyPrefs(merged, saved ?? {});
    set({ ...merged, loaded: true });
    applyTheme(get().theme);
    applyZoom(get().uiZoom);
    applyMetrics(get().uiRadius, get().uiGap);
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
    if (p.uiRadius !== undefined || p.uiGap !== undefined)
      applyMetrics(get().uiRadius, get().uiGap);
    // 落盘合并 800ms 防抖（2026-11-01 审查修复）：recentFolders 随每次目录
    // 导航 update——旧实现逐次全量序列化 settings.json（含菜单/工具栏布局
    // 可达上百 KB）+ 整店订阅组件（SettingsPanel）逐次重渲染；UI 态仍即时
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      api.saveSettings(toPlain(get())).catch(() => undefined);
    }, 800);
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

// 卸载前冲刷未落盘的防抖批量（同截图偏好 flushPrefs 口径）：防抖窗内关窗
// 不丢末次改动（recentFolders 等）。window 守卫 = vitest 的 node 环境无 window
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (saveTimer === undefined) return;
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    api.saveSettings(toPlain(useSettings.getState())).catch(() => undefined);
  });
}
