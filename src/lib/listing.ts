// 文件清单导出行构建（2026-11-09「导出文件清单 ▸」三格式）：CSV（原始字节，
// Excel 友好）/ Markdown 表格（人类可读体积）/ 纯文本（仅名称一行一个）。
// 纯函数无 IPC/store 依赖，配单测锁定转义与列口径。

import type { FileEntry } from "./ipc";
import { formatBytes, formatTime } from "./format";

export type ListingFormat = "csv" | "md" | "txt";

const CSV_COLS = "名称,类型,大小(字节),修改时间" as const;
const MD_COLS = "| 名称 | 类型 | 大小 | 修改时间 |" as const;
const MD_RULE = "| --- | --- | ---: | --- |" as const;

const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Markdown 表格单元内的管道与换行会破坏列结构，替换为全角 */
const mdEsc = (v: string) => v.replace(/\|/g, "｜").replace(/\r?\n/g, " ");
const typeName = (e: FileEntry) =>
  e.isDir ? "文件夹" : (e.name.split(".").pop()?.toUpperCase() ?? "文件");

/** 构建清单全文（行尾 CRLF，Excel/记事本双开友好） */
export function buildListing(entries: FileEntry[], fmt: ListingFormat): string {
  if (fmt === "txt") {
    return entries.map((e) => e.name).join("\r\n");
  }
  if (fmt === "md") {
    const rows = entries.map(
      (e) =>
        `| ${mdEsc(e.name)} | ${mdEsc(typeName(e))} | ${
          e.isDir ? "—" : formatBytes(e.size)
        } | ${formatTime(e.mtimeMs)} |`,
    );
    return [MD_COLS, MD_RULE, ...rows].join("\r\n");
  }
  const rows = entries.map((e) =>
    [
      esc(e.name),
      esc(typeName(e)),
      e.isDir ? "" : String(e.size),
      formatTime(e.mtimeMs),
    ].join(","),
  );
  return [CSV_COLS, ...rows].join("\r\n");
}

/** 各格式的保存框默认文件名与过滤器 */
export function listingFileName(fmt: ListingFormat): string {
  return fmt === "csv" ? "文件清单.csv" : fmt === "md" ? "文件清单.md" : "文件清单.txt";
}

export function listingFilter(
  fmt: ListingFormat,
): { name: string; extensions: string[] } {
  return {
    name: fmt === "csv" ? "CSV" : fmt === "md" ? "Markdown" : "文本",
    extensions: [fmt],
  };
}
