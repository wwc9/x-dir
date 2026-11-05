import { describe, expect, it } from "vitest";

import { typeAheadStep } from "../typeAhead";

const items = ["a.txt", "ab.txt", "b.md", "AB2.txt", "c"].map((name, i) => ({
  name,
  path: `C:\\${name}-${i}`,
}));

// 重复首字母场景：多个 b 开头条目 + 恰好存在 "bb" 前缀条目（TC/Explorer 在此
// 病灶上会停驻/乒乓，b3、b1 永远循环不到）
const repItems = ["b1.txt", "bb.txt", "b2.txt", "b3.txt"].map((name, i) => ({
  name,
  path: `C:\\${name}-${i}`,
}));

describe("typeAheadStep（前缀匹配，TC/Explorer 惯例）", () => {
  it("无选中时从头部开始匹配前缀", () => {
    const r = typeAheadStep(items, "", "a", -1);
    expect(r?.idx).toBe(0);
    expect(r?.disp).toBe("a");
  });

  it("大小写不敏感", () => {
    expect(typeAheadStep(items, "a", "B", -1)?.idx).toBe(1); // ab.txt
  });

  it("多字符缓冲逐字符累积（ab → ab.txt）", () => {
    const r = typeAheadStep(items, "a", "b", -1);
    expect(r?.idx).toBe(1);
    expect(r?.buf).toBe("ab");
  });

  it("从当前项之后循环查找（回绕）", () => {
    expect(typeAheadStep(items, "", "a", 0)?.idx).toBe(1); // a.txt → ab.txt
    expect(typeAheadStep(items, "", "a", 3)?.idx).toBe(0); // AB2.txt 之后回绕
  });

  it("无命中返回 null", () => {
    expect(typeAheadStep(items, "", "z", -1)).toBeNull();
    expect(typeAheadStep([], "", "a", -1)).toBeNull();
  });
});

describe("重复字母按普通缓冲累积（2026-11-05 移除同键循环）", () => {
  it("重复字母即真针：bb 前缀命中 bb.txt", () => {
    expect(typeAheadStep(repItems, "b", "b", -1)).toMatchObject({
      idx: 1,
      disp: "bb",
      needle: "bb",
    });
  });
  it("继续扩展无命中即无匹配（bbb → null，不回退单字符）", () => {
    expect(typeAheadStep(repItems, "bb", "b", 1)).toBeNull();
  });
  it("无 bb 条目时 bb 同样无命中（不再循环 b 开头）", () => {
    const only = ["b1.txt", "b2.txt", "b3.txt"].map((name, i) => ({
      name,
      path: "C:\\dir\\" + name + "-" + i,
    }));
    expect(typeAheadStep(only, "b", "b", 0)).toBeNull();
  });
  it("打错的缓冲无命中 → null（单字符回退档已移除）", () => {
    expect(typeAheadStep(items, "a", "z", -1)).toBeNull();
  });
});

describe("* 前缀 = 子串匹配（TC 原生语义）", () => {
  const sub = ["topzebra.txt", "zebra.md", "a.txt"].map((name, i) => ({
    name,
    path: `C:\\${name}-${i}`,
  }));

  it("*z 命中名称中段", () => {
    expect(typeAheadStep(sub, "*", "z", -1)).toMatchObject({ idx: 0, disp: "*z" });
  });

  it("* 重复字母同式：*zz 无包含命中 → null（循环已移除）", () => {
    expect(typeAheadStep(sub, "*z", "z", 1)).toBeNull();
  });

  it("裸 * 无意义返回 null", () => {
    expect(typeAheadStep(sub, "", "*", -1)).toBeNull();
  });

  it("裸前缀不会命中中段（要子串必须显式 *）", () => {
    expect(typeAheadStep(sub, "", "z", -1)?.idx).toBe(1); // zebra.md 前缀命中
    expect(typeAheadStep(sub, "t", "o", -1)?.idx).toBe(0); // to 前缀 topzebra
  });
});

// 中文条目：py = Rust 下发的拼音首字母串（名称小写、汉字逐个取首字母）
const cnItems = [
  { name: "forge请下这个txt文件", path: "E:\\a\\1", py: ["forgeqxzgtxtwj"] },
  { name: "modules", path: "E:\\a\\2", py: null },
  { name: "预算表.xlsx", path: "E:\\a\\3", py: ["ysb.xlsx"] },
];

