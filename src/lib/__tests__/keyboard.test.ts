// 快捷键总测（§7.2 / 设置面板「快捷键」页）：每条 scope=global 的快捷键
// 至少一条按键事件断言，并与 lib/shortcuts.ts 清单做双向对齐——清单里的
// id 漏测、或测试覆盖了清单外 id，都判失败，防清单与实现漂移。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { GLOBAL_SHORTCUT_IDS } from "../shortcuts";
import { dfsPanes, mkPane } from "../layoutTree";
import { onGlobalKeyDown } from "../keyboard";
import { registerList } from "../listRegistry";
import type { FileEntry } from "../ipc";
import { useLayout } from "../../stores/layout";
import { usePanes } from "../../stores/panes";
import { useUi } from "../../stores/ui";
import { usePreview } from "../../stores/preview";
import { useSettings } from "../../stores/settings";
import { api } from "../ipc";

// stores/ui 含 Tauri/浏览器副作用（现挂灵动岛回执、此前是 OverlayToaster），
// node 环境不真开：以等价 zustand 替身覆盖 keyboard.ts 用到的面
// （menu/dialog/globalSearch/menuPage/swapFrom）
const uiFns = vi.hoisted(() => ({ closePaneConfirmed: vi.fn() }));
vi.mock("../../stores/ui", async () => {
  const { create } = await import("zustand");
  const useUi = create<{
    dialog: unknown;
    dialogResolve: ((v: unknown) => void) | null;
    menu: { items: unknown[]; x: number; y: number } | null;
    globalSearch: boolean;
    menuPage: boolean;
    swapFrom: string | null;
    typeAhead: { buf: string; hit: string | null } | null;
    closeMenu(): void;
    openGlobalSearch(): void;
    closeGlobalSearch(): void;
    openMenuPage(): void;
    closeMenuPage(): void;
    cancelSwap(): void;
    setTypeAhead(t: { buf: string; hit: string | null } | null): void;
    toast(text: string, kind?: "info" | "error"): void;
  }>()((set) => ({
    dialog: null,
    dialogResolve: null,
    menu: null,
    globalSearch: false,
    menuPage: false,
    swapFrom: null,
    typeAhead: null,
    closeMenu: () => set({ menu: null }),
    openGlobalSearch: () => set({ globalSearch: true, menuPage: false }),
    closeGlobalSearch: () => set({ globalSearch: false }),
    exitPages: () => set({ menuPage: false, globalSearch: false }),
    openMenuPage: () => set({ menuPage: true, globalSearch: false }),
    closeMenuPage: () => set({ menuPage: false }),
    cancelSwap: () => set({ swapFrom: null }),
    setTypeAhead: (t) => set({ typeAhead: t }),
    toast: () => undefined,
  }));
  return { useUi, closePaneConfirmed: uiFns.closePaneConfirmed };
});

// applyZoom 走 WebView2 原生缩放（node 无 window）：替身只留调用记录
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn(() => Promise.resolve()) }),
}));

// Tauri invoke 在 node 测试环境不可用：api 换成懒建 spy 替身（全部 resolve），
// 其余导出（DEFAULT_SETTINGS 等）保持原样；共享 Map 必须 vi.hoisted 承载。
const apiSpies = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    api: new Proxy({}, {
      get(_t, prop: string) {
        if (!apiSpies.has(prop)) {
          apiSpies.set(prop, vi.fn(() => Promise.resolve(undefined)));
        }
        return apiSpies.get(prop);
      },
    }),
  };
});

// focusNearest / Alt+D / Ctrl+F 触及 DOM 与 rAF
vi.stubGlobal("document", {
  querySelector: vi.fn(() => null),
  querySelectorAll: vi.fn(() => []),
});
// type-ahead 计时器走浏览器惯例 window.setTimeout（@types/node 下裸 setTimeout
// 返回 Timeout 与 number 字段不符）：node 测试环境把 window 指回 globalThis 即可
vi.stubGlobal("window", globalThis);
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  cb(0);
  return 0;
});

