import { describe, expect, it } from "vitest";

import {
  arabicToCnNum,
  withFreshIds,
  cnNumToArabic,
  parentFolderName,
  describeOp,
  diffFragments,
  illegalChars,
  newOp,
  pickRenames,
  planRenames,
  REN_TEMPLATES,
  type RenameOp,
} from "../batchRename";

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
    expect(items[3].error).toBe("改完后会与第 3 行重名");
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

describe("人话描述 / diff / 非法字符 / 模板（2026-11-07 易用性批）", () => {
  it("describeOp 各类型人话效果（参数实时反映）", () => {
    expect(describeOp(newOp({ type: "remove", find: "备份" }))).toBe("删除名称里所有的「备份」");
    expect(describeOp(newOp({ type: "replace", find: "2026审计", replace: "审计" }))).toBe("把「2026审计」替换为「审计」");
    expect(describeOp(newOp({ type: "replace", find: "x", replace: "", regex: true }))).toBe("查找正则「x」删除");
    expect(describeOp(newOp({ type: "prefix", text: "X-Dir_" }))).toBe("在最前面加「X-Dir_」");
    expect(describeOp(newOp({ type: "suffix", text: "-s" }))).toBe("在扩展名前加「-s」");
    expect(describeOp(newOp({ type: "insert", text: "前-", position: "start" }))).toBe("在名称开头插入「前-」");
    expect(describeOp(newOp({ type: "trim", head: 2, tail: 3 }))).toBe("去掉开头 2 个、末尾 3 个字符");
    expect(describeOp(newOp({ type: "number", position: "end", start: 1, pad: 3, separator: "-" }))).toBe(
      "在扩展名前加编号「-001」「-002」…",
    );
    expect(describeOp(newOp({ type: "case", mode: "lower" }))).toBe("把英文字母全部改为小写");
    expect(describeOp(newOp({ type: "date", format: "ymd", position: "start", separator: "_" }))).toContain("加文件修改日期");
  });

  it("diffFragments 取最长公共前后缀，中间为变更片段", () => {
    expect(diffFragments("底稿.docx", "底稿-001.docx")).toEqual({ pre: "底稿", mid: "-001", post: ".docx" });
    // 大小写差异在首字母：后缀 "g...png" 9 字符相同，mid = 新名前 3 字符
    expect(diffFragments("IMG_0001.png", "img_0001.png")).toEqual({ pre: "", mid: "img", post: "_0001.png" });
    expect(diffFragments("same.txt", "same.txt")).toEqual({ pre: "same.txt", mid: "", post: "" });
  });

  it("illegalChars 定位 Windows 非法字符（去重保序）", () => {
    expect(illegalChars("a?:b<c|.txt")).toEqual(["?", ":", "<", "|"]);
    expect(illegalChars("正常名称.txt")).toEqual([]);
  });

  it("错误人话：重名指出冲突行号，非法列出具体字符", () => {
    const items = planRenames([f("a copy.txt"), f("b.txt"), f("a?.txt")], ops(newOp({ type: "remove", find: " copy" })));
    // a copy.txt → a.txt（无冲突）；第三行 a?.txt 未变更不判错
    expect(items[0].error).toBeNull();
    // 构造重名：copy 删除后两行同名
    const items2 = planRenames(
      [f("a copy.txt"), f("a.txt")],
      ops(newOp({ type: "remove", find: " copy" })),
    );
    // a copy.txt → a.txt 撞上批内未变更的 a.txt（磁盘现有文件，执行必失败）
    expect(items2[0].error).toBe("改完后会与第 2 行重名");
    const items3 = planRenames([f("a?.txt")], ops(newOp({ type: "replace", find: "a", replace: "b" })));
    expect(items3[0].error).toBe("含有不允许的字符「?」");
  });

  it("常用任务模板：build 生成的规则链可直接出有效计划", () => {
    for (const tp of REN_TEMPLATES) {
      const items = planRenames([f("演示 File.TXT", 1e12)], tp.build());
      expect(items.every((i) => typeof i.newName === "string")).toBe(true);
    }
    const numbered = planRenames([f("a.txt"), f("b.txt")], REN_TEMPLATES[0].build());
    expect(numbered.map((i) => i.newName)).toEqual(["a-01.txt", "b-02.txt"]);
  });
});

