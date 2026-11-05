// 首字母跳转（type-ahead）匹配纯函数：键盘直接敲字符累积缓冲，选中名称匹配
// 的下一项（从当前项之后循环查找，Total Commander/Explorer 惯例）。匹配串 =
// 文件名小写，或 Rust 下发的拼音首字母串 py（汉字取拼音首字母，如
// "forge请下这个txt文件" → "forgeqxzgtxtwj"，敲 "qxzg" 即可跳到；名称优先于 py）。
//
// 匹配策略（2026-11-01 定案；2026-11-05 增补中段首字母 + 读音分层；同日用户
// 定案移除同键循环）：
// 1. 缓冲以 "*" 开头 = 子串匹配（TC 原生语义，"*zeb" 命中 "topzebra.txt"）；
//    否则前缀匹配。
// 1b. 前缀整缓冲未命中（或只驻留当前项）→ 拼音首字母串中段匹配（py.includes）：
//     支持用文件名中间文字的首字母定位（"2026年度审计报告" 敲 "sjbg" 直达"审计
//     报告"段）。启用条件 = 缓冲 ≥2 字符（重复字符如 "ll"/"bb" 与普通针同权，
//     2026-11-05 起不再排除）。仅 py 中段：名称中段匹配仍属 "*" 显式子串语义。
// 1c/1d. 多音字变体兜底层（前缀 + 中段）：词典次读法（谷=lù / 晟=shèng）排在
//     全部首选读音命中之后，罕用读法只在无更好命中时兜底。
// 2.（已移除，2026-11-05 用户定案）不再有「重复按同一字母在同类间循环」的
//    回退档——重复字母按普通缓冲累积（"ll" 即真针 ll），全档无命中 = 无匹配，
//    由 Backspace 回删或超时重来；多命中间的移动一律 Tab/Shift+Tab。
//
// 统计 pos/total（当前命中在同匹配集中的 1 起序位/总数）：多命中时回显 pill
// 显示 "2/7"，用户知道 Tab 会循环到第几个、还有多少个。

export interface TypeAheadItem {
  name: string;
  path: string;
  /** 拼音首字母匹配变体（Rust 端随列表下发，多音字全读音组合；不含汉字为 null） */
  py?: string[] | null;
}

export interface TypeAheadMatch {
  idx: number;
  /** 完整输入缓冲（循环回退不截断，供下次按键接续） */
  buf: string;
  /** 显示用缓冲：连续重复字符折叠（"bbbb" → "b"） */
  disp: string;
  /** 命中在其匹配集中的序位（1 起，按显示顺序） */
  pos: number;
  /** 该匹配集总数 */
  total: number;
  /** 生效匹配针（2026-11-05：Tab 循环 / Backspace 重匹配 / 行内高亮共用；
   *  循环回退档 = 触发回退的本次按键字符） */
  needle: string;
  /** 生效匹配档位（同上） */
  mode: TaMode;
  /** 命中读音层（2026-11-05 精度修正）：0 = 名称/首选读音串（py[0]，Rust
   *  变体生成保证 py[0] 为全首选读音），1 = 多音字变体串（py[1..]，罕用
   *  读法如 谷=lù 只做兜底）——Tab 循环按本层冻结集合 */
  src: TaSrc;
}

/** 匹配档位（pill 状态与行内高亮随行存储，见 TypeAheadState） */
export type TaMode = "prefix" | "contains" | "pymid";

/** 读音层：0 = 名称/首选读音串；1 = 多音字变体串；2 = 全部（同键循环等
 *  宽容场景用） */
export type TaSrc = 0 | 1 | 2;

type Mode = TaMode;

/** 读音层取串：0 = py[0]（Rust 变体生成保证为全首选读音），1 = py[1..]
 *  （多音字变体），2 = 全部（同键循环等宽容场景） */
function pysOf(it: TypeAheadItem, src: TaSrc): string[] {
  const py = it.py;
  if (!py?.length) return [];
  if (src === 2) return py;
  return src === 0 ? py.slice(0, 1) : py.slice(1);
}

