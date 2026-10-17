import { describe, expect, it } from "vitest";

import {
  applyPreset,
  closePane,
  clampRatio,
  dfsPanes,
  mkPane,
  mkTab,
  moveTab,
  paneIds,
  setPaneColWidths,
  setRatio,
  setSizes,
  splitPane,
  swapPanes,
  treeDividers,
  updatePane,
  type LayoutNode,
  type PaneNode,
  type Preset,
} from "../layoutTree";
import { THIS_PC } from "../ipc";

describe("swapPanes", () => {
  it("互换 tabs/activeTab，窗格 id 与几何位置不动", () => {
    let tree: LayoutNode = applyPreset(mkPane("C:\\"), "1x2");
    const [a, b] = dfsPanes(tree);
    tree = updatePane(tree, a.id, (p) => ({
      ...p,
      tabs: [mkTab("C:\\left-1"), mkTab("C:\\left-2")],
      activeTab: 1,
    }));
    tree = updatePane(tree, b.id, (p) => ({
      ...p,
      tabs: [mkTab("E:\\right")],
      activeTab: 0,
    }));
    const before = dfsPanes(tree);

    const next = swapPanes(tree, a.id, b.id);

    const after = dfsPanes(next);
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id)); // id 与位置不动
    expect(after[0].tabs.map((t) => t.path)).toEqual(["E:\\right"]); // 内容互换
    expect(after[1].tabs.map((t) => t.path)).toEqual(["C:\\left-1", "C:\\left-2"]);
    expect(after[1].activeTab).toBe(1); // 激活态随 tabs 一起走
    expect(tree.type !== "pane" && before[0].tabs[0].path === "C:\\left-1").toBe(true); // 原树不被修改
  });

  it("同 id / 窗格不存在时返回原树", () => {
    const tree = applyPreset(mkPane("C:\\"), "1x2");
    const [a] = dfsPanes(tree);
    expect(swapPanes(tree, a.id, a.id)).toBe(tree);
    expect(swapPanes(tree, a.id, "pane-nope")).toBe(tree);
  });
});

describe("splitPane", () => {
  it("叶原位替换为 split，新窗格继承路径，原树不被修改", () => {
    const tree = mkPane("C:\\Work");
    const snapshot = JSON.stringify(tree);
    const next = splitPane(tree, tree.id, "horizontal");

    expect(tree.type).toBe("pane");
    expect(JSON.stringify(tree)).toBe(snapshot);
    expect(next.type).toBe("split");
    const panes = dfsPanes(next);
    expect(panes).toHaveLength(2);
    expect(panes[0].tabs[0].path).toBe("C:\\Work");
    expect(panes[1].tabs[0].path).toBe("C:\\Work");
  });

  it("嵌套窗格分裂后总数正确", () => {
    const tree = applyPreset(mkPane("C:\\"), "2x2");
    const target = dfsPanes(tree)[1];
    const next = splitPane(tree, target.id, "vertical");
    expect(dfsPanes(next)).toHaveLength(5);
  });
});

describe("closePane", () => {
  it("移除窗格且树折叠", () => {
    let tree: LayoutNode = applyPreset(mkPane("C:\\a"), "1x2");
    expect(dfsPanes(tree)).toHaveLength(2);
    tree = closePane(tree, dfsPanes(tree)[0].id);
    expect(tree.type).toBe("pane");
    expect(dfsPanes(tree)).toHaveLength(1);
  });

  it("深层折叠：split 只剩一个子时上提", () => {
    let tree: LayoutNode = applyPreset(mkPane("C:\\"), "2x2");
    const panes = dfsPanes(tree);
    tree = closePane(tree, panes[0].id);
    tree = closePane(tree, dfsPanes(tree)[0].id);
    expect(dfsPanes(tree)).toHaveLength(2);
  });

  it("根唯一窗格时关闭为无操作", () => {
    const tree = mkPane("C:\\");
    const next = closePane(tree, tree.id);
    expect(next).toBe(tree);
  });
});

describe("ratio / sizes", () => {
  it("ratio 钳制 0.15~0.85", () => {
    expect(clampRatio(0.01)).toBe(0.15);
    expect(clampRatio(0.99)).toBe(0.85);
    expect(clampRatio(0.5)).toBe(0.5);
  });

  it("setRatio / setSizes 只命中目标 split", () => {
    const tree = applyPreset(mkPane("C:\\"), "2x2");
    const root = tree as Extract<LayoutNode, { type: "split" }>;

    const next = setRatio(tree, root.id, 0.9);
    expect((next as Extract<LayoutNode, { type: "split" }>).ratio).toBe(0.85);

    const next2 = setSizes(tree, root.id, [70, 30]);
    expect(
      (next2 as Extract<LayoutNode, { type: "split" }>).sizes,
    ).toEqual([70, 30]);
  });

  it("行主序：setSizes 只命中所在行组，不跨行", () => {
    const tree = applyPreset(mkPane("C:\\"), "2x2");
    const root = tree as Extract<LayoutNode, { type: "split" }>;
    const [row0] = root.children as unknown as [
      { id: string },
      { id: string; sizes?: number[] },
    ];
    const next = setSizes(tree, row0.id, [70, 30]);
    const nRoot = next as Extract<LayoutNode, { type: "split" }>;
    const [n0, n1] = nRoot.children as unknown as [
      { sizes?: number[] },
      { sizes?: number[] },
    ];
    expect(n0.sizes).toEqual([70, 30]);
    expect(n1.sizes).toBeUndefined(); // 另一行不受影响
  });
});

