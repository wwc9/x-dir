// 窗格状态条选中统计（纯函数，2026-11-03 方案 B）：
// 多选 = 数量 + 已知大小合计 + 类型 Top2 摘要（扩展名大写，文件夹归并）；
// 单选 = 行内属性条（名称 · 大小 · 修改时间，免开属性对话框）。
// selected 可能含未加载页的路径（选择记忆/搜索前选中），未命中的项只计数、
// 不参与大小与类型摘要（resolved 回传覆盖数，调用方按需提示）。

import type { FileEntry } from "./ipc";

export interface SelTypeCount {
  label: string;
  n: number;
}

export interface SelStats {
  count: number;
  /** 已加载条目的大小合计（文件夹不计；全为文件夹/越页未命中时为 0） */
  size: number;
  /** 单选且条目已在加载页（行内属性条数据源）；多选或未命中为 null */
  single: FileEntry | null;
  /** 多选类型 Top2（数量降序，并列按标签序）；单选为空 */
  topTypes: SelTypeCount[];
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
  if (sel.length === 1) {
    return { count: 1, size, single: hit[0] ?? null, topTypes: [], resolved: hit.length };
  }
  const counts = new Map<string, number>();
  for (const e of hit) {
    const label = e.isDir
      ? "文件夹"
      : e.name.lastIndexOf(".") > 0
        ? e.name.slice(e.name.lastIndexOf(".") + 1).toUpperCase()
        : "无扩展名";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const topTypes = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([label, n]) => ({ label, n }));
  return { count: sel.length, size, single: null, topTypes, resolved: hit.length };
}

/** 修改时间短格式（MM-dd HH:mm）——行内属性条用（全长格式见 format.formatTime） */
export function formatShortTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