function matchOf(it: TypeAheadItem, needle: string, mode: Mode, src: TaSrc = 2): boolean {
  const name = it.name.toLowerCase();
  const pys = pysOf(it, src).map((p) => p.toLowerCase());
  if (mode === "prefix") {
    if (name.startsWith(needle)) return true;
    return pys.some((p) => p.startsWith(needle));
  }
  if (mode === "contains") {
    if (name.includes(needle)) return true;
    return pys.some((p) => p.includes(needle));
  }
  // pymid = 仅拼音首字母串中段（文件名中间文字的首字母定位，策略 1b）
  return pys.some((p) => p.includes(needle));
}

/** 中段首字母匹配启用条件（策略 1b）：非 "*" 模式 + 缓冲 ≥2 字符。重复字符
 *  （"ll"/"bb"）与普通针同权（2026-11-05 移除同键循环后解禁——此前排除
 *  重复字符就是为给循环语义让位） */
function pymidEligible(star: boolean, needle: string): boolean {
  return !star && needle.length >= 2;
}

/** 从当前项之后环绕找下一个匹配项 */
function findFrom(
  items: TypeAheadItem[],
  needle: string,
  curIdx: number,
  mode: Mode,
  src: TaSrc = 2,
): number | null {
  return findDir(items, needle, curIdx, mode, 1, src);
}

/** 双向环绕查找（dir=1 向后 / dir=-1 向前；Tab 循环用 -1） */
function findDir(
  items: TypeAheadItem[],
  needle: string,
  curIdx: number,
  mode: Mode,
  dir: 1 | -1,
  src: TaSrc = 2,
): number | null {
  const n = items.length;
  for (let i = 1; i <= n; i++) {
    const idx = dir === 1 ? (curIdx + i) % n : (((curIdx - i) % n) + n) % n;
    if (matchOf(items[idx], needle, mode, src)) return idx;
  }
  return null;
}

/** 命中项在匹配集中的序位与总数（单趟计数） */
function statsOf(
  items: TypeAheadItem[],
  needle: string,
  hitIdx: number,
  mode: Mode,
  src: TaSrc = 2,
): { pos: number; total: number } {
  let pos = 0;
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    if (!matchOf(items[i], needle, mode, src)) continue;
    total += 1;
    if (i <= hitIdx) pos += 1;
  }
  return { pos, total };
}

/** 显示用缓冲 = 实际生效的匹配针（整缓冲命中显示 "bb"；循环回退显示 "b"/"*z"） */
function dispOf(star: boolean, needle: string): string {
  return star ? `*${needle}` : needle;
}

/**
 * @param items   当前列表条目（显示顺序）
 * @param prevBuf 上次生效缓冲（typeAheadStep 返回的 buf，可为空串）
 * @param key     本次按键（单字符）
 * @param curIdx  当前选中下标，无选中为 -1
 * @returns 命中（含生效缓冲与序位统计）；连单字符都无命中返回 null
 */
export function typeAheadStep(
  items: TypeAheadItem[],
  prevBuf: string,
  key: string,
  curIdx: number,
): TypeAheadMatch | null {
  if (!items.length) return null;
  const ch = key.toLowerCase();
  if (!ch) return null;
  const next = prevBuf + ch;
  if (next === "*") return null; // 裸 "*" 无意义
  return resolveFrom(items, next, curIdx);
}

/** 级联核心（step 与 rematch 共用）：对完整缓冲按 1→1b→1c→1d→2→3 档位解析。
 *  读音分层（2026-11-05 精度修正，"罕用读音降级"定案的落地形态）：首选层
 *  （名称 + py[0]，Rust 保证 py[0] 为全首选读音）的前缀与中段严格在前；
 *  多音字变体层（py[1..]，词典字母序次读法）整体兜底在后——词典无词频
 *  数据无法甄别 谷=lù（罕用）与 晟=shèng（常用但排序第二），故变体不删除
 *  而是降级：所有首选读音命中（乃至变体前缀）永远先于变体中段，"谷商"
 *  类假阳性只在整目录再无更好命中时才可能兜底出现 */
