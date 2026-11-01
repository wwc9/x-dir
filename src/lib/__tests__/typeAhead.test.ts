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

describe("重复首字母循环", () => {
  it("重复按 b 在全部 b 开头条目间循环（不停驻、不乒乓）", () => {
    expect(typeAheadStep(repItems, "", "b", -1)?.idx).toBe(0); // b1
    // "bb" 前缀恰好命中 bb.txt：整缓冲命中且前进 → 跳过去（刻意输入 bb 仍有效）
    expect(typeAheadStep(repItems, "b", "b", 0)).toMatchObject({ idx: 1, disp: "bb" });
    // 已在 bb.txt：整缓冲 "bbb" 无命中 → 立即回退单字符循环 → b2
    expect(typeAheadStep(repItems, "bb", "b", 1)).toMatchObject({ idx: 2, disp: "b" });
    expect(typeAheadStep(repItems, "bbb", "b", 2)?.idx).toBe(3); // b3
    expect(typeAheadStep(repItems, "bbbb", "b", 3)?.idx).toBe(0); // 回绕 b1
  });

  it("缓冲保留完整输入供接续（回退不截断 buf）", () => {
    expect(typeAheadStep(repItems, "bb", "b", 1)?.buf).toBe("bbb");
  });

  it("无 bb 干扰时重复键同样循环", () => {
    const only = ["b1.txt", "b2.txt", "b3.txt"].map((name, i) => ({
      name,
      path: `C:\\${name}-${i}`,
    }));
    expect(typeAheadStep(only, "b", "b", 0)?.idx).toBe(1);
    expect(typeAheadStep(only, "bb", "b", 1)?.idx).toBe(2);
    expect(typeAheadStep(only, "bbb", "b", 2)?.idx).toBe(0);
  });

  it("打错的缓冲回退单字符继续跳", () => {
    // "a" 后敲 z：az 无命中 → 回退 z 单字符也无命中 → null
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

  it("* 重复字母在包含匹配间循环", () => {
    // 当前在 zebra.md（1）继续敲 z：*zz 无包含命中 → 回退 *z 包含循环 → 回绕 topzebra
    expect(typeAheadStep(sub, "*z", "z", 1)).toMatchObject({ idx: 0, disp: "*z" });
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
  { name: "forge请下这个txt文件", path: "E:\\a\\1", py: "forgeqxzgtxtwj" },
  { name: "modules", path: "E:\\a\\2", py: null },
  { name: "预算表.xlsx", path: "E:\\a\\3", py: "ysb.xlsx" },
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

  it("前缀语义与英文名一致：不能跳过开头直达中段", () => {
    expect(typeAheadStep(cnItems, "q", "x", -1)).toBeNull(); // qx 无命中 → 回退 x 也无
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
    // 循环到 b2 = 第 3 个；统计按生效单字符 needle 计
    expect(typeAheadStep(repItems, "bb", "b", 1)).toMatchObject({
      idx: 2,
      pos: 3,
      total: 4,
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