describe("拼音首字母跳转（py 匹配串）", () => {
  it("敲拼音首字母命中中文名（预算表 → ysb）", () => {
    const r = typeAheadStep(cnItems, "y", "s", -1);
    expect(r?.idx).toBe(2);
    expect(r?.disp).toBe("ys");
  });

  it("混合名：ASCII 段原样、汉字段按首字母（从名称开头逐字符走）", () => {
    expect(typeAheadStep(cnItems, "forge", "q", -1)?.idx).toBe(0);
    expect(typeAheadStep(cnItems, "forgeqx", "z", -1)?.idx).toBe(0);
  });

  it("英文名不受影响，py 为 null 时回落名称前缀", () => {
    expect(typeAheadStep(cnItems, "mo", "d", -1)?.idx).toBe(1);
  });
});

// 中段首字母场景（2026-11-05）：py = Rust 下发拼音首字母串（ASCII/数字段原样保留）
const midItems = [
  { name: "2026年度审计报告.pdf", path: "E:\\m\\1", py: ["2026ndsjbg.pdf"] },
  { name: "审计底稿.docx", path: "E:\\m\\2", py: ["sjdg.docx"] },
  { name: "readme.md", path: "E:\\m\\3", py: null },
];

describe("拼音首字母中段匹配（文件名中间文字的首字母直达）", () => {
  it("前缀未命中时用名称中段首字母直达（sjb → 2026年度审计报告）", () => {
    // "sjb"：前缀无命中（sjdg 只到 sj 段），py 中段命中 2026年度**审**计**报**告
    expect(typeAheadStep(midItems, "sj", "b", -1)).toMatchObject({
      idx: 0,
      disp: "sjb",
    });
    // 接续 "g"：整串 "sjbg" 的中段唯一命中 = 当前项（驻留）→ 不前进，pill 无命中
    expect(typeAheadStep(midItems, "sjb", "g", 0)).toBeNull();
  });

  it("前缀命中优先于中段（与列表顺序无关）", () => {
    // 中段命中项在前、前缀命中项在后：needle "sjbg" 应落前缀命中（idx 1）
    const mix = [
      { name: "2026年度审计报告.pdf", path: "p0", py: ["2026ndsjbg.pdf"] },
      { name: "世界博览会.txt", path: "p1", py: ["sjbg.txt"] },
    ];
    expect(typeAheadStep(mix, "sjb", "g", -1)?.idx).toBe(1);
  });

  it("单字符不走中段（保持 Explorer 单键前缀语义）", () => {
    // "g" 无任何前缀命中；中段不启用（len=1）→ 不跳中段含 g 的 dg
    expect(typeAheadStep(midItems, "", "g", -1)).toBeNull();
  });

  it("重复字符与普通针同权：py 前缀与中段都可命中（循环移除后解禁）", () => {
    const rep = [
      { name: "b1.txt", path: "r0", py: null },
      { name: "报表板.xlsx", path: "r1", py: ["bbb.xlsx"] },
      { name: "b2.txt", path: "r2", py: null },
    ];
    expect(typeAheadStep(rep, "", "b", -1)?.idx).toBe(0); // b1
    // "bb"：py 前缀命中 bbb.xlsx（tier1 首选前缀）
    expect(typeAheadStep(rep, "b", "b", 0)).toMatchObject({ idx: 1, needle: "bb", src: 0 });
    // "bb" 中段（名称以别的字开头）：年度报表板 → ndbbb 含 bb
    const mid = [{ name: "年度报表板.xlsx", path: "m0", py: ["ndbbb.xlsx"] }];
    expect(typeAheadStep(mid, "b", "b", -1)).toMatchObject({
      idx: 0,
      mode: "pymid",
      needle: "bb",
    });
    expect(matchRangeOf(mid[0].name, mid[0].py, "bb", "pymid")).toEqual([2, 2]);
  });

  it("中段命中也参与序位统计", () => {
    const two = [
      { name: "2026年度审计报告.pdf", path: "t0", py: ["2026ndsjbg.pdf"] },
      { name: "集团审计报告.docx", path: "t1", py: ["jtsjbg.docx"] },
    ];
    // 当前在第二命中（idx 1）继续扩展仍命中：环绕到第一命中，pos 按中段匹配集计
    expect(typeAheadStep(two, "sjb", "g", 1)).toMatchObject({ idx: 0, pos: 1, total: 2 });
  });

  it("旧语义退役：前缀失败不再返回 null，中段可达", () => {
    // 2026-11-05 前：qx 无前缀命中 → null（不能跳过开头直达中段）；
    // 现走 py 中段：forgeqxzgtxtwj 含 "qx" → 命中
    expect(typeAheadStep(cnItems, "q", "x", -1)).toMatchObject({ idx: 0, disp: "qx" });
  });
});

