// 批量重命名规则引擎（纯函数，配单测）：规则链模型——按序堆叠的改名规则，
// 逐条对名称应用（Smart File Renamer / Advanced Renamer 同范式）。
// 规则类型：替换（字面/正则）/ 删除 / 插入 / 前缀 / 后缀 / 修剪 /
// 序号 / 大小写 / 日期（文件修改时间）/ 中文数字互转 / 数字补齐 /
// 数字四则 / 日期格式化（改写名称内日期写法）/ 简繁转换 / 转拼音。
// 每条规则独立作用域（主名/扩展名/整名）。
// 扩展名保护：主名模式下扩展名原样保留；「.bashrc」点首名整名视作主名。
import { isValidName } from "./path";
// 简繁转换（MIT AND Apache-2.0，按方向子路径导入只带所需词典）与
// 拼音（MIT）仅被「转换」类规则使用；其余规则零开销
import { Converter } from "opencc-js/cn2t";
import { Converter as T2CnConverter } from "opencc-js/t2cn";
import { pinyin } from "pinyin-pro";

export type RenameScope = "name" | "nameExt" | "ext";
export type CaseMode = "upper" | "lower" | "title";
export type DateFmt = "ymd" | "ymdCompact" | "ymdHms";
/** 名称内日期重排目标格式（日期格式化规则） */
export type DateReFmt = "ymd" | "ymdCompact" | "cn";
export type ArithOp = "add" | "sub" | "mul" | "div";

export type RenameOp = { id: string; enabled: boolean; scope: RenameScope } & (
  | { type: "replace"; find: string; replace: string; regex: boolean }
  | { type: "remove"; find: string }
  | { type: "insert"; text: string; position: "start" | "end" | "at"; at?: number }
  | { type: "prefix"; text: string }
  | { type: "suffix"; text: string }
  | { type: "trim"; head: number; tail: number }
  | { type: "number"; position: "start" | "end"; start: number; pad: number; separator: string }
  | { type: "case"; mode: CaseMode }
  | { type: "date"; format: DateFmt; position: "start" | "end"; separator: string }
  | { type: "cnNum"; mode: "toArabic" | "toChinese" }
  | { type: "padNum"; width: number }
  | { type: "arith"; arith: ArithOp; value: number }
  | { type: "dateFormat"; format: DateReFmt }
  | { type: "chinese"; mode: "s2t" | "t2s" }
  | { type: "pinyin"; mode: "initials" | "full" }
  | { type: "trimEdges" }
  | { type: "parent"; position: "start" | "end"; separator: string }
  | { type: "removeCls"; keep: boolean; cls: CharCls[] }
);

/** 字符类（删除指定字符规则的可勾选类型） */
export type CharCls = "space" | "digit" | "hanzi" | "upper" | "lower" | "cnPunct" | "enPunct" | "illegal";

export const CLS_NAMES: Record<CharCls, string> = {
  space: "空格", digit: "数字", hanzi: "汉字", upper: "大写字母",
  lower: "小写字母", cnPunct: "中文符号", enPunct: "英文符号", illegal: "非法字符",
};

const CLS_RE: Record<CharCls, string> = {
  space: "\\s\\u3000",
  digit: "\\d",
  hanzi: "一-龥",
  upper: "A-Z",
  lower: "a-z",
  cnPunct: "　-〿！-～—…‘’“”",
  enPunct: "!-/:-@[-`{-~",
  illegal: "\\/:*?\"<>|\\x00-\\x1f",
};

/** 由勾选类型编译字符类正则（keep = 反选只保留；未勾选返回 null） */
export function removeClsRegex(cls: CharCls[], keep: boolean): RegExp | null {
  if (!cls.length) return null;
  const inner = cls.map((c) => CLS_RE[c]).join("");
  try {
    return new RegExp(keep ? `[^${inner}]` : `[${inner}]`, "gu");
  } catch {
    return null;
  }
}

/* ── 简繁转换（opencc-js，转换器惰性单例，词典仅在用到时初始化）── */
let s2tConv: ((s: string) => string) | null = null;
let t2sConv: ((s: string) => string) | null = null;

/** 简→繁 / 繁→简（非汉字原样保留；转换器初始化失败时原文返回） */
function convertChinese(text: string, mode: "s2t" | "t2s"): string {
  try {
    if (mode === "s2t") {
      s2tConv ??= Converter({ from: "cn", to: "t" }) as (s: string) => string;
      return s2tConv(text);
    }
    t2sConv ??= T2CnConverter({ from: "t", to: "cn" }) as (s: string) => string;
    return t2sConv(text);
  } catch {
    return text;
  }
}

/** 汉字转拼音（pinyin-pro，非汉字原样保留；initials = 首字母第一个字母） */
function convertPinyin(text: string, mode: "initials" | "full"): string {
  if (mode === "initials") {
    // pattern first = 首字母（审 → s 而非声母 sh）；nonZh consecutive 保留非汉字段
    return pinyin(text, { pattern: "first", toneType: "none", nonZh: "consecutive" }).replace(/\s+/g, "");
  }
  return pinyin(text, { toneType: "none", type: "array" }).join("");
}

