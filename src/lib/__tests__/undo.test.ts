// 撤销栈（lib/undo）单测：入栈/LIFO/容量上限、五类条目的逆操作分派。
// ipc 模块替换为 spy（Tauri invoke node 不可用），ui store 替身避开 Blueprint DOM。
// 2026-11-06 精确化：move 携带 from→to 精确对（"(2)" 落点名可撤回）、
// copy 撤销删副本（进回收站）、rename 批量整批一条（一次 Ctrl+Z 全撤）。
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
    useUndo.getState().push({ kind: "rename", ops: [{ from: "C:\\a.txt", to: "C:\\b.txt" }] });
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
    useUndo.getState().push({
      kind: "rename",
      ops: [{ from: "C:\\d\\a.txt", to: "C:\\d\\b.txt" }],
    });
    await useUndo.getState().undo();
    expect(spy("renameItem")).toHaveBeenCalledWith("C:\\d\\b.txt", "a.txt");
    expect(useUndo.getState().stack).toEqual([]);
  });

  it("rename 批量：一次撤销逆序全部改回", async () => {
    useUndo.getState().push({
      kind: "rename",
      ops: [
        { from: "C:\\d\\1.txt", to: "C:\\d\\一.txt" },
        { from: "C:\\d\\2.txt", to: "C:\\d\\二.txt" },
      ],
    });
    expect(useUndo.getState().peekLabel()).toBe("重命名 2 项");
    await useUndo.getState().undo();
    expect(spy("renameItem")).toHaveBeenCalledWith("C:\\d\\一.txt", "1.txt");
    expect(spy("renameItem")).toHaveBeenCalledWith("C:\\d\\二.txt", "2.txt");
    expect(spy("renameItem")).toHaveBeenCalledTimes(2);
  });

  it("trash：调 restoreFromTrash 并回报恢复数", async () => {
    spy("restoreFromTrash").mockResolvedValue({ restored: 2, missing: 1 });
    useUndo.getState().push({ kind: "trash", paths: ["C:\\a", "C:\\b", "C:\\c"] });
    await useUndo.getState().undo();
    expect(spy("restoreFromTrash")).toHaveBeenCalledWith(["C:\\a", "C:\\b", "C:\\c"]);
  });

  it("move：按 from 父目录分组把精确落点移回（含 (2) 落点名）", async () => {
    spy("moveItems").mockResolvedValue({ jobId: 7 });
    useUndo.getState().push({
      kind: "move",
      destDir: "C:\\dest",
      pairs: [
        { from: "C:\\src1\\a.txt", to: "C:\\dest\\a.txt" },
        { from: "C:\\src2\\b.txt", to: "C:\\dest\\b (2).txt" },
      ],
    });
    await useUndo.getState().undo();
    // 精确落点（"(2)" 原样移回），各按 from 的父目录分组
    expect(spy("moveItems")).toHaveBeenCalledWith(["C:\\dest\\a.txt"], "C:\\src1", "rename", false);
    expect(spy("moveItems")).toHaveBeenCalledWith(["C:\\dest\\b (2).txt"], "C:\\src2", "rename", false);
  });

  it("copy：副本移入回收站（可再救回），源不动", async () => {
    spy("deleteItems").mockResolvedValue({ jobId: 8 });
    useUndo.getState().push({
      kind: "copy",
      sources: ["C:\\src\\a.txt"],
      destDir: "C:\\dest",
      copies: ["C:\\dest\\a (2).txt"],
    });
    expect(useUndo.getState().peekLabel()).toBe('复制 "a (2).txt"');
    await useUndo.getState().undo();
    // 只删精确副本（skip 策略下目标旧文件不在 copies 里，绝不误删）
    expect(spy("deleteItems")).toHaveBeenCalledWith(["C:\\dest\\a (2).txt"], false);
    expect(spy("moveItems")).not.toHaveBeenCalled();
  });

  it("copy 多项 label 计数", () => {
    useUndo.getState().push({
      kind: "copy",
      sources: ["C:\\s\\a", "C:\\s\\b"],
      destDir: "C:\\d",
      copies: ["C:\\d\\a", "C:\\d\\b"],
    });
    expect(useUndo.getState().peekLabel()).toBe("复制 2 项");
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
    useUndo.getState().push({ kind: "rename", ops: [{ from: "C:\\a.txt", to: "C:\\b.txt" }] });
    expect(useUndo.getState().peekRedoLabel()).toBeNull();
    await useUndo.getState().undo();
    expect(useUndo.getState().redoStack).toHaveLength(1);
    expect(useUndo.getState().peekRedoLabel()).toBe('重命名 "b.txt"');
  });

  it("redo rename：按原方向改到新名并压回撤销栈（可往复）", async () => {
    useUndo.getState().push({
      kind: "rename",
      ops: [{ from: "C:\\d\\a.txt", to: "C:\\d\\b.txt" }],
    });
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

  it("redo copy：重新复制（压回由 onDone items 门控）", async () => {
    spy("copyItems").mockResolvedValue({ jobId: 4 });
    useUndo.getState().push({
      kind: "copy",
      sources: ["C:\\s\\a.txt"],
      destDir: "C:\\d",
      copies: ["C:\\d\\a.txt"],
    });
    await useUndo.getState().undo();
    spy("copyItems").mockClear();
    await useUndo.getState().redo();
    expect(spy("copyItems")).toHaveBeenCalledWith(["C:\\s\\a.txt"], "C:\\d", "rename", false);
    expect(useUndo.getState().redoStack).toEqual([]);
  });

  it("redo move：从撤销后位置重新移向 destDir（压回由 onDone items 门控）", async () => {
    spy("moveItems").mockResolvedValue({ jobId: 5 });
    useUndo.getState().push({
      kind: "move",
      destDir: "C:\\d",
      pairs: [{ from: "C:\\s\\a.txt", to: "C:\\d\\a.txt" }],
    });
    await useUndo.getState().undo();
    spy("moveItems").mockClear();
    await useUndo.getState().redo();
    expect(spy("moveItems")).toHaveBeenCalledWith(["C:\\s\\a.txt"], "C:\\d", "rename", false);
    expect(useUndo.getState().redoStack).toEqual([]);
  });

  it("新操作入栈清空重做分支", async () => {
    useUndo.getState().push({ kind: "rename", ops: [{ from: "C:\\a.txt", to: "C:\\b.txt" }] });
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