describe("转换类规则（中文数字/补齐/四则/日期格式化/简繁/拼音）", () => {
  it("中文数字 → 阿拉伯（十/百/千/万进位 + 两）", () => {
    expect(cnNumToArabic("十二")).toBe(12);
    expect(cnNumToArabic("二十五")).toBe(25);
    expect(cnNumToArabic("一百零三")).toBe(103);
    expect(cnNumToArabic("三千零五十")).toBe(3050);
    expect(cnNumToArabic("一万二")).toBe(10002);
    expect(cnNumToArabic("两")).toBe(2);
    expect(cnNumToArabic("abc")).toBeNull();
    expect(cnNumToArabic("报告2025")).toBeNull();
  });

  it("阿拉伯 → 中文数字（零位折叠/节间补零/越界 null）", () => {
    expect(arabicToCnNum(0)).toBe("零");
    expect(arabicToCnNum(12)).toBe("十二");
    expect(arabicToCnNum(103)).toBe("一百零三");
    expect(arabicToCnNum(3050)).toBe("三千零五十");
    expect(arabicToCnNum(10001)).toBe("一万零一");
    expect(arabicToCnNum(120000000)).toBe("一亿二千万");
    expect(arabicToCnNum(1.5)).toBeNull();
    expect(arabicToCnNum(-3)).toBeNull();
  });

  it("planRenames：中文数字互转作用于名称", () => {
    const items = planRenames([f("第十二期报告")], ops(newOp({ type: "cnNum", mode: "toArabic" })));
    expect(items[0].newName).toBe("第12期报告");
    const items2 = planRenames([f("第12期报告")], ops(newOp({ type: "cnNum", mode: "toChinese" })));
    expect(items2[0].newName).toBe("第十二期报告");
  });

  it("补齐位数：短数字前补零，长数字不变", () => {
    const items = planRenames([f("第3期"), f("第2025期")], ops(newOp({ type: "padNum", width: 4 })));
    expect(items.map((i) => i.newName)).toEqual(["第0003期", "第2025期"]);
    const narrow = planRenames([f("第12期")], ops(newOp({ type: "padNum", width: 3 })));
    expect(narrow[0].newName).toBe("第012期"); // width=3 即补齐到 3 位
  });

  it("数字加减乘除（除法保留两位小数；可与补齐位数链式组合）", () => {
    const mk = (arith: "add" | "sub" | "mul" | "div", value: number) => newOp({ type: "arith", arith, value });
    expect(planRenames([f("第3期")], ops(mk("add", 1)))[0].newName).toBe("第4期");
    expect(planRenames([f("第10页")], ops(mk("sub", 3)))[0].newName).toBe("第7页");
    expect(planRenames([f("30张")], ops(mk("mul", 2)))[0].newName).toBe("60张");
    expect(planRenames([f("30张")], ops(mk("div", 4)))[0].newName).toBe("7.5张");
    const items = planRenames([f("003号")], ops(mk("add", 1), newOp({ type: "padNum", width: 3 })));
    expect(items[0].newName).toBe("004号");
  });

  it("日期格式化：识别常见写法统一为目标格式，非法串不动", () => {
    const reformat = (fmt: "ymd" | "ymdCompact" | "cn", name: string) =>
      planRenames([f(name)], ops(newOp({ type: "dateFormat", format: fmt })))[0].newName;
    expect(reformat("cn", "2026-11-07报告")).toBe("2026年11月7日报告");
    expect(reformat("ymd", "报告20261107")).toBe("报告2026-11-07");
    expect(reformat("ymd", "报告20261107_140509")).toBe("报告2026-11-07");
    expect(reformat("ymdCompact", "2026年11月7日底稿")).toBe("20261107底稿");
    expect(reformat("ymd", "2026/11/7底稿")).toBe("2026-11-07底稿");
    expect(reformat("ymd", "20251340报告")).toBe("20251340报告"); // 13月40日非法
    expect(reformat("ymd", "140509")).toBe("140509"); // 年份 1405 < 1900
    expect(reformat("ymd", "第2025期")).toBe("第2025期"); // 年份后无月日
  });

  it("简繁转换（opencc-js 词典，词级转换）", () => {
    const items = planRenames([f("审计报告数据库")], ops(newOp({ type: "chinese", mode: "s2t" })));
    expect(items[0].newName).toBe("審計報告數據庫");
    const items2 = planRenames([f("審計報告資料庫")], ops(newOp({ type: "chinese", mode: "t2s" })));
    expect(items2[0].newName).toBe("审计报告资料库");
  });

  it("转拼音（首字母/全拼，非汉字原样保留）", () => {
    const items = planRenames([f("拼音")], ops(newOp({ type: "pinyin", mode: "initials" })));
    expect(items[0].newName).toBe("py");
    const items2 = planRenames([f("拼音2025")], ops(newOp({ type: "pinyin", mode: "full" })));
    expect(items2[0].newName).toBe("pinyin2025");
    const items3 = planRenames([f("审计ABC2025")], ops(newOp({ type: "pinyin", mode: "initials" })));
    expect(items3[0].newName).toBe("sjABC2025");
  });

  it("describeOp 转换类人话效果", () => {
    expect(describeOp(newOp({ type: "cnNum", mode: "toArabic" }))).toBe("把名称里的中文数字换成阿拉伯数字");
    expect(describeOp(newOp({ type: "padNum", width: 3 }))).toBe("把名称里的数字补齐到 3 位");
    expect(describeOp(newOp({ type: "arith", arith: "mul", value: 2 }))).toBe("把名称里的数字乘 2");
    expect(describeOp(newOp({ type: "dateFormat", format: "cn" }))).toBe("把名称里的日期统一成「2026年11月7日」写法");
    expect(describeOp(newOp({ type: "chinese", mode: "s2t" }))).toBe("把简体汉字转换为繁体");
    expect(describeOp(newOp({ type: "pinyin", mode: "initials" }))).toBe("把汉字转换为拼音首字母");
  });
});

