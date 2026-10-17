// 详情视图列宽纯逻辑（表头拖拽共用；AGENTS：交互纯函数进 lib/ 并配单测）

export interface ColWidths {
  name: number;
  mtime: number;
  type: number;
  size: number;
  loc: number;
}

export type ColKey = keyof ColWidths;

/** 默认列宽（px）：沿用 .np-col-* 的历史 CSS 值 */
export const COL_DEFAULTS: ColWidths = {
  name: 240,
  mtime: 130,
  type: 110,
  size: 80,
  loc: 160,
};

export const COL_MIN = 56;
export const COL_MAX = 480;

/* ── 详情视图内容自然宽（Explorer 口径）──
   各列定宽互不影响：拖一列只改这一列；可见列总宽超出窗格容器时 .np-rows
   开横向滚动（np-scroll-x），内容层与表头用 min-width 撑到自然宽。
   布局常量与 index.css 的 .np-head/.np-row 盒模型同源（改一处必须同改）：
   左内衬 14 = 4(.np-rows padding) + 2(.np-row margin) + 8(.np-row padding)；
   图标位 16；列间沟槽 7；右内衬 24 = 14 + 10(纵向滚动条槽 scrollbar-gutter)。 */

export const COL_LAYOUT = { insetL: 14, icon: 16, gap: 7, insetR: 24 } as const;

export type ColGroup = "normal" | "search" | "thispc" | "gsearch";

/** 可见列宽（按窗格宽逐级隐藏；阈值镜像 index.css 窄窗格容器查询 479/379/299，
 *  两处必须同改）。列序与表头渲染序一致，隐藏只影响求和 */
export function visibleColWidths(w: number, c: ColWidths, group: ColGroup): number[] {
  const cols: number[] = [c.name];
  if (group === "gsearch") {
    // 全盘搜索弹窗：名称/位置/大小/类型恒显（放不下走横滚）；修改时间列在
    // 面板 <GS_MTIME_MIN 隐藏（预览拖宽挤占时让位——1100 宽弹窗默认面板 ~647 恰好隐藏）
    cols.push(c.loc, c.type, c.size);
    if (w >= GS_MTIME_MIN) cols.push(c.mtime);
    return cols;
  }
  const wide = w >= 480; // type 与搜索"位置"列 <480 隐藏
  if (group === "search" && wide) cols.push(c.loc);
  if (group === "normal" && w >= 380) cols.push(c.mtime);
  if (wide) cols.push(c.type);
  if (group === "thispc") {
    // 此电脑：总大小 / 可用空间两列共用同一 size 宽
    if (w >= 300) cols.push(c.size, c.size);
  } else if (w >= 300) {
    cols.push(c.size);
  }
  return cols;
}

/** 详情视图内容自然宽 = 左内衬 + 图标位 + 可见列宽和 + 列间沟槽 + 右内衬 */
export function detailsContentWidth(w: number, c: ColWidths, group: ColGroup): number {
  const cols = visibleColWidths(w, c, group);
  const sum = cols.reduce((a, b) => a + b, 0);
  return (
    COL_LAYOUT.insetL +
    COL_LAYOUT.icon +
    COL_LAYOUT.gap * cols.length +
    sum +
    COL_LAYOUT.insetR
  );
}

/** 拖拽/载入统一钳制；非法值落到该列默认宽 */
export function clampColWidth(w: number, key: ColKey): number {
  if (!Number.isFinite(w)) return COL_DEFAULTS[key];
  return Math.min(COL_MAX, Math.max(COL_MIN, Math.round(w)));
}

/** localStorage 读入的脏数据 → 合法列宽（未知键忽略，缺省补默认） */
export function sanitizeColWidths(raw: unknown): ColWidths {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out = { ...COL_DEFAULTS };
  for (const k of Object.keys(COL_DEFAULTS) as ColKey[]) {
    const v = src[k];
    if (typeof v === "number") out[k] = clampColWidth(v, k);
  }
  return out;
}

/* ── 全盘搜索结果列（名称/位置/大小/类型/修改时间）──
   宽度独立于文件列表：搜索弹窗宽固定，用户对两侧的比例偏好不同，不互相干扰。
   列语义与列表 loc/size/type/mtime 列相同，CSS 直接复用 .np-col-* 类；
   mtime 参与逐级隐藏（面板 <660 隐藏，见 visibleColWidths gsearch 分支）。 */

export interface GsColWidths {
  name: number;
  loc: number;
  size: number;
  type: number;
  mtime: number;
}

export type GsColKey = keyof GsColWidths;

/** gsearch 修改时间列可见阈值（visibleColWidths gsearch 分支同源，改一处必须同改） */
export const GS_MTIME_MIN = 660;

export function gsMtimeVisible(w: number): boolean {
  return w >= GS_MTIME_MIN;
}

/** 默认宽总和 578 + 框架 89（5 列沟槽）= 自然宽 667：全页模式下窄窗（面板 ≥660 显示
 *  mtime）不出横滚；mtime 132 容下 "2025-04-12 11:29" 全文不截断 */
export const GS_COL_DEFAULTS: GsColWidths = {
  name: 168,
  loc: 134,
  size: 72,
  type: 72,
  mtime: 132,
};

export function clampGsColWidth(w: number, key: GsColKey): number {
  if (!Number.isFinite(w)) return GS_COL_DEFAULTS[key];
  return Math.min(COL_MAX, Math.max(COL_MIN, Math.round(w)));
}

export function sanitizeGsColWidths(raw: unknown): GsColWidths {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out = { ...GS_COL_DEFAULTS };
  for (const k of Object.keys(GS_COL_DEFAULTS) as GsColKey[]) {
    const v = src[k];
    if (typeof v === "number") out[k] = clampGsColWidth(v, k);
  }
  return out;
}

/* ── 全盘搜索预览面板宽（结果区/预览区分隔条拖拽）── */

export const GS_PV_DEFAULT = 400;
export const GS_PV_MIN = 280;
export const GS_PV_MAX = 640;

/** 拖拽/载入统一钳制；非法值回落默认宽 */
export function clampGsPreviewW(w: number): number {
  if (!Number.isFinite(w)) return GS_PV_DEFAULT;
  return Math.min(GS_PV_MAX, Math.max(GS_PV_MIN, Math.round(w)));
}
