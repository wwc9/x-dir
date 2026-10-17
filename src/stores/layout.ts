import { create } from "zustand";

import {
  applyPreset,
  closePane,
  dfsPanes,
  mkTab,
  moveTab as treeMoveTab,
  paneIds,
  setPaneColWidths as treeSetPaneColWidths,
  setSizes as treeSetSizes,
  splitPane,
  swapPanes as treeSwapPanes,
  updatePane,
  updateTab,
  type LayoutNode,
  type PaneNode,
  type Preset,
  type SplitDir,
} from "../lib/layoutTree";
import { THIS_PC } from "../lib/ipc";

interface LayoutStore {
  tree: LayoutNode | null;
  activePaneId: string | null;
  /** 复制/移动到窗格的"目标窗格"记忆（源窗格 id → 上次选过的目标 id，会话级）；
   *  Ctrl+Shift+C/X 直达该目标，未记忆时回落 DFS 序首个其他窗格 */
  paneTargets: Record<string, string>;
  init(tree: LayoutNode): void;
  setActive(paneId: string): void;
  activePane(): PaneNode | null;
  activeTabId(): string | null;
  activePath(): string;
  /** 源窗格的传输目标窗格：显式记忆优先，否则 DFS 序首个其他窗格 */
  paneTargetOf(paneId: string): string | null;
  setPaneTarget(fromPaneId: string, toPaneId: string): void;
  split(dir: SplitDir): void;
  splitAt(paneId: string, dir: SplitDir): void;
  /** 交换两窗格位置（互换 tabs/activeTab）；活动焦点留在发起方 a */
  exchangePanes(a: string, b: string): void;
  close(paneId: string): void;
  preset(p: Preset): void;
  /** 新标签：缺省继承本窗格当前路径（无标签时回落"此电脑"） */
  newTab(paneId: string, path?: string): void;
  /** 复制标签：在原位后插入同路径新标签并激活 */
  duplicateTab(paneId: string, tabIndex: number): void;
  closeTab(paneId: string, tabIndex: number): void;
  /** 关闭除 keepIndex 外的全部标签（右键菜单） */
  closeOtherTabs(paneId: string, keepIndex: number): void;
  /** 关闭 fromIndex 及其右侧的全部标签（右键菜单） */
  closeTabsRight(paneId: string, fromIndex: number): void;
  moveTab(fromPaneId: string, tabIndex: number, toPaneId: string): void;
  activateTab(paneId: string, tabIndex: number): void;
  setTabPath(tabId: string, path: string): void;
  setSizes(splitId: string, sizes: number[]): void;
  /** 窗格级列宽（每窗格独立，随工作区树持久化；拖拽中只写内存树，
   *  「上次会话」1s 防抖自动保存兜底落盘） */
  setPaneColWidths(paneId: string, colWidths: PaneNode["colWidths"]): void;
}

