// 批量重命名规则引擎（纯函数，配单测）：规则链模型——按序堆叠的改名规则，
// 逐条对名称应用（Smart File Renamer / Advanced Renamer 同范式）。
// 规则类型 9 种：替换（字面/正则）/ 删除 / 插入 / 前缀 / 后缀 / 修剪 /
// 序号 / 大小写 / 日期（文件修改时间）。每条规则独立作用域（主名/扩展名/整名）。
// 扩展名保护：主名模式下扩展名原样保留；「.bashrc」点首名整名视作主名。
import { isValidName } from "./path";

export type RenameScope = "name" | "nameExt" | "ext";
export type CaseMode = "upper" | "lower" | "title";
export type DateFmt = "ymd" | "ymdCompact" | "ymdHms";

export type RenameOp = { id: string; enabled: boolean; scope: RenameScope } & (
  | { type: "replace"; find: string; replace: string; regex: boolean }
  | { type: "remove"; find: string }
  | { type: "insert"; text: string; position: "start" | "end" }
  | { type: "prefix"; text: string }
  | { type: "suffix"; text: string }
  | { type: "trim"; head: number; tail: number }
  | { type: "number"; position: "start" | "end"; start: number; pad: number; separator: string }
  | { type: "case"; mode: CaseMode }
  | { type: "date"; format: DateFmt; position: "start" | "end"; separator: string }
);

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

/** 编译正则（非法返回 null）：UI 内联校验与引擎共用同一判定 */
export function compileRegex(find: string): RegExp | null {
  if (!find) return null;
  try {
    return new RegExp(find, "gu");
  } catch {
    return null;
  }
}

let opSeq = 0;

/** 新规则工厂（带唯一 id；id 用于 React key 与排序）。
 *  泛型 T 按规则类型分支收紧可传字段（传错字段名编译期报错），
 *  未传的类型特定参数在实现内补默认值 */
export function newOp<T extends RenameOp["type"]>(
  partial: { type: T; scope?: RenameScope; enabled?: boolean } & Partial<
    Omit<Extract<RenameOp, { type: T }>, "type" | "id" | "enabled" | "scope">
  >,
): RenameOp {
  const out = {
    scope: partial.scope ?? ("name" as RenameScope),
    enabled: partial.enabled ?? true,
    id: `op${++opSeq}`,
    ...partial,
  } as unknown as RenameOp;
  const d = out as unknown as Record<string, unknown>;
  switch (out.type) {
    case "replace":
      if (d.regex === undefined) d.regex = false;
      break;
    case "insert":
      if (d.position === undefined) d.position = "end";
      break;
    case "number":
      if (d.position === undefined) d.position = "end";
      if (d.start === undefined) d.start = 1;
      if (d.pad === undefined) d.pad = 2;
      if (d.separator === undefined) d.separator = "";
      break;
    case "trim":
      if (d.head === undefined) d.head = 0;
      if (d.tail === undefined) d.tail = 0;
      break;
    case "date":
      if (d.format === undefined) d.format = "ymd";
      if (d.position === undefined) d.position = "end";
      if (d.separator === undefined) d.separator = "";
      break;
  }
  return out;
}

/** 拆主名/扩展名（".bashrc" 这类点首名无扩展名概念，整名视作主名） */
function splitName(name: string, isDir: boolean): [string, string] {
  if (isDir) return [name, ""];
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

function applyCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "upper": return text.toUpperCase();
    case "lower": return text.toLowerCase();
    case "title": return text.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  }
}

function fmtDate(mtimeMs: number | undefined, format: DateFmt): string {
  if (!mtimeMs) return "";
  const dt = new Date(mtimeMs);
  const p = (n: number) => String(n).padStart(2, "0");
  const Y = dt.getFullYear(), M = p(dt.getMonth() + 1), D = p(dt.getDate());
  const h = p(dt.getHours()), m = p(dt.getMinutes()), s = p(dt.getSeconds());
  switch (format) {
    case "ymd": return `${Y}-${M}-${D}`;
    case "ymdCompact": return `${Y}${M}${D}`;
    case "ymdHms": return `${Y}-${M}-${D}_${h}${m}${s}`;
  }
}

/** 单条规则对目标段的一次应用（number/date 用 idx/mtime 注入计数与时间） */
function applyOp(text: string, op: RenameOp, idx: number, mtimeMs: number | undefined): string {
  if (!op.enabled) return text;
  switch (op.type) {
    case "replace": {
      if (!op.find) return text;
      if (op.regex) {
        const re = compileRegex(op.find);
        return re ? text.replace(re, op.replace) : text;
      }
      return text.split(op.find).join(op.replace);
    }
    case "remove": {
      if (!op.find) return text;
      return text.split(op.find).join("");
    }
    case "insert":
      return op.position === "start" ? op.text + text : text + op.text;
    case "prefix":
      return op.text + text;
    case "suffix":
      return text + op.text;
    case "trim": {
      const head = Math.max(0, op.head), tail = Math.max(0, op.tail);
      return text.slice(head, tail > 0 ? text.length - tail : undefined);
    }
    case "number": {
      const n = String(Math.max(op.start, 0) + idx).padStart(Math.min(Math.max(op.pad, 1), 6), "0");
      return op.position === "start" ? n + op.separator + text : text + op.separator + n;
    }
    case "case":
      return applyCase(text, op.mode);
    case "date": {
      const d = fmtDate(mtimeMs, op.format);
      if (!d) return text;
      return op.position === "start" ? d + op.separator + text : text + op.separator + d;
    }
  }
}

/** 生成改名计划：规则链按序应用 + 全批目标重名/非法名检测
 *  （与既有文件的同名冲突由执行期报告；正则非法时该规则静默跳过，
 *  UI 通过 compileRegex 同源判定显示内联红字） */
export function planRenames(
  entries: { path: string; name: string; isDir: boolean; mtimeMs?: number }[],
  ops: RenameOp[],
): RenamePlanItem[] {
  const items: RenamePlanItem[] = entries.map((e, idx) => {
    const [s0, e0] = splitName(e.name, e.isDir);
    // 段状态跨规则链维护：name 规则改主名段、ext 规则改扩展名段、
    // nameExt 规则改整名（应用后重拆段，后续规则仍能正确作用）
    let stem = s0;
    let ext = e0;
    for (const op of ops) {
      if (!op.enabled) continue;
      if (op.scope === "ext") {
        ext = applyOp(ext, op, idx, e.mtimeMs);
      } else if (op.scope === "name") {
        stem = applyOp(stem, op, idx, e.mtimeMs);
      } else {
        const whole = applyOp(stem + ext, op, idx, e.mtimeMs);
        const [ns, ne] = splitName(whole, e.isDir);
        stem = ns;
        ext = ne;
      }
    }
    const newName = stem + ext;
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

/** 从计划中取可执行子集（已变更且无错误；picked = 预览行勾选集，空集 = 全部参与） */
export function pickRenames(
  items: RenamePlanItem[],
  picked?: Set<string>,
): { path: string; newName: string }[] {
  return items
    .filter((i) => i.changed && !i.error && (!picked || picked.has(i.path)))
    .map((i) => ({ path: i.path, newName: i.newName }));
}
