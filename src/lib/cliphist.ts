// 剪贴板历史浮窗纯函数（§3.7）：相对时间、大小格式化、类型图标与标签。
// 图标仅导出 lucide 组件引用，渲染一律经 AppIcon（iconRule 审计）。

import { FileText, Files, Image as ImageIcon } from "lucide-react";

export type ClipKind = "text" | "image" | "files";

export interface ClipKindMeta {
  label: string;
  icon: typeof FileText;
}

export function clipKindMeta(kind: string): ClipKindMeta {
  switch (kind) {
    case "image":
      return { label: "图片", icon: ImageIcon };
    case "files":
      return { label: "文件", icon: Files };
    default:
      return { label: "文本", icon: FileText };
  }
}

/** 相对时间（now 可注入供测试）：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}

/** 大小格式化：B / KB / MB（1 位小数） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