interface FireOpts {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  target?: { tagName?: string; blur?(): void };
}

function fire(o: FireOpts): { prevented: boolean } {
  let prevented = false;
  onGlobalKeyDown({
    key: o.key,
    ctrlKey: o.ctrl ?? false,
    metaKey: o.meta ?? false,
    shiftKey: o.shift ?? false,
    altKey: o.alt ?? false,
    preventDefault: () => {
      prevented = true;
    },
    target: o.target ?? {},
  } as unknown as KeyboardEvent);
  return { prevented };
}

let tabId: string;
const h = {
  onArrow: vi.fn(),
  onNav: vi.fn(),
  onEnter: vi.fn(),
  onBackspace: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onProperties: vi.fn(),
  onContextMenu: vi.fn(),
  onSelectAll: vi.fn(),
  onCopy: vi.fn(),
  onPaste: vi.fn(),
  onTransferToPane: vi.fn(),
  onRefresh: vi.fn(),
  onNewFolder: vi.fn(),
  getSnapshot: vi.fn((): { entries: FileEntry[]; selected: string[] } => ({
    entries: [],
    selected: [],
  })),
  revealEntry: vi.fn(),
};

/** 覆盖登记：与 GLOBAL_SHORTCUT_IDS 对齐（双向校验见末尾测试） */
const covered = new Set<string>();

const FILE_A: FileEntry = {
  path: "C:\\a.txt",
  name: "a.txt",
  isDir: false,
  size: 1,
  mtimeMs: 0,
  ctimeMs: 0,
  attrs: { hidden: false, system: false, readonly: false },
  py: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useUi.setState({
    dialog: null,
    dialogResolve: null,
    menu: null,
    globalSearch: false,
    swapFrom: null,
  });
  usePreview.setState({ queue: [], index: 0 });
  usePanes.setState({ tabs: {} });
  useLayout.getState().init(mkPane("C:\\"));
  const pane = dfsPanes(useLayout.getState().tree!)[0];
  tabId = pane.tabs[0].id;
  usePanes.getState().ensure(tabId, { viewMode: "details", sort: { key: "name", dir: "asc" } });
  usePanes.getState().navigate(tabId, "C:\\dir");
  registerList(tabId, h as never);
});

