// IPC 死绑定回归测试：api（lib/ipc.ts）里的每个方法必须至少有一个 UI 调用点，
// 防止后端命令下线后前端绑定滞留（2026-10-15 体检发现 runCustomCommand 死绑定）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
const ipc = readFileSync(join(SRC, "lib", "ipc.ts"), "utf8");

// api 导出块里的顶层方法名（两个空格缩进的 `name: (` 键）
const apiBlock = ipc.slice(ipc.indexOf("export const api"));
const names = [...apiBlock.matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*): \(/gm)].map((m) => m[1]);

// 全项目调用面（去空白，容忍 Prettier 把 api.method 换行拆开；\0 分隔防跨文件误拼）
const callSites = walk(SRC)
  .filter((f) => !f.endsWith(join("lib", "ipc.ts")))
  .map((f) => readFileSync(f, "utf8"))
  .join("\u0000")
  .replace(/[ \t\r\n]+/g, "");

describe("api 死绑定审计", () => {
  it("api 方法清单非空（解析自检）", () => {
    expect(names.length).toBeGreaterThan(50);
  });

  it("每个 api 方法在 UI 侧至少有一个调用点", () => {
    const dead = names.filter((n) => !callSites.includes(`api.${n}`));
    expect(dead).toEqual([]);
  });
});
