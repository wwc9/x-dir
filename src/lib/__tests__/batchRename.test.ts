import { describe, expect, it } from "vitest";

import { DEFAULT_RULE, pickRenames, planRenames, type RenameRule } from "../batchRename";

const rule = (p: Partial<RenameRule>): RenameRule => ({ ...DEFAULT_RULE, ...p });
const f = (name: string) => ({ path: `C:\\d\\${name}`, name, isDir: false });
const d = (name: string) => ({ path: `C:\\d\\${name}`, name, isDir: true });

describe("批量重命名规则（planRenames）", () => {
  it("查找替换只作用于主名，扩展名保留", () => {
    const items = planRenames([f("底稿2023.docx"), f("底稿2023.xlsx")], rule({ find: "2023", replace: "2024" }));
    expect(items.map((i) => i.newName)).toEqual(["底稿2024.docx", "底稿2024.xlsx"]);
    expect(items.every((i) => i.changed && !i.error)).toBe(true);
  });

  it("替换串包含点号不伪造扩展名（主名整体保护）", () => {
    const items = planRenames([f("a.b.txt")], rule({ find: "a", replace: "x.y" }));
    expect(items[0].newName).toBe("x.y.b.txt");
  });

  it("文件夹对整名应用规则", () => {
    const items = planRenames([d("旧资料")], rule({ find: "旧", replace: "新" }));
    expect(items[0].newName).toBe("新资料");
  });

  it("前后缀 + 序号按顺序递增并左补零（原名保留：前缀+主名+序号+后缀）", () => {
    const items = planRenames([f("a.pdf"), f("b.pdf"), d("c")], rule({ prefix: "P", suffix: "s", useSeq: true, seqStart: 9, seqPad: 3 }));
    expect(items.map((i) => i.newName)).toEqual(["Pa009s.pdf", "Pb010s.pdf", "Pc011s"]);
  });

  it("未变更项不判错；变更后非法/重名被判错且被 pickRenames 过滤", () => {
    const items = planRenames(
      [f("same.txt"), f("a?.txt"), f("dup.bin"), f("dup2.bin")],
      rule({ find: "2", replace: "" }),
    );
    expect(items[0].changed).toBe(false);
    expect(items[0].error).toBeNull();
    // a?.txt 未被规则命中（不含"2"）：未变更不判错
    expect(items[1].changed).toBe(false);
    expect(items[1].error).toBeNull();
    // dup2.bin → dup.bin：与批内现有名冲突
    expect(items[3].newName).toBe("dup.bin");
    expect(items[3].error).toBe("目标重名");
    expect(pickRenames(items)).toEqual([]);
  });

  it("变更后名称非法被判错", () => {
    const items = planRenames([f("a?.txt")], rule({ find: "a", replace: "b" }));
    expect(items[0].newName).toBe("b?.txt");
    expect(items[0].error).toBe("名称非法");
    expect(pickRenames(items)).toEqual([]);
  });
});
