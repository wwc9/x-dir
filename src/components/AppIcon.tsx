// 图标统一入口（AGENTS.md §4.5）：全项目只允许经此组件渲染 Lucide 图标，
// 颜色走 --np-* token；禁止再引入其他图标库或手绘 SVG。
// 尺寸四档（DENSITY.icon*）：默认 sm（按钮内图标），调用点禁写裸数字。
import type { LucideIcon } from "lucide-react";

import { DENSITY } from "../lib/tokens";

export function AppIcon({
  icon: I,
  size = DENSITY.iconSm,
  colorVar,
  strokeWidth = 2,
  className,
}: {
  icon: LucideIcon;
  size?: number;
  /** index.css 的 --np-* 颜色变量名（不含 var() 包装）；缺省继承 currentColor */
  colorVar?: string;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <I
      size={size}
      strokeWidth={strokeWidth}
      color={colorVar ? `var(${colorVar})` : undefined}
      className={className}
      aria-hidden
    />
  );
}

/** Blueprint 控件的 icon 属性（接受 ReactNode）专用快捷封装 */
export function ic(I: LucideIcon, size: number = DENSITY.iconSm) {
  return <AppIcon icon={I} size={size} />;
}
