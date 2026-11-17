import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutNode } from "../../lib/layoutTree";
import { useLayout } from "../layout";
import { usePanes } from "../panes";
import { useSettings } from "../settings";

const T = "tab-1";

function seed(): string[] {
  // 独立 zustand store，直接操作真实状态（setTabPath 在 tree 为 null 时安全 no-op）
  usePanes.getState().ensure(T, { viewMode: "details", sort: { key: "name", dir: "asc" } });
  usePanes.getState().navigate(T, "C:\\");
  usePanes.getState().navigate(T, "C:\\a");
  usePanes.getState().navigate(T, "C:\\a\\b");
  return ["C:\\", "C:\\a", "C:\\a\\b"];
}

describe("窗格历史栈（navigate / back / forward）", () => {
  beforeEach(() => {
    usePanes.setState({ tabs: {} });
  });

  it("navigate 顺序压栈，index 指向栈顶", () => {
    const hist = seed();
    const ui = usePanes.getState().tabs[T];
    expect(ui.history).toEqual(hist);
    expect(ui.historyIndex).toBe(2);
  });

  it("navigate 截断前进分支：后退后访问新地址，旧前进栈丢弃", () => {
    seed();
    usePanes.getState().back(T);
    usePanes.getState().navigate(T, "C:\\x");
    const ui = usePanes.getState().tabs[T];
    expect(ui.history).toEqual(["C:\\", "C:\\a", "C:\\x"]);
    expect(ui.historyIndex).toBe(2);
  });

  it("back：index 左移、历史不删；栈底再退为无操作", () => {
    seed();
    usePanes.getState().back(T);
    expect(usePanes.getState().tabs[T].historyIndex).toBe(1);
    usePanes.getState().back(T);
    usePanes.getState().back(T); // 已在栈底
    const ui = usePanes.getState().tabs[T];
    expect(ui.historyIndex).toBe(0);
    expect(ui.history).toHaveLength(3);
  });

  it("forward：index 右移；栈顶再进为无操作", () => {
    seed();
    usePanes.getState().back(T);
    usePanes.getState().forward(T);
    expect(usePanes.getState().tabs[T].historyIndex).toBe(2);
    usePanes.getState().forward(T); // 已在栈顶
    expect(usePanes.getState().tabs[T].historyIndex).toBe(2);
  });

  it("重复 navigate 同一路径为无操作", () => {
    seed();
    usePanes.getState().navigate(T, "C:\\a\\b");
    const ui = usePanes.getState().tabs[T];
    expect(ui.history).toHaveLength(3);
    expect(ui.historyIndex).toBe(2);
  });

  it("navigate / back / forward 清空选中与锚点", () => {
    seed();
    usePanes.getState().setSelected(T, ["a.txt"], "a.txt");
    usePanes.getState().back(T);
    expect(usePanes.getState().tabs[T].selected).toEqual([]);
    expect(usePanes.getState().tabs[T].anchor).toBeNull();
  });
});

describe("窗格搜索类型选择（searchType，2026-10-17）", () => {
  it("设置后保留在 tab 上（新搜索沿用上次类型）", () => {
    const st = usePanes.getState();
    st.navigate("p1", "C:\a");
    const id = Object.keys(usePanes.getState().tabs)[0];
    expect(usePanes.getState().tabs[id].searchType).toBe("all");
    st.setSearchType(id, "docs");
    expect(usePanes.getState().tabs[id].searchType).toBe("docs");
    // 关闭搜索（setSearch null）不清类型
    st.setSearch(id, null);
    expect(usePanes.getState().tabs[id].searchType).toBe("docs");
  });
});

describe("选择记忆（selMemory，2026-10-15）", () => {
  beforeEach(() => {
    usePanes.setState({ tabs: {} });
  });

  it("离开时快照、回到该目录自动恢复（含锚点）", () => {
    seed(); // C:\ → C:\a → C:\a\b
    usePanes.getState().setSelected(T, ["C:\\a\\b\\x.txt", "C:\\a\\b\\y.txt"], "C:\\a\\b\\x.txt");
    usePanes.getState().back(T);
    expect(usePanes.getState().tabs[T].selected).toEqual([]); // C:\a 无记忆
    usePanes.getState().forward(T);
    expect(usePanes.getState().tabs[T].selected).toEqual([
      "C:\\a\\b\\x.txt",
      "C:\\a\\b\\y.txt",
    ]);
    expect(usePanes.getState().tabs[T].anchor).toBe("C:\\a\\b\\x.txt");
  });

  it("显式清空后离开 = 该目录记忆一并清除（回来不复活）", () => {
    seed();
    usePanes.getState().setSelected(T, ["C:\\a\\b\\x.txt"], "C:\\a\\b\\x.txt");
    usePanes.getState().back(T);
    usePanes.getState().forward(T); // 已恢复
    usePanes.getState().setSelected(T, [], null); // Esc 清空语义
    usePanes.getState().back(T);
    usePanes.getState().forward(T);
    expect(usePanes.getState().tabs[T].selected).toEqual([]);
  });

  it("开关关闭（rememberSelection=false）时导航照旧清空", () => {
    seed();
    useSettings.setState({ rememberSelection: false });
    usePanes.getState().setSelected(T, ["C:\\a\\b\\x.txt"], "C:\\a\\b\\x.txt");
    usePanes.getState().back(T);
    expect(usePanes.getState().tabs[T].selected).toEqual([]);
    usePanes.getState().forward(T);
    expect(usePanes.getState().tabs[T].selected).toEqual([]);
    useSettings.setState({ rememberSelection: true });
  });

  it("记忆上限 50：超出丢最旧目录", () => {
    seed();
    const ui = usePanes.getState().tabs[T];
    let memory: Record<string, { paths: string[]; anchor: string | null }> = {};
    for (let i = 0; i < 55; i++) {
      memory = { ...memory, [`C:\\dir${i}`]: { paths: [`C:\\dir${i}\\f.txt`], anchor: null } };
    }
    usePanes.setState({ tabs: { ...usePanes.getState().tabs, [T]: { ...ui, selMemory: memory } } });
    // 从 C:\a\b 导航到新目录：快照写入触发淘汰
    usePanes.getState().setSelected(T, ["C:\\a\\b\\z.txt"], "C:\\a\\b\\z.txt");
    usePanes.getState().navigate(T, "C:\\new");
    const mem = usePanes.getState().tabs[T].selMemory;
    const keys = Object.keys(mem);
    expect(keys.length).toBeLessThanOrEqual(50);
    expect(keys).not.toContain("C:\\dir0");
    expect(keys).toContain("C:\\a\\b");
  });
});

