import { describe, expect, it } from "vitest";

import { expandPattern, parseNameLines, planFolders } from "../folderBatch";

describe("名单解析（parseNameLines）", () => {
  it("逐行 trim、去空行", () => {
    expect(parseNameLines("  甲 \n\n乙\n\r\n\t丙\t")).toEqual(["甲", "乙", "丙"]);
    expect(parseNameLines("")).toEqual([]);
  });
});

describe("序号模板展开（expandPattern）", () => {
  it("{} 按止号位数补零", () => {
    expect(expandPattern("第{}章", 1, 3)).toEqual(["第1章", "第2章", "第3章"]);
    expect(expandPattern("第{}章", 8, 12)).toEqual([
      "第08章",
      "第09章",
      "第10章",
      "第11章",
      "第12章",
    ]);
  });
  it("无占位符退化为单项；起止倒置为空；超上限截断", () => {
    expect(expandPattern("单独", 1, 9)).toEqual(["单独"]);
    expect(expandPattern("第{}章", 5, 1)).toEqual([]);
    expect(expandPattern("{}", 1, 1000)).toHaveLength(500);
  });
});

describe("预演命名（planFolders）", () => {
  it("非法名与名单内重名标 error，不中断后续", () => {
    const plan = planFolders("lines", "甲\ncon\n甲\nAB\nab", "", 1, 0, []);
    expect(plan).toEqual([
      { req: "甲", name: "甲", error: null },
      { req: "con", name: null, error: "名称含非法字符或为 Windows 保留名" },
      { req: "甲", name: null, error: "名单内重名" },
      { req: "AB", name: "AB", error: null },
      { req: "ab", name: null, error: "名单内重名" },
    ]);
  });

  it("与磁盘已有项重名按 (2) 递增（含扩展名拆分口径）", () => {
    const plan = planFolders("lines", "data\nv1.2\ndata", "", 1, 0, [
      "data",
      "v1.2",
    ]);
    // 带点名的避让与 jobs::pick 同款：stem 加 (2)、扩展名原样保留
    expect(plan.map((p) => p.name)).toEqual(["data (2)", "v1 (2).2", null]);
  });

  it("预演名互相避让：连续同名请求依次 (2)(3)", () => {
    // existing 同时有 data / data (2) / data (3)，请求 data → 得 data (4)
    const plan = planFolders("lines", "data", "", 1, 0, [
      "data",
      "data (2)",
      "data (3)",
    ]);
    expect(plan[0].name).toBe("data (4)");
  });

  it("pattern 模式走同一套判定", () => {
    // 补零位数只取决于止号（3 → 1 位），撞车走 (2) 避让而非改写补零
    const plan = planFolders("pattern", "", "周{}", 1, 3, ["周2"]);
    expect(plan.map((p) => p.name)).toEqual(["周1", "周2 (2)", "周3"]);
  });
});
