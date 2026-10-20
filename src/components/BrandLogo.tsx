// 品牌标：九宫格对角渐变（与应用/任务栏图标同源，资产由 tools/gen-logo-icon.mjs 生成）
// 顶栏与「关于」浮窗共用，尺寸经 size prop 控制（svg 定长，无裸色值——渐变即品牌色）。
import { useId } from "react";

export function BrandLogo({ size = 22 }: { size?: number }) {
  // 渐变 id 按实例唯一：顶栏与浮窗同屏渲染时 DOM 不出现重复 id
  const gradId = `xd-logo-${useId()}`;
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true">
      <defs>
        <linearGradient
          id={gradId}
          x1="4"
          y1="4"
          x2="94"
          y2="94"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#3574f0" />
          <stop offset="0.5" stopColor="#5c9dff" />
          <stop offset="1" stopColor="#bae2fd" />
        </linearGradient>
      </defs>
      {[4, 36, 68].flatMap((x) =>
        [4, 36, 68].map((y) => (
          <rect
            key={`${x}.${y}`}
            x={x}
            y={y}
            width={26}
            height={26}
            fill={`url(#${gradId})`}
          />
        )),
      )}
    </svg>
  );
}