/* ── 中文数字 ↔ 阿拉伯数字（整数；零一二两三四五六七八九十百千万亿）── */
const CN_DIGIT: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字解析（整数，支持十/百/千/万/亿；非纯中文数字串返回 null） */
export function cnNumToArabic(s: string): number | null {
  if (!/^[零一二两三四五六七八九十百千万亿]+$/.test(s) || s.length > 24) return null;
  let result = 0, section = 0, number = 0;
  for (const ch of s) {
    const d = CN_DIGIT[ch];
    if (d !== undefined) { number += d; continue; }
    if (ch === "十") { number += number === 0 ? 1 : 0; section += number * 10; number = 0; continue; }
    if (ch === "百") { section += number * 100; number = 0; continue; }
    if (ch === "千") { section += number * 1000; number = 0; continue; }
    if (ch === "万") { section = (section + number) * 10000; result += section; section = 0; number = 0; continue; }
    if (ch === "亿") { section = (section + number) * 100000000; result += section; section = 0; number = 0; continue; }
  }
  return result + section + number;
}

const CN_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 节内（0-9999）中文数字（零位折叠为单个「零」；段首「一十」简写「十」） */
function sec4ToCn(v: number): string {
  const q = Math.floor(v / 1000) % 10, b = Math.floor(v / 100) % 10;
  const s = Math.floor(v / 10) % 10, g = v % 10;
  let out = "";
  if (q) out += CN_NUM[q] + "千";
  if (b) out += CN_NUM[b] + "百";
  else if (q && (s || g)) out += "零";
  if (s) out += out === "" && s === 1 ? "十" : CN_NUM[s] + "十";
  else if ((q || b) && g) out += "零";
  if (g) out += CN_NUM[g];
  return out;
}

/** 阿拉伯整数 → 中文数字（0 ≤ n < 1e12；越界返回 null） */
export function arabicToCnNum(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) return null;
  if (n === 0) return "零";
  const secs: number[] = [];
  let r = n;
  while (r > 0) { secs.push(r % 10000); r = Math.floor(r / 10000); }
  const units = ["", "万", "亿"];
  let out = "";
  let pendingZero = false;
  for (let i = secs.length - 1; i >= 0; i--) {
    const v = secs[i];
    if (v === 0) { if (out) pendingZero = true; continue; }
    // 节间补零：低位节不足千位（或中间有整零节）时，与已输出高位之间补单个「零」
    if (out && (pendingZero || v < 1000)) out += "零";
    pendingZero = false;
    out += sec4ToCn(v) + (i > 0 ? units[i] : "");
  }
  return out;
}

/** 名称内日期重排（日期格式化规则）：识别常见写法统一为目标格式。
 *  识别顺序 = 8 位紧凑（可带 _HHMMSS）在前、分隔写法在后；带 (?!\d) 防截断
 *  更长的数字串；年份 < 1900 或月日非法的串原样保留（时间不进目标格式时丢弃） */