function resolveFrom(
  items: TypeAheadItem[],
  next: string,
  curIdx: number,
): TypeAheadMatch | null {
  const star = next.startsWith("*");
  const mode: Mode = star ? "contains" : "prefix";
  const needle = (star ? next.slice(1) : next).toLowerCase();
  if (!needle) return null;

  // 1) 首选层整缓冲：名称前缀 / py[0]（全首选读音）前缀；不驻留当前项
  const h1 = findFrom(items, needle, curIdx, mode, 0);
  if (h1 !== null && h1 !== curIdx) {
    const { pos, total } = statsOf(items, needle, h1, mode, 0);
    return { idx: h1, buf: next, disp: dispOf(star, needle), pos, total, needle, mode, src: 0 };
  }
  // 1b) 首选层中段：拼音首字母串（py[0]）中段直达（文件名中间文字）
  if (pymidEligible(star, needle)) {
    const h1b = findFrom(items, needle, curIdx, "pymid", 0);
    if (h1b !== null && h1b !== curIdx) {
      const { pos, total } = statsOf(items, needle, h1b, "pymid", 0);
      return { idx: h1b, buf: next, disp: dispOf(star, needle), pos, total, needle, mode: "pymid", src: 0 };
    }
  }
  // 1c) 变体兜底层（多音字次读法）：前缀语义（名称以次读法开头，如"联晟…"）
  const h1c = findFrom(items, needle, curIdx, mode, 1);
  if (h1c !== null && h1c !== curIdx) {
    const { pos, total } = statsOf(items, needle, h1c, mode, 1);
    return { idx: h1c, buf: next, disp: dispOf(star, needle), pos, total, needle, mode, src: 1 };
  }
  // 1d) 变体兜底层：中段语义（"2026…--江西联晟…"，联晟居名中）
  if (pymidEligible(star, needle)) {
    const h1d = findFrom(items, needle, curIdx, "pymid", 1);
    if (h1d !== null && h1d !== curIdx) {
      const { pos, total } = statsOf(items, needle, h1d, "pymid", 1);
      return { idx: h1d, buf: next, disp: dispOf(star, needle), pos, total, needle, mode: "pymid", src: 1 };
    }
  }
  // 全档无命中 = 无匹配（2026-11-05 用户定案移除同键循环回退档：重复字母按
  // 普通缓冲累积、全档无命中即无匹配，多命中的移动一律 Tab/Shift+Tab）
  return null;
}

/** 命中集内循环（2026-11-05 定案：Tab / Shift+Tab）：沿用产生该命中时的
 *  生效针、档位与读音层（循环不换档），从当前项向前/向后环绕；集内唯一项 = 原地驻留 */
export function typeAheadCycle(
  items: TypeAheadItem[],
  prev: TypeAheadMatch,
  curIdx: number,
  dir: 1 | -1,
): TypeAheadMatch | null {
  if (!items.length) return null;
  const hit = findDir(items, prev.needle, curIdx, prev.mode, dir, prev.src);
  if (hit === null) return null;
  const { pos, total } = statsOf(items, prev.needle, hit, prev.mode);
  return { ...prev, idx: hit, pos, total };
}

/** 回删后重匹配（2026-11-05 定案：Backspace）：当前项在新缓冲下仍命中
 *  （按级联档位序取其可用的最高档）→ 驻留原位只刷新统计；否则从当前项
 *  之后按 step 同款级联重新找 */