describe("删除指定字符（字符类勾选 + 删除/保留）", () => {
  it("删除勾选类型：空格+数字", () => {
    const items = planRenames([f("ab c12 3d.txt")], ops(newOp({ type: "removeCls", keep: false, cls: ["space", "digit"] })));
    expect(items[0].newName).toBe("abcd.txt");
  });
  it("保留模式：只保留汉字", () => {
    const items = planRenames([f("ab12汉字cd")], ops(newOp({ type: "removeCls", keep: true, cls: ["hanzi"] })));
    expect(items[0].newName).toBe("汉字");
  });
  it("中文/英文标点分类可分", () => {
    const cn = planRenames([f("a、b。c")], ops(newOp({ type: "removeCls", keep: false, cls: ["cnPunct"] })));
    expect(cn[0].newName).toBe("abc");
    const en = planRenames([f("a-b_c")], ops(newOp({ type: "removeCls", keep: false, cls: ["enPunct"] })));
    expect(en[0].newName).toBe("abc");
  });
  it("非法字符类含 Windows 保留字符", () => {
    const items = planRenames([f("a|b")], ops(newOp({ type: "removeCls", keep: false, cls: ["illegal"] })));
    expect(items[0].newName).toBe("ab");
  });
  it("大小写分开勾选", () => {
    const items = planRenames([f("aA1bB")], ops(newOp({ type: "removeCls", keep: false, cls: ["upper", "digit"] })));
    expect(items[0].newName).toBe("ab");
  });
  it("未勾选 = 原样不变（兜底句交给 UI）", () => {
    const items = planRenames([f("a b")], ops(newOp({ type: "removeCls", keep: false, cls: [] })));
    expect(items[0].newName).toBe("a b");
    expect(items[0].changed).toBe(false);
  });
  it("describeOp：删除/保留两态人话", () => {
    expect(describeOp(newOp({ type: "removeCls", keep: false, cls: ["space", "digit"] }))).toBe("删除名称里的空格、数字");
    expect(describeOp(newOp({ type: "removeCls", keep: true, cls: ["hanzi"] }))).toBe("只保留名称里的汉字（删除其余字符）");
    expect(describeOp(newOp({ type: "removeCls", keep: false, cls: [] }))).toBe("未勾选要删除的字符类型");
  });
});

