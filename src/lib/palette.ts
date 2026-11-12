// 功能库快速命令面板（方案 C 贴身轻浮窗，2026-11-11）纯逻辑：默认高频清单 /
// 搜索过滤 / 右键现场可用性判定 / 视口内吸附定位。渲染层在
// components/CommandPalette.tsx；执行走 listRegistry.builtinMenuItem（与右键
// 菜单同一执行器，闭包持有触发窗格列表上下文）。
import type { FileEntry } from "./ipc";
import {
  BUILTIN_FNS,
  builtinByKey,
  entryVisible,
  type BuiltinFn,
} from "./menuCommands";

/** 默认高频清单（query 为空时按此序置顶展示，2026-11-11 方案 C 定稿 12 项；
 *  其余功能按注册表序跟排，搜索即达全库） */
export const PALETTE_QUICK_KEYS = [
  "hashCalc",
  "zipHere",
  "findDuplicates",
  "pdfMerge",
  "copyPath",
  "batchRename",
  "moveToPane",
  "openTerminal",
  "fileTouch",
  "xlsxMerge",
  "exportList",
  "pdfToPng",
] as const;

export interface PaletteItem {
  fn: BuiltinFn;
  /** 右键现场（选中条目/空白）下是否可执行；false = 置灰不可选 */
  available: boolean;
  /** 搜索针（名称+说明+分组拼接小写）：默认注册表原文；i18n 语言非中文时
   *  调用方以译名重建（CommandPalette 用 t() 重组），保证英文可搜 */
  search: string;
}

/** 当前面下功能是否可用：有选中 = supportsSel 能力位 + 注册表条件（对象/
 *  数量/扩展名）；空白右键 = 仅 supportsBlank 能力位（条件恒过，同右键菜单
 *  entryVisible 的 blank 口径） */
export function paletteAvailable(fn: BuiltinFn, sel: FileEntry[]): boolean {
  if (sel.length) return fn.supportsSel && entryVisible(fn.cond, "sel", sel);
  return fn.supportsBlank && entryVisible(fn.cond, "blank", null);
}

/** 面板全库清单：可用项稳定置顶 + 不可用项沉底（2026-11-12 用户定案；sort
 *  ES2019 起稳定，两块各自保持高频 12 项 → 注册表原序）；功能库入口自身
 *  （builtin:palette，同日入库）与窗格工具（supportsSel/Blank 双 false，仅
 *  工具栏可用）不入面板——前者是面板自己的唤起入口（自列无意义），后者
 *  执行器不在 listRegistry，右键语境无执行路径 */
export function paletteItems(sel: FileEntry[]): PaletteItem[] {
  const quickSet = new Set<string>(PALETTE_QUICK_KEYS);
  const quick = PALETTE_QUICK_KEYS.map((k) => builtinByKey(k)).filter(
    (f): f is BuiltinFn => !!f,
  );
  const rest = BUILTIN_FNS.filter(
    (f) =>
      f.key !== "palette" &&
      !quickSet.has(f.key) &&
      (f.supportsSel || f.supportsBlank),
  );
  return [...quick, ...rest]
    .map((fn) => ({
      fn,
      available: paletteAvailable(fn, sel),
      search: `${fn.label}${fn.desc}${fn.group}`.toLowerCase(),
    }))
    .sort((a, b) => Number(b.available) - Number(a.available));
}

/** 搜索过滤：search 针小写包含，query 按空格拆多词 AND（每词都须命中，
 *  「pdf 合并」→ 命中「合并为 PDF」）；空 query 原样返回 */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const terms = q.split(/\s+/);
  return items.filter((it) => terms.every((t) => it.search.includes(t)));
}

/** 面板吸附定位钳制：默认贴触发点（右键菜单锚位）原样落下；右/下溢出视口
 *  时回推，四周保底 EDGE 边距（与右键菜单 DENSITY.menuClampW 同款启发式） */
export function clampPalettePos(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
): { x: number; y: number } {
  const EDGE = 8;
  const cx = Math.min(Math.max(x, EDGE), Math.max(EDGE, vw - w - EDGE));
  const cy = y + h <= vh - EDGE ? y : Math.max(EDGE, vh - h - EDGE);
  return { x: cx, y: cy };
}