describe("序位统计（重复首字母回显 x/y）", () => {
  it("pos/total 按 1 起显示顺序计数", () => {
    // repItems 有 4 个 b 前缀：首敲 b 命中第 1 个
    expect(typeAheadStep(repItems, "", "b", -1)).toMatchObject({
      idx: 0,
      pos: 1,
      total: 4,
    });
    // "bb" 唯一前缀命中 bb.txt：1/1（bb 后再 b = "bbb" 无命中，循环已移除）
    expect(typeAheadStep(repItems, "b", "b", 0)).toMatchObject({
      idx: 1,
      pos: 1,
      total: 1,
});
  });

  it("整缓冲命中的统计按整缓冲计（bb 唯一 → 1/1）", () => {
    expect(typeAheadStep(repItems, "b", "b", 0)).toMatchObject({
      idx: 1,
      pos: 1,
      total: 1,
    });
  });

  it("唯一命中 total=1", () => {
    expect(typeAheadStep(items, "", "c", -1)).toMatchObject({ idx: 4, pos: 1, total: 1 });
  });
});

// ── Tab 循环 / Backspace 重匹配 / 行内高亮定位（2026-11-05 定案）──
import {
  matchRangeOf,
  typeAheadCycle,
  typeAheadRematch,
} from "../typeAhead";

describe("typeAheadCycle（Tab 命中集内循环，沿用生效针与档位）", () => {
  const cyc = [
    { name: "报表1.xlsx", path: "c0", py: ["bb1.xlsx"] },
    { name: "报表2.xlsx", path: "c1", py: ["bb2.xlsx"] },
    { name: "年度报表.docx", path: "c2", py: ["ndbb.docx"] }, // 中段命中档
  ];
  it("向后循环整缓冲命中集，环绕", () => {
    const m = typeAheadStep(cyc, "b", "b", -1)!; // "bb" 前缀命中 报表1
    expect(m).toMatchObject({ idx: 0, pos: 1, total: 2 });
    const n1 = typeAheadCycle(cyc, m, 0, 1)!;
    expect(n1).toMatchObject({ idx: 1, pos: 2, total: 2, needle: "bb", mode: "prefix" });
    const n2 = typeAheadCycle(cyc, n1, 1, 1)!;
    expect(n2.idx).toBe(0); // 环绕
    const p1 = typeAheadCycle(cyc, n1, 1, -1)!;
    expect(p1.idx).toBe(0); // 向前
  });
  it("拼音中段命中档循环不换档（sjbg 案例）", () => {
    const mid = [
      { name: "2026年度审计报告.pdf", path: "m0", py: ["2026ndsjbg.pdf"] },
      { name: "集团审计报告.docx", path: "m1", py: ["jtsjbg.docx"] },
    ];
    const m = typeAheadStep(mid, "sjb", "g", -1)!; // 中段命中 m0
    expect(m.mode).toBe("pymid");
    const n = typeAheadCycle(mid, m, 0, 1)!;
    expect(n).toMatchObject({ idx: 1, pos: 2, total: 2, mode: "pymid" });
  });
  it("集内唯一项循环原地驻留", () => {
    const m = typeAheadStep(items, "", "c", -1)!; // c 唯一
    expect(typeAheadCycle(items, m, 4, 1)?.idx).toBe(4);
  });
});

describe("typeAheadRematch（Backspace 回删重匹配）", () => {
  it("当前项在新缓冲下仍命中 → 驻留原位只刷新统计", () => {
    const m = typeAheadStep(repItems, "b", "b", 0)!; // "bb" → bb.txt
    const r = typeAheadRematch(repItems, "b", m.idx)!;
    // "b" 前缀集 = 4 项，bb.txt 是第 2 项
    expect(r).toMatchObject({ idx: 1, needle: "b", pos: 2, total: 4 });
  });
  it("回删后的缓冲当前项仍命中 → 驻留（预算表 y 档）", () => {
    const m = typeAheadStep(cnItems, "y", "s", -1)!; // "ys" 命中 预算表
    expect(m.idx).toBe(2);
    const r = typeAheadRematch(cnItems, "y", 2)!; // 回删到 "y"：当前仍前缀命中 → 驻留
    expect(r).toMatchObject({ idx: 2, needle: "y", pos: 1, total: 1 });
  });
  it("回删到空壳（裸 *）返回 null", () => {
    expect(typeAheadRematch(items, "*", -1)).toBeNull();
  });
});

