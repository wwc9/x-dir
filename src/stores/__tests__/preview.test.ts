import { beforeEach, describe, expect, it } from "vitest";

import type { FileEntry } from "../../lib/ipc";
import { pickStartIndex, usePreview } from "../preview";

function fe(name: string): FileEntry {
  return {
    name,
    path: `C:\\dir\\${name}`,
    isDir: false,
    size: 10,
    mtimeMs: 0,
    ctimeMs: 0,
    attrs: { hidden: false, system: false, readonly: false },
    py: null,
  };
}

const FILES = ["a.png", "b.txt", "c.docx", "d.mp4"].map(fe);

describe("预览队列 store（Quick Look 模型）", () => {
  beforeEach(() => {
    usePreview.setState({ queue: [], index: 0 });
  });

  it("openPreview 设置队列与起始下标", () => {
    usePreview.getState().openPreview(FILES, 2);
    const s = usePreview.getState();
    expect(s.queue).toHaveLength(4);
    expect(s.index).toBe(2);
    expect(s.current()?.name).toBe("c.docx");
  });

  it("openPreview 空队列 no-op", () => {
    usePreview.getState().openPreview([], 0);
    expect(usePreview.getState().queue).toHaveLength(0);
  });

  it("next/prev 循环切换（到尾回头）", () => {
    usePreview.getState().openPreview(FILES, 0);
    usePreview.getState().next();
    expect(usePreview.getState().current()?.name).toBe("b.txt");
    usePreview.getState().openPreview(FILES, 3);
    usePreview.getState().next();
    expect(usePreview.getState().index).toBe(0);
    usePreview.getState().prev();
    expect(usePreview.getState().index).toBe(3);
  });

  it("goto 负数/越界折回", () => {
    usePreview.getState().openPreview(FILES, 0);
    usePreview.getState().goto(-1);
    expect(usePreview.getState().index).toBe(3);
    usePreview.getState().goto(99);
    expect(usePreview.getState().index).toBe(3);
  });

  it("close 清空队列释放引用", () => {
    usePreview.getState().openPreview(FILES, 1);
    usePreview.getState().close();
    const s = usePreview.getState();
    expect(s.queue).toHaveLength(0);
    expect(s.current()).toBeNull();
  });

  it("空队列上 next/prev no-op", () => {
    usePreview.getState().next();
    usePreview.getState().prev();
    expect(usePreview.getState().index).toBe(0);
  });
});

describe("pickStartIndex（Space 唤起起始下标）", () => {
  it("无选中 → 从第一个文件开始", () => {
    expect(pickStartIndex(FILES, [])).toBe(0);
  });

  it("选中的文件命中队列 → 从它开始（按路径匹配）", () => {
    expect(pickStartIndex(FILES, ["C:\\dir\\c.docx"])).toBe(2);
    expect(pickStartIndex(FILES, ["C:\\dir\\d.mp4"])).toBe(3);
  });

  it("选中路径不在队列（如选中的是文件夹）→ 回落 0", () => {
    expect(pickStartIndex(FILES, ["C:\\other\\子文件夹"])).toBe(0);
  });

  it("多选时取第一个命中", () => {
    expect(pickStartIndex(FILES, ["C:\\dir\\b.txt", "C:\\dir\\a.png"])).toBe(0);
    expect(pickStartIndex(FILES, ["C:\\zzz", "C:\\dir\\b.txt"])).toBe(1);
  });

  it("同名不同目录：按路径命中正确的那个（搜索结果回归）", () => {
    const dup = { ...fe("a.png"), path: "C:\\other\\a.png" };
    const files = [FILES[0], dup];
    expect(pickStartIndex(files, ["C:\\other\\a.png"])).toBe(1);
    expect(pickStartIndex(files, ["C:\\dir\\a.png"])).toBe(0);
  });
});
