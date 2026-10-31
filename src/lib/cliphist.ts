// 剪贴板历史浮窗纯函数（§3.7）：相对时间、大小格式化、类型图标与标签。
// 图标仅导出 lucide 组件引用，渲染一律经 AppIcon（iconRule 审计）。

import { AlignLeft, Camera, File, FolderClosed, Link2, Route } from "lucide-react";

export type ClipKind = "text" | "image" | "files" | "dirs" | "link" | "path";

export interface ClipKindMeta {
  label: string;
  icon: typeof AlignLeft;
}

/** 字形 = 方案 B「内容形态」（2026-10-31 用户选定，去文件框直接画内容）：
 * 文本=文字行 链接=链环 路径=路线 图片=相机 文件=单纸 文件夹=闭夹；
 * 全部候选对照见 design/clip-iconsets-preview.html */
export function clipKindMeta(kind: string): ClipKindMeta {
  switch (kind) {
    case "image":
      return { label: "图片", icon: Camera };
    case "files":
      return { label: "文件", icon: File };
    case "dirs":
      return { label: "文件夹", icon: FolderClosed };
    case "link":
      return { label: "链接", icon: Link2 };
    case "path":
      return { label: "路径", icon: Route };
    default:
      return { label: "文本", icon: AlignLeft };
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

/** 数字取条键判定（T2-3）：Alt+1-9 任意时刻生效；裸 1-9 仅在需回传
 * hasFocus=false（搜索框未聚焦）时生效（聚焦时是搜索字符）。
 * 返回 0 基下标；非取条键返回 null */
export function pickDigit(
  e: { code: string; altKey: boolean },
  inputFocused: boolean,
): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (!m) return null;
  if (inputFocused && !e.altKey) return null;
  return Number(m[1]) - 1;
}
