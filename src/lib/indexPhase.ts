// 索引模式阶段推导纯函数：把 index_status 轮询回执（守护存活 + 已配置卷 + 各卷回执）
// 归约为「启动中 / 初建中 / 就绪 / 失败 / 离线」五阶段，驱动状态条 chip 与进度弹层。
// 纯函数（铁律：交互逻辑进 lib/ 并配单测），组件层只做状态持有。

import type { IndexStatus } from "./ipc";

/** 开启开关后等待守护拉起的宽限窗（UAC 授权 + 进程启动 + 首次心跳） */
export const INDEX_START_GRACE_MS = 15_000;

export type IndexVolState = "ready" | "building" | "error";

export interface IndexVolPhase {
  letter: string;
  state: IndexVolState;
  entries: number;
  error: string | null;
}

/** off=开关关 starting=等待守护拉起 building=有卷在建 ready=全部就绪 error=有卷失败 down=守护离线 */
export type IndexPhase = "off" | "starting" | "building" | "ready" | "error" | "down";

export interface IndexPhaseResult {
  phase: IndexPhase;
  vols: IndexVolPhase[];
  /** 就绪卷的条目总数（完成回执展示用） */
  totalEntries: number;
}

/**
 * 阶段归约：
 * - 开关关 → off
 * - 无回执（刚开开关/轮询未回）或守护未存活且在宽限窗内 → starting
 * - 守护未存活且超出宽限窗 → down（上次启动失败/已退出）
 * - 守护存活：逐卷判定——回执缺失/不新鲜 = building；error = error；fresh = ready。
 *   汇总取最差：error > building > ready。
 * - 已配置卷清单为空时回落 status.volumes 的键（守护未携 daemon.json 的兜底）。
 */
export function analyzeIndexPhase(
  status: IndexStatus | null,
  enabled: boolean,
  enabledAtMs: number | null,
  nowMs: number,
): IndexPhaseResult {
  if (!enabled) return { phase: "off", vols: [], totalEntries: 0 };
  const inGrace = enabledAtMs !== null && nowMs - enabledAtMs < INDEX_START_GRACE_MS;
  if (!status || !status.daemonAlive) {
    return { phase: inGrace ? "starting" : "down", vols: [], totalEntries: 0 };
  }
  const letters =
    status.configured.length > 0 ? status.configured : Object.keys(status.volumes);
  if (!letters.length) return { phase: "building", vols: [], totalEntries: 0 };
  const vols: IndexVolPhase[] = letters.map((letter) => {
    const v = status.volumes[letter];
    if (!v) {
      // 回执缺失（MFT 枚举中，守护尚未登记该卷）→ 初建中
      return { letter, state: "building", entries: 0, error: null };
    }
    if (v.error) return { letter, state: "error", entries: v.entries, error: v.error };
    if (!v.fresh) {
      // 刚启动尚未到首次同步（daemon 存活时 lastSync 每 0.5s 必刷新）→ 视作在建
      return { letter, state: "building", entries: v.entries, error: null };
    }
    return { letter, state: "ready", entries: v.entries, error: null };
  });
  const totalEntries = vols.reduce((n, v) => (v.state === "ready" ? n + v.entries : n), 0);
  const phase: IndexPhase = vols.some((v) => v.state === "error")
    ? "error"
    : vols.some((v) => v.state === "building")
      ? "building"
      : "ready";
  return { phase, vols, totalEntries };
}

/** 就绪卷清单一句话："C、D 共 1,234,567 项"（无就绪卷返回 null） */
export function readySummary(vols: IndexVolPhase[], totalEntries: number): string | null {
  const ready = vols.filter((v) => v.state === "ready");
  if (!ready.length) return null;
  return `${ready.map((v) => v.letter).join("、")} 共 ${totalEntries.toLocaleString()} 项`;
}

/** 失败卷清单一句话："C: 卷不可用"（无失败卷返回 null） */
export function errorSummary(vols: IndexVolPhase[]): string | null {
  const errs = vols.filter((v) => v.state === "error");
  if (!errs.length) return null;
  return errs.map((v) => `${v.letter}: ${v.error ?? "未知错误"}`).join(" · ");
}
