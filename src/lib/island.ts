// 灵动岛（顶栏中央动态信息位）仲裁状态机：纯函数 + 单测，组件层只做渲染。
// 通道优先级（高 → 低）：任务 > 瞬时模式（交换窗格）> 全盘搜索 > 事件回执 >
// 剪贴板持有 > 默认路径（活动窗格位置——空闲态不制造动态，路径即答案）。
// 回执过期由 store 剪枝，以 now 参数注入，无内部时钟，保证可测且渲染确定。
import type { JobInfo, JobMode } from "../stores/jobs";

/** 任务类别标签（灵动岛与任务面板共用单源；图标在 components/JobList.MODE_ICONS） */
export const JOB_LABELS: Record<JobMode, string> = {
  copy: "复制",
  move: "移动",
  delete: "删除",
  pdfmerge: "PDF 合并",
  pdfsplit: "PDF 拆分",
  pdfwatermark: "PDF 水印",
  pdfextract: "PDF 提取页",
  pdfremove: "PDF 删除页",
  pdfrotate: "PDF 旋转",
  pdfcompress: "PDF 压缩",
  imgtopdf: "图片转 PDF",
  officetopdf: "文档转 PDF",
  cleanmeta: "隐私清理",
  officetotext: "导出文本",
  convertenc: "编码转换",
  mergecsv: "表格合并",
  mergetexts: "文本合并",
  zip: "压缩",
  extract: "解压",
  imgcompress: "图片压缩",
  imgwatermark: "图片水印",
  imgconvert: "格式转换",
  imgresize: "尺寸调整",
  imgmontage: "宫格拼图",
};

/** 任务引擎摘要（灵动岛迷你态）：最新任务在前，计数/暂停态聚合 */
export interface IslandJobSummary {
  /** running + queued 总数 */
  count: number;
  label: string;
  /** 最新任务进度；排队/不确定态为 null */
  percent: number | null;
  /** 正在处理的文件名（空 = 准备中） */
  current: string;
  anyQueued: boolean;
  anyPaused: boolean;
}

/** 任务整体进度：优先按字节，无字节总量按文件数；两者皆无 = 不确定态 */
function jobFraction(j: JobInfo): number | null {
  if (j.totalBytes > 0) return j.doneBytes / j.totalBytes;
  if (j.totalFiles > 0) return j.doneFiles / j.totalFiles;
  return null;
}

/** 从任务引擎派生岛屿摘要：head 取最新任务（order 末位，与任务面板一致） */
export function summarizeJobs(
  jobs: Record<number, JobInfo>,
  order: number[],
): IslandJobSummary | null {
  if (!order.length) return null;
  const list = order.map((id) => jobs[id]).filter(Boolean);
  if (!list.length) return null;
  const head = list[list.length - 1];
  return {
    count: list.length,
    label: JOB_LABELS[head.mode] ?? "任务",
    // 排队是独立状态（无百分比语义）；不确定态（无字节/文件总量）同样为 null
    percent: head.phase === "queued" ? null : jobFraction(head),
    current: head.currentPath ? head.currentPath.split(/[\\/]/).pop() ?? "" : "",
    anyQueued: list.some((j) => j.phase === "queued"),
    anyPaused: list.some((j) => j.phase === "paused"),
  };
}

/** 事件回执：完成/失败/取消/恢复等一次性播报，到期由 store 剪枝 */
export interface IslandReceipt {
  id: string;
  tone: "ok" | "fail" | "info";
  text: string;
  /** 到期时间戳（resolve 时过期即丢弃） */
  until: number;
}

/** 灵动岛当前应显示的通道视图 */
export type IslandView =
  | { kind: "job"; job: IslandJobSummary }
  | { kind: "swap" }
  | { kind: "gsearch"; matched: number }
  | { kind: "receipt"; receipt: IslandReceipt }
  | { kind: "clipboard"; count: number; cut: boolean }
  | { kind: "path"; path: string; selected: number };

export interface IslandInput {
  now: number;
  job: IslandJobSummary | null;
  /** 交换窗格选择模式进行中 */
  swap: boolean;
  /** 全盘搜索流进行中的命中数；null = 无搜索 */
  gsearch: number | null;
  receipts: IslandReceipt[];
  clip: { count: number; cut: boolean } | null;
  path: string;
  /** 活动窗格选中项数（默认路径态后缀） */
  selected: number;
}

/** 仲裁：同一时刻只显示一个通道，按头部注释的优先级取第一个命中 */
export function resolveIsland(input: IslandInput): IslandView {
  if (input.job) return { kind: "job", job: input.job };
  if (input.swap) return { kind: "swap" };
  if (input.gsearch !== null) return { kind: "gsearch", matched: input.gsearch };
  // 回执取最新一条未过期的（push 顺序即新旧，末位最新）
  for (let i = input.receipts.length - 1; i >= 0; i--) {
    if (input.receipts[i].until > input.now) {
      return { kind: "receipt", receipt: input.receipts[i] };
    }
  }
  if (input.clip) return { kind: "clipboard", count: input.clip.count, cut: input.clip.cut };
  return { kind: "path", path: input.path, selected: input.selected };
}