describe("applyPreset（行主序便签网格）", () => {
  it("2x2：根纵向两行，每行横向两格", () => {
    const tree = applyPreset(mkPane("C:\\"), "2x2");
    expect(tree.type).toBe("split");
    expect((tree as Extract<LayoutNode, { type: "split" }>).dir).toBe(
      "vertical",
    );
    expect(dfsPanes(tree)).toHaveLength(4);
  });

  it("按 DFS 序复用现有路径，不足补“此电脑”", () => {
    let tree: LayoutNode = mkPane("C:\\A1");
    tree = splitPane(tree, dfsPanes(tree)[0].id, "horizontal");
    tree = splitPane(tree, dfsPanes(tree)[1].id, "horizontal");
    const seeded = updatePane(tree, dfsPanes(tree)[0].id, (p) => ({
      ...p,
      tabs: p.tabs.map((t) => ({ ...t, path: "C:\\A1" })),
    }));
    const next = applyPreset(seeded, "2x2");
    const panes = dfsPanes(next);
    expect(panes).toHaveLength(4);
    expect(panes[0].tabs[0].path).toBe("C:\\A1");
    expect(panes[3].tabs[0].path).toBe(THIS_PC);
  });

  it("混合预设 1+2：上 1 格 + 下 2 格", () => {
    const tree = applyPreset(mkPane("C:\\"), "1+2");
    expect(tree.type).toBe("split");
    expect((tree as Extract<LayoutNode, { type: "split" }>).dir).toBe(
      "vertical",
    );
    const rows = (tree as Extract<LayoutNode, { type: "split" }>)
      .children as unknown as [LayoutNode, LayoutNode];
    expect(dfsPanes(rows[0])).toHaveLength(1);
    expect(dfsPanes(rows[1])).toHaveLength(2);
  });

  it("混合预设 2+1：上 2 格 + 下 1 格", () => {
    const tree = applyPreset(mkPane("C:\\"), "2+1");
    const rows = (tree as Extract<LayoutNode, { type: "split" }>)
      .children as unknown as [LayoutNode, LayoutNode];
    expect(dfsPanes(rows[0])).toHaveLength(2);
    expect(dfsPanes(rows[1])).toHaveLength(1);
  });

  it("三联预设 3x1 / 1x3", () => {
    expect(dfsPanes(applyPreset(mkPane("C:\\"), "3x1"))).toHaveLength(3);
    expect(dfsPanes(applyPreset(mkPane("C:\\"), "1x3"))).toHaveLength(3);
  });

  it("2x3 预设共 6 格且 id 唯一", () => {
    const next = applyPreset(mkPane("C:\\"), "2x3");
    expect(dfsPanes(next)).toHaveLength(6);
    expect(paneIds(next).length).toBe(6);
  });

  it("六宫格·横 3x2：根纵向三行，每行两格", () => {
    const tree = applyPreset(mkPane("C:\\"), "3x2");
    const root = tree as Extract<LayoutNode, { type: "split" }>;
    expect(root.dir).toBe("vertical");
    expect(root.children).toHaveLength(3);
    expect(root.children.map((r) => dfsPanes(r).length)).toEqual([2, 2, 2]);
  });

  it("顶栏 + 双侧栏 1+3：上 1 行 + 下 3 栏，根占比 1:3", () => {
    const tree = applyPreset(mkPane("C:\\"), "1+3");
    const root = tree as Extract<LayoutNode, { type: "split" }>;
    expect(root.dir).toBe("vertical");
    expect(root.children.map((r) => dfsPanes(r).length)).toEqual([1, 3]);
    expect(root.sizes![0]).toBeCloseTo(25, 5);
    expect(root.sizes![1]).toBeCloseTo(75, 5);
  });

  it("左侧栏 1|2 / 右侧栏 2|1：根横向，权重归一化为百分比", () => {
    const left = applyPreset(mkPane("C:\\"), "1|2");
    const lRoot = left as Extract<LayoutNode, { type: "split" }>;
    expect(lRoot.dir).toBe("horizontal");
    expect(lRoot.children.map((c) => dfsPanes(c).length)).toEqual([1, 2]);
    expect(lRoot.sizes![0]).toBeCloseTo(100 / 3, 5);
    expect(lRoot.sizes![1]).toBeCloseTo(200 / 3, 5);

    const right = applyPreset(mkPane("C:\\"), "2|1");
    const rRoot = right as Extract<LayoutNode, { type: "split" }>;
    expect(rRoot.dir).toBe("horizontal");
    expect(rRoot.children.map((c) => dfsPanes(c).length)).toEqual([2, 1]);
    expect(rRoot.sizes![0]).toBeCloseTo(200 / 3, 5);
    expect(rRoot.sizes![1]).toBeCloseTo(100 / 3, 5);
  });

  it("便当 bento-t / bento-l：结构同 2+1、1|2 但根均分（无 sizes）", () => {
    const top = applyPreset(mkPane("C:\\"), "bento-t");
    const tRoot = top as Extract<LayoutNode, { type: "split" }>;
    expect(tRoot.dir).toBe("vertical");
    expect(tRoot.children.map((r) => dfsPanes(r).length)).toEqual([2, 1]);
    expect(tRoot.sizes).toBeUndefined();

    const side = applyPreset(mkPane("C:\\"), "bento-l");
    const sRoot = side as Extract<LayoutNode, { type: "split" }>;
    expect(sRoot.dir).toBe("horizontal");
    expect(sRoot.children.map((c) => dfsPanes(c).length)).toEqual([1, 2]);
    expect(sRoot.sizes).toBeUndefined();
  });

  it("全部 16 种预设均可构建且窗格数正确", () => {
    const counts: Record<Preset, number> = {
      "1x1": 1,
      "1x2": 2,
      "2x1": 2,
      "1x3": 3,
      "3x1": 3,
      "2x2": 4,
      "2x3": 6,
      "3x2": 6,
      "3x3": 9,
      "1+2": 3,
      "2+1": 3,
      "1+3": 4,
      "1|2": 3,
      "2|1": 3,
      "bento-t": 3,
      "bento-l": 3,
    };
    for (const [p, n] of Object.entries(counts)) {
      expect(dfsPanes(applyPreset(mkPane("C:\\"), p as Preset))).toHaveLength(n);
    }
  });
});

