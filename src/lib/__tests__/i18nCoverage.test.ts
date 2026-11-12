// i18n 英文覆盖审计（2026-11-12）：与 iconRule / apiBinding / cssClasses 同款的
// 「新代码违反即 CI 失败」规范审计——英文界面不允许漏翻。四条规则：
// ① 全库 t()/t2() 字面量键（含 CJK）必须在 EN 词典或豁免清单（Rust 写盘硬编码
//    后缀等回落中文即正确的串）；
// ② typeName 全部可能输出（TYPE_NAMES 值 + 兜底）必须在 EN 词典；
// ③ 数据文件的功能名/描述/分类标签（渲染端 t() 透传的间接键）必须在 EN 词典；
// ④ EN 词典不得有死词条（键串在除 i18n.ts 外全部源码中不再出现即剪）。
import { describe, expect, it } from "vitest";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { EN } from "../i18n";
import { TYPE_NAMES, typeName } from "../fileIcons";
import { BUILTIN_FNS } from "../menuCommands";
import { PREVIEW_LABELS } from "../previewKind";
import { SEARCH_TYPE_OPTIONS } from "../searchStream";
import { SHORTCUT_GROUPS } from "../shortcuts";
import { JOB_LABELS } from "../island";
import { BLANK_MODES } from "../pdfOps";
import { REN_TEMPLATES } from "../batchRename";

/** 豁免清单：键含 CJK 但不进词典（注释里写理由，新增成员须补理由）。
 *  - Rust 端写盘硬编码中文后缀（src-tauri img/mod.rs sibling_out 等），前端
 *    仅预览显示；EN 译文会造成「预览文件名 ≠ 实际产出」——回落中文即正确。
 *  - 「中」= EN 模式下切回中文的语言钮，显示中文标签即语义。 */
const WHITELIST = new Set([
  "_提取", "_删页", "_插页", "_加密", "_解密", // PDF 工具输出后缀（Rust 写盘）
  "_压缩", "_水印", "_转换", "_缩放", "水印", // 图片工具输出后缀（Rust 写盘）
  "中", // 语言切换钮
]);

const CJK = /[\u4e00-\u9fff]/;

/** 递归收集 src 下全部 .ts/.tsx（排除测试、i18n.ts 本体、clip/shot 独立窗口） */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "clip" || name === "shot") continue;
      out.push(...walk(p));
    } else if (/\.(tsx?)$/.test(name) && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const srcDir = join(__dirname, "..", "..");
const files = walk(srcDir).filter((f) => !f.replace(/\\/g, "/").endsWith("lib/i18n.ts"));
const sources = new Map(files.map((f) => [f.replace(/\\/g, "/"), readFileSync(f, "utf8")]));
const corpus = [...sources.values()].join("\n");

describe("i18n 英文覆盖审计（EN 模式不允许漏翻）", () => {
  it("① t()/t2() 字面量键（含 CJK）全部收录进 EN 词典（或豁免）", () => {
    const missing: string[] = [];
    for (const [file, src] of sources) {
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const m of line.matchAll(/\bt2?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
          let key: string;
          try {
            key = JSON.parse(`"${m[1]}"`);
          } catch {
            continue;
          }
          if (!CJK.test(key)) continue;
          if (!(key in EN) && !WHITELIST.has(key)) missing.push(`${file}:${i + 1}  "${key}"`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("② typeName 全部可能输出已收录（类别名 + 兜底）", () => {
    const outs = new Set<string>([typeName("x", true), typeName("noext", false), "{ext} 文件"]);
    for (const v of Object.values(TYPE_NAMES)) outs.add(v);
    const missing = [...outs].filter((k) => CJK.test(k) && !(k in EN));
    expect(missing).toEqual([]);
  });

  it("③ 数据文件功能名/描述/分类标签（渲染端 t() 间接键）已收录", () => {
    const indirect = new Set<string>();
    for (const f of BUILTIN_FNS) {
      indirect.add(f.label);
      if (f.desc) indirect.add(f.desc);
      if (f.group) indirect.add(f.group);
    }
    for (const v of Object.values(PREVIEW_LABELS)) indirect.add(v);
    for (const o of SEARCH_TYPE_OPTIONS) {
      indirect.add(o.label);
      if (o.title) indirect.add(o.title);
    }
    for (const g of SHORTCUT_GROUPS) {
      indirect.add(g.title);
      for (const it of g.items) indirect.add(it.label);
    }
    for (const v of Object.values(JOB_LABELS)) indirect.add(v);
    for (const m of BLANK_MODES) indirect.add(m.label);
    for (const tp of REN_TEMPLATES) {
      indirect.add(tp.label);
      indirect.add(tp.desc);
    }
    const missing = [...indirect].filter((k) => CJK.test(k) && !(k in EN));
    expect(missing).toEqual([]);
  });

  it("④ EN 词典无死词条（键串已不在任何源码中出现）", () => {
    // 双口径判定：raw 源码子串（覆盖数据文件与注释外的任何出现）∪ 全库
    // t()/t2() 字面量的「解析后形态」集合（消除 \n、\"、\i 等转义形态差）。
    // 注：字典键与 t() 实参在运行时同源，解析形态相等即视为在用。
    const parsedKeys = new Set<string>();
    for (const src of sources.values()) {
      const lines = src.split("\n");
      for (const line of lines) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const m of line.matchAll(/\bt2?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
          // JSON 严格解析之外的串按 JS 字符串语义顺序解码（\\ 配对优先、
          // \i 等未知转义丢反斜杠留字符），与运行时实参逐字一致
          const jsLike = m[1].replace(/\\(.?)/g, (_, c: string) => {
            if (c === "n") return "\n";
            if (c === "t") return "\t";
            if (c === "r") return "\r";
            if (c === "b") return "\b";
            if (c === "f") return "\f";
            if (c === "" ) return "";
            return c; // " \ / 与未知转义（\i 等）→ 字符本身
          });
          parsedKeys.add(jsLike);
        }
      }
    }
    const dead = Object.keys(EN).filter(
      (k) => !corpus.includes(k) && !parsedKeys.has(k),
    );
    expect(dead).toEqual([]);
  });
});