describe("matchRangeOf（行内命中高亮的名称字符区间）", () => {
  it("名称前缀命中 → 名称头部区间", () => {
    expect(matchRangeOf("ab.txt", null, "ab", "prefix")).toEqual([0, 2]);
  });
  it("拼音中段命中 → 对齐回名称中段字符（省进 段）", () => {
    // py "2026n9ysjckkb"：ASCII/数字各 1 字符、汉字各 1 首字母 → 逐字符对齐；
    // 名称字符序：2 0 2 6 年 9 月 省 进 …（省 = 下标 7）
    const r = matchRangeOf("2026年9月省进出口快报", ["2026n9ysjckkb"], "sj", "pymid");
    expect(r).toEqual([7, 2]);
  });
  it("拼音前缀档命中 → 名称头部区间（按 py 对齐数）", () => {
    expect(matchRangeOf("预算表.xlsx", ["ysb.xlsx"], "ys", "prefix")).toEqual([0, 2]);
  });
  it("contains 命中名称 → 名称内区间", () => {
    expect(matchRangeOf("topzebra.txt", null, "zeb", "contains")).toEqual([3, 3]);
  });
  it("对不上（py 缺失 / 偏移错位）返回 null 不高亮", () => {
    expect(matchRangeOf("省进", null, "sj", "pymid")).toBeNull();
    expect(matchRangeOf("2026年9月省进出口快报", ["对不上的串"], "sj", "pymid")).toBeNull();
  });
});

// 多音字变体（2026-11-05）：晟=chéng/shèng（字典首选 chéng）——py 变体数组
// 同时携带 lc 与 ls 两串，敲 ls（联晟 常用读音）必须命中
describe("多音字首字母变体", () => {
  const dup = [
    {
      name: "2026年9月快报--江西联晟投资发展有限公司 (1)",
      path: "d0",
      py: [
        "2026n9ykb--jxlctzfzyxgs (1)",
        "2026n9ykb--jxlstzfzyxgs (1)",
      ],
    },
    { name: "readme.md", path: "d1", py: null },
  ];
  it("敲 ls 命中联晟（pymid 多变体 some 命中）", () => {
    expect(typeAheadStep(dup, "l", "s", -1)).toMatchObject({
      idx: 0,
      disp: "ls",
      mode: "pymid",
    });
  });
  it("行内高亮对齐到 ls 变体：联=下标 13，高亮 2 字符", () => {
    // 名称字符序：2 0 2 6 年 9 月 快 报 - - 江 西 联(13) 晟(14)…
    expect(matchRangeOf(dup[0].name, dup[0].py, "ls", "pymid")).toEqual([13, 2]);
  });
  it("敲 lc（字典首选读音）同样命中", () => {
    expect(typeAheadStep(dup, "l", "c", -1)?.idx).toBe(0);
  });
});

// 读音分层精度（2026-11-05「罕用读音降级」定案）：谷=lù 类词典次读法只做
// 兜底——首选层命中 > 变体前缀 > 变体中段，谷商类假阳性不再抢先
describe("读音分层：罕用读音兜底排序", () => {
  const guFile = {
    name: "2026.9月快报 （江西国信医药谷商业运营管理有限公司）",
    path: "g0",
    py: ["2026.9ykb（jxgxyygsyyyglxgs）", "2026.9ykb（jxgxyyylsyyyglxgs）"], // 谷: g / l(变体)
  };
  const lianPrefix = {
    name: "联晟电子2026年9月快报",
    path: "l0",
    py: ["lctz2026n9ykb", "lstz2026n9ykb"], // 晟: c(首选) / s(变体，居名称开头)
  };
  const lianMid = {
    name: "2026年9月快报--江西联晟投资发展有限公司 (1)",
    path: "l1",
    py: ["2026n9ykb--jxlctzfzyxgs (1)", "2026n9ykb--jxlstzfzyxgs (1)"],
  };
  const primaryLs = { name: "乐事预算.xlsx", path: "p0", py: ["lsys.xlsx"] }; // 首选读音 ls

  it("首选读音命中 > 变体命中：乐事先于联晟电子", () => {
    const r = typeAheadStep([lianPrefix, primaryLs], "l", "s", -1)!;
    expect(r).toMatchObject({ idx: 1, needle: "ls", mode: "prefix", src: 0 });
  });
  it("变体前缀 > 变体中段：联晟电子先于谷商（即使谷商排前）", () => {
    const r = typeAheadStep([guFile, lianPrefix], "l", "s", -1)!;
    expect(r).toMatchObject({ idx: 1, mode: "prefix", src: 1 });
  });
  it("变体中段兜底仍可达：联晟居名中的文件可定位（同级内按显示序）", () => {
    // 谷商与联晟-居名中同为变体中段档（词典无词频无法再分），档内显示序先者胜
    const r = typeAheadStep([guFile, lianMid], "l", "s", -1)!;
    expect(r).toMatchObject({ idx: 0, mode: "pymid", src: 1 });
    const r2 = typeAheadStep([lianMid, guFile], "l", "s", -1)!;
    expect(r2).toMatchObject({ idx: 0, mode: "pymid", src: 1 });
  });
  it("目录仅有谷商类假阳性来源时才兜底命中（排最后）", () => {
    const r = typeAheadStep([guFile], "l", "s", -1)!;
    expect(r).toMatchObject({ idx: 0, mode: "pymid", src: 1 });
  });
});
