// 首字母跳转（type-ahead）匹配纯函数：键盘直接敲字符累积缓冲，选中名称匹配
// 的下一项（从当前项之后循环查找，Total Commander/Explorer 惯例）。匹配串 =
// 文件名小写，或 Rust 下发的拼音首字母串 py（汉字取拼音首字母，如
// "forge请下这个txt文件" → "forgeqxzgtxtwj"，敲 "qxzg" 即可跳到；名称优先于 py）。
//
// 匹配策略（对齐 TC 快速搜索，2026-11-01 调研定案；2026-11-05 增补中段首字母）：
// 1. 缓冲以 "*" 开头 = 子串匹配（TC 原生语义，"*zeb" 命中 "topzebra.txt"）；
//    否则前缀匹配。
// 1b. 前缀整缓冲未命中（或只驻留当前项）→ 拼音首字母串中段匹配（py.includes）：
//     支持用文件名中间文字的首字母定位（"2026年度审计报告" 敲 "sjbg" 直达"审计
//     报告"段）。启用条件 = 缓冲 ≥2 字符且含 ≥2 个不同字符——单字符与重复单字
//     字符（"b"/"bb"）不启用，保持 2 的同键循环语义不变（敲 "bb" 的意图更可能
//     是循环下一个 b，而非找拼音含 bb 的文件）。仅 py 中段：名称中段匹配仍属
//     "*" 显式子串语义，不自动启用（无法与循环区分，见 4）。
// 2. 整缓冲无命中，或命中只是停驻在当前项（环绕后唯一匹配是自己）→ 立即回退
//    为仅本次按键循环："b","b" 即在所有 b 开头条目间逐个循环。不停驻、不回跳
//    （TC/Explorer 在"恰好存在 bb.txt"时会停驻一步甚至乒乓，此处为友好改进）。
// 3. 回退后缓冲保留完整输入（"bbb" 不截断），下一次同键扩展 "bbbb" 仍无命中
//    → 继续循环；显示取实际生效的匹配针（"bb"/"b"，disp 字段）。
// 4. 故意不做「前缀失败自动名称子串回退」：无法与重复字母循环区分（敲 "bb" 到底
//    是想循环到下一个 b，还是想找名字含 bb 的文件？），TC 也不做——要子串
//    匹配请显式敲 "*" 前缀。
//
// 统计 pos/total（当前命中在同匹配集中的 1 起序位/总数）：重复首字母文件多时
// 回显 pill 显示 "2/7"，用户知道循环到第几个、还有多少个。

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
}

/** 匹配档位（pill 状态与行内高亮随行存储，见 TypeAheadState） */
export type TaMode = "prefix" | "contains" | "pymid";

type Mode = TaMode;

function matchOf(it: TypeAheadItem, needle: string, mode: Mode): boolean {
  const name = it.name.toLowerCase();
  if (mode === "prefix") {
    if (name.startsWith(needle)) return true;
    return !!it.py?.some((p) => p.toLowerCase().startsWith(needle));
  }
  if (mode === "contains") {
    if (name.includes(needle)) return true;
    return !!it.py?.some((p) => p.toLowerCase().includes(needle));
  }
  // pymid = 仅拼音首字母串中段（文件名中间文字的首字母定位，策略 1b）
  return !!it.py?.some((p) => p.toLowerCase().includes(needle));
}

/** 中段首字母匹配启用条件（策略 1b）：非 "*" 模式 + 缓冲 ≥2 字符且含 ≥2 个
 *  不同字符——单字符与重复单字符（"b"/"bb"）不启用，保持同键循环语义不变 */
function pymidEligible(star: boolean, needle: string): boolean {
  return !star && needle.length >= 2 && new Set(needle).size >= 2;
}

/** 从当前项之后环绕找下一个匹配项 */
function findFrom(
  items: TypeAheadItem[],
  needle: string,
  curIdx: number,
  mode: Mode,
): number | null {
  return findDir(items, needle, curIdx, mode, 1);
}