export function typeAheadRematch(
  items: TypeAheadItem[],
  buf: string,
  curIdx: number,
): TypeAheadMatch | null {
  if (!items.length || !buf || buf === "*") return null;
  const star = buf.startsWith("*");
  const needle = (star ? buf.slice(1) : buf).toLowerCase();
  if (!needle || curIdx < 0 || curIdx >= items.length) return resolveFrom(items, buf, curIdx);
  // 驻留判定按级联同序：首选前缀 → 首选中段 → 变体前缀 → 变体中段
  //（同键循环档已移除，无单字符回退层）
  const tiers: [Mode, string, TaSrc][] = [
    [star ? "contains" : "prefix", needle, 0],
    ...((pymidEligible(star, needle) ? [["pymid", needle, 0] as [Mode, string, TaSrc]] : []) as [Mode, string, TaSrc][]),
    [star ? "contains" : "prefix", needle, 1],
    ...((pymidEligible(star, needle) ? [["pymid", needle, 1] as [Mode, string, TaSrc]] : []) as [Mode, string, TaSrc][]),
  ];
  for (const [m, nd, s] of tiers) {
    if (matchOf(items[curIdx], nd, m, s)) {
      const { pos, total } = statsOf(items, nd, curIdx, m, s);
      return { idx: curIdx, buf, disp: dispOf(star, nd), pos, total, needle: nd, mode: m, src: s };
    }
  }
  return resolveFrom(items, buf, curIdx);
}

/** 行内命中高亮定位（2026-11-05 定案）：返回名称中被命中的字符区间
 *  [起始字符下标, 字符数]，供 FileList 名称单元格分三段渲染。
 *  - 名称档（prefix 命中名称 / contains 命中名称）→ 直接名称区间
 *  - 拼音档 → 按 py 串命中偏移对齐回名称字符（ASCII 与汉字各贡献 1 个
 *    py 字符；非 ASCII 非汉字贡献 lower(char) 全串——偏移错位即放弃高亮，
 *    不影响命中本身）
 *  对齐失败或未命中返回 null（不高亮） */
export function matchRangeOf(
  name: string,
  py: string[] | null | undefined,
  needle: string,
  mode: TaMode,
): [number, number] | null {
  const nd = needle.toLowerCase();
  if (!nd) return null;
  const lname = name.toLowerCase();
  if (mode !== "pymid" && lname.includes(nd)) {
    // 名称命中（prefix 的 includes ⊇ startsWith；contains 同式）：按码点定位起点与长度
    let start = -1;
    let before = 0;
    for (let i = 0; i < lname.length; ) {
      if (lname.startsWith(nd, i)) {
        start = i;
        break;
      }
      i += lname.codePointAt(i)! > 0xffff ? 2 : 1;
      before += 1;
    }
    if (start === -1) return null;
    let lenChars = 0;
    for (let i = start; i < start + nd.length; lenChars += 1) {
      i += lname.codePointAt(i)! > 0xffff ? 2 : 1;
    }
    return [before, lenChars];
  }
  // 拼音档（pymid）或 contains/prefix 落到 py 通道：py 命中偏移 → 名称字符区间
  //（多变体：取首个能对齐成功的变体）
  if (!py?.length) return null;
  for (const variant of py) {
    const r = pyRangeOf(name, variant, nd);
    if (r) return r;
  }
  return null;
}

/** 单个 py 变体的命中偏移对齐（matchRangeOf 内部用） */
function pyRangeOf(name: string, py: string, nd: string): [number, number] | null {
  const pyLower = py.toLowerCase();
  const p0 = pyLower.indexOf(nd);
  if (p0 < 0) return null;
  // 对齐表：第 i 个名称字符的 py 起始偏移（码点扫描；贡献数 = lower(char) 码点数，
  // 汉字生成器只贡献 1 个首字母字符，ASCII 贡献 1 个，理论一致；总数不符即放弃）
  const offsets: number[] = [];
  let p = 0;
  for (let i = 0; i < name.length; ) {
    const cp = name.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const adv = cp > 0xffff ? 2 : 1;
    const contrib = [...ch.toLowerCase()].length;
    offsets.push(p);
    p += contrib;
    i += adv;
  }
  if (p !== [...pyLower].length) return null; // 对不上（罕见字符）→ 不高亮
  const ndLen = [...nd].length;
  let startChar = -1;
  let lenChars = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] === p0) startChar = i;
    if (startChar >= 0 && offsets[i] < p0 + ndLen) lenChars += 1;
  }
  if (startChar < 0) return null; // 命中起点落在某字符贡献内部 → 不高亮
  return [startChar, lenChars];
}
