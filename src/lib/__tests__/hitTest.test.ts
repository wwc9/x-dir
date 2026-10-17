import { describe, expect, it } from "vitest";

import { allSourcesInside, dropGuard, hitPane, rectsIntersect, type PaneRects } from "../hitTest";

const rect = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b });

const panes: PaneRects[] = [
  {
    paneId: "p1",
    pane: rect(0, 40, 640, 480),
    tabbar: rect(8, 60, 630, 84),
  },
  {
    paneId: "p2",
    pane: rect(648, 40, 1280, 480),
    tabbar: rect(656, 60, 1270, 84),
  },
];

describe("hitPane（OLE 落点命中）", () => {
  it("命中窗格列表区", () => {
    expect(hitPane(panes, 300, 200)).toEqual({ paneId: "p1", onTabbar: false });
    expect(hitPane(panes, 900, 300)).toEqual({ paneId: "p2", onTabbar: false });
  });

  it("命中标签条", () => {
    expect(hitPane(panes, 100, 70)).toEqual({ paneId: "p1", onTabbar: true });
    expect(hitPane(panes, 700, 80)).toEqual({ paneId: "p2", onTabbar: true });
  });

  it("窗格外 / 顶栏区不命中", () => {
    expect(hitPane(panes, 644, 200)).toBeNull(); // 沟槽
    expect(hitPane(panes, 300, 20)).toBeNull(); // 顶栏
  });

  it("边界为左闭右开", () => {
    expect(hitPane(panes, 0, 40)).toEqual({ paneId: "p1", onTabbar: false });
    expect(hitPane(panes, 640, 40)).toBeNull(); // p1 右边界外
  });
});

describe("allSourcesInside（同目录守护）", () => {
  it("全部源在目标目录 → true（大小写不敏感）", () => {
    expect(allSourcesInside(["C:\\a\\x.txt", "C:\\a\\b"], "c:\\A")).toBe(true);
  });

  it("跨目录源 → false", () => {
    expect(allSourcesInside(["C:\\a\\x.txt", "C:\\b\\y.txt"], "C:\\a")).toBe(false);
  });

  it("盘符根路径正确识别父目录", () => {
    expect(allSourcesInside(["E:\\file.dat"], "E:\\")).toBe(true);
  });
});

describe("rectsIntersect（框选矩形相交）", () => {
  it("重叠相交，四向任意方向", () => {
    const a = rect(10, 10, 50, 30);
    expect(rectsIntersect(a, rect(40, 20, 80, 60))).toBe(true); // 右下角相交
    expect(rectsIntersect(a, rect(0, 0, 15, 15))).toBe(true); // 左上角相交
    expect(rectsIntersect(a, rect(20, 25, 30, 60))).toBe(true); // 仅底边条带相交
  });

  it("边贴边 / 角贴角不算相交", () => {
    const a = rect(10, 10, 50, 30);
    expect(rectsIntersect(a, rect(50, 10, 90, 30))).toBe(false); // 右边缘贴合
    expect(rectsIntersect(a, rect(10, 30, 50, 60))).toBe(false); // 底边缘贴合
    expect(rectsIntersect(a, rect(50, 30, 90, 60))).toBe(false); // 角贴合
  });

  it("分离不相交", () => {
    expect(rectsIntersect(rect(0, 0, 10, 10), rect(20, 20, 30, 30))).toBe(false);
  });
});
describe("dropGuard（拖放自落守护）", () => {
  it("源就是目标目录 → self（拖到显示源目录的窗格）", () => {
    expect(dropGuard(["E:\\a"], "E:\\a")).toBe("self");
    // 大小写不同仍是同一目录
    expect(dropGuard(["C:\\Data"], "c:\\data")).toBe("self");
  });

  it("目标在源内部 → inside（父目录拖进自己的子目录）", () => {
    expect(dropGuard(["E:\\a"], "E:\\a\\b")).toBe("inside");
    expect(dropGuard(["e:\\a", "E:\\other"], "E:\\a\\x\\y")).toBe("inside");
  });

  it("同名前缀兄弟目录不误伤", () => {
    expect(dropGuard(["E:\\ab"], "E:\\abc\\x")).toBe("none");
    expect(dropGuard(["E:\\a"], "E:\\ab")).toBe("none");
  });

  it("正常跨目录移动 → none", () => {
    expect(dropGuard(["C:\\a\\x.txt"], "D:\\dest")).toBe("none");
    expect(dropGuard([], "C:\\\\")).toBe("none");
  });
});
