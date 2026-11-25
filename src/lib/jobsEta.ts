// 长任务剩余时间估算（2026-11-25 用户需求）：纯函数 + vitest。
// ETA = 已耗时 × (1-f) / f 的比例外推——无需速度状态，字节进度与文件数进度
// 通用（fraction 由调用方传入，与 JobList.fractionOf / island.jobFraction 同源）。
import { t } from "./i18n";

/** 进度比例 → 剩余秒数；不可估算返回 null：
 *  - 阶段非 running（排队/暂停不外推）
 *  - f ≤ 2%（早期分母不稳，抖动大）或 f ≥ 1（临近完成无需 ETA）
 *  - 启动不足 2s（样本太短）
 *  - 结果非有限/非正
 *  返回值向上取整到整秒（≥1）。 */
export function etaSeconds(
  startedAtMs: number | undefined,
  fraction: number | null,
  phase: string,
  nowMs: number,
): number | null {
  if (startedAtMs === undefined) return null;
  if (phase !== "running" || fraction === null) return null;
  if (fraction <= 0.02 || fraction >= 1) return null;
  const elapsed = (nowMs - startedAtMs) / 1000;
  if (elapsed < 2) return null;
  const eta = (elapsed * (1 - fraction)) / fraction;
  if (!Number.isFinite(eta) || eta <= 0) return null;
  return Math.max(1, Math.ceil(eta));
}

/** ETA 人话：< 60s = 「约 N 秒」；否则「约 N 分钟」（向上取整） */
export function etaText(sec: number): string {
  return sec < 60 ? t("约 {n} 秒", { n: sec }) : t("约 {n} 分钟", { n: Math.ceil(sec / 60) });
}
