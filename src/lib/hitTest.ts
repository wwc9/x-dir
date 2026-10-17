// V3 OLE 拖拽的落点命中纯函数（单测覆盖；DOM/命令执行在 lib/oleDispatch.ts）

import { parentPath } from "./path";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PaneRects {
  paneId: string;
  pane: Rect;
  tabbar: Rect;
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
}

/** 矩形相交（边贴边 = 不相交，对齐"框到边缘不算选中"的框选直觉） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** 命中判定：返回落点所在窗格与是否落在其标签条上 */
export function hitPane(
  rects: PaneRects[],
  x: number,
  y: number,
): { paneId: string; onTabbar: boolean } | null {
  for (const r of rects) {
    if (!contains(r.pane, x, y)) continue;
    return { paneId: r.paneId, onTabbar: contains(r.tabbar, x, y) };
  }
  return null;
}

/** 同目录守护：全部源都已在此目录时，放下应为无操作（对齐 Explorer 直觉） */
export function allSourcesInside(sources: string[], destDir: string): boolean {
  return sources.every((s) => {
    const p = parentPath(s);
    return !!p && p.toLowerCase() === destDir.toLowerCase();
  });
}

export type DropGuard = "none" | "self" | "inside";

/** 自落守护（大小写折叠 + 组件边界，与 Rust 端 dest_inside_source 同语义）：
 *  "self" = 源就是目标目录（拖到正显示源目录的窗格，OS 必然失败，应静默忽略）；
 *  "inside" = 目标在某个源目录内部（拖父目录进自己的子目录，后端会拒绝） */
export function dropGuard(sources: string[], destDir: string): DropGuard {
  const d = destDir.replace(/\\+$/, "").toLowerCase();
  for (const s of sources) {
    const src = s.replace(/\\+$/, "").toLowerCase();
    if (src === d) return "self";
    if (
      d.length > src.length &&
      d.startsWith(src) &&
      d.charCodeAt(src.length) === 92 // "\"
    ) {
      return "inside";
    }
  }
  return "none";
}
