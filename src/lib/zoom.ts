// 界面缩放步进（Ctrl +/-/0、Ctrl+滚轮共用）：标准档位表，非档位现值
// （如旧配置遗留）向最近的下一档靠拢。

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

const STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** 缩放档位表（设置下拉与步进共用；升序） */
export const ZOOM_STEPS: readonly number[] = STEPS;

/** dir=1 放大、-1 缩小；已在边界时保持不变 */
export function zoomStep(cur: number, dir: 1 | -1): number {
  if (dir === 1) {
    return STEPS.find((z) => z > cur + 1e-6) ?? STEPS[STEPS.length - 1];
  }
  return [...STEPS].reverse().find((z) => z < cur - 1e-6) ?? STEPS[0];
}

/** 钳制任意现值到允许区间（启动时兜底旧/坏配置） */
export function zoomClamp(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
}