export const useLayout = create<LayoutStore>()((set, get) => ({
  tree: null,
  activePaneId: null,
  paneTargets: {},

  init(tree) {
    set({ tree, activePaneId: dfsPanes(tree)[0]?.id ?? null });
  },

  setActive(paneId) {
    set({ activePaneId: paneId });
  },

  activePane() {
    const { tree, activePaneId } = get();
    if (!tree || !activePaneId) return null;
    return dfsPanes(tree).find((p) => p.id === activePaneId) ?? null;
  },

  activeTabId() {
    const p = get().activePane();
    return p?.tabs[p.activeTab]?.id ?? null;
  },

  activePath() {
    const p = get().activePane();
    return p?.tabs[p.activeTab]?.path ?? THIS_PC;
  },

  split(dir) {
    const { activePaneId } = get();
    if (activePaneId) get().splitAt(activePaneId, dir);
  },

  splitAt(paneId, dir) {
    const { tree } = get();
    if (!tree) return;
    const before = paneIds(tree);
    const next = splitPane(tree, paneId, dir);
    const newPane = paneIds(next).find((id) => !before.includes(id));
    set({ tree: next, activePaneId: newPane ?? paneId });
  },

  exchangePanes(a, b) {
    const { tree } = get();
    if (!tree) return;
    const next = treeSwapPanes(tree, a, b);
    if (next === tree) return;
    // 活动焦点留在发起方：用户视角是"我的窗格换到了对方的内容"
    set({ tree: next, activePaneId: a });
  },

  close(paneId) {
    const { tree } = get();
    if (!tree) return;
    if (dfsPanes(tree).length <= 1) return; // 根唯一窗格禁止关闭
    const before = dfsPanes(tree).map((p) => p.id);
    const idx = before.indexOf(paneId);
    const next = closePane(tree, paneId);
    const after = dfsPanes(next);
    set({
      tree: next,
      activePaneId: after[Math.min(Math.max(idx, 0), after.length - 1)]?.id ?? null,
    });
  },

  preset(p) {
    const { tree } = get();
    if (!tree) return;
    const next = applyPreset(tree, p);
    set({ tree: next, activePaneId: dfsPanes(next)[0]?.id ?? null });
  },

  paneTargetOf(paneId) {
    const { tree, paneTargets } = get();
    if (!tree) return null;
    const others = dfsPanes(tree).filter((p) => p.id !== paneId);
    if (!others.length) return null;
    const explicit = paneTargets[paneId];
    if (explicit && others.some((p) => p.id === explicit)) return explicit;
    return others[0].id;
  },

  setPaneTarget(fromPaneId, toPaneId) {
    set((s) => ({ paneTargets: { ...s.paneTargets, [fromPaneId]: toPaneId } }));
  },

  newTab(paneId, path) {
    const { tree } = get();
    if (!tree) return;
    const pane = dfsPanes(tree).find((p) => p.id === paneId);
    // 缺省继承当前路径（分裂窗格同语义）；无标签回落"此电脑"
    const dest =
      path ?? pane?.tabs[pane.activeTab]?.path ?? THIS_PC;
    set({
      tree: updatePane(tree, paneId, (p) => ({
        ...p,
        tabs: [...p.tabs, mkTab(dest)],
        activeTab: p.tabs.length,
      })),
      activePaneId: paneId,
    });
  },

  duplicateTab(paneId, tabIndex) {
    const { tree } = get();
    if (!tree) return;
    const pane = dfsPanes(tree).find((p) => p.id === paneId);
    const src = pane?.tabs[tabIndex];
    if (!pane || !src) return;
    set({
      tree: updatePane(tree, paneId, (p) => {
        const tabs = [...p.tabs.slice(0, tabIndex + 1), mkTab(src.path), ...p.tabs.slice(tabIndex + 1)];
        return { ...p, tabs, activeTab: tabIndex + 1 };
      }),
      activePaneId: paneId,
    });
  },

  closeTab(paneId, tabIndex) {
    const { tree } = get();
    if (!tree) return;
    const pane = dfsPanes(tree).find((p) => p.id === paneId);
    if (!pane) return;
    if (pane.tabs.length <= 1) {
      if (dfsPanes(tree).length <= 1) {
        // 唯一窗格的唯一标签：导航到"此电脑"而非关闭
        set({
          tree: updatePane(tree, paneId, (p) => ({
            ...p,
            tabs: p.tabs.map((t, i) => (i === 0 ? { ...t, path: THIS_PC } : t)),
          })),
        });
      } else {
        get().close(paneId);
      }
      return;
    }
    set({
      tree: updatePane(tree, paneId, (p) => {
        const tabs = p.tabs.filter((_, i) => i !== tabIndex);
        return {
          ...p,
          tabs,
          activeTab: Math.min(p.activeTab, tabs.length - 1),
        };
      }),
    });
  },

  closeOtherTabs(paneId, keepIndex) {
    const { tree } = get();
    if (!tree) return;
    const pane = dfsPanes(tree).find((p) => p.id === paneId);
    const keep = pane?.tabs[keepIndex];
    if (!pane || !keep) return;
    set({
      tree: updatePane(tree, paneId, (p) => ({
        ...p,
        tabs: [keep],
        activeTab: 0,
      })),
    });
  },

  closeTabsRight(paneId, fromIndex) {
    const { tree } = get();
    if (!tree) return;
    set({
      tree: updatePane(tree, paneId, (p) => {
        const tabs = p.tabs.slice(0, fromIndex + 1);
        return { ...p, tabs, activeTab: Math.min(p.activeTab, tabs.length - 1) };
      }),
    });
  },

  moveTab(fromPaneId, tabIndex, toPaneId) {
    const { tree } = get();
    if (!tree) return;
    const next = treeMoveTab(tree, fromPaneId, tabIndex, toPaneId);
    if (next === tree) return;
    set({ tree: next, activePaneId: toPaneId });
  },

  activateTab(paneId, tabIndex) {
    const { tree } = get();
    if (!tree) return;
    set({
      tree: updatePane(tree, paneId, (p) => ({ ...p, activeTab: tabIndex })),
      activePaneId: paneId,
    });
  },

  setTabPath(tabId, path) {
    const { tree } = get();
    if (!tree) return;
    set({ tree: updateTab(tree, tabId, (t) => ({ ...t, path })) });
  },

  setSizes(splitId, sizes) {
    const { tree } = get();
    if (!tree) return;
    // 行主序网格：行边界由根组天然共享，列宽各行独立，无需跨组同步
    set({ tree: treeSetSizes(tree, splitId, sizes) });
  },

  setPaneColWidths(paneId, colWidths) {
    const { tree } = get();
    if (!tree || !colWidths) return;
    set({ tree: treeSetPaneColWidths(tree, paneId, colWidths) });
  },
}));