describe("全局守卫", () => {
  it("menu-close：右键菜单打开时 Esc 关闭菜单", () => {
    useUi.setState({ menu: { items: [], x: 0, y: 0 } });
    expect(fire({ key: "Escape" }).prevented).toBe(true);
    expect(useUi.getState().menu).toBeNull();
    covered.add("menu-close");
  });

  it("menu-page-close：右键菜单页打开时 Esc 关闭；输入框内先失焦", () => {
    useUi.setState({ menuPage: true });
    const blur = vi.fn();
    // 输入框聚焦：第一次 Esc 只失焦，页面保持打开
    expect(fire({ key: "Escape", target: { tagName: "INPUT", blur } }).prevented).toBe(true);
    expect(blur).toHaveBeenCalledOnce();
    expect(useUi.getState().menuPage).toBe(true);
    // 其余全局快捷键在菜单页停用
    expect(fire({ key: "t", ctrl: true }).prevented).toBe(false);
    expect(h.onRefresh).not.toHaveBeenCalled();
    // 页面上叠着对话框（重置预设确认等）：Esc 归对话框（Blueprint），页面保持
    useUi.setState({ dialog: { type: "confirm", message: "x" } });
    expect(fire({ key: "Escape" }).prevented).toBe(false);
    expect(useUi.getState().menuPage).toBe(true);
    useUi.setState({ dialog: null });
    // 非输入焦点：Esc 关闭菜单页
    expect(fire({ key: "Escape" }).prevented).toBe(true);
    expect(useUi.getState().menuPage).toBe(false);
    covered.add("menu-page-close");
  });

  it("gsearch-open：定制页内 Ctrl+Shift+F = 切换到全盘搜索页（整页互斥）", () => {
    useUi.setState({ menuPage: true });
    expect(fire({ key: "F", ctrl: true, shift: true }).prevented).toBe(true);
    expect(useUi.getState().menuPage).toBe(false);
    expect(useUi.getState().globalSearch).toBe(true);
    // 已在全盘搜索页再按：保持打开（幂等），反向切换走顶栏定制钮/Esc
    expect(fire({ key: "F", ctrl: true, shift: true }).prevented).toBe(true);
    expect(useUi.getState().globalSearch).toBe(true);
    useUi.setState({ globalSearch: false });
  });

  it("模态守卫：对话框打开时全部全局快捷键停用", () => {
    useUi.setState({ dialog: { type: "alert", message: "x" } });
    const before = dfsPanes(useLayout.getState().tree!)[0].tabs.length;
    const r = fire({ key: "t", ctrl: true });
    expect(r.prevented).toBe(false);
    expect(dfsPanes(useLayout.getState().tree!)[0].tabs.length).toBe(before);
    expect(h.onRefresh).not.toHaveBeenCalled();
  });

  it("gsearch-open：Ctrl+Shift+F 唤起全盘搜索（输入框聚焦时也可）", () => {
    expect(fire({ key: "F", ctrl: true, shift: true }).prevented).toBe(true);
    expect(useUi.getState().globalSearch).toBe(true);
    // 输入框内同样生效（模态守卫之后的早退分支不影响）
    useUi.setState({ globalSearch: false });
    fire({ key: "F", ctrl: true, shift: true, target: { tagName: "INPUT" } });
    expect(useUi.getState().globalSearch).toBe(true);
    covered.add("gsearch-open");
  });

  it("gsearch-page-close：全盘搜索页非输入焦点 Esc 关闭", () => {
    useUi.setState({ globalSearch: true });
    // 页面打开时全局快捷键停用
    expect(fire({ key: "t", ctrl: true }).prevented).toBe(false);
    expect(h.onRefresh).not.toHaveBeenCalled();
    // 非输入焦点：Esc 关闭页面
    expect(fire({ key: "Escape" }).prevented).toBe(true);
    expect(useUi.getState().globalSearch).toBe(false);
    covered.add("gsearch-page-close");
  });

  it("zoom：Ctrl+=/−/0 三档步进与重置", () => {
    useSettings.getState().update({ uiZoom: 1 });
    fire({ key: "=", ctrl: true });
    expect(useSettings.getState().uiZoom).toBe(1.1);
    fire({ key: "-", ctrl: true });
    expect(useSettings.getState().uiZoom).toBe(1);
    fire({ key: "0", ctrl: true });
    expect(useSettings.getState().uiZoom).toBe(1);
    covered.add("zoom");
  });

  it("input-blur：输入框聚焦时 Esc 仅失焦，其余键不路由", () => {
    const blur = vi.fn();
    expect(fire({ key: "Escape", target: { tagName: "INPUT", blur } }).prevented).toBe(false);
    expect(blur).toHaveBeenCalledOnce();
    // 非 Esc 键在输入框内不触发任何列表操作
    fire({ key: "F5", target: { tagName: "INPUT", blur } });
    expect(h.onRefresh).not.toHaveBeenCalled();
    covered.add("input-blur");
  });

  it("webview 加速键兜底：F5 / Ctrl+R / Ctrl+F / Ctrl+P 在早退分支也被拦截", () => {
    // 输入框聚焦：F5 不得漏给 WebView2（否则整页重载、内存态全丢），也不路由刷新
    expect(fire({ key: "F5", target: { tagName: "INPUT" } }).prevented).toBe(true);
    expect(h.onRefresh).not.toHaveBeenCalled();
    // 输入框聚焦的 Ctrl+F 同理（不弹 WebView2 查找栏，也不开窗格搜索）
    expect(fire({ key: "f", ctrl: true, target: { tagName: "INPUT" } }).prevented).toBe(true);
    expect(usePanes.getState().tabs[tabId]?.search ?? null).toBeNull();
    // 模态守卫内：Ctrl+R / Ctrl+P 拦截，绝不触发重载/打印
    useUi.setState({ dialog: { type: "alert", message: "x" } });
    expect(fire({ key: "r", ctrl: true }).prevented).toBe(true);
    expect(fire({ key: "p", ctrl: true }).prevented).toBe(true);
    useUi.setState({ dialog: null });
    // 列表态：同样只拦截不动作（刷新走 F5 分支，Ctrl+R 无应用语义）
    expect(fire({ key: "r", ctrl: true }).prevented).toBe(true);
    expect(fire({ key: "p", ctrl: true }).prevented).toBe(true);
    expect(h.onRefresh).not.toHaveBeenCalled();
  });
});

