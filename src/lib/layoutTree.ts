// 分割树纯函数操作（§6.3.1）：旧树入、新树出，全部可单测。
// split 节点携带 id（渲染 key + ratio/sizes 写回目标）；sizes 为 react-resizable-panels 回写的百分比。

import { THIS_PC } from "./ipc";
import type { ColWidths } from "./columns";

export type SplitDir = "horizontal" | "vertical";

export interface Tab {
  id: string;
  path: string;
}

export interface PaneNode {
  type: "pane";
  id: string;
  tabs: Tab[];
  activeTab: number;
  /** 窗格级列宽（每窗格独立，随工作区树持久化）；
   *  缺省（旧档/未拖过）由读取端回落 settings.colWidths 全局默认 */
  colWidths?: ColWidths;
}

export interface SplitNode {
  type: "split";
  id: string;
  dir: SplitDir;
  ratio: number;
  sizes?: number[];
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;
/** 布局预设（16 种，§侧边栏布局预设）："行×列" 网格、"顶/底栏+N"、"左/右侧栏"、便当 */
export type Preset =
  | "1x1"
  | "2x1"
  | "1x2"
  | "3x1"
  | "1x3"
  | "2x2"
  | "2x3"
  | "3x2"
  | "3x3"
  | "1+2"
  | "2+1"
  | "1+3"
  | "1|2"
  | "2|1"
  | "bento-t"
  | "bento-l";

/// 预设规格：根沿 dir 分成 groups.length 段，每段沿垂直方向均分 groups[i] 格；
/// sizes = 根分割初始权重（构建时归一化为百分比），缺省均分
interface PresetSpec {
  dir: SplitDir;
  groups: number[];
  sizes?: number[];
}

const PRESET_SPECS: Record<Preset, PresetSpec> = {
  "1x1": { dir: "vertical", groups: [1] },
  "2x1": { dir: "vertical", groups: [1, 1] }, // 上下两行
  "1x2": { dir: "horizontal", groups: [1, 1] }, // 左右两栏
  "3x1": { dir: "vertical", groups: [1, 1, 1] }, // 三行
  "1x3": { dir: "horizontal", groups: [1, 1, 1] }, // 三栏
  "2x2": { dir: "vertical", groups: [2, 2] }, // 四宫格
  "2x3": { dir: "vertical", groups: [3, 3] }, // 六宫格·竖（两行三列）
  "3x2": { dir: "vertical", groups: [2, 2, 2] }, // 六宫格·横（三行两列）
  "3x3": { dir: "vertical", groups: [3, 3, 3] }, // 九宫格
  "1+2": { dir: "vertical", groups: [1, 2], sizes: [1, 2] }, // 顶栏 + 下左右
  "2+1": { dir: "vertical", groups: [2, 1], sizes: [2, 1] }, // 底栏 + 上左右
  "1+3": { dir: "vertical", groups: [1, 3], sizes: [1, 3] }, // 顶栏 + 双侧栏
  "1|2": { dir: "horizontal", groups: [1, 2], sizes: [1, 2] }, // 左侧栏 + 右上下
  "2|1": { dir: "horizontal", groups: [2, 1], sizes: [2, 1] }, // 右侧栏 + 左上下
  "bento-t": { dir: "vertical", groups: [2, 1] }, // 便当·上二下一（均分）
  "bento-l": { dir: "horizontal", groups: [1, 2] }, // 便当·左一右二（均分）
};

let seq = 0;
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

export function mkTab(path: string): Tab {
  return { id: newId("tab"), path };
}

export function mkPane(path: string): PaneNode {
  return { type: "pane", id: newId("pane"), tabs: [mkTab(path)], activeTab: 0 };
}

export function mkSplit(dir: SplitDir, children: LayoutNode[]): SplitNode {
  return {
    type: "split",
    id: newId("split"),
    dir,
    ratio: 1 / children.length,
    children,
  };
}

export function dfsPanes(node: LayoutNode): PaneNode[] {
  return node.type === "pane" ? [node] : node.children.flatMap(dfsPanes);
}

export function paneIds(node: LayoutNode): string[] {
  return dfsPanes(node).map((p) => p.id);
}

export function currentPath(p: PaneNode): string {
  return p.tabs[p.activeTab]?.path ?? THIS_PC;
}

export function updatePane(
  tree: LayoutNode,
  paneId: string,
  fn: (p: PaneNode) => PaneNode,
): LayoutNode {
  if (tree.type === "pane") {
    return tree.id === paneId ? fn(tree) : tree;
  }
  return {
    ...tree,
    children: tree.children.map((c) => updatePane(c, paneId, fn)),
  };
}

/** 窗格级列宽（每窗格独立，随工作区树持久化）：写入完整五列宽，不可变更新；
 *  无此窗格时原树原引用返回 */
export function setPaneColWidths(
  tree: LayoutNode,
  paneId: string,
  colWidths: ColWidths,
): LayoutNode {
  return updatePane(tree, paneId, (p) => ({ ...p, colWidths }));
}

export function updateTab(
  tree: LayoutNode,
  tabId: string,
  fn: (t: Tab) => Tab,
): LayoutNode {
  return updatePane(tree, paneByTabId(tree, tabId), (p) => ({
    ...p,
    tabs: p.tabs.map((t) => (t.id === tabId ? fn(t) : t)),
  }));
}

export function paneByTabId(tree: LayoutNode, tabId: string): string {
  for (const p of dfsPanes(tree)) {
    if (p.tabs.some((t) => t.id === tabId)) return p.id;
  }
  return "";
}

/// 分裂：叶原位替换为 split，新窗格继承原窗格当前路径
export function splitPane(
  tree: LayoutNode,
  paneId: string,
  dir: SplitDir,
): LayoutNode {
  if (tree.type === "pane") {
    if (tree.id !== paneId) return tree;
    return mkSplit(dir, [tree, mkPane(currentPath(tree))]);
  }
  return {
    ...tree,
    children: tree.children.map((c) => splitPane(c, paneId, dir)),
  };
}

/// 关闭窗格：父 split 剩单子时用该子替换（树折叠）；根唯一窗格时忽略
export function closePane(tree: LayoutNode, paneId: string): LayoutNode {
  if (tree.type === "pane") return tree;
  const children: LayoutNode[] = [];
  for (const c of tree.children) {
    if (c.type === "pane" && c.id === paneId) continue;
    children.push(closePane(c, paneId));
  }
  if (children.length === 0) return tree; // 不应发生：至少保留一个窗格
  if (children.length === 1) return children[0];
  return { ...tree, children };
}

/// 跨窗格移动标签（V2 标签拖动）：源窗格剩唯一标签时不移动（等价于关窗格，
/// 应走 closePane）；移动后目标窗格激活该标签，源窗格激活索引钳制。
export function moveTab(
  tree: LayoutNode,
  fromPaneId: string,
  tabIndex: number,
  toPaneId: string,
): LayoutNode {
  if (fromPaneId === toPaneId) return tree;
  const from = dfsPanes(tree).find((p) => p.id === fromPaneId);
  const tab = from?.tabs[tabIndex];
  if (!from || !tab || from.tabs.length <= 1) return tree;
  let next = updatePane(tree, fromPaneId, (p) => {
    const tabs = p.tabs.filter((_, i) => i !== tabIndex);
    return { ...p, tabs, activeTab: Math.min(p.activeTab, tabs.length - 1) };
  });
  next = updatePane(next, toPaneId, (p) => ({
    ...p,
    tabs: [...p.tabs, tab],
    activeTab: p.tabs.length,
  }));
  return next;
}

/// 交换两个窗格的位置：仅互换 tabs 与 activeTab——窗格 id 与几何位置不动，
/// 选中/视图/排序等按 tabId 记录的状态随 tabs 一起走。同 id 或任一窗格
/// 不存在时返回原树（引用相等，调用方可据此跳过 set）。
export function swapPanes(
  tree: LayoutNode,
  a: string,
  b: string,
): LayoutNode {
  if (a === b) return tree;
  const panes = dfsPanes(tree);
  const pa = panes.find((p) => p.id === a);
  const pb = panes.find((p) => p.id === b);
  if (!pa || !pb) return tree;
  const sub = (node: LayoutNode): LayoutNode => {
    if (node.type === "pane") {
      if (node.id === a) return { ...node, tabs: pb.tabs, activeTab: pb.activeTab };
      if (node.id === b) return { ...node, tabs: pa.tabs, activeTab: pa.activeTab };
      return node;
    }
    return { ...node, children: node.children.map(sub) };
  };
  return sub(tree);
}

const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;

export function clampRatio(r: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}

export function setRatio(
  tree: LayoutNode,
  splitId: string,
  ratio: number,
): LayoutNode {
  if (tree.type === "pane") return tree;
  return {
    ...tree,
    ratio: tree.id === splitId ? clampRatio(ratio) : tree.ratio,
    children: tree.children.map((c) => setRatio(c, splitId, ratio)),
  };
}

export function setSizes(
  tree: LayoutNode,
  splitId: string,
  sizes: number[],
): LayoutNode {
  if (tree.type === "pane") return tree;
  return {
    ...tree,
    sizes: tree.id === splitId ? sizes : tree.sizes,
    children: tree.children.map((c) => setSizes(c, splitId, sizes)),
  };
}

/// 预设重建（按 PRESET_SPECS：根沿 spec.dir 分段，段内沿垂直方向均分）。
/// 按 DFS 序复用现有窗格首标签路径，不足补"此电脑"；根 sizes 权重归一化为
/// 百分比（LayoutView 的 defaultSize 以 100 为总量）。
export function applyPreset(tree: LayoutNode, preset: Preset): LayoutNode {
  const spec = PRESET_SPECS[preset];
  const paths = dfsPanes(tree)
    .map(currentPath)
    .filter((p) => p !== THIS_PC);
  let i = 0;
  const cell = (): PaneNode => mkPane(paths[i++] ?? THIS_PC);
  const cross: SplitDir = spec.dir === "vertical" ? "horizontal" : "vertical";
  const seg = (n: number): LayoutNode =>
    n > 1 ? mkSplit(cross, Array.from({ length: n }, cell)) : cell();
  const root =
    spec.groups.length > 1
      ? mkSplit(spec.dir, spec.groups.map(seg))
      : seg(spec.groups[0]);
  if (spec.sizes && root.type === "split") {
    const sum = spec.sizes.reduce((a, b) => a + b, 0);
    return { ...root, sizes: spec.sizes.map((s) => (s / sum) * 100) };
  }
  return root;
}

/// 缩略图描线几何（Sidebar 方案缩略图与布局预设瓷砖共用）：
/// 树 → 内边距 pad 内的分割线段 [x1, y1, x2, y2]。1px 线画在 x.5 整数对齐
/// 坐标上保证像素锐利；分割线占位 1px，sizes 存在时按真实比例还原。
export function treeDividers(
  node: LayoutNode,
  size: number,
  pad = 1,
): [number, number, number, number][] {
  const lines: [number, number, number, number][] = [];

  const walk = (n: LayoutNode, x: number, y: number, w: number, h: number): void => {
    if (n.type !== "split" || w < 2 || h < 2) return;
    const kids = n.children;
    if (kids.length < 2) {
      for (const c of kids) walk(c, x, y, w, h);
      return;
    }
    const horiz = n.dir === "horizontal";
    const k = kids.length;
    const T = Math.max(horiz ? w : h, k);
    const sum = n.sizes ? n.sizes.reduce((a, b) => a + b, 0) : k;
    // 累积边界取整；钳制保证每段 ≥1px、分割线各占 1px 且不越界
    let prev = 0;
    let cum = 0;
    const cuts: number[] = [];
    for (let i = 1; i < k; i++) {
      cum += n.sizes ? n.sizes[i - 1] / sum : 1 / k;
      const cut = Math.min(
        T - 2 * (k - i) + 1,
        Math.max(prev + 2, Math.round(T * cum)),
      );
      cuts.push(cut);
      prev = cut;
    }
    let base = 0;
    kids.forEach((c, i) => {
      const end = i < k - 1 ? cuts[i] : T;
      if (horiz) {
        walk(c, x + base, y, end - base, h);
        if (i < k - 1) lines.push([x + end + 0.5, y, x + end + 0.5, y + h]);
      } else {
        walk(c, x, y + base, w, end - base);
        if (i < k - 1) lines.push([x, y + end + 0.5, x + w, y + end + 0.5]);
      }
      base = end + 1;
    });
  };

  walk(node, pad, pad, size - 2 * pad, size - 2 * pad);
  return lines;
}
