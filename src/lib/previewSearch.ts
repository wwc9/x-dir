// 预览内查找（2026-10-18）：跨类型（PDF/文本/Markdown/office/表格）共用匹配核心。
// 纯函数只管"在哪匹配"；DOM 高亮经 CSS Custom Highlight API（无侵入，不改渲染树）。
// PDF 多页并存时各页各自注册分组（group），合并后统一写入 CSS.highlights，
// 避免页与页互相覆盖。命中上限防病态输入拖死。

/** 单个命中：在节点文本序列中的位置（node 序号 + 节点内区间 + 全局序号） */
export interface MatchRange {
  node: number;
  start: number;
  end: number;
  match: number;
}

/** 预览内查找控制通道：宿主（QuickPreview 搜索条）持有词与活动命中序号，
 *  渲染器据此高亮/滚动并回报命中总数 */
export interface PreviewSearchCtl {
  term: string;
  active: number;
  onTotal(total: number): void;
}

/** 可搜索的预览类型（officeBinary 转换完成后按 PDF 通道可搜） */
export const SEARCHABLE_KINDS = new Set([
  "pdf",
  "officeBinary",
  "text",
  "markdown",
  "officeDoc",
  "officeSheet",
  "officeSlides",
  "email",
  "epub",
]);

const MATCH_CAP = 2000;

/** 大小写不敏感子串匹配，返回命中起点数组（纯函数）；空词返回空 */
export function findMatches(hay: string, needle: string, cap = MATCH_CAP): number[] {
  if (!needle) return [];
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  const out: number[] = [];
  let i = h.indexOf(n);
  while (i >= 0 && out.length < cap) {
    out.push(i);
    i = h.indexOf(n, i + n.length);
  }
  return out;
}

/** 节点文本序列 + 全局命中偏移 → 逐节点区间（纯函数）。跨节点的命中拆成多段
 *  （同 match 序号），渲染层按段建 Range。 */
export function mapRanges(
  nodeTexts: string[],
  matches: number[],
  needle: string,
): MatchRange[] {
  if (!needle || !matches.length) return [];
  const starts: number[] = [];
  const cum: number[] = [];
  let acc = 0;
  for (const t of nodeTexts) {
    starts.push(acc);
    cum.push(acc + t.length);
    acc += t.length;
  }
  const out: MatchRange[] = [];
  for (let mi = 0; mi < matches.length; mi++) {
    const mStart = matches[mi];
    const mEnd = mStart + needle.length;
    for (let node = 0; node < nodeTexts.length && starts[node] < mEnd; node++) {
      const s = Math.max(mStart, starts[node]);
      const e = Math.min(mEnd, cum[node]);
      if (e > s) out.push({ node, start: s - starts[node], end: e - starts[node], match: mi });
    }
  }
  return out;
}

/** CSS Custom Highlight API 的注册名（index.css ::highlight 配对） */
export const HIGHLIGHT_NORMAL = "pv-search";
export const HIGHLIGHT_ACTIVE = "pv-search-active";

type HighlightCtor = new (...ranges: Range[]) => unknown;
interface HighlightRegistry {
  highlights: Map<string, unknown>;
}

function cssRegistry(): HighlightRegistry | null {
  const css = CSS as unknown as { highlights?: Map<string, unknown> };
  return css.highlights ? { highlights: css.highlights } : null;
}

function writeHighlights(normal: Range[], active: Range[]): void {
  const reg = cssRegistry();
  const HL = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  if (!reg || !HL) return;
  reg.highlights.set(HIGHLIGHT_NORMAL, new HL(...normal));
  reg.highlights.set(HIGHLIGHT_ACTIVE, new HL(...active));
}

/** 分组注册表：PDF 每页一组、文档渲染器一组，任一组更新即全量重写 */
const groups = new Map<string, { normal: Range[]; active: Range[] }>();

/** 更新一个高亮分组并重写全局高亮（空数组 = 移除该组） */
export function setGroupHighlights(
  group: string,
  normal: Range[],
  active: Range[],
): void {
  if (!normal.length && !active.length) groups.delete(group);
  else groups.set(group, { normal, active });
  const allNormal: Range[] = [];
  const allActive: Range[] = [];
  for (const g of groups.values()) {
    allNormal.push(...g.normal);
    allActive.push(...g.active);
  }
  writeHighlights(allNormal, allActive);
}

export function clearGroupHighlights(group: string): void {
  if (!groups.delete(group)) return;
  const allNormal: Range[] = [];
  const allActive: Range[] = [];
  for (const g of groups.values()) {
    allNormal.push(...g.normal);
    allActive.push(...g.active);
  }
  writeHighlights(allNormal, allActive);
}

/** 清空全部分组（条目切换/搜索关闭时调用） */
export function clearAllHighlights(): void {
  groups.clear();
  const reg = cssRegistry();
  if (!reg) return;
  reg.highlights.delete(HIGHLIGHT_NORMAL);
  reg.highlights.delete(HIGHLIGHT_ACTIVE);
}

/** 收集元素内可见文本节点（跳过 script/style/input） */
export function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "INPUT" || tag === "TEXTAREA") {
        return NodeFilter.FILTER_REJECT;
      }
      return (node as Text).nodeValue?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let cur = walker.nextNode();
  while (cur) {
    out.push(cur as Text);
    cur = walker.nextNode();
  }
  return out;
}

/** 容器内应用查找高亮（DOM 副作用，组件 effect 调用）：返回命中总数；active
 *  命中不在视口时滚动到视口中央。term 为空时清除该组。 */
export function highlightInContainer(
  root: HTMLElement,
  group: string,
  term: string,
  activeIndex: number,
): number {
  if (!term) {
    clearGroupHighlights(group);
    return 0;
  }
  const nodes = collectTextNodes(root);
  const nodeTexts = nodes.map((n) => n.nodeValue ?? "");
  const matches = findMatches(nodeTexts.join(""), term);
  const ranges = mapRanges(nodeTexts, matches, term);
  const normal: Range[] = [];
  const active: Range[] = [];
  for (const r of ranges) {
    const range = document.createRange();
    const el = nodes[r.node];
    range.setStart(el, r.start);
    range.setEnd(el, r.end);
    (r.match === activeIndex ? active : normal).push(range);
  }
  setGroupHighlights(group, normal, active);
  const anchor = active[0] ?? normal[0];
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const scroller = root.closest(".np-pv-body, .np-gsearch-pv, .np-pv-doc") ?? root;
    const box = scroller.getBoundingClientRect();
    if (rect.top < box.top || rect.bottom > box.bottom) {
      anchor.startContainer.parentElement?.scrollIntoView({
        block: "center",
        behavior: "instant" as ScrollBehavior,
      });
    }
  }
  return matches.length;
}
