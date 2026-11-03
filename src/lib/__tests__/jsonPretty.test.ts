import { describe, expect, it } from "vitest";

import { prettyJson } from "../jsonPretty";

describe("压缩 JSON 自动排版（prettyJson，2026-11-03）", () => {
  it("压缩单行对象 → 2 空格缩进排版", () => {
    const r = prettyJson('{"a":1,"b":[1,2]}');
    expect(r).not.toBeNull();
    expect(r!.text).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  });

  it("压缩单行数组同样排版", () => {
    const r = prettyJson('[1,{"x":true}]');
    expect(r!.text).toContain("\n");
    expect(r!.text).toContain("  ");
  });

  it("已含换行（本就排版过）→ 不动", () => {
    expect(prettyJson('{\n  "a": 1\n}')).toBeNull();
  });

  it("非法 JSON / 纯量 / 空串 → null", () => {
    expect(prettyJson("{oops}")).toBeNull();
    expect(prettyJson("123")).toBeNull();
    expect(prettyJson('"text"')).toBeNull();
    expect(prettyJson("")).toBeNull();
    expect(prettyJson("  ")).toBeNull();
  });

  it("超长内容（> maxChars）→ null", () => {
    const big = '{"a":"' + "x".repeat(200_001) + '"}';
    expect(prettyJson(big)).toBeNull();
    expect(prettyJson('{"a":1}', 4)).toBeNull();
  });

  it("重排结果异常膨胀（>1.5×）→ 保持原文", () => {
    // 深嵌套单元素数组重排会产生大量换行与缩进
    const deep = "[".repeat(500) + "]".repeat(500);
    expect(prettyJson(deep, 10_000)).toBeNull();
  });
});