describe("treeDividers（缩略图描线几何）", () => {
  const split = (n: LayoutNode) => n as Extract<LayoutNode, { type: "split" }>;

  it("单格无线段；两栏 1x2 有一条垂直中线（x.5 对齐）", () => {
    expect(treeDividers(mkPane("C:\\"), 24)).toEqual([]);
    const lines = treeDividers(applyPreset(mkPane("C:\\"), "1x2"), 24);
    // 内区 [1, 23]，切口相对内区 = round(22/2) = 11，线画在 1 + 11 + 0.5
    expect(lines).toEqual([[12.5, 1, 12.5, 23]]);
  });

  it("四宫格 2x2：十字形 = 上行、下行两条竖线段 + 一条横线，共线于中线", () => {
    const lines = treeDividers(applyPreset(mkPane("C:\\"), "2x2"), 24);
    const verticals = lines.filter(([x1, , x2]) => x1 === x2);
    const horizontals = lines.filter(([x1, , x2]) => x1 !== x2);
    // 竖分发生在每行内部：两行各一条线段，x 共线于 12.5
    expect(verticals).toEqual([
      [12.5, 1, 12.5, 12],
      [12.5, 13, 12.5, 23],
    ]);
    expect(horizontals).toEqual([[1, 12.5, 23, 12.5]]);
  });

  it("按 sizes 还原真实比例（1+2 顶栏占 1/3）", () => {
    const tree = applyPreset(mkPane("C:\\"), "1+2");
    expect(split(tree).sizes).toBeDefined();
    const lines = treeDividers(tree, 24);
    const [hLine] = lines.filter(([x1, , x2]) => x1 !== x2);
    // 切口 = 1 + round(22 × 1/3) = 8，线画在 8.5
    expect(hLine[1]).toBe(8.5);
  });

  it("任意树 / 任意尺寸：横切轴半整数对齐，延伸轴整数且都在内区", () => {
    for (const p of [
      "1x1", "2x1", "1x2", "3x1", "1x3", "2x2", "2x3", "3x2", "3x3",
      "1+2", "2+1", "1+3", "1|2", "2|1", "bento-t", "bento-l",
    ] as Preset[]) {
      for (const size of [18, 24, 28, 64]) {
        for (const [x1, y1, x2, y2] of treeDividers(applyPreset(mkPane("C:\\"), p), size)) {
          const inRange = (v: number) => v >= 1 && v <= size - 1;
          if (x1 === x2) {
            // 垂直线：x 半整数，y 整数端点
            expect(x1 % 1).toBe(0.5);
            expect(Number.isInteger(y1)).toBe(true);
            expect(Number.isInteger(y2)).toBe(true);
            expect(y1).toBeLessThan(y2);
          } else {
            expect(y1 % 1).toBe(0.5);
            expect(Number.isInteger(x1)).toBe(true);
            expect(Number.isInteger(x2)).toBe(true);
            expect(x1).toBeLessThan(x2);
          }
          for (const v of [x1, y1, x2, y2]) expect(inRange(v)).toBe(true);
        }
      }
    }
  });

  it("极小尺寸不产生越界线段（钳制兜底）", () => {
    const lines = treeDividers(applyPreset(mkPane("C:\\"), "3x3"), 8);
    for (const [x1, y1, x2, y2] of lines) {
      expect(x1).toBeGreaterThanOrEqual(1);
      expect(x2).toBeLessThanOrEqual(7);
      expect(y1).toBeGreaterThanOrEqual(1);
      expect(y2).toBeLessThanOrEqual(7);
    }
  });
});

