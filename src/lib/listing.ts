// 重复文件清单导出（2026-11-09「查找重复文件」增强）：前端持有重复组数据，
// CSV 文本就地构建。文件清单导出（2026-11-10）已整体移至 Rust fs/listing.rs
// ——列表分页下发前端只持有当前页，整文件夹递归必须后端收集，列集也随单源。

import type { DupGroup } from "./ipc";

const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** 可释放空间合计（每组 = 体积 × (份数 - 1)，保留一份口径） */
export function dupWaste(groups: DupGroup[]): number {
  return groups.reduce((acc, g) => acc + g.size * (g.paths.length - 1), 0);
}

/** 重复文件 CSV：组号/文件路径/大小(字节)/SHA-256 四列，组内按路径排序
 *  （后端已排）——审计核对时可直接按组筛除副本 */
export function buildDupCsv(groups: DupGroup[]): string {
  const rows: string[] = ["组号,文件路径,大小(字节),SHA-256"];
  groups.forEach((g, i) => {
    for (const p of g.paths) {
      rows.push([String(i + 1), esc(p), String(g.size), g.hash].join(","));
    }
  });
  return rows.join("\r\n");
}
