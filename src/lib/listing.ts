// 清单导出共享类型与纯函数（2026-11-10 参数面板）。文件清单的行收集与
// 三格式构建在 Rust fs/listing.rs 单源（列表分页下发前端只持有当前页），
// 这里只放对话框参数结构与默认文件名推算。

import type { DupGroup, ListingFormat } from "./ipc";
import { fileNameOf, isValidName } from "./path";

const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** 导出文件清单参数（参数面板回执；与 Rust export_listing 命令同名参数同语义） */
export interface ExportListingOptions {
  /** 穿透子文件夹（选中文件夹展开子树；空白处 = 整树 vs 仅直接子项） */
  recursive: boolean;
  /** 导出内容：全部 / 仅文件 / 仅文件夹 */
  content: "all" | "files" | "dirs";
  fmt: ListingFormat;
  /** 文件名（不含扩展名；空 = 回落默认） */
  fileName: string;
}

/** 默认文件名 = 「文件夹名-文件清单」（与 Rust listing_base_name 同口径；
 *  盘根等非法名回落「文件清单」） */
export function exportListingDefaultName(dir: string): string {
  const n = fileNameOf(dir);
  return isValidName(n) ? `${n}-文件清单` : "文件清单";
}

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
