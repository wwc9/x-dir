// 撤销栈（lib/undo）单测：入栈/LIFO/容量上限、四类条目的逆操作分派。
// ipc 模块替换为 spy（Tauri invoke node 不可用），ui store 替身避开 Blueprint DOM。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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

vi.mock("../../stores/ui", async () => {
  const { create } = await import("zustand");
  const useUi = create<{ toast(text: string, kind?: "info" | "error"): void }>()(() => ({
    toast: () => undefined,
  }));
  return { useUi };
});

import { useUndo } from "../undo";
import { api } from "../ipc";

// redo/undo 的 bump() → usePanes.bumpAffected 走 window.setTimeout 计时窗口：
// node 环境把 window 指回 globalThis（同 keyboard.test 惯例）
vi.stubGlobal("window", globalThis);

const spy = (name: string) =>
  (api as unknown as Record<string, Mock>)[name];

beforeEach(() => {
  vi.clearAllMocks();
  apiSpies.forEach((fn) => fn.mockResolvedValue(undefined));
  useUndo.getState().clear();
});

describe("撤销栈（undo）", () => {
  it("push/LIFO：栈顶先撤销，peekLabel 反映下一项", () => {
    useUndo.getState().push({ kind: "rename", from: "C:\\a.txt", to: "C:\\b.txt" });
    useUndo.getState().push({ kind: "newfolder", path: "C:\\新建文件夹" });
    expect(useUndo.getState().peekLabel()).toBe('新建 "新建文件夹"');
    useUndo.getState().undo();
    expect(useUndo.getState().peekLabel()).toBe('重命名 "b.txt"');
  });

  it("容量上限 50：超出丢最旧", () => {
    for (let i = 0; i < 55; i++) {
      useUndo.getState().push({ kind: "newfolder", path: `C:\\f${i}` });
    }
    expect(useUndo.getState().stack.length).toBe(50);
    const first = useUndo.getState().stack[0];
    expect(first.kind === "newfolder" ? first.path : null).toBe("C:\\f5");
  });

  it("rename：改回原名", async () => {
    useUndo.getState().push({ kind: "rename", from: "C:\\d\\a.txt", to: "C:\\d\\b.txt" });
    await useUndo.getState().undo();
    expect(spy("renameItem")).toHaveBeenCalledWith("C:\\d\\b.txt", "a.txt");
    expect(useUndo.getState().stack).toEqual([]);
  });

  it("trash：调 restoreFromTrash 并回报恢复数", async () => {
    spy("restoreFromTrash").mockResolvedValue({ restored: 2, missing: 1 });
    useUndo.getState().push({ kind: "trash", paths: ["C:\\a", "C:\\b", "C:\\c"] });
    await useUndo.getState().undo();
    expect(spy("restoreFromTrash")).toHaveBeenCalledWith(["C:\\a", "C:\\b", "C:\\c"]);
  });

  it("move：按原父目录分组移回，冲突自动改名", async () => {
    spy("moveItems").mockResolvedValue({ jobId: 7 });
    useUndo.getState().push({
      kind: "move",
      sources: ["C:\\src1\\a.txt", "C:\\src2\\b.txt"],
      destDir: "C:\\dest",
    });
    await useUndo.getState().undo();
    // 两组父目录 → 两次 moveItems（destDir\name → 原父目录）
    expect(spy("moveItems")).toHaveBeenCalledWith(["C:\\dest\\a.txt"], "C:\\src1", "rename", false);
    expect(spy("moveItems")).toHaveBeenCalledWith(["C:\\dest\\b.txt"], "C:\\src2", "rename", false);
  });

  it("newfolder：移入回收站（可再还原）", async () => {
    spy("deleteItems").mockResolvedValue({ jobId: 9 });
    useUndo.getState().push({ kind: "newfolder", path: "C:\\d\\新建文件夹" });
    await useUndo.getState().undo();
    expect(spy("deleteItems")).toHaveBeenCalledWith(["C:\\d\\新建文件夹"], false);
  });

  it("空栈 undo 无操作", async () => {
    await useUndo.getState().undo();
    expect(spy("renameItem")).not.toHaveBeenCalled();
  });
});

describe("重做栈（redo）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiSpies.forEach((fn) => fn.mockResolvedValue(undefined));
    useUndo.getState().clear();
  });

  it("undo 弹出的条目进重做栈；peekRedoLabel 反映原方向语义", async () => {
    useUndo.getState().push({ kind: "rename", from: "C:\\a.txt", to: "C:\\b.txt" });
    expect(useUndo.getState().peekRedoLabel()).toBeNull();
    await useUndo.getState().undo();
    expect(useUndo.getState().redoStack).toHaveLength(1);
    expect(useUndo.getState().peekRedoLabel()).toBe('重命名 "b.txt"');
  });

  it("redo rename：按原方向改到新名并压回撤销栈（可往复）", async () => {
    useUndo.getState().push({ kind: "rename", from: "C:\\d\\a.txt", to: "C:\\d\\b.txt" });
    await useUndo.getState().undo();
    spy("renameItem").mockClear();
    await useUndo.getState().redo();
    expect(spy("renameItem")).toHaveBeenCalledWith("C:\\d\\a.txt", "b.txt");
    expect(useUndo.getState().redoStack).toEqual([]);
    expect(useUndo.getState().stack).toHaveLength(1);
    // 再撤销 → 再重做，往复对称
    await useUndo.getState().undo();
    expect(useUndo.getState().stack).toEqual([]);
    await useUndo.getState().redo();
    expect(useUndo.getState().stack).toHaveLength(1);
  });

  it("redo newfolder：重新建目录并压回", async () => {
    spy("createDir").mockResolvedValue("C:\\d\\新建文件夹");
    useUndo.getState().push({ kind: "newfolder", path: "C:\\d\\新建文件夹" });
    await useUndo.getState().undo();
    spy("deleteItems").mockClear();
    await useUndo.getState().redo();
    expect(spy("createDir")).toHaveBeenCalledWith("C:\\d", "新建文件夹");
    expect(useUndo.getState().stack).toHaveLength(1);
  });

  it("redo trash：重新入回收站（压回撤销栈由任务 onDone 门控）", async () => {
    spy("deleteItems").mockResolvedValue({ jobId: 3 });
    useUndo.getState().push({ kind: "trash", paths: ["C:\\a"] });
    await useUndo.getState().undo();
    spy("deleteItems").mockClear();
    await useUndo.getState().redo();
    expect(spy("deleteItems")).toHaveBeenCalledWith(["C:\\a"], false);
    // 栈压回在 jobs onDone(ok && !cancelled) 才发生：node 测试无 job 事件流，
    // 此处只断言重做分支已弹出、命令已按原方向重发
    expect(useUndo.getState().redoStack).toEqual([]);
  });

  it("新操作入栈清空重做分支", async () => {
    useUndo.getState().push({ kind: "rename", from: "C:\\a.txt", to: "C:\\b.txt" });
    await useUndo.getState().undo();
    expect(useUndo.getState().redoStack).toHaveLength(1);
    useUndo.getState().push({ kind: "newfolder", path: "C:\\x" });
    expect(useUndo.getState().redoStack).toEqual([]);
  });

  it("空栈 redo 无操作", async () => {
    await useUndo.getState().redo();
    expect(spy("renameItem")).not.toHaveBeenCalled();
  });
});
