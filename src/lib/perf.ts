// 性能模式（2026-11-17 新设置页定案）：硬件档位判定纯函数 + 高/低两档预设
// 与对比表数据。判定只在首启做一次（结果缓存 settings.perfTier），组件层
// 只消费；模式解析规则 = perfMode 为 auto 时取判定档，否则取显式档。
import type { Settings, SystemInfo } from "./ipc";

export type PerfMode = "auto" | "high" | "low";
export type PerfTier = "high" | "low";

/** 独显关键词：命中任一 = 存在独立显卡（NVIDIA 全系 / AMD RX·Pro / Intel Arc） */
const DISCRETE_GPU = /(nvidia|geforce|rtx|gtx|radeon\s+(rx|pro)|arc)/i;
/** 核显关键词：Intel 核显 / AMD 标称版 Radeon（带 (TM) 的都是处理器附带） */
const INTEGRATED_GPU = /(uhd|iris|hd graphics|radeon\(tm\))/i;

/** 仅核显（或检不出）：DXGI 软件渲染器已在 Rust 端滤除，空表 = 保守按低配 */
export function integratedOnly(gpus: string[]): boolean {
  if (!gpus.length) return true;
  return !gpus.some((g) => DISCRETE_GPU.test(g) && !INTEGRATED_GPU.test(g));
}

/** 档位判定：远程会话一票低配；否则硬件信号（线程 <4 / 内存 ≤8G / 仅核显）
 *  命中 ≥2 条 = 低配。cpuThreads 0（不可得）不参与计数 */
export function detectTier(
  info: Pick<SystemInfo, "cpuThreads" | "memoryGb" | "gpus">,
  remoteSession: boolean,
): PerfTier {
  if (remoteSession) return "low";
  let hits = 0;
  if (info.cpuThreads > 0 && info.cpuThreads < 4) hits++;
  if (info.memoryGb > 0 && info.memoryGb <= 8) hits++;
  if (integratedOnly(info.gpus)) hits++;
  return hits >= 2 ? "low" : "high";
}

/** 模式解析：auto 取判定档，否则显式档 */
export function resolvePerf(mode: PerfMode, tier: PerfTier): PerfTier {
  return mode === "auto" ? tier : mode;
}

/** 两档预设（写入对应设置项；高性能 = 出厂默认值）。
 *  剪贴板历史常驻浮窗是第二个 WebView 进程，弱机内存开销显著；
 *  窗口毛玻璃属全窗模糊合成开销，低配强制关。
 *  2026-11-18 用户定案「点击档位切换相应设置项」：两档对称切换——
 *  高性能 = 毛玻璃开（背景图案为用户审美选择不重置），低性能 = 毛玻璃关 */
export const PERF_PRESET: Record<PerfTier, Partial<Settings>> = {
  high: {
    showFolderSize: true,
    shotCrosshair: true,
    realIcons: true,
    cliphistEnabled: true,
    fxGlass: true,
    fxAnim: true,
    windowGlass: "on",
  },
  low: {
    showFolderSize: false,
    shotCrosshair: false,
    realIcons: false,
    cliphistEnabled: false,
    fxGlass: false,
    fxAnim: false,
    windowGlass: "off",
  },
};

/** 性能页对比表（两模式差异；全部会随 Seg 切换真实写盘） */
export const PERF_TABLE: { label: string; high: string; low: string }[] = [
  {
    label: "真实图标",
    high: "显示文件类型的系统真实图标",
    low: "关，回退线条图标",
  },
  {
    label: "文件夹大小",
    high: "显示（后台递归计算，异步补齐）",
    low: "关（大小列留空，省 IO）",
  },
  {
    label: "截图十字辅助线",
    high: "开（截图选取时显示）",
    low: "关（少一层全屏覆盖层重绘）",
  },
  {
    label: "剪贴板历史",
    high: "开（后台监听 + 常驻浮窗）",
    low: "关（省内存与后台开销）",
  },
  {
    label: "右键菜单毛玻璃",
    high: "开（「霜」玻璃质感）",
    low: "关（实底，弱 GPU / 远程更流畅）",
  },
  {
    label: "主题与浮层动画",
    high: "开（圆形揭示 / 进场过渡）",
    low: "关（直切，不重绘）",
  },
  {
    label: "窗口毛玻璃",
    high: "开（背景图案可在设置 → 外观更换）",
    low: "关（省一层模糊合成）",
  },
];
