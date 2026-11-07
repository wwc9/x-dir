// 批量重命名规则引擎（纯函数，配单测）：查找替换（字面/正则）+ 前后缀 +
// 可选序号 + 大小写格式化 + 作用域（主名/扩展名）。
// 扩展名保护：文件只对主名应用规则（扩展名原样保留）；文件夹对整个名称应用；
// 「仅扩展名」模式下替换与大小写只作用于扩展名段（前后缀与序号不参与）。
import { isValidName } from "./path";

/** 大小写格式化档（PowerRename Text formatting 同款语义） */
export type CaseMode = "keep" | "upper" | "lower" | "title";

export interface RenameRule {
  /** 字面查找（区分大小写；空 = 不替换）；regex = true 时按正则解释 */
  find: string;
  replace: string;
  /** 正则模式：find 按 JS RegExp 全局匹配解释，替换串支持 $1 捕获组 */
  regex: boolean;
  prefix: string;
  suffix: string;
  /** 大小写格式化：作用于目标段（仅主名模式 = 主名，仅扩展名模式 = 扩展名） */
  caseMode: CaseMode;
  /** 仅扩展名：替换与大小写只作用于扩展名段；前后缀与序号不参与 */
  extOnly: boolean;
  /** 加序号：按选中顺序在主名末尾（后缀之前）补数字 */
  useSeq: boolean;
  seqStart: number;
  /** 序号位数（1–6，不足左补零） */
  seqPad: number;
}

export const DEFAULT_RULE: RenameRule = {
  find: "",
  replace: "",
  regex: false,
  prefix: "",
  suffix: "",
  caseMode: "keep",
  extOnly: false,
  useSeq: false,
  seqStart: 1,
  seqPad: 2,
};

/** 编译正则（非法返回 null）：UI 内联校验与引擎共用同一判定 */
export function compileRegex(find: string): RegExp | null {
  if (!find) return null;
  try {
    return new RegExp(find, "gu");
  } catch {
    return null;
  }
}

export interface RenamePlanItem {
  path: string;
  isDir: boolean;
  oldName: string;
  newName: string;
  /** newName ≠ oldName（真正会被执行） */
  changed: boolean;
  /** 冲突/非法原因；null = 可执行 */
  error: string | null;
}

/** 拆主名/扩展名（".bashrc" 这类点首名无扩展名概念，整名视作主名） */
function splitName(name: string, isDir: boolean): [string, string] {
  if (isDir) return [name, ""];
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

/** 查找替换（正则模式全局匹配 + 捕获组；字面模式全量字面替换） */
function applyFind(text: string, rule: RenameRule, re: RegExp | null): string {
  if (!rule.find) return text;
  return rule.regex && re ? text.replace(re, rule.replace) : text.split(rule.find).join(rule.replace);
}

/** 大小写格式化：title = 每个连续字母词首字母大写（其余小写；中文等无大小写文字原样） */
function applyCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    case "title":
      return text.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    default:
      return text;
  }
}

/** 生成改名计划：逐项应用规则 + 全批目标重名/非法名检测（与既有文件的同名冲突由执行期报告） */
export function planRenames(
  entries: { path: string; name: string; isDir: boolean }[],
  rule: RenameRule,
): RenamePlanItem[] {
  const pad = Math.min(Math.max(rule.seqPad, 1), 6);
  // 正则非法：替换项全部判错（UI 顶部另有内联红字，同源 compileRegex）
  const re = rule.regex ? compileRegex(rule.find) : null;
  const regexInvalid = rule.regex && !!rule.find && !re;
  const items: RenamePlanItem[] = entries.map((e, idx) => {
    const [stem, ext] = splitName(e.name, e.isDir);
    let newName: string;
    if (rule.extOnly) {
      // 仅扩展名：替换与大小写作用于扩展名段（含点）；前后缀与序号不参与
      newName = stem + applyCase(applyFind(ext, rule, re), rule.caseMode);
    } else {
      const replaced = applyCase(applyFind(stem, rule, re), rule.caseMode);
      const seq = rule.useSeq
        ? String(Math.max(rule.seqStart, 0) + idx).padStart(pad, "0")
        : "";
      newName = `${rule.prefix}${replaced}${seq}${rule.suffix}${ext}`;
    }
    return {
      path: e.path,
      isDir: e.isDir,
      oldName: e.name,
      newName,
      changed: newName !== e.name,
      error: null,
    };
  });
  const countByName = new Map<string, number>();
  for (const it of items) {
    const k = it.newName.toLowerCase();
    countByName.set(k, (countByName.get(k) ?? 0) + 1);
  }
  for (const it of items) {
    if (!it.changed) continue;
    if (regexInvalid) it.error = "正则无效";
    else if (!isValidName(it.newName)) it.error = "名称非法";
    else if ((countByName.get(it.newName.toLowerCase()) ?? 0) > 1) it.error = "目标重名";
  }
  return items;
}

/** 从计划中取可执行子集（已变更且无错误） */
export function pickRenames(items: RenamePlanItem[]): { path: string; newName: string }[] {
  return items
    .filter((i) => i.changed && !i.error)
    .map((i) => ({ path: i.path, newName: i.newName }));
}
