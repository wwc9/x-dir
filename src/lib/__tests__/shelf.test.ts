import { describe, expect, it } from "vitest";

import { SHELF_MAX, shelfAdd, shelfEntryIsDir, shelfRemove } from "../shelf";

describe("shelfAdd", () => {
  it("空列表追加：保序收录", () => {
    const r = shelfAdd([], ["E:\\a\\b.txt", "E:\\a\\c"]);
    expect(r).toEqual({ items: ["E:\\a\\b.txt", "E:\\a\\c"], added: 2, skipped: 0 });
  });

  it("去重：Windows 路径大小写不敏感", () => {
    const r = shelfAdd(["E:\\a\\b.txt"], ["e:\\A\\B.TXT", "E:\\a\\c"]);
    expect(r.items).toEqual(["E:\\a\\b.txt", "E:\\a\\c"]);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("批量内自带重复也只收录一次", () => {
    const r = shelfAdd([], ["E:\\x", "E:\\x", "e:\\X"]);
    expect(r.items).toEqual(["E:\\x"]);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(2);
  });

  it("超上限的新路径整条忽略（保留先入项），skipped 计数", () => {
    const full = Array.from({ length: SHELF_MAX }, (_, i) => `E:\\f${i}`);
    const r = shelfAdd(full, ["E:\\new1", "E:\\new2"]);
    expect(r.items).toHaveLength(SHELF_MAX);
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(2);
  });

  it("恰好填满：部分收录，剩余忽略", () => {
    const r = shelfAdd(["E:\\old"], ["E:\\n1", "E:\\n2"], 2);
    expect(r.items).toEqual(["E:\\old", "E:\\n1"]);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("空串路径忽略", () => {
    const r = shelfAdd([], [""]);
    expect(r.items).toEqual([]);
    expect(r.skipped).toBe(1);
  });
});

describe("shelfRemove", () => {
  it("大小写不敏感移除，未命中原样返回", () => {
    const items = ["E:\\a\\b.txt", "E:\\a\\c"];
    expect(shelfRemove(items, "e:\\A\\B.txt")).toEqual(["E:\\a\\c"]);
    expect(shelfRemove(items, "E:\\nope")).toEqual(items);
  });
});

describe("shelfEntryIsDir", () => {
  it("无扩展名路径推断为文件夹", () => {
    expect(shelfEntryIsDir("E:\\Code\\x-dir")).toBe(true);
    expect(shelfEntryIsDir("E:\\Code\\x-dir\\")).toBe(true);
  });

  it("带扩展名（含 dotfile）推断为文件", () => {
    expect(shelfEntryIsDir("E:\\a\\README.md")).toBe(false);
    expect(shelfEntryIsDir("E:\\a\\.gitignore")).toBe(false);
  });
});
