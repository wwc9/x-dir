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
  /** 拼音首字母匹配串（Rust 端随列表下发；不含汉字为 null） */
  py?: string | null;
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
}

type Mode = "prefix" | "contains" | "pymid";

function matchOf(it: TypeAheadItem, needle: string, mode: Mode): boolean {
  const name = it.name.toLowerCase();
  if (mode === "prefix") {
    if (name.startsWith(needle)) return true;
    return !!it.py && it.py.toLowerCase().startsWith(needle);
  }
  if (mode === "contains") {
    if (name.includes(needle)) return true;
    return !!it.py && it.py.toLowerCase().includes(needle);
  }
  // pymid = 仅拼音首字母串中段（文件名中间文字的首字母定位，策略 1b）
  return !!it.py && it.py.toLowerCase().includes(needle);
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
  const from = curIdx + 1;
  for (let i = 0; i < items.length; i++) {
    const idx = (from + i) % items.length;
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
  const star = next.startsWith("*");
  const mode: Mode = star ? "contains" : "prefix";
  const needle = (star ? next.slice(1) : next).toLowerCase();
  if (!needle) return null; // 裸 "*" 无意义

  // 1) 整缓冲匹配：命中且不驻留当前项（驻留 = 环绕后唯一匹配是自己，等价死端）
  const h1 = findFrom(items, needle, curIdx, mode);
  if (h1 !== null && h1 !== curIdx) {
    const { pos, total } = statsOf(items, needle, h1, mode);
    return { idx: h1, buf: next, disp: dispOf(star, needle), pos, total };
  }
  // 1b) 前缀未命中（或驻留）→ 拼音首字母串中段（文件名中间文字的首字母直达）
  if (pymidEligible(star, needle)) {
    const h1b = findFrom(items, needle, curIdx, "pymid");
    if (h1b !== null && h1b !== curIdx) {
      const { pos, total } = statsOf(items, needle, h1b, "pymid");
      return { idx: h1b, buf: next, disp: dispOf(star, needle), pos, total };
    }
  }
  // 2) 回退为本次按键循环（"*" 语义随模式保留）；缓冲保留完整输入供接续
  const h2 = findFrom(items, ch, curIdx, mode);
  if (h2 !== null && h2 !== curIdx) {
    const { pos, total } = statsOf(items, ch, h2, mode);
    return { idx: h2, buf: next, disp: dispOf(star, ch), pos, total };
  }
  // 3) 连单字符都只剩当前项：停驻显示（pill 告知当前即唯一匹配）；全无命中 = null
  if (h2 !== null) {
    const { pos, total } = statsOf(items, ch, h2, mode);
    return { idx: h2, buf: next, disp: dispOf(star, ch), pos, total };
  }
  return null;
}
