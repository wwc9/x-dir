// 任务卡列表（灵动岛展开面板，2026-10-15 从旧左下角 JobCenter 迁移）：
// 逐条任务 = 进度条 + 暂停/继续（仅 copy/move）+ 取消；展开开关在 stores/jobs
// （灵动岛 pill 与这里共享）。完成/失败经 toast + 灵动岛回执播报（stores/jobs）。
import { ProgressBar } from "@blueprintjs/core";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Eraser,
  FileDown,
  FileMinus,
  FileText,
  FileType,
  FolderInput,
  Grid3x3,
  Images,
  Merge,
  Minimize2,
  Pause,
  Play,
  Replace,
  RotateCw,
  Scaling,
  Scissors,
  Stamp,
  Table,
  TableProperties,
  Trash2,
  X,
} from "lucide-react";

import { JOB_LABELS } from "../lib/island";
import { fileNameOf } from "../lib/path";
import { DENSITY } from "../lib/tokens";
import { useJobs, type JobInfo, type JobMode } from "../stores/jobs";
import { AppIcon } from "./AppIcon";

/** 任务类别 → 图标（标签文字在 lib/island 的 JOB_LABELS 单源） */
const MODE_ICONS: Record<JobMode, typeof Copy> = {
  copy: Copy,
  move: FolderInput,
  delete: Trash2,
  pdfmerge: FileText,
  pdfsplit: Scissors,
  pdfwatermark: FileText,
  pdfextract: FileDown,
  pdfremove: FileMinus,
  pdfrotate: RotateCw,
  pdfcompress: Minimize2,
  imgtopdf: Images,
  officetopdf: FileText,
  cleanmeta: Eraser,
  officetotext: FileType,
  convertenc: Replace,
  mergecsv: Table,
  mergetexts: Merge,
  mergexlsx: TableProperties,
  zip: Archive,
  extract: ArchiveRestore,
  imgcompress: Minimize2,
  imgwatermark: Stamp,
  imgconvert: Replace,
  imgresize: Scaling,
  imgmontage: Grid3x3,
};

/** 任务整体进度：优先按字节，无字节总量按文件数；两者皆无 = 不确定态 */
function fractionOf(j: JobInfo): number | null {
  if (j.totalBytes > 0) return j.doneBytes / j.totalBytes;
  if (j.totalFiles > 0) return j.doneFiles / j.totalFiles;
  return null;
}

function percentText(j: JobInfo): string {
  // 排队/暂停是独立状态：覆盖百分比显示，让任务卡一眼可辨
  if (j.phase === "queued") return "排队中";
  if (j.phase === "paused") return "已暂停";
  const f = fractionOf(j);
  return f === null ? "…" : `${Math.min(100, Math.round(f * 100))}%`;
}

function JobRow({ job }: { job: JobInfo }) {
  const Icon = MODE_ICONS[job.mode];
  return (
    <div className="np-job-row">
      <span className="np-job-icon">
        <AppIcon icon={Icon} size={DENSITY.iconSm} />
      </span>
      <div className="np-job-main">
        <div className="np-job-line">
          <span className="np-job-label">{JOB_LABELS[job.mode]}</span>
          <span className="np-job-file np-ellipsis">
            {job.currentPath ? fileNameOf(job.currentPath) : "准备中…"}
          </span>
          <span className="np-job-pct">{percentText(job)}</span>
        </div>
        <ProgressBar
          className="np-job-bar"
          stripes={false}
          value={fractionOf(job) ?? undefined}
        />
      </div>
      {(job.mode === "copy" || job.mode === "move") && job.phase !== "queued" && (
        <button
          className="np-job-cancel"
          data-tip={job.phase === "paused" ? "继续任务" : "暂停任务"}
          onClick={() =>
            job.phase === "paused"
              ? useJobs.getState().resume(job.jobId)
              : useJobs.getState().pause(job.jobId)
          }
        >
          <AppIcon icon={job.phase === "paused" ? Play : Pause} size={DENSITY.iconXs} />
        </button>
      )}
      <button
        className="np-job-cancel"
        data-tip="取消任务"
        onClick={() => useJobs.getState().cancel(job.jobId)}
      >
        <AppIcon icon={X} size={DENSITY.iconXs} />
      </button>
    </div>
  );
}

/** 展开面板：有活动任务才渲染内容（调用方控制开合时机） */
export function JobList() {
  const order = useJobs((s) => s.order);
  const jobs = useJobs((s) => s.jobs);
  if (!order.length) return null;
  const list = order.map((id) => jobs[id]).filter(Boolean);
  return (
    <div className="np-joblist">
      {list.map((j) => (
        <JobRow key={j.jobId} job={j} />
      ))}
    </div>
  );
}
