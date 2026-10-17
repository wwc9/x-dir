import { create } from "zustand";
import type { Sort, ViewMode } from "../lib/ipc";
import { parentPath } from "../lib/path";
import { useHistory } from "./history";
import { useLayout } from "./layout";
import { useSettings } from "./settings";

export interface TabUi {
  history: string[];
  historyIndex: number;
  viewMode: ViewMode;
  sort: Sort;
  selected: string[];
  anchor: string | null;
  refreshTick: number;
  total: number;
  editing: string | null;
  /** 当前目录加载错误（地址栏标红依据，§6.10） */
  error: string | null;
  /** V2 递归搜索：非 null = 搜索模式（值为查询词） */
  search: string | null;
  /** 视图内过滤（Ctrl+E）：非 null = 过滤态（值为过滤词，Rust 端 nameFilter）。
   *  与递归搜索（search）互斥展示：搜索浮层打开期间过滤条隐藏 */
  filter: string | null;
  /** 按路径记忆的选中集（导航离开时快照，回到该目录恢复；上限 SEL_MEMORY_MAX）。
   *  anchor 一并保存：Shift 范围选在恢复后延续离开前的基准 */
  selMemory: Record<string, { paths: string[]; anchor: string | null }>;
}

/** 选择记忆条目上限（单标签）：防长会话无界增长，超出丢最旧 */
export const SEL_MEMORY_MAX = 50;

/** 写入选择记忆：旧条目靠后 = 最旧在前，超限丢头部；空选 = 清除该目录记忆 */
function rememberSel(
  memory: Record<string, { paths: string[]; anchor: string | null }>,
  path: string,
  selected: string[],
  anchor: string | null,
): Record<string, { paths: string[]; anchor: string | null }> {
  const next: Record<string, { paths: string[]; anchor: string | null }> = {};
  for (const [k, v] of Object.entries(memory)) {
    if (k !== path) next[k] = v;
  }
  if (!selected.length) return next;
  next[path] = { paths: selected, anchor };
  const keys = Object.keys(next);
  if (keys.length > SEL_MEMORY_MAX) {
    for (const k of keys.slice(0, keys.length - SEL_MEMORY_MAX)) delete next[k];
  }
  return next;
}

/** 导航换目录时的选中处理：先快照旧目录选中，再按记忆恢复新目录（可开关）。
 *  无记忆 = 清空（与旧行为一致） */
function swapSelection(
  tabs: Record<string, TabUi>,
  tabId: string,
  fromPath: string,
  toPath: string,
): Partial<TabUi> {
  const ui = tabs[tabId];
  if (!ui) return {};
  const remember = useSettings.getState().rememberSelection;
  const memory = remember
    ? rememberSel(ui.selMemory, fromPath, ui.selected, ui.anchor)
    : ui.selMemory;
  const restored = remember ? (memory[toPath]?.paths ?? []) : [];
  return {
    selMemory: memory,
    selected: restored,
    anchor: remember ? (memory[toPath]?.anchor ?? null) : null,
  };
}

interface PanesStore {
  tabs: Record<string, TabUi>;
  ensure(tabId: string, defaults: { viewMode: ViewMode; sort: Sort }): void;
  navigate(tabId: string, path: string): void;
  back(tabId: string): void;
  forward(tabId: string): void;
  up(tabId: string): void;
  setView(tabId: string, viewMode: ViewMode): void;
  setSort(tabId: string, sort: Sort): void;
  setSelected(tabId: string, selected: string[], anchor: string | null): void;
  setEditing(tabId: string, editing: string | null): void;
  setTotal(tabId: string, total: number): void;
  setError(tabId: string, error: string | null): void;
  setSearch(tabId: string, query: string | null): void;
  /** 视图内过滤（Ctrl+E）：null = 关闭；空串 = 过滤条开着待输入 */
  setFilter(tabId: string, query: string | null): void;
  bumpRefresh(tabId: string): void;
  bumpAffected(dirs: string[]): void;
  currentPathOf(tabId: string): string | null;
}

function patch(
  tabs: Record<string, TabUi>,
  tabId: string,
  p: Partial<TabUi>,
): Record<string, TabUi> {
  const cur = tabs[tabId];
  if (!cur) return tabs;
  return { ...tabs, [tabId]: { ...cur, ...p } };
}

// 目录监控/任务完成事件的合并窗口（§6.8）：notify 对一次文件操作会连发多条
// dir-changed，job-done 还会再补一轮；逐条 bumpRefresh 会让列表反复重拉
// （跨窗格拖放闪烁刷新的根因）。事件先进待处理集，窗口期至多整批 flush 一次；
// flush 期间新到的事件进下一窗口。模块级：与 store 生命周期一致
const BUMP_AFFECTED_WINDOW_MS = 250;
let pendingDirs = new Set<string>();
let pendingTimer: number | null = null;

