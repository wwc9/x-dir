import { describe, expect, it } from "vitest";

import { POOL_SIZE, randomSchemeName } from "../schemeName";

describe("randomSchemeName（随机方案默认名）", () => {
  it("无重名时直接返回词池词", () => {
    // rand=0 → 永远取池中第一个词
    expect(randomSchemeName(["别的方案"], () => 0)).toBe(POOL_FIRST);
    // rand≈1 → 取池中最后一个词
    expect(randomSchemeName([], () => 0.999999)).toBe(POOL_LAST);
  });

  it("重名时在同词后追加序号，跳过已占用的序号", () => {
    expect(randomSchemeName([POOL_FIRST], () => 0)).toBe(`${POOL_FIRST} 2`);
    expect(randomSchemeName([POOL_FIRST, `${POOL_FIRST} 2`], () => 0)).toBe(
      `${POOL_FIRST} 3`,
    );
  });

  it("重名比较大小写不敏感", () => {
    expect(randomSchemeName(["晚风".toUpperCase()], () => 0)).toBe("晚风 2");
  });

  it("rand 全域随机不会越界，且始终非空", () => {
    for (let i = 0; i < 500; i++) {
      const name = randomSchemeName([], Math.random);
      expect(name.length).toBeGreaterThan(0);
      expect(POOL_SIZE).toBeGreaterThan(16); // 词池足够分散
    }
  });
});

const POOL_FIRST = randomSchemeName([], () => 0);
const POOL_LAST = randomSchemeName([], () => 0.999999);
