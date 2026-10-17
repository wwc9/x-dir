// np-* 类名审计回归测试：TS/TSX 引用的每个 np-* 类必须在 index.css 有定义，
// 或在白名单内（JS 查询钩子 / 语义标记类）。
// 2026-10-15 体检发现 5 个无定义死类（np-ctxmenu / np-select-menu / np-dup-group /
// np-cmp-sec / np-menued-cond-pop），本测试防回归。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 无 CSS 定义但合法的类：用途见行内注释；新增成员必须说明理由 */
const ALLOWLIST = new Set<string>([
  "np-dialog", // Blueprint Dialog 上的语义标记类，样式由 .bp6-dialog + 皮肤类（np-pv 等）承担
  "np-pop-trigger", // JS 查询钩子（TitleBar 判断点击目标是否在弹层触发钮内），不参与样式
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (f !== "__tests__") walk(p, out);
    } else if (/\.(tsx|ts)$/.test(f) && !f.includes(".test.")) out.push(p);
  }
  return out;
}

const SRC = join(__dirname, "..", "..");
const css = readFileSync(join(SRC, "index.css"), "utf8");
const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]));

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const used = new Set<string>();
for (const f of walk(SRC)) {
  const src = stripComments(readFileSync(f, "utf8"));
  // (?<![-\w]) 排除 CSS 变量名（--np-icon-*）与标识符片段；以 - 结尾的是动态前缀（np-col-${…}）
  for (const m of src.matchAll(/(?<![-\w])np-[a-z0-9-]+/g)) {
    const cls = m[0];
    if (!cls.endsWith("-")) used.add(cls);
  }
}

describe("np-* 类名审计", () => {
  it("类名引用非空（扫描自检）", () => {
    expect(used.size).toBeGreaterThan(100);
  });

  it("每个被引用的 np-* 类都有 CSS 定义或在白名单内", () => {
    const orphans = [...used].filter((c) => !defined.has(c) && !ALLOWLIST.has(c));
    expect(orphans).toEqual([]);
  });

  it("白名单成员不得已有 CSS 定义（防止占着白名单不放）", () => {
    const stale = [...ALLOWLIST].filter((c) => defined.has(c));
    expect(stale).toEqual([]);
  });
});
