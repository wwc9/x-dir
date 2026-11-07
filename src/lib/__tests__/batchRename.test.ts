import { describe, expect, it } from "vitest";

import { newOp, pickRenames, planRenames, type RenameOp } from "../batchRename";

const f = (name: string, mtimeMs?: number) => ({
  path: `C:\\d\\${name}`,
  name,
  isDir: false,
  mtimeMs,
});
const d = (name: string) => ({ path: `C:\\d\\${name}`, name, isDir: true });
const ops = (...list: RenameOp[]): RenameOp[] => list;

describe("批量重命名规则链（planRenames）", () => {
  it("替换只作用于主名，扩展名保留", () => {
    const items = planRenames(
      [f("底稿2023.docx"), f("底稿2023.xlsx")],
      ops(newOp({ type: "replace", find: "2023", replace: "2024" })),
    );
    expect(items.map((i) => i.newName)).toEqual(["底稿2024.docx", "底稿2024.xlsx"]);
    expect(items.every((i) => i.changed && !i.error)).toBe(true);
  });

  it("替换串包含点号不伪造扩展名（主名整体保护）", () => {
    const items = planRenames(
      [f("a.b.txt")],
      ops(newOp({ type: "replace", find: "a", replace: "x.y" })),
    );
    expect(items[0].newName).toBe("x.y.b.txt");
  });

  it("正则全局替换 + $1 捕获组；非法正则静默跳过（UI 内联提示同源判定）", () => {
    const items = planRenames(
      [f("29-03-2020底稿.docx")],
      ops(newOp({ type: "replace", find: "(\\d{2})-(\\d{2})-(\\d{4})", replace: "$3-$2-$1", regex: true })),
    );
    expect(items[0].newName).toBe("2020-03-29底稿.docx");
    const bad = planRenames([f("a.txt")], ops(newOp({ type: "replace", find: "(", replace: "x", regex: true })));
    expect(bad[0].changed).toBe(false);
  });

  it("删除规则 = 移除全部匹配", () => {
    const items = planRenames([f("IMG_0001 copy.png"), f("x copy.png")], ops(newOp({ type: "remove", find: " copy" })));
    expect(items.map((i) => i.newName)).toEqual(["IMG_0001.png", "x.png"]);
  });

  it("插入规则：开头/末尾", () => {
    const items = planRenames(
      [f("a.txt")],
      ops(newOp({ type: "insert", text: "前-", position: "start" }), newOp({ type: "insert", text: "-后", position: "end" })),
    );
    expect(items[0].newName).toBe("前-a-后.txt");
  });

  it("前后缀规则夹住主名（扩展名仍在末尾）", () => {
    const items = planRenames([f("a.pdf")], ops(newOp({ type: "prefix", text: "P" }), newOp({ type: "suffix", text: "-s" })));
    expect(items[0].newName).toBe("Pa-s.pdf");
  });

  it("修剪规则：去首尾 N 字符", () => {
    const items = planRenames([f("abcdef.txt")], ops(newOp({ type: "trim", head: 2, tail: 3 })));
    expect(items[0].newName).toBe("c.txt");
  });

  it("序号规则默认参数补齐（不传 start/pad 时 1/2 位，防 undefinedNaN）", () => {
    const items = planRenames([f("a.txt")], ops(newOp({ type: "number", position: "end" })));
    expect(items[0].newName).toBe("a01.txt");
  });

  it("序号规则：位置/起始/位数/分隔符，按条目顺序计数", () => {
    const items = planRenames(
      [f("a.pdf"), f("b.pdf"), d("c")],
      ops(newOp({ type: "number", position: "end", start: 9, pad: 3, separator: "-" })),
    );
    expect(items.map((i) => i.newName)).toEqual(["a-009.pdf", "b-010.pdf", "c-011"]);
  });

  it("大小写规则：全大写/全小写/每词首字母大写（中文原样）", () => {
    expect(planRenames([f("audit report.docx")], ops(newOp({ type: "case", mode: "upper" })))[0].newName).toBe("AUDIT REPORT.docx");
    expect(planRenames([f("Audit Report.docx")], ops(newOp({ type: "case", mode: "lower" })))[0].newName).toBe("audit report.docx");
    expect(planRenames([f("audit report 底稿.docx")], ops(newOp({ type: "case", mode: "title" })))[0].newName).toBe(
      "Audit Report 底稿.docx",
    );
  });

  it("日期规则：使用文件修改时间（mtimeMs），格式化三档", () => {
    const ms = new Date(2026, 10, 7, 14, 5, 9).getTime(); // 2026-11-07 14:05:09
    expect(planRenames([f("a.txt", ms)], ops(newOp({ type: "date", format: "ymd", position: "end", separator: "_" })))[0].newName).toBe(
      "a_2026-11-07.txt",
    );
    expect(planRenames([f("a.txt", ms)], ops(newOp({ type: "date", format: "ymdCompact", position: "end", separator: "-" })))[0].newName).toBe(
      "a-20261107.txt",
    );
    expect(planRenames([f("a.txt", ms)], ops(newOp({ type: "date", format: "ymdHms", position: "end", separator: "_" })))[0].newName).toBe(
      "a_2026-11-07_140509.txt",
    );
  });

  it("规则链按序生效（Advanced Renamer / Smart File Renamer 范式）", () => {
    // ① 删除 " copy" → ② 序号加在末尾 → ③ 整名大写
    const items = planRenames(
      [f("IMG_0001 copy.png"), f("IMG_0002 copy.png")],
      ops(
        newOp({ type: "remove", find: " copy" }),
        newOp({ type: "number", position: "end", start: 1, pad: 2, separator: "_" }),
        newOp({ type: "case", mode: "upper" }),
      ),
    );
    expect(items.map((i) => i.newName)).toEqual(["IMG_0001_01.png", "IMG_0002_02.png"]);
  });

  it("每条规则独立作用域：仅扩展名改扩展名，主名不受后续主名规则之外的干扰", () => {
    const items = planRenames(
      [f("底稿.JPEG")],
      ops(newOp({ type: "replace", find: "JPEG", replace: "jpg", scope: "ext" })),
    );
    expect(items[0].newName).toBe("底稿.jpg");
    // scope = nameExt 整名规则（整名大写后重拆段）
    const items2 = planRenames([f("底稿.txt")], ops(newOp({ type: "case", mode: "upper", scope: "nameExt" })));
    expect(items2[0].newName).toBe("底稿.TXT");
  });

  it("禁用规则跳过", () => {
    const items = planRenames(
      [f("a.txt")],
      ops(newOp({ type: "prefix", text: "P", enabled: false }), newOp({ type: "suffix", text: "s" })),
    );
    expect(items[0].newName).toBe("as.txt");
  });

  it("未变更不判错；变更后非法/重名判错且被 pickRenames 过滤", () => {
    const items = planRenames(
      [f("same.txt"), f("a?.txt"), f("dup.bin"), f("dup2.bin")],
      ops(newOp({ type: "replace", find: "2", replace: "" })),
    );
    expect(items[0].changed).toBe(false);
    expect(items[0].error).toBeNull();
    expect(items[1].changed).toBe(false);
    expect(items[1].error).toBeNull();
    expect(items[3].newName).toBe("dup.bin");
    expect(items[3].error).toBe("目标重名");
    expect(pickRenames(items)).toEqual([]);
  });

  it("pickRenames 尊重预览行勾选（空集 = 全部参与）", () => {
    const items = planRenames(
      [f("a.txt"), f("b.txt")],
      ops(newOp({ type: "prefix", text: "P" })),
    );
    const picked = new Set([items[0].path]);
    expect(pickRenames(items, picked)).toEqual([{ path: items[0].path, newName: "Pa.txt" }]);
    expect(pickRenames(items)).toHaveLength(2);
  });
});
