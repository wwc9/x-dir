import { create } from "zustand";
import type { FileEntry, Sort, ViewMode } from "../lib/ipc";
import { dfsPanes } from "../lib/layoutTree";
import { parentPath } from "../lib/path";
import { useHistory } from "./history";
import { useLayout } from "./layout";
import { useNavTree } from "./navtree";
import { useSettings } from "./settings";

/** 导航树联动定位（树可见时把展开/高亮对齐到新路径）：统一从导航动作进入，
 *  不再跟随行点击——点文件行会把用户手动展开的树分支折叠掉（2026-11-27
 *  审查修复），只有真正的目录切换才改写树状态 */
function relocateTree(path: string): void {
  if (!useSettings.getState().navTreeVisible) return;
  useNavTree.getState().locate(path);
}

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
  /** 乐观插入的新建文件夹合成行（2026-11-11 Explorer 式新建）：createDir 在途
   *  时先上屏（点击到出现零延迟），软刷新带回真实条目（同 path）后让位 */
  pendingNew: FileEntry | null;
  /** 当前目录加载错误（地址栏标红依据，§6.10） */
  error: string | null;
  /** V2 递归搜索：非 null = 搜索模式（值为查询词） */
  search: string | null;
  /** 窗格搜索的类型选择（"all"/"files"/"dirs"/常用类型预设 key；组合 ext: 词随查询下发） */
  searchType: string;
  /** 窗格搜索是否穿透子文件夹（2026-11-01）：false 仅当前目录（默认）、true 递归。
   *  搜索行为偏好，跨导航粘性（不随换目录重置，区别于 searchType） */
  searchDeep: boolean;
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
  /** 重命名后修剪选中：from 路径（含锚点）原地替换为 to，其余不动（2026-11-27
   *  幽灵选中修复：不替换则状态条继续显示旧路径、Delete 落空） */
  replaceSelection(tabId: string, from: string, to: string): void;
  /** 删除收尾后全局修剪选中：所有标签的选中集 / 锚点剔除已删路径（不区分
   *  标签——删除动作可能来自搜索结果、其他窗格；跨目录的旧记忆条目不在此
   *  清理，恢复时未命中自然失效） */
  purgeSelection(paths: string[]): void;
  setEditing(tabId: string, editing: string | null): void;
  /** 乐观插入合成行（新建文件夹 Explorer 式）：null = 清除 */
  setPendingNew(tabId: string, entry: FileEntry | null): void;
  setTotal(tabId: string, total: number): void;
  setError(tabId: string, error: string | null): void;
  setSearch(tabId: string, query: string | null): void;
  setSearchType(tabId: string, t: string): void;
  setSearchDeep(tabId: string, deep: boolean): void;
  /** 视图内过滤（Ctrl+E）：null = 关闭；空串 = 过滤条开着待输入 */
  setFilter(tabId: string, query: string | null): void;
  bumpRefresh(tabId: string): void;
  /** dirs 内目录有变更：immediate = 主动动作收尾同步刷新（零延迟）；缺省走
   *  250ms 合并窗（外部 watcher 批量事件防抖，§6.8）。命中判定 = 标签当前
   *  路径（layout 事实源）∈ dirs */
  bumpAffected(dirs: string[], opts?: { immediate?: boolean }): void;
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
// 主动刷新去重窗（2026-11-17 用户定案提速）：immediate 刷过的目录短暂记账，
// watcher 合并窗撞上同目录时跳过一次（X-Dir 内部动作同样触发 watcher，
// 防同一次变更双拉列表）；跳过一次性消费，后续真变更照常入窗
const RECENT_FLUSH_MS = 500;
const recentFlush = new Map<string, number>();

