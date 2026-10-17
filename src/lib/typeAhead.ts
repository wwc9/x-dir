// 首字母跳转（type-ahead）匹配纯函数：键盘直接敲字符累积缓冲，
// 选中名称匹配串以缓冲为前缀的下一项（从当前项之后循环查找，TC/Explorer 惯例）。
// 匹配串 = 文件名小写，或 Rust 下发的拼音首字母串 py（汉字取拼音首字母，如
// "forge请下这个txt文件" → "forgeqxzgtxtwj"，敲 "qxzg" 即可跳到；名称优先于 py）。
// 缓冲整体无命中时回退为仅本次按键重试（"ab" 打错退回单字符继续跳）。

export interface TypeAheadItem {
  name: string;
  path: string;
  /** 拼音首字母匹配串（Rust 端随列表下发；不含汉字为 null） */
  py?: string | null;
}

/**
 * @param items  当前列表条目（显示顺序）
 * @param buf    已累积缓冲（小写）
 * @param curIdx 当前选中下标，无选中为 -1
 * @returns 命中条目下标；无命中返回 null
 */
export function pickTypeAhead(
  items: TypeAheadItem[],
  buf: string,
  curIdx: number,
): number | null {
  if (!items.length || !buf) return null;
  const needle = buf.toLowerCase();
  const from = curIdx + 1;
  for (let i = 0; i < items.length; i++) {
    const idx = (from + i) % items.length;
    const it = items[idx];
    if (it.name.toLowerCase().startsWith(needle)) return idx;
    if (it.py && it.py.startsWith(needle)) return idx;
  }
  return null;
}