describe("窗格与布局", () => {
  it("pane-focus-n：Ctrl+数字聚焦 DFS 序第 N 窗格", () => {
    useLayout.getState().split("horizontal");
    const panes = dfsPanes(useLayout.getState().tree!);
    expect(panes.length).toBe(2);
    fire({ key: "1", ctrl: true });
    expect(useLayout.getState().activePaneId).toBe(panes[0].id);
    fire({ key: "2", ctrl: true });
    expect(useLayout.getState().activePaneId).toBe(panes[1].id);
    covered.add("pane-focus-n");
  });

  it("pane-focus-dir：Alt+方向键调用最近窗格聚焦（无候选时保持原焦点）", () => {
    const before = useLayout.getState().activePaneId;
    expect(fire({ key: "ArrowRight", alt: true }).prevented).toBe(true);
    expect(useLayout.getState().activePaneId).toBe(before);
    covered.add("pane-focus-dir");
  });

  it("pane-split：Ctrl+Shift+H / V 横向与纵向分裂", () => {
    fire({ key: "H", ctrl: true, shift: true });
    expect(dfsPanes(useLayout.getState().tree!).length).toBe(2);
    fire({ key: "V", ctrl: true, shift: true });
    expect(dfsPanes(useLayout.getState().tree!).length).toBe(3);
    covered.add("pane-split");
  });

  it("pane-close：Ctrl+Shift+W 触发活动窗格关闭确认", () => {
    const active = useLayout.getState().activePaneId!;
    fire({ key: "W", ctrl: true, shift: true });
    expect(uiFns.closePaneConfirmed).toHaveBeenCalledWith(active);
    covered.add("pane-close");
  });

  it("swap-cancel：交换窗格选择模式下 Esc 取消", () => {
    useUi.setState({ swapFrom: useLayout.getState().activePaneId });
    expect(fire({ key: "Escape" }).prevented).toBe(true);
    expect(useUi.getState().swapFrom).toBeNull();
    covered.add("swap-cancel");
  });

  it("copy-to-pane / move-to-pane：Ctrl+Shift+C / X 传输到目标窗格", () => {
    fire({ key: "C", ctrl: true, shift: true });
    expect(h.onTransferToPane).toHaveBeenLastCalledWith(false);
    fire({ key: "X", ctrl: true, shift: true });
    expect(h.onTransferToPane).toHaveBeenLastCalledWith(true);
    covered.add("copy-to-pane");
    covered.add("move-to-pane");
  });
});

describe("标签页", () => {
  it("tab-new：Ctrl+T 新建标签并激活", () => {
    // 真实键盘事件语义：无 Shift 的字母键 e.key 为小写（Ctrl+T → "t"）
    fire({ key: "t", ctrl: true });
    const pane = dfsPanes(useLayout.getState().tree!)[0];
    expect(pane.tabs.length).toBe(2);
    expect(pane.activeTab).toBe(1);
    covered.add("tab-new");
  });

  it("tab-close：Ctrl+W 关闭当前标签（两标签时收回到 1 个）", () => {
    useLayout.getState().newTab(useLayout.getState().activePaneId!);
    fire({ key: "w", ctrl: true });
    const pane = dfsPanes(useLayout.getState().tree!)[0];
    expect(pane.tabs.length).toBe(1);
    expect(pane.activeTab).toBe(0);
    covered.add("tab-close");
  });

  it("tab-cycle：Ctrl+Tab 右移、Ctrl+Shift+Tab 左移（循环）", () => {
    useLayout.getState().newTab(useLayout.getState().activePaneId!);
    expect(dfsPanes(useLayout.getState().tree!)[0].activeTab).toBe(1);
    fire({ key: "Tab", ctrl: true });
    expect(dfsPanes(useLayout.getState().tree!)[0].activeTab).toBe(0);
    fire({ key: "Tab", ctrl: true, shift: true });
    expect(dfsPanes(useLayout.getState().tree!)[0].activeTab).toBe(1);
    covered.add("tab-cycle");
  });
});