/** 刷新当前路径命中 dirs 的全部标签（immediate 与合并窗 flush 共用） */
function flushAffected(dirs: Set<string>) {
  for (const tabId of Object.keys(usePanes.getState().tabs)) {
    const cur = usePanes.getState().currentPathOf(tabId);
    if (cur && dirs.has(cur.replace(/\\+$/, ""))) {
      usePanes.getState().bumpRefresh(tabId);
    }
  }
  const now = Date.now();
  for (const [d, exp] of recentFlush) {
    if (exp <= now) recentFlush.delete(d);
  }
}

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
          pendingNew: null,
          error: null,
          search: null,
        searchType: "all",
          searchDeep: false,
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
        pendingNew: null,
        error: null,
        search: null,
        searchType: "all",
        // 过滤是"视图局部"工具：进入新目录即还原完整列表（后退/前进不清，
        // 与 search 同语义——回到原目录时过滤视角仍在）
        filter: null,
        ...swapSelection(s.tabs, tabId, from, path),
      }),
    }));
    useLayout.getState().setTabPath(tabId, path);
    relocateTree(path);
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
    relocateTree(to);
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
    relocateTree(to);
  },

  up(tabId) {
    const cur = get().currentPathOf(tabId);
    if (!cur) return;
    const parent = parentPath(cur);
    if (!parent) return;
    // history 头不等于当前显示路径（会话恢复/方案应用后从未导航过 = 空栈，
    // 或同 id 档复用造成漂移）时先把当前路径补入栈再上行——否则 navigate
    // 会以错位的历史头为基点，"上一级"不再指向当前窗格文件夹的父级
    //（2026-11-17 用户反馈）；补种同时保住「后退回到子目录」的历史链
    const ui = get().tabs[tabId];
    if (ui && ui.history[ui.historyIndex] !== cur) get().navigate(tabId, cur);
    get().navigate(tabId, parent);
  },

  setView(tabId, viewMode) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { viewMode }) }));
    // 同步写 layout 树 Tab：排序/视图随工作区持久化（重启/方案重建不回默认）
    useLayout.getState().setTabViewMode(tabId, viewMode);
  },

  setSort(tabId, sort) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { sort }) }));
    useLayout.getState().setTabSort(tabId, sort);
  },

  setSelected(tabId, selected, anchor) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { selected, anchor }) }));
  },

  replaceSelection(tabId, from, to) {
    const cur = get().tabs[tabId];
    if (!cur || !cur.selected.includes(from)) return;
    const norm = (p: string) => p.replace(/\\+$/, "").toLowerCase();
    const f = norm(from);
    const selected = cur.selected.map((p) => (norm(p) === f ? to : p));
    const anchor = cur.anchor && norm(cur.anchor) === f ? to : cur.anchor;
    set((s) => ({ tabs: patch(s.tabs, tabId, { selected, anchor }) }));
  },

  purgeSelection(paths) {
    if (!paths.length) return;
    const dead = new Set(paths.map((p) => p.replace(/\\+$/, "").toLowerCase()));
    let changed = false;
    const tabs = { ...get().tabs };
    for (const [id, ui] of Object.entries(tabs)) {
      const selected = ui.selected.filter((p) => !dead.has(p.replace(/\\+$/, "").toLowerCase()));
      const anchor =
        ui.anchor && !dead.has(ui.anchor.replace(/\\+$/, "").toLowerCase()) ? ui.anchor : null;
      if (selected.length !== ui.selected.length || anchor !== ui.anchor) {
        tabs[id] = { ...ui, selected, anchor };
        changed = true;
      }
    }
    if (changed) set({ tabs });
  },

  setEditing(tabId, editing) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { editing }) }));
  },

  setPendingNew(tabId, entry) {
    set((s) => ({ tabs: patch(s.tabs, tabId, { pendingNew: entry }) }));
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

  setSearchType(tabId, t) {
    const cur = get().tabs[tabId];
    if (cur?.searchType === t) return;
    set((s) => ({ tabs: patch(s.tabs, tabId, { searchType: t }) }));
  },

  setSearchDeep(tabId, deep) {
    const cur = get().tabs[tabId];
    if (cur?.searchDeep === deep) return;
    set((s) => ({ tabs: patch(s.tabs, tabId, { searchDeep: deep }) }));
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

  bumpAffected(dirs, opts) {
    // 主动动作收尾立即刷新（2026-11-17 用户定案提速）：不再等 250ms 合并窗；
    // 同批 watcher 待刷项一并清除并在去重窗记账（内部动作稍后必触发 watcher）
    if (opts?.immediate) {
      const hit = new Set(dirs.map((d) => d.replace(/\\+$/, "")));
      for (const d of hit) {
        pendingDirs.delete(d);
        recentFlush.set(d, Date.now() + RECENT_FLUSH_MS);
      }
      flushAffected(hit);
      return;
    }
    // 外部 watcher 通道保持合并窗：刚被主动刷新过的目录跳过一次
    for (const d of dirs) {
      const nd = d.replace(/\\+$/, "");
      const exp = recentFlush.get(nd);
      if (exp !== undefined && exp > Date.now()) {
        recentFlush.delete(nd);
        continue;
      }
      pendingDirs.add(nd);
    }
    if (!pendingDirs.size || pendingTimer !== null) return;
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      const hit = pendingDirs;
      pendingDirs = new Set<string>();
      flushAffected(hit);
    }, BUMP_AFFECTED_WINDOW_MS);
  },

  currentPathOf(tabId) {
    // 标签当前路径以 layout 树为唯一事实源（2026-11-17 用户反馈「返回上一级
    // 不针对当前窗格文件夹」根因）：panes store 的 history 只在用户导航时生长，
    // 会话恢复/方案应用重建标签后它空缺或整体漂移——旧实现只读 history，
    // up/目录监控匹配（bumpAffected）便对错目录或失灵
    const { tree } = useLayout.getState();
    if (!tree) return null;
    for (const p of dfsPanes(tree)) {
      const t = p.tabs[p.activeTab];
      if (t?.id === tabId) return t.path;
    }
    return null;
  },
}));
