import { describe, expect, it } from "vitest";

import { mergeDialogPrefs, sanitizeDialogPrefs } from "../dialogPrefs";

describe("对话框参数记忆（dialogPrefs，2026-11-09 P2）", () => {
  it("sanitizeDialogPrefs：仅收两层 primitive 对象表，脏值整键剔除", () => {
    expect(
      sanitizeDialogPrefs({
        imgCompress: { target: 1, quality: 75, ok: true },
        // 值含非 primitive 的键剔除；空壳组不收
        bad: { nested: { a: 1 }, arr: [1], nil: null, keep: "x" },
        empty: {},
        notObj: 42,
        arr: ["x"],
      }),
    ).toEqual({
      imgCompress: { target: 1, quality: 75, ok: true },
      bad: { keep: "x" },
    });
    // 非对象/数组/裸值 = 空表
    expect(sanitizeDialogPrefs(null)).toEqual({});
    expect(sanitizeDialogPrefs([1])).toEqual({});
    expect(sanitizeDialogPrefs("x")).toEqual({});
  });

  it("mergeDialogPrefs：磁盘缺字段回落默认，类型不符忽略，多余键不带入", () => {
    const fb = { target: 0, quality: 75, label: "智能" };
    expect(mergeDialogPrefs(fb, { target: 2, quality: 60 })).toEqual({
      target: 2,
      quality: 60,
      label: "智能",
    });
    // 类型不符（quality 存成字符串）→ 该键回落默认
    expect(mergeDialogPrefs(fb, { quality: "60", unknown: 1 })).toEqual({
      target: 0,
      quality: 75,
      label: "智能",
    });
    // 脏 saved（非对象）= 纯默认
    expect(mergeDialogPrefs(fb, null)).toEqual(fb);
    expect(mergeDialogPrefs(fb, "x")).toEqual(fb);
    // 不原地改 fallback
    const src = { ...fb };
    mergeDialogPrefs(src, { target: 3 });
    expect(src).toEqual(fb);
  });
});
