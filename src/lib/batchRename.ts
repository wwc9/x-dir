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
      if (d.find === undefined) d.find = "";
      if (d.replace === undefined) d.replace = "";
      if (d.regex === undefined) d.regex = false;
      break;
    case "prefix":
    case "suffix":
      if (d.text === undefined) d.text = "";
      break;
    case "remove":
      if (d.find === undefined) d.find = "";
      break;
    case "insert":
      if (d.position === undefined) d.position = "end";
      if (d.text === undefined) d.text = "";
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
  const byName = new Map<string, number[]>();
  for (const [i, it] of items.entries()) {
    const k = it.newName.toLowerCase();
    const list = byName.get(k);
    if (list) list.push(i);
    else byName.set(k, [i]);
  }
  for (const [i, it] of items.entries()) {
    if (!it.changed) continue;
    if (!isValidName(it.newName)) it.error = `含有不允许的字符「${illegalChars(it.newName).join(" ")}」`;
    else {
      const same = byName.get(it.newName.toLowerCase())?.filter((j) => j !== i) ?? [];
      // 与批内任何其他行同名即冲突：撞「改后行」= 互相冲突，撞「未变更行」=
      // 与磁盘现有文件同名（执行必失败），统一提前报告（2026-11-07 人话升级）
      if (same.length > 0) it.error = `改完后会与第 ${same[0] + 1} 行重名`;
    }
  }
  return items;
}

/** 找出名称中 Windows 不允许的字符（去重保序；供错误人话提示） */
export function illegalChars(name: string): string[] {
  const bad = name.match(/[\\/:*?"<>|]/g);
  return bad ? [...new Set(bad)] : [];
}

/** 旧名 → 新名的变更片段（最长公共前缀/后缀取中间变更段；供预览 diff 高亮）。
 *  无变更时 mid = "" */
export function diffFragments(
  oldName: string,
  newName: string,
): { pre: string; mid: string; post: string } {
  let pre = 0;
  const min = Math.min(oldName.length, newName.length);
  while (pre < min && oldName[pre] === newName[pre]) pre++;
  let suf = 0;
  while (
    suf < min - pre &&
    oldName[oldName.length - 1 - suf] === newName[newName.length - 1 - suf]
  )
    suf++;
  return {
    pre: newName.slice(0, pre),
    mid: newName.slice(pre, newName.length - suf),
    post: newName.slice(newName.length - suf),
  };
}

/** 单条规则的人话效果描述（规则卡效果行；参数实时生成） */
export function describeOp(op: RenameOp): string {
  switch (op.type) {
    case "replace": {
      if (!op.find && !op.replace) return "未填写查找与替换内容";
      const what = op.regex ? `查找正则「${op.find}」` : `把「${op.find}」`;
      return op.replace ? `${what}替换为「${op.replace}」` : `${what}删除`;
    }
    case "remove":
      return op.find ? `删除名称里所有的「${op.find}」` : "未填写要删除的文字";
    case "insert":
      return `${op.position === "start" ? "在名称开头" : "在名称末尾"}插入「${op.text}」`;
    case "prefix":
      return `在最前面加「${op.text}」`;
    case "suffix":
      return `在扩展名前加「${op.text}」`;
    case "trim":
      return `去掉开头 ${op.head} 个、末尾 ${op.tail} 个字符`;
    case "number": {
      const n = String(op.start).padStart(Math.min(Math.max(op.pad, 1), 6), "0");
      const n2 = String(op.start + 1).padStart(Math.min(Math.max(op.pad, 1), 6), "0");
      const sep = op.separator || "";
      return `在扩展名前加编号「${sep}${n}」「${sep}${n2}」…`;
    }
    case "case":
      return op.mode === "upper" ? "把英文字母全部改为大写" : op.mode === "lower" ? "把英文字母全部改为小写" : "每个词首字母改为大写";
    case "date":
      return `${op.position === "start" ? "在名称开头" : "在扩展名前"}加文件修改日期（${fmtDate(Date.now(), op.format)}${op.separator ? ` 分隔符「${op.separator}」` : ""}）`;
  }
}

/** 常用任务模板（一键生成整条规则链；空态与任务 chips 共用） */
export interface RenameTemplate {
  id: string;
  label: string;
  desc: string;
  build: () => RenameOp[];
}

export const REN_TEMPLATES: RenameTemplate[] = [
  {
    id: "number",
    label: "批量编号",
    desc: "在名称末尾加 01、02、03…",
    build: () => [newOp({ type: "number", position: "end", start: 1, pad: 2, separator: "-" })],
  },
  {
    id: "nospace",
    label: "去空格",
    desc: "删除名称中所有空格",
    build: () => [newOp({ type: "remove", find: " " })],
  },
  {
    id: "date",
    label: "加日期前缀",
    desc: "名称前加修改日期 2026-11-07_",
    build: () => [newOp({ type: "date", format: "ymd", position: "start", separator: "_" })],
  },
  {
    id: "lower",
    label: "全部小写",
    desc: "英文字母转小写",
    build: () => [newOp({ type: "case", mode: "lower" })],
  },
  {
    id: "ext",
    label: "换扩展名",
    desc: "如批量 jpg → png（填写查找替换）",
    build: () => [newOp({ type: "replace", find: "jpg", replace: "png", scope: "ext" })],
  },
];

/** 从计划中取可执行子集（已变更且无错误；picked = 预览行勾选集，空集 = 全部参与） */
export function pickRenames(
  items: RenamePlanItem[],
  picked?: Set<string>,
): { path: string; newName: string }[] {
  return items
    .filter((i) => i.changed && !i.error && (!picked || picked.has(i.path)))
    .map((i) => ({ path: i.path, newName: i.newName }));
}