describe("导航与视图", () => {
  it("addr-focus：Alt+D 聚焦活动窗格地址栏", () => {
    expect(fire({ key: "d", alt: true }).prevented).toBe(true);
    covered.add("addr-focus");
  });

  it("search-pane：Ctrl+F 打开窗格内递归搜索（置空串待输入）", () => {
    fire({ key: "f", ctrl: true });
    expect(usePanes.getState().tabs[tabId]?.search).toBe("");
    covered.add("search-pane");
  });

  it("view-filter：Ctrl+E 打开视图内过滤（空串待输入；Esc 分层退出）", () => {
    fire({ key: "e", ctrl: true });
    expect(usePanes.getState().tabs[tabId]?.filter).toBe("");
    // 过滤词生效后 Esc：先关搜索/过滤，最后才清选择
    usePanes.getState().setFilter(tabId, "abc");
    usePanes.getState().setSelected(tabId, ["C:\\dir\\a.txt"], "C:\\dir\\a.txt");
    fire({ key: "Escape" });
    expect(usePanes.getState().tabs[tabId]?.filter).toBeNull();
    expect(usePanes.getState().tabs[tabId]?.selected).toEqual(["C:\\dir\\a.txt"]);
    covered.add("view-filter");
  });

  it("nav-up：Backspace 上级目录（路由到列表处理器）", () => {
    fire({ key: "Backspace" });
    expect(h.onBackspace).toHaveBeenCalledOnce();
    covered.add("nav-up");
  });

  it("refresh：F5 强制刷新活动窗格", () => {
    expect(fire({ key: "F5" }).prevented).toBe(true);
    expect(h.onRefresh).toHaveBeenCalledWith(true);
    covered.add("refresh");
  });

  it("view-cycle：F3 在 详细信息 ↔ 列表 间循环", () => {
    expect(usePanes.getState().tabs[tabId]?.viewMode).toBe("details");
    fire({ key: "F3" });
    expect(usePanes.getState().tabs[tabId]?.viewMode).toBe("list");
    fire({ key: "F3" });
    expect(usePanes.getState().tabs[tabId]?.viewMode).toBe("details");
    covered.add("view-cycle");
  });
});

