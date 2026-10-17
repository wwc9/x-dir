// 图标渲染规范回归测试（AGENTS §4.5）：lucide 组件只允许经 AppIcon/ic() 渲染，
// 任何组件文件直接 JSX 渲染 `<IconName>` 即判失败。
// 2026-10-15 体检发现 DialogHost 直接渲染 <ArrowRight>，本测试防回归。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

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
const files = walk(SRC).filter((f) => relative(SRC, f).replace(/\\/g, "/") !== "components/AppIcon.tsx");

describe("图标渲染唯一入口（§4.5）", () => {
  it("除 AppIcon.tsx 外，任何文件不得直接 JSX 渲染 lucide 组件", () => {
    const violations: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const m = src.match(/import\s*{([^}]*)}\s*from\s*["']lucide-react["']/);
      if (!m) continue;
      const names = m[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/).pop()!)
        .filter(Boolean);
      for (const n of names) {
        if (new RegExp(`<${n}(\\s|/?>)`).test(src)) {
          violations.push(`${relative(SRC, f)}: <${n}> 直接渲染（应经 <AppIcon icon={${n}}> 或 ic(${n})）`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
