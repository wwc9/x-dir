// 批量重命名规则引擎（纯函数，配单测）：查找替换 + 前后缀 + 可选序号。
// 扩展名保护：文件只对主名应用规则（扩展名原样保留）；文件夹对整个名称应用。
import { isValidName } from "./path";

export interface RenameRule {
  /** 字面查找（区分大小写；空 = 不替换） */
  find: string;
  replace: string;
  prefix: string;
  suffix: string;
  /** 加序号：按选中顺序在主名末尾（后缀之前）补数字 */
  useSeq: boolean;
  seqStart: number;
  /** 序号位数（1–6，不足左补零） */
  seqPad: number;
}

export const DEFAULT_RULE: RenameRule = {
  find: "",
  replace: "",
  prefix: "",
  suffix: "",
  useSeq: false,
  seqStart: 1,
  seqPad: 2,
};

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

/** 生成改名计划：逐项应用规则 + 全批目标重名/非法名检测（与既有文件的同名冲突由执行期报告） */
export function planRenames(
  entries: { path: string; name: string; isDir: boolean }[],
  rule: RenameRule,
): RenamePlanItem[] {
  const pad = Math.min(Math.max(rule.seqPad, 1), 6);
  const items: RenamePlanItem[] = entries.map((e, idx) => {
    const [stem, ext] = splitName(e.name, e.isDir);
    const replaced = rule.find ? stem.split(rule.find).join(rule.replace) : stem;
    const seq = rule.useSeq
      ? String(Math.max(rule.seqStart, 0) + idx).padStart(pad, "0")
      : "";
    const newName = `${rule.prefix}${replaced}${seq}${rule.suffix}${ext}`;
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
    if (!isValidName(it.newName)) it.error = "名称非法";
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