describe("返回上一级与当前路径事实源（2026-11-17 用户反馈）", () => {
  function paneWith(tabId: string, path: string): LayoutNode {
    return { type: "pane", id: "pane-1", tabs: [{ id: tabId, path }], activeTab: 0 };
  }
  beforeEach(() => {
    usePanes.setState({ tabs: {} });
    useLayout.getState().init(paneWith("t1", "E:\\Job"));
  });

  it("currentPathOf 以 layout 树为准（history 空缺也不为 null）", () => {
    usePanes.getState().ensure("t1", { viewMode: "details", sort: { key: "name", dir: "asc" } });
    expect(usePanes.getState().currentPathOf("t1")).toBe("E:\\Job");
  });

  it("会话恢复态（history 空缺）：up 直达显示路径的父级并补齐后退链", () => {
    // 模拟重启恢复：树里 t1 在 E:\Job，panes store 仅有 ensure 空档（无历史）
    usePanes.getState().ensure("t1", { viewMode: "details", sort: { key: "name", dir: "asc" } });
    usePanes.getState().up("t1");
    expect(useLayout.getState().tree).toMatchObject({ tabs: [{ id: "t1", path: "E:\\" }] });
    const ui = usePanes.getState().tabs["t1"];
    expect(ui.history).toEqual(["E:\\Job", "E:\\"]);
    expect(ui.historyIndex).toBe(1);
    // 后退回到子目录（补种历史链的意义所在）
    usePanes.getState().back("t1");
    expect(useLayout.getState().tree).toMatchObject({ tabs: [{ path: "E:\\Job" }] });
  });

  it("history 漂移（同 id 档被方案重新应用）：up 以显示路径为基点而非陈旧历史头", () => {
    usePanes.getState().ensure("t1", { viewMode: "details", sort: { key: "name", dir: "asc" } });
    usePanes.getState().navigate("t1", "E:\\Job\\sub"); // 历史头长到 sub
    // 方案再次应用：layout 树整体重建，同 id 标签路径回到方案存档路径
    useLayout.getState().init(paneWith("t1", "D:\\其他"));
    usePanes.getState().up("t1");
    expect(useLayout.getState().tree).toMatchObject({ tabs: [{ path: "D:\\" }] });
  });

  it("盘符根与伪路径（此电脑）不误导航", () => {
    usePanes.getState().ensure("t1", { viewMode: "details", sort: { key: "name", dir: "asc" } });
    useLayout.getState().init(paneWith("t1", "E:\\"));
    usePanes.getState().up("t1");
    expect(useLayout.getState().tree).toMatchObject({ tabs: [{ path: "E:\\" }] });
    useLayout.getState().init(paneWith("t1", "::{ThisPC}"));
    usePanes.getState().up("t1");
    expect(useLayout.getState().tree).toMatchObject({ tabs: [{ path: "::{ThisPC}" }] });
  });
});

describe("主动刷新 immediate 与去重窗（2026-11-17 提速定案）", () => {
  function paneWith(tabId: string, path: string): LayoutNode {
    return { type: "pane", id: "p", tabs: [{ id: tabId, path }], activeTab: 0 };
  }
  beforeEach(() => {
    vi.stubGlobal("window", globalThis); // 合并窗走 window.setTimeout
    useLayout.getState().init(paneWith("t1", "E:\\data"));
    usePanes.setState({ tabs: {} });
    usePanes.getState().ensure("t1", { viewMode: "details", sort: { key: "name", dir: "asc" } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("immediate 同步刷新命中标签（零延迟，不等合并窗）", () => {
    expect(usePanes.getState().tabs["t1"].refreshTick).toBe(0);
    usePanes.getState().bumpAffected(["E:\\data"], { immediate: true });
    expect(usePanes.getState().tabs["t1"].refreshTick).toBe(1);
    // 未命中目录不动
    usePanes.getState().bumpAffected(["D:\\other"], { immediate: true });
    expect(usePanes.getState().tabs["t1"].refreshTick).toBe(1);
  });

  it("主动刷新后 500ms 内同目录 watcher 批跳过（防双拉），真变更照常入窗", () => {
    vi.useFakeTimers();
    usePanes.getState().bumpAffected(["E:\\data"], { immediate: true });
    expect(usePanes.getState().tabs["t1"].refreshTick).toBe(1);
    // 内部动作的 watcher 回声：同目录在去重窗内，吞掉一次
    usePanes.getState().bumpAffected(["E:\\data"]);
    vi.advanceTimersByTime(400);
    expect(usePanes.getState().tabs["t1"].refreshTick).toBe(1);
    // 去重窗过期后的真实变更：照常入合并窗并刷新
    vi.advanceTimersByTime(300);
    usePanes.getState().bumpAffected(["E:\\data"]);
    vi.advanceTimersByTime(300);
    expect(usePanes.getState().tabs["t1"].refreshTick).toBe(2);
  });
});