describe("首批扩容规则（首尾空白/父文件夹名/插入第N字符后/扩展名小写）", () => {
  it("去首尾空白（含全角空格，内部空白不动）", () => {
    const items = planRenames([f("  报告  .txt"), f("　底稿　"), f("a b.txt")], ops(newOp({ type: "trimEdges" })));
    expect(items.map((i) => i.newName)).toEqual(["报告.txt", "底稿", "a b.txt"]);
    expect(items.every((i) => i.changed === (i.oldName !== i.newName))).toBe(true);
  });

  it("父文件夹名：前缀/后缀 + 分隔符；盘根文件跳过", () => {
    const items = planRenames([f("底稿.txt")], ops(newOp({ type: "parent", position: "start", separator: "-" })));
    expect(items[0].newName).toBe("d-底稿.txt");
    const items2 = planRenames([f("底稿.txt")], ops(newOp({ type: "parent", position: "end", separator: "_" })));
    expect(items2[0].newName).toBe("底稿_d.txt");
    // 盘根文件（C:\a.txt）无父文件夹名 → 原样
    const root = { path: "C:\a.txt", name: "a.txt", isDir: false };
    const items3 = planRenames([root], ops(newOp({ type: "parent", position: "start", separator: "-" })));
    expect(items3[0].newName).toBe("a.txt");
    expect(items3[0].changed).toBe(false);
  });

  it("插入文字：第 N 个字符后（越界钳制到末尾）", () => {
    const items = planRenames([f("ABC.txt")], ops(newOp({ type: "insert", position: "at", at: 2, text: "-" })));
    expect(items[0].newName).toBe("AB-C.txt");
    const items2 = planRenames([f("AB.txt")], ops(newOp({ type: "insert", position: "at", at: 9, text: "-" })));
    expect(items2[0].newName).toBe("AB-.txt");
  });

  it("扩展名小写（case+ext+lower 句式卡）", () => {
    const items = planRenames([f("报告.TXT"), f("照片.PNG")], ops(newOp({ type: "case", scope: "ext", mode: "lower" })));
    expect(items.map((i) => i.newName)).toEqual(["报告.txt", "照片.png"]);
  });

  it("describeOp：新类型人话效果", () => {
    expect(describeOp(newOp({ type: "trimEdges" }))).toBe("去掉名称首尾的空白（含全角空格）");
    expect(describeOp(newOp({ type: "parent", position: "start", separator: "-" }))).toBe("在名称开头加父文件夹名");
    expect(describeOp(newOp({ type: "insert", position: "at", at: 2, text: "-" }))).toBe("在第 2 个字符后插入「-」");
    expect(describeOp(newOp({ type: "case", scope: "ext", mode: "lower" }))).toBe("把英文字母全部改为小写");
  });

  it("parentFolderName 纯函数", () => {
    expect(parentFolderName("C:\\d\\sub\\a.txt")).toBe("sub");
    expect(parentFolderName("C:\\d\\a.txt")).toBe("d");
    expect(parentFolderName("C:\\a.txt")).toBe("");
    expect(parentFolderName("/home/user/a.txt")).toBe("user");
  });
});

it("withFreshIds：方案套用重发 id 且字段原样保留", () => {
  const chain = ops(newOp({ type: "trimEdges" }), newOp({ type: "arith", arith: "add", value: 1 }));
  const fresh = withFreshIds(chain);
  expect(fresh.map((o) => o.id)).not.toEqual(chain.map((o) => o.id));
  expect(new Set(fresh.map((o) => o.id)).size).toBe(fresh.length);
  expect(fresh[0].type).toBe("trimEdges");
  const arith = fresh[1] as Extract<RenameOp, { type: "arith" }>;
  expect(arith.arith).toBe("add");
  expect(arith.value).toBe(1);
});
