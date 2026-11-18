// 窗缘盖板 ↔ 画布成对审计回归测试：glasswin 作用域下凡 body 直铺画布背景
// （background / background-image），同一规则必须同时命中顶缘盖板
// .np-winedge-top。盖板（顶缘 ~2px WebView2 合成器毛刺覆盖物，见 index.css
// winedge 段）与画布是两层独立绘制，靠「同一规则逐字同源 + attachment fixed
// 同视口坐标系」保证像素逐点一致；2026-11-18 曾因 166aaeb 重写五案深色时
// 连带删除 custom 模式的独立克隆规则，致「顶栏白条」复发（2026-11-19 用户
// 再反馈）——本测试把成对约定升级为 CI 硬门禁，结构性杜绝再次漂移。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(__dirname, "..", "..", "index.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** 提取全部声明块（朴素扫描：声明体不含花括号，@media/@supports/@keyframes
 *  壳与帧选择器〔from/to/0%〕不会命中 glasswin 断言） */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1],
  body: m[2],
}));

/** glasswin 作用域内直铺 body 画布的规则（背景层属值级声明，变量声明不命中） */
const paintsCanvas = (r: { selector: string; body: string }) =>
  r.selector.includes("html.glasswin") &&
  r.selector.includes("> body") &&
  /background(-image)?\s*:/.test(r.body);

describe("winedge 顶缘盖板 ↔ 画布成对审计", () => {
  it("规则提取自检：glasswin 规则在位", () => {
    expect(rules.some((r) => r.selector.includes("html.glasswin"))).toBe(true);
  });

  it("glasswin 下 body 画布规则必须与 .np-winedge-top 同规则成对", () => {
    const violators = rules
      .filter(paintsCanvas)
      .filter((r) => !r.selector.includes(".np-winedge-top"))
      .map((r) => r.selector.trim());
    expect(violators).toEqual([]);
  });

  it("custom 模式：成对克隆必须含图片与蒙版两层（浅/深各一）", () => {
    const paired = rules.filter(
      (r) =>
        r.selector.includes('data-glassbg="custom"]') &&
        r.selector.includes("> body") &&
        r.selector.includes(".np-winedge-top"),
    );
    const light = paired.find((r) => !r.selector.includes(".bp6-dark"));
    const dark = paired.find((r) => r.selector.includes(".bp6-dark"));
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    for (const r of [light, dark]) {
      expect(r!.body).toContain("var(--glassbg-img)");
      expect(r!.body).toContain("--glassbg-veil");
    }
  });

  it("aurora 基座：顶缘盖板克隆 var(--np-bg)（fixed 同视口坐标系）", () => {
    const base = rules.find(
      (r) =>
        r.selector.includes("html.glasswin .np-winedge-top") &&
        r.body.includes("var(--np-bg)"),
    );
    expect(base).toBeDefined();
  });
});
