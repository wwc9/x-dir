import { beforeEach, describe, expect, it } from "vitest";

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