/** 双向环绕查找（dir=1 向后 / dir=-1 向前；Tab 循环用 -1） */
function findDir(
  items: TypeAheadItem[],
  needle: string,
  curIdx: number,
  mode: Mode,
  dir: 1 | -1,
): number | null {
  const n = items.length;
  for (let i = 1; i <= n; i++) {
    const idx = dir === 1 ? (curIdx + i) % n : (((curIdx - i) % n) + n) % n;
    if (matchOf(items[idx], needle, mode)) return idx;
  }
  return null;
}

/** 命中项在匹配集中的序位与总数（单趟计数） */
function statsOf(
  items: TypeAheadItem[],
  needle: string,
  hitIdx: number,
  mode: Mode,
): { pos: number; total: number } {
  let pos = 0;
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    if (!matchOf(items[i], needle, mode)) continue;
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

/** 级联核心（step 与 rematch 共用）：对完整缓冲按 1→1b→2→3 档位解析 */
function resolveFrom(
  items: TypeAheadItem[],
  next: string,
  curIdx: number,
): TypeAheadMatch | null {
  const star = next.startsWith("*");
  const mode: Mode = star ? "contains" : "prefix";
  const needle = (star ? next.slice(1) : next).toLowerCase();
  if (!needle) return null;
  const ch = needle[needle.length - 1];

  // 1) 整缓冲匹配：命中且不驻留当前项（驻留 = 环绕后唯一匹配是自己，等价死端）
  const h1 = findFrom(items, needle, curIdx, mode);
  if (h1 !== null && h1 !== curIdx) {
    const { pos, total } = statsOf(items, needle, h1, mode);
    return { idx: h1, buf: next, disp: dispOf(star, needle), pos, total, needle, mode };
  }
  // 1b) 前缀未命中（或驻留）→ 拼音首字母串中段（文件名中间文字的首字母直达）
  if (pymidEligible(star, needle)) {
    const h1b = findFrom(items, needle, curIdx, "pymid");
    if (h1b !== null && h1b !== curIdx) {
      const { pos, total } = statsOf(items, needle, h1b, "pymid");
      return { idx: h1b, buf: next, disp: dispOf(star, needle), pos, total, needle, mode: "pymid" };
    }
  }
  // 2) 回退为本次按键循环（"*" 语义随模式保留）；缓冲保留完整输入供接续
  const h2 = findFrom(items, ch, curIdx, mode);
  if (h2 !== null && h2 !== curIdx) {
    const { pos, total } = statsOf(items, ch, h2, mode);
    return { idx: h2, buf: next, disp: dispOf(star, ch), pos, total, needle: ch, mode };
  }
  // 3) 连单字符都只剩当前项：停驻显示（pill 告知当前即唯一匹配）；全无命中 = null
  if (h2 !== null) {
    const { pos, total } = statsOf(items, ch, h2, mode);
    return { idx: h2, buf: next, disp: dispOf(star, ch), pos, total, needle: ch, mode };
  }
  return null;
}

/** 命中集内循环（2026-11-05 定案：Tab / Shift+Tab）：沿用产生该命中时的
 *  生效针与档位（循环不换档），从当前项向前/向后环绕；集内唯一项 = 原地驻留 */
export function typeAheadCycle(
  items: TypeAheadItem[],
  prev: TypeAheadMatch,
  curIdx: number,
  dir: 1 | -1,
): TypeAheadMatch | null {
  if (!items.length) return null;
  const hit = findDir(items, prev.needle, curIdx, prev.mode, dir);
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
  const ch = needle[needle.length - 1];
  const tiers: [Mode, string][] = [
    [star ? "contains" : "prefix", needle],
    ...(pymidEligible(star, needle) ? ([["pymid", needle] as [Mode, string]]) : []),
    [star ? "contains" : "prefix", ch],
  ];
  for (const [m, nd] of tiers) {
    if (matchOf(items[curIdx], nd, m)) {
      const { pos, total } = statsOf(items, nd, curIdx, m);
      return { idx: curIdx, buf, disp: dispOf(star, nd), pos, total, needle: nd, mode: m };
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