export function reformatDates(text: string, format: DateReFmt): string {
  return text.replace(
    /(\d{4})(\d{2})(\d{2})(?:_?(\d{2})(\d{2})(\d{2}))?(?!\d)|(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?!\d)/g,
    (m, y1, mo1, d1, _H, _M, _S, y2, mo2, d2) => {
      const y = Number(y1 ?? y2), mo = Number(mo1 ?? mo2), dd = Number(d1 ?? d2);
      if (y < 1900 || mo < 1 || mo > 12 || dd < 1 || dd > 31) return m;
      const dt = new Date(y, mo - 1, dd);
      if (dt.getMonth() !== mo - 1 || dt.getDate() !== dd) return m;
      const p = (v: number) => String(v).padStart(2, "0");
      if (format === "cn") return `${y}年${mo}月${dd}日`;
      if (format === "ymdCompact") return `${y}${p(mo)}${p(dd)}`;
      return `${y}-${p(mo)}-${p(dd)}`;
    },
  );
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
      if (d.at === undefined) d.at = 3;
      break;
    case "case":
      if (d.mode === undefined) d.mode = "upper";
      break;
    case "trimEdges":
      break;
    case "parent":
      if (d.position === undefined) d.position = "start";
      if (d.separator === undefined) d.separator = "-";
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
    case "cnNum":
      if (d.mode === undefined) d.mode = "toArabic";
      break;
    case "padNum":
      if (d.width === undefined) d.width = 3;
      break;
    case "arith":
      if (d.arith === undefined) d.arith = "add";
      if (d.value === undefined) d.value = 1;
      break;
    case "dateFormat":
      if (d.format === undefined) d.format = "ymd";
      break;
    case "chinese":
      if (d.mode === undefined) d.mode = "s2t";
      break;
    case "pinyin":
      if (d.mode === undefined) d.mode = "initials";
      break;
    case "removeCls":
      if (d.keep === undefined) d.keep = false;
      if (d.cls === undefined) d.cls = [];
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
function applyOp(text: string, op: RenameOp, idx: number, mtimeMs: number | undefined, parent: string): string {
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
    case "insert": {
      if (op.position === "at") {
        const at = Math.max(0, Math.min(op.at ?? 0, text.length));
        return text.slice(0, at) + op.text + text.slice(at);
      }
      return op.position === "start" ? op.text + text : text + op.text;
    }
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
    case "cnNum":
      return op.mode === "toArabic"
        ? text.replace(/[零一二两三四五六七八九十百千万亿]+/g, (m) => {
            const v = cnNumToArabic(m);
            return v === null ? m : String(v);
          })
        : text.replace(/\d+/g, (m) => arabicToCnNum(Number(m)) ?? m);
    case "padNum":
      return text.replace(/\d+/g, (m) => m.padStart(Math.max(1, Math.min(op.width, 12)), "0"));
    case "arith": {
      return text.replace(/\d+(?:\.\d+)?/g, (m) => {
        const v = Number(m);
        let r: number;
        switch (op.arith) {
          case "add": r = v + op.value; break;
          case "sub": r = v - op.value; break;
          case "mul": r = v * op.value; break;
          default: r = op.value === 0 ? v : Math.round((v / op.value) * 100) / 100;
        }
        return String(r);
      });
    }
    case "dateFormat":
      return reformatDates(text, op.format);
    case "chinese":
      return convertChinese(text, op.mode);
    case "pinyin":
      return convertPinyin(text, op.mode);
    case "removeCls": {
      const re = removeClsRegex(op.cls, op.keep);
      if (!re) return text;
      return text.replace(re, "");
    }
    case "trimEdges":
      return text.replace(/^\s+|\s+$/gu, "");
    case "parent": {
      if (!parent) return text;
      return op.position === "start" ? parent + op.separator + text : text + op.separator + parent;
    }
  }
}

/** 父文件夹名（路径上一级目录名；盘根/无上级返回 ""） */
export function parentFolderName(path: string): string {
  const i1 = path.lastIndexOf("\\"), i2 = path.lastIndexOf("/");
  const cut = Math.max(i1, i2) > 0 ? path.slice(0, Math.max(i1, i2)) : "";
  if (!cut || /^[A-Za-z]:$/.test(cut)) return "";
  return cut.slice(Math.max(cut.lastIndexOf("\\"), cut.lastIndexOf("/")) + 1) || cut;
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
    const parentName = parentFolderName(e.path);
    // 段状态跨规则链维护：name 规则改主名段、ext 规则改扩展名段、
    // nameExt 规则改整名（应用后重拆段，后续规则仍能正确作用）
    let stem = s0;
    let ext = e0;
    for (const op of ops) {
      if (!op.enabled) continue;
      if (op.scope === "ext") {
        ext = applyOp(ext, op, idx, e.mtimeMs, parentName);
      } else if (op.scope === "name") {
        stem = applyOp(stem, op, idx, e.mtimeMs, parentName);
      } else {
        const whole = applyOp(stem + ext, op, idx, e.mtimeMs, parentName);
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
      return `${op.position === "at" ? `在第 ${op.at ?? 0} 个字符后` : op.position === "start" ? "在名称开头" : "在名称末尾"}插入「${op.text}」`;
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
    case "cnNum":
      return op.mode === "toArabic" ? "把名称里的中文数字换成阿拉伯数字" : "把名称里的阿拉伯数字换成中文数字";
    case "padNum":
      return `把名称里的数字补齐到 ${op.width} 位`;
    case "arith": {
      const sym = op.arith === "add" ? "加" : op.arith === "sub" ? "减" : op.arith === "mul" ? "乘" : "除";
      return `把名称里的数字${sym} ${op.value}`;
    }
    case "dateFormat":
      return op.format === "cn"
        ? "把名称里的日期统一成「2026年11月7日」写法"
        : op.format === "ymd"
          ? "把名称里的日期统一成「2026-11-07」写法"
          : "把名称里的日期统一成「20261107」写法";
    case "chinese":
      return op.mode === "s2t" ? "把简体汉字转换为繁体" : "把繁体汉字转换为简体";
    case "pinyin":
      return op.mode === "initials" ? "把汉字转换为拼音首字母" : "把汉字转换为全拼";
    case "trimEdges":
      return "去掉名称首尾的空白（含全角空格）";
    case "parent":
      return `${op.position === "start" ? "在名称开头" : "在名称末尾"}加父文件夹名`;
    case "removeCls": {
      if (!op.cls.length) return "未勾选要删除的字符类型";
      const names = op.cls.map((c) => CLS_NAMES[c]).join("、");
      return op.keep ? `只保留名称里的${names}（删除其余字符）` : `删除名称里的${names}`;
    }
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