export const usePanes = create<PanesStore>()((set, get) => ({
  tabs: {},

  ensure(tabId, defaults) {
    if (!tabId || get().tabs[tabId]) return;
    set((s) => ({
      tabs: {
        ...s.tabs,
        [tabId]: {
          history: [],
          historyIndex: -1,
          viewMode: defaults.viewMode,
          sort: defaults.sort,
          selected: [],
          anchor: null,
          refreshTick: 0,
          total: 0,
          editing: null,
          error: null,
          search: null,
          filter: null,
          selMemory: {},
        },
      },
    }));
  },

  navigate(tabId, path) {
    const ui = get().tabs[tabId];
    if (!ui || ui.history[ui.historyIndex] === path) return;
    const from = ui.history[ui.historyIndex];
    const history = [...ui.history.slice(0, ui.historyIndex + 1), path];
    set((s) => ({
      tabs: patch(s.tabs, tabId, {
        history,
        historyIndex: history.length - 1,
        editing: null,
        error: null,
        search: null,
        // 过滤是"视图局部"工具：进入新目录即还原完整列表（后退/前进不清，
        // 与 search 同语义——回到原目录时过滤视角仍在）
        filter: null,
        ...swapSelection(s.tabs, tabId, from, path),
      }),
    }));
    useLayout.getState().setTabPath(tabId, path);
    useHistory.getState().record(path); // 全局浏览历史（顶栏下拉）
  },

  back(tabId) {
    const ui = get().tabs[tabId];
    if (!ui || ui.historyIndex <= 0) return;
    const idx = ui.historyIndex - 1;
    const from = ui.history[ui.historyIndex];
    const to = ui.history[idx];
    set((s) => ({
      tabs: patch(s.tabs, tabId, { historyIndex: idx, ...swapSelection(s.tabs, tabId, from, to) }),
    }));
    useLayout.getState().setTabPath(tabId, to);
  },

  forward(tabId) {
    const ui = get().tabs[tabId];
    if (!ui || ui.historyIndex >= ui.history.length - 1) return;
    const idx = ui.historyIndex + 1;
    const from = ui.history[ui.historyIndex];
    const to = ui.history[idx];
    set((s) => ({
      tabs: patch(s.tabs, tabId, { historyIndex: idx, ...swapSelection(s.tabs, tabId, from, to) }),
    }));
    useLayout.getState().setTabPath(tabId, to);
  },

  up(tabId) {
    const cur = get().currentPathOf(tabId);
    if (!cur) return;
    const parent = parentPath(cur);
    if (parent) get().navigate(tabId, parent);
  },

  setView(tabId, viewMode) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { viewMode }) }));
  },

  setSort(tabId, sort) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { sort }) }));
  },

  setSelected(tabId, selected, anchor) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { selected, anchor }) }));
  },

  setEditing(tabId, editing) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { editing }) }));
  },

  setTotal(tabId, total) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { total }) }));
  },

  setError(tabId, error) {
    const cur = get().tabs[tabId];
    if (cur?.error === error) return;
    set((s) => ({ tabs: patch(s.tabs, tabId, { error }) }));
  },

  setSearch(tabId, query) {
    const cur = get().tabs[tabId];
    if (cur?.search === query) return;
    set((s) => ({
      tabs: patch(s.tabs, tabId, { search: query, selected: [], anchor: null }),
    }));
  },

  setFilter(tabId, query) {
    const cur = get().tabs[tabId];
    if (cur?.filter === query) return;
    set((s) => ({ tabs: patch(s.tabs, tabId, { filter: query }) }));
  },

  bumpRefresh(tabId) {
    const ui = get().tabs[tabId];
    if (!ui) return;
    set((s) => ({ tabs: patch(s.tabs, tabId, { refreshTick: ui.refreshTick + 1 }) }));
  },

  bumpAffected(dirs) {
    for (const d of dirs) pendingDirs.add(d.replace(/\\+$/, ""));
    if (pendingTimer !== null) return;
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      const hit = pendingDirs;
      pendingDirs = new Set<string>();
      for (const [tabId, ui] of Object.entries(get().tabs)) {
        const cur = ui.history[ui.historyIndex];
        if (cur && hit.has(cur.replace(/\\+$/, ""))) {
          get().bumpRefresh(tabId);
        }
      }
    }, BUMP_AFFECTED_WINDOW_MS);
  },

  currentPathOf(tabId) {
    return get().tabs[tabId]?.history[get().tabs[tabId]?.historyIndex ?? 0] ?? null;
  },
}));
