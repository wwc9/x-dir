// 窗格状态条选中统计（纯函数，2026-11-03 方案 B）：
// 多选纯文件 = 数量 + 合计；多选含文件夹 = 仅数量（文件夹大小需递归统计，
// 部分和会误导）；单选 = 行内属性条（名称 · 大小 · 修改时间，免开属性对话框）。
// selected 可能含未加载页的路径（选择记忆/搜索前选中），未命中的项只计数、
// 不参与大小与 hasDir 判定（resolved 回传覆盖数，调用方按需提示）。

import type { FileEntry } from "./ipc";

export interface SelStats {
  count: number;
  /** 已加载纯文件的大小合计（全为文件夹/越页未命中时为 0） */
  size: number;
  /** 多选命中文件夹：合计不展示（部分和误导），调用方只显示数量 */
  hasDir: boolean;
  /** 单选且条目已在加载页（行内属性条数据源）；多选或未命中为 null */
  single: FileEntry | null;
  /** 在加载页命中的条目数 */
  resolved: number;
}

export function selStats(
  sel: readonly string[],
  entries: readonly FileEntry[],
): SelStats {
  const set = new Set(sel);
  const hit: FileEntry[] = [];
  for (const e of entries) if (set.has(e.path)) hit.push(e);
  const size = hit.reduce((n, e) => (e.isDir ? n : n + e.size), 0);
  const hasDir = hit.some((e) => e.isDir);
  return {
    count: sel.length,
    size,
    hasDir,
    single: sel.length === 1 ? (hit[0] ?? null) : null,
    resolved: hit.length,
  };
}

/** 修改时间短格式（MM-dd HH:mm）——行内属性条用（全长格式见 format.formatTime） */
export function formatShortTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