describe("快速预览", () => {
  it("preview-toggle：Space 以选中文件开启预览", () => {
    h.getSnapshot.mockReturnValue({
      entries: [FILE_A, { ...FILE_A, name: "b.txt", path: "C:\\b.txt" }],
      selected: ["C:\\b.txt"],
    });
    expect(fire({ key: " " }).prevented).toBe(true);
    expect(usePreview.getState().queue.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
    expect(usePreview.getState().index).toBe(1);
    covered.add("preview-toggle");
  });

  it("preview-cycle / preview-open-file / preview-close：预览开着时 ↑↓ 切换、Enter 打开、Esc 关闭", () => {
    usePreview.getState().openPreview([FILE_A, { ...FILE_A, name: "b.txt", path: "C:\\b.txt" }], 0);
    (api.openItem as unknown as Mock).mockClear();
    fire({ key: "ArrowDown" });
    expect(usePreview.getState().index).toBe(1);
    fire({ key: "ArrowUp" });
    expect(usePreview.getState().index).toBe(0);
    fire({ key: "Enter" });
    expect(api.openItem as unknown as Mock).toHaveBeenCalledWith("C:\\a.txt");
    fire({ key: "Escape" });
    expect(usePreview.getState().queue).toEqual([]);
    covered.add("preview-cycle");
    covered.add("preview-open-file");
    covered.add("preview-close");
  });
});

describe("列表选择", () => {
  it("sel-arrow：方向键移动选择，Shift 范围选", () => {
    fire({ key: "ArrowDown" });
    expect(h.onArrow).toHaveBeenCalledWith("down", false);
    fire({ key: "ArrowRight", shift: true });
    expect(h.onArrow).toHaveBeenCalledWith("right", true);
    fire({ key: "ArrowLeft" });
    expect(h.onArrow).toHaveBeenCalledWith("left", false);
    fire({ key: "ArrowUp" });
    expect(h.onArrow).toHaveBeenCalledWith("up", false);
    covered.add("sel-arrow");
  });

  it("sel-page：PgDn / PgUp 翻页移动", () => {
    fire({ key: "PageDown" });
    expect(h.onNav).toHaveBeenCalledWith("pagedown", false);
    fire({ key: "PageUp", shift: true });
    expect(h.onNav).toHaveBeenCalledWith("pageup", true);
    covered.add("sel-page");
  });

  it("sel-homeend：Home / End 跳首尾", () => {
    fire({ key: "Home" });
    expect(h.onNav).toHaveBeenCalledWith("home", false);
    fire({ key: "End", shift: true });
    expect(h.onNav).toHaveBeenCalledWith("end", true);
    covered.add("sel-homeend");
  });

  it("select-all：Ctrl+A 全选", () => {
    fire({ key: "a", ctrl: true });
    expect(h.onSelectAll).toHaveBeenCalledOnce();
    covered.add("select-all");
  });

  it("sel-clear：Esc 先关窗格内搜索；无搜索时清空选择", () => {
    usePanes.getState().setSearch(tabId, "abc");
    fire({ key: "Escape" });
    expect(usePanes.getState().tabs[tabId]?.search).toBeNull();
    // 搜索关闭同时已清空选择（setSearch 语义）
    usePanes.getState().setSelected(tabId, ["C:\\dir\\a.txt"], "C:\\dir\\a.txt");
    fire({ key: "Escape" });
    expect(usePanes.getState().tabs[tabId]?.selected).toEqual([]);
    covered.add("sel-clear");
  });
});

describe("文件操作", () => {
  it("open：Enter 打开选中项", () => {
    fire({ key: "Enter" });
    expect(h.onEnter).toHaveBeenCalledOnce();
    covered.add("open");
  });

  it("rename：F2 就地重命名", () => {
    fire({ key: "F2" });
    expect(h.onRename).toHaveBeenCalledOnce();
    covered.add("rename");
  });

  it("delete / delete-permanent：Delete 回收站，Shift+Delete 永久删除", () => {
    fire({ key: "Delete" });
    expect(h.onDelete).toHaveBeenLastCalledWith(false);
    fire({ key: "Delete", shift: true });
    expect(h.onDelete).toHaveBeenLastCalledWith(true);
    covered.add("delete");
    covered.add("delete-permanent");
  });

  it("clipboard：Ctrl+C / X / V 复制 / 剪切 / 粘贴", () => {
    fire({ key: "c", ctrl: true });
    expect(h.onCopy).toHaveBeenLastCalledWith(false);
    fire({ key: "x", ctrl: true });
    expect(h.onCopy).toHaveBeenLastCalledWith(true);
    fire({ key: "v", ctrl: true });
    expect(h.onPaste).toHaveBeenCalledOnce();
    covered.add("clipboard");
  });

  it("new-folder：Ctrl+Shift+N 新建文件夹", () => {
    fire({ key: "n", ctrl: true, shift: true });
    expect(h.onNewFolder).toHaveBeenCalledOnce();
    covered.add("new-folder");
  });

  it("properties：Alt+Enter 打开属性", () => {
    expect(fire({ key: "Enter", alt: true }).prevented).toBe(true);
    expect(h.onProperties).toHaveBeenCalledOnce();
    covered.add("properties");
  });

  it("context-menu：Shift+F10 与 ContextMenu 键呼出右键菜单", () => {
    fire({ key: "F10", shift: true });
    expect(h.onContextMenu).toHaveBeenCalledOnce();
    fire({ key: "ContextMenu" });
    expect(h.onContextMenu).toHaveBeenCalledTimes(2);
    covered.add("context-menu");
  });

  it("undo：Ctrl+Z 弹出撤销栈并执行逆操作", async () => {
    const { useUndo } = await import("../undo");
    useUndo.getState().push({ kind: "rename", from: "C:\\dir\\a.txt", to: "C:\\dir\\b.txt" });
    fire({ key: "z", ctrl: true });
    await Promise.resolve();
    expect(api.renameItem as unknown as Mock).toHaveBeenCalledWith("C:\\dir\\b.txt", "a.txt");
    expect(useUndo.getState().stack).toEqual([]);
    covered.add("undo");
  });

  it("redo：Ctrl+Y / Ctrl+Shift+Z 按原方向重做刚撤销的操作", async () => {
    const { useUndo } = await import("../undo");
    useUndo.getState().push({ kind: "rename", from: "C:\\dir\\a.txt", to: "C:\\dir\\b.txt" });
    fire({ key: "z", ctrl: true });
    await Promise.resolve();
    (api.renameItem as unknown as Mock).mockClear();
    // Ctrl+Y：重做 = 改回新名
    fire({ key: "y", ctrl: true });
    await Promise.resolve();
    expect(api.renameItem as unknown as Mock).toHaveBeenCalledWith("C:\\dir\\a.txt", "b.txt");
    expect(useUndo.getState().redoStack).toEqual([]);
    expect(useUndo.getState().stack).toHaveLength(1);
    // Ctrl+Shift+Z 等效：再撤销后以 Shift 组合键重做
    fire({ key: "z", ctrl: true });
    await Promise.resolve();
    (api.renameItem as unknown as Mock).mockClear();
    fire({ key: "Z", ctrl: true, shift: true });
    await Promise.resolve();
    expect(api.renameItem as unknown as Mock).toHaveBeenCalledWith("C:\\dir\\a.txt", "b.txt");
    covered.add("redo");
  });
});

describe("首字母跳转（type-ahead）", () => {
  it("type-ahead：字符累积前缀匹配并选中，超时后重新累积", () => {
    vi.useFakeTimers();
    try {
      const entries = [
        { ...FILE_A, name: "a.txt", path: "C:\\dir\\a.txt" },
        { ...FILE_A, name: "ab.txt", path: "C:\\dir\\ab.txt" },
        { ...FILE_A, name: "b.md", path: "C:\\dir\\b.md" },
      ];
      h.getSnapshot.mockReturnValue({ entries, selected: [] });
      fire({ key: "a" });
      expect(h.revealEntry).toHaveBeenLastCalledWith("C:\\dir\\a.txt");
      // 输入缓冲与命中经 useUi.typeAhead 回显（列表角落定位 pill）
      expect(useUi.getState().typeAhead).toEqual({ buf: "a", hit: "a.txt" });
      fire({ key: "b" });
      expect(h.revealEntry).toHaveBeenLastCalledWith("C:\\dir\\ab.txt");
      expect(useUi.getState().typeAhead).toEqual({ buf: "ab", hit: "ab.txt" });
      // 停顿超时：缓冲清空，单字符重新匹配
      vi.advanceTimersByTime(1100);
      expect(useUi.getState().typeAhead).toBeNull();
      fire({ key: "b" });
      expect(h.revealEntry).toHaveBeenLastCalledWith("C:\\dir\\b.md");
      covered.add("type-ahead");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("清单对齐（lib/shortcuts.ts）", () => {
  it("scope=global 清单逐条有测试覆盖", () => {
    const missing = GLOBAL_SHORTCUT_IDS.filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });

  it("测试覆盖不超出清单（防改名后残留孤儿覆盖）", () => {
    const extra = [...covered].filter((id) => !GLOBAL_SHORTCUT_IDS.includes(id));
    expect(extra).toEqual([]);
  });
});