describe("updatePane", () => {
  it("不可变更新", () => {
    const tree = applyPreset(mkPane("C:\\"), "2x2");
    const target = dfsPanes(tree)[2];
    const next = updatePane(tree, target.id, (p) => ({
      ...p,
      tabs: [...p.tabs, { id: "t9", path: "D:\\" }],
    }));
    expect(dfsPanes(tree).find((p) => p.id === target.id)!.tabs).toHaveLength(1);
    expect(dfsPanes(next).find((p) => p.id === target.id)!.tabs).toHaveLength(2);
  });
});

describe("moveTab（V2 标签跨窗格拖动）", () => {
  function seed(): { tree: LayoutNode; from: PaneNode; to: PaneNode } {
    const tree = applyPreset(mkPane("C:\\"), "1x2");
    const [from, to] = dfsPanes(tree);
    // from 窗格三个标签
    return {
      tree: updatePane(tree, from.id, (p) => ({
        ...p,
        tabs: [mkTab("C:\\a"), mkTab("C:\\b"), mkTab("C:\\c")],
        activeTab: 2,
      })),
      from,
      to,
    };
  }

  it("移动中间标签：源表移除、目标表追加并激活", () => {
    const { tree, from, to } = seed();
    const moving = dfsPanes(tree).find((p) => p.id === from.id)!.tabs[1];
    const next = moveTab(tree, from.id, 1, to.id);
    const src = dfsPanes(next).find((p) => p.id === from.id)!;
    const dst = dfsPanes(next).find((p) => p.id === to.id)!;
    expect(src.tabs.map((t) => t.path)).toEqual(["C:\\a", "C:\\c"]);
    expect(src.activeTab).toBe(1); // 钳制到有效范围
    expect(dst.tabs).toHaveLength(2);
    expect(dst.tabs[1].id).toBe(moving.id); // 标签 id 不变（历史栈随之带走）
    expect(dst.activeTab).toBe(1);
  });

  it("移动激活标签后源激活索引钳制", () => {
    const { tree, from, to } = seed(); // activeTab = 2
    const next = moveTab(tree, from.id, 2, to.id);
    const src = dfsPanes(next).find((p) => p.id === from.id)!;
    expect(src.tabs).toHaveLength(2);
    expect(src.activeTab).toBe(1);
  });

  it("同窗格 / 源仅剩一个标签 / 越界索引 均为无操作", () => {
    const { tree, from, to } = seed();
    expect(moveTab(tree, from.id, 0, from.id)).toBe(tree);
    expect(moveTab(tree, to.id, 0, to.id)).toBe(tree); // 目标单标签窗格
    expect(moveTab(tree, from.id, 9, to.id)).toBe(tree); // 越界
    const single = mkPane("C:\\solo");
    expect(moveTab(single, single.id, 0, to.id)).toBe(single);
  });
});

describe("setPaneColWidths（窗格级列宽）", () => {
  it("只改目标窗格，其余窗格保持无 colWidths（独立不联动）", () => {
    const tree = applyPreset(mkPane("C:\\"), "1x2");
    const [a] = dfsPanes(tree);
    const cols = { name: 300, mtime: 140, type: 120, size: 90, loc: 180 };
    const next = setPaneColWidths(tree, a.id, cols);
    const [na, nb] = dfsPanes(next);
    expect(na.colWidths).toEqual(cols);
    expect(nb.colWidths).toBeUndefined();
    expect(dfsPanes(tree)[0].colWidths).toBeUndefined(); // 原树不可变
  });

  it("窗格不存在时原引用返回", () => {
    const tree = mkPane("C:\\");
    expect(setPaneColWidths(tree, "nope", { name: 1, mtime: 1, type: 1, size: 1, loc: 1 })).toBe(tree);
  });
});
