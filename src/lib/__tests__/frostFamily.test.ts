// 强霜浮层家族成员审计回归测试：glasswin 作用域下凡「浮离画布之上」的浮层
// 面板（菜单/气泡/自绘下拉/功能库面板等）必须入强霜家族——background 用
// --np-surface-glass-strong（弹层浓度参数）且挂 backdrop-filter（弹层模糊
// 参数 0.55 联动 + 8px 下限）。半透明面无模糊即「穿透病」（背后内容锐利
// 穿透）；漏网浮层会经 token 继承拿到半透明底而无模糊（2026-11-19 用户
// 反馈功能库面板 np-palette 与二级弹窗不一致即此病——它不带 glasswin 作用
// 域、靠 --np-surface 在 glasswin 下的继承变半透明，规则扫描抓不到，故以
// 家族成员名单锁死）。新浮层入族 = index.css 强霜家族规则补选择器 + 本测试
// 名单补成员（须注理由）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(__dirname, "..", "..", "index.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1],
  body: m[2],
}));

/** glasswin 强霜家族规则 = 挂 backdrop-filter 且 background 用强霜 token */
const familyRules = rules.filter(
  (r) =>
    r.selector.includes("html.glasswin") &&
    /backdrop-filter/.test(r.body) &&
    r.body.includes("var(--np-surface-glass-strong)"),
);

/** 必须入族的浮层（浮离画布之上的面板/下拉；新成员必须注释理由） */
const REQUIRED_MEMBERS: [string, string][] = [
  [".bp6-menu", "右键/顶栏菜单"],
  [".bp6-popover-content", "Popover 自定义内容弹层（布局预设等）"],
  [".np-tip", "悬浮提示"],
  [".np-sugg", "地址补全下拉"],
  [".np-cal-jump", "日历年月跳转下拉"],
  [".np-cal-hits", "日历命中下拉"],
  [".np-palette", "功能库快速命令面板（2026-11-19 收编）"],
  [".np-clip-srcmenu", "剪贴板浮窗来源筛选自绘下拉（2026-11-25 来源筛选）"],
  [".np-pv-sheet-detail", "表格预览单元格详情浮层（2026-11-26 八项增强：Enter/双击看全文，浮于网格之上）"],
];

describe("强霜浮层家族成员审计", () => {
  it("家族规则在位且消费弹层参数", () => {
    expect(familyRules.length).toBeGreaterThan(0);
    // 模糊 = 家族规则体内直接消费；浓度 = 经 token 定义消费
    // （--np-surface-glass-strong: rgba(…, var(--np-glass-pop-alpha))）
    expect(
      familyRules.map((r) => r.body).join("\n"),
    ).toContain("var(--np-glass-pop-blur");
    const tokenDef = rules.find(
      (r) =>
        /--np-surface-glass-strong\s*:/.test(r.body) &&
        r.body.includes("var(--np-glass-pop-alpha"),
    );
    expect(tokenDef, "强霜 token 未接弹层浓度参数").toBeDefined();
  });

  it.each(REQUIRED_MEMBERS)("浮层 %s 已入族", (cls) => {
    const hit = familyRules.some((r) => r.selector.includes(cls));
    expect(hit, `${cls} 未入强霜家族（穿透病风险）`).toBe(true);
  });
});
