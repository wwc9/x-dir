import { describe, expect, it } from "vitest";

import { compileRegex, DEFAULT_RULE, pickRenames, planRenames, type RenameRule } from "../batchRename";

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

describe("批量重命名高级规则（2026-11-07 市场对齐批）", () => {
  it("正则全局替换 + $1 捕获组", () => {
    // 日期换位：29-03-2020 → 2020-03-29（PowerRename 经典示例）
    const items = planRenames(
      [f("29-03-2020底稿.docx")],
      rule({ find: "(\\d{2})-(\\d{2})-(\\d{4})", replace: "$3-$2-$1", regex: true }),
    );
    expect(items[0].newName).toBe("2020-03-29底稿.docx");
    // 全局：所有匹配都被替换
    const items2 = planRenames([f("a-1-b-1.docx")], rule({ find: "1", replace: "x", regex: true }));
    expect(items2[0].newName).toBe("a-x-b-x.docx");
  });

  it("正则非法：替换项判「正则无效」且不可执行", () => {
    const items = planRenames([f("底稿(2023).docx")], rule({ find: "(", replace: "x", regex: true }));
    expect(items[0].changed).toBe(true);
    expect(items[0].error).toBe("正则无效");
    expect(pickRenames(items)).toEqual([]);
  });

  it("compileRegex 与引擎同源判定非法正则", () => {
    expect(compileRegex("(")).toBeNull();
    expect(compileRegex("\\d+")?.source).toBe("\\d+");
    expect(compileRegex("")).toBeNull();
  });

  it("大小写格式化：全大写/全小写/每词首字母大写（中文原样）", () => {
    expect(planRenames([f("audit report.docx")], rule({ caseMode: "upper" }))[0].newName).toBe("AUDIT REPORT.docx");
    expect(planRenames([f("Audit Report.docx")], rule({ caseMode: "lower" }))[0].newName).toBe("audit report.docx");
    expect(planRenames([f("audit report 底稿.docx")], rule({ caseMode: "title" }))[0].newName).toBe(
      "Audit Report 底稿.docx",
    );
    // 与查找替换叠加：先替换后格式化
    expect(
      planRenames([f("q3 report.docx")], rule({ find: "q3", replace: "Q4", caseMode: "lower" }))[0].newName,
    ).toBe("q4 report.docx");
  });

  it("仅扩展名模式：替换与大小写只作用于扩展名段，前后缀序号不参与", () => {
    const items = planRenames([f("底稿.JPEG")], rule({ find: "JPEG", replace: "jpg", caseMode: "lower", extOnly: true }));
    expect(items[0].newName).toBe("底稿.jpg");
    // 前后缀/序号在 extOnly 下不参与（即使给了也不生效）
    const items2 = planRenames([f("底稿.jpeg")], rule({ prefix: "P", suffix: "s", useSeq: true, extOnly: true }));
    expect(items2[0].newName).toBe("底稿.jpeg");
    // 文件夹无扩展名概念：extOnly 对整名不生效（splitName 返回空 ext）
    const dirs = planRenames([d("资料")], rule({ find: "资料", replace: "档案", extOnly: true }));
    expect(dirs[0].changed).toBe(false);
  });
});
