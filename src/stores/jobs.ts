import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { api } from "../lib/ipc";
import { JOB_LABELS } from "../lib/island";
import { useIsland } from "./island";
import { usePanes } from "./panes";

export interface JobInfo {
  jobId: number;
  mode: JobMode;
  phase: string;
  totalFiles: number;
  doneFiles: number;
  totalBytes: number;
  doneBytes: number;
  currentPath: string;
  destDir: string | null;
  sourceParents: string[];
}

/** 任务类别：copy/move/delete 引擎原生；pdf* = PDF 处理（lopdf）；
 *  officetopdf / cleanmeta / convertenc / mergecsv / mergetexts / zip = 办公批处理（2026-10-14） */
export type JobMode =
  | "copy"
  | "move"
  | "delete"
  | "pdfmerge"
  | "pdfsplit"
  | "pdfwatermark"
  | "pdfextract"
  | "pdfremove"
  | "pdfrotate"
  | "pdfcompress"
  | "imgtopdf"
  | "officetopdf"
  | "cleanmeta"
  | "officetotext"
  | "convertenc"
  | "mergecsv"
  | "mergetexts"
  | "mergexlsx"
  | "zip"
  | "extract"
  | "imgcompress"
  | "imgwatermark"
  | "imgconvert"
  | "imgresize"
  | "imgmontage";

/** Rust JobProgress 镜像（src-tauri/src/jobs/mod.rs，serde camelCase） */
interface JobProgressPayload {
  jobId: number;
  phase: string;
  totalFiles: number;
  doneFiles: number;
  totalBytes: number;
  doneBytes: number;
  currentPath: string;
}

/** Rust JobDone 镜像（同上） */
interface JobDonePayload {
  jobId: number;
  ok: boolean;
  cancelled: boolean;
  failed: { path: string; message: string }[];
}

interface JobsStore {
  jobs: Record<number, JobInfo>;
  order: number[];
  /** 任务卡列表展开（灵动岛 pill 与其下方任务面板共用同一开关） */
  expanded: boolean;
  toggleExpanded(): void;
  init(): Promise<() => void>;
  /** onDone：任务终态回调（ok/cancelled/failed），撤销栈用它在任务成功后入栈 */
  register(
    jobId: number,
    mode: JobMode,
    destDir: string | null,
    sourceParents: string[],
    onDone?: (d: { ok: boolean; cancelled: boolean }) => void,
  ): void;
  cancel(jobId: number): void;
  /** 暂停/恢复（仅 copy/move 任务响应；乐观切 phase，实际由后端 job-progress 确认） */
  pause(jobId: number): void;
  resume(jobId: number): void;
}

export const useJobs = create<JobsStore>()((set, get) => ({
  jobs: {},
  order: [],
  expanded: false,

  toggleExpanded() {
    set((s) => ({ expanded: !s.expanded }));
  },

  async init() {
    const l1 = await listen<JobProgressPayload>("job-progress", (e) => {
      const p = e.payload;
      set((s) => {
        const cur = s.jobs[p.jobId];
        if (!cur) return s;
        return {
          jobs: {
            ...s.jobs,
            [p.jobId]: {
              ...cur,
              phase: p.phase,
              totalFiles: p.totalFiles,
              doneFiles: p.doneFiles,
              totalBytes: p.totalBytes,
              doneBytes: p.doneBytes,
              currentPath: p.currentPath,
            },
          },
        };
      });
    });
    const l2 = await listen<JobDonePayload>("job-done", (e) => {
      const d = e.payload;
      // 终态钩子先于状态清理（撤销栈等消费方在任务成功后才入栈）
      const hook = doneHooks.get(d.jobId);
      if (hook) {
        doneHooks.delete(d.jobId);
        hook({ ok: d.ok, cancelled: d.cancelled });
      }
      let info = get().jobs[d.jobId];
      set((s) => {
        const jobs = { ...s.jobs };
        const order = s.order.filter((id) => id !== d.jobId);
        delete jobs[d.jobId];
        return { jobs, order };
      });
      if (d.failed?.length) {
        // 取消不算错误（§6.7：取消也是终态）
        if (!d.cancelled) {
          useIsland.getState().pushReceipt("fail", `${d.failed!.length} 项操作失败`);
          import("./ui").then(({ useUi }) => {
            // 带上首个失败项的文件名与原因，假失败/真失败都能一眼定位
            const first = d.failed![0];
            const name = first.path.split(/[\\/]/).pop() ?? first.path;
            const more = d.failed!.length > 1 ? ` 等 ${d.failed!.length} 项` : "";
            useUi.getState().toast(
              `${d.failed!.length} 项操作失败：${name}${more}（${first.message}）`,
              "error",
            );
          });
        } else {
          useIsland.getState().pushReceipt("info", "任务已取消");
        }
      } else if (info) {
        // 成功回执：灵动岛轻播报
        useIsland
          .getState()
          .pushReceipt("ok", `${JOB_LABELS[info.mode] ?? "任务"}完成`);
      }
      // 极快完成的任务：done 事件可能先于 invoke 返回的 jobId（register 尚未执行）。
      // 短暂暂存，等 register 落地后补一次受影响目录刷新
      if (!info) {
        lateDone.set(d.jobId, d);
        window.setTimeout(() => {
          const late = lateDone.get(d.jobId);
          lateDone.delete(d.jobId);
          const reg = late && get().jobs[d.jobId];
          if (reg) bumpAffectedOf(reg);
        }, 120);
        return;
      }
      bumpAffectedOf(info);
    });
    // 目录监控脏标记（§6.8）：对应路径的可见窗格自动重拉
    const l3 = await listen<{ path: string }>("dir-changed", (e) => {
      usePanes.getState().bumpAffected([e.payload.path]);
    });
    return () => {
      l1();
      l2();
      l3();
    };
  },

  register(jobId, mode, destDir, sourceParents, onDone) {
    if (onDone) doneHooks.set(jobId, onDone);
    set((s) => ({
      jobs: {
        ...s.jobs,
        [jobId]:
          s.jobs[jobId] ??
          ({
            jobId,
            mode,
            phase: "running",
            totalFiles: 0,
            doneFiles: 0,
            totalBytes: 0,
            doneBytes: 0,
            currentPath: "",
            destDir,
            sourceParents,
          } satisfies JobInfo),
      },
      order: s.order.includes(jobId) ? s.order : [...s.order, jobId],
    }));
    // done 先于 register 到达的收尾（极快任务）：任务实际已终态，落袋即除——
    // 否则 register 会把一个早已结束的任务挂进列表成为僵尸条目（永远无法关闭）
    const d = lateDone.get(jobId);
    if (d) {
      lateDone.delete(jobId);
      const hook = doneHooks.get(jobId);
      if (hook) {
        doneHooks.delete(jobId);
        hook({ ok: d.ok, cancelled: d.cancelled });
      }
      const info = get().jobs[jobId];
      if (info) {
        bumpAffectedOf(info);
        set((s) => ({
          jobs: Object.fromEntries(
            Object.entries(s.jobs).filter(([id]) => Number(id) !== jobId),
          ),
          order: s.order.filter((id) => id !== jobId),
        }));
        // 失败/取消回执已在 job-done 监听器播过；这里只补漏掉的成功回执
        if (!d.cancelled && !d.failed?.length) {
          useIsland
            .getState()
            .pushReceipt("ok", `${JOB_LABELS[info.mode] ?? "任务"}完成`);
        }
      }
    }
  },

  cancel(jobId) {
    api.cancelJob(jobId).catch(() => undefined);
  },

  pause(jobId) {
    set((s) => {
      const cur = s.jobs[jobId];
      if (!cur || (cur.mode !== "copy" && cur.mode !== "move")) return s;
      return { jobs: { ...s.jobs, [jobId]: { ...cur, phase: "paused" } } };
    });
    api.pauseJob(jobId).catch(() => undefined);
  },

  resume(jobId) {
    set((s) => {
      const cur = s.jobs[jobId];
      if (!cur || cur.phase !== "paused") return s;
      return { jobs: { ...s.jobs, [jobId]: { ...cur, phase: "running" } } };
    });
    api.resumeJob(jobId).catch(() => undefined);
  },
}));

/** done 事件先于 register 到达时的暂存（极快完成的小任务） */
const lateDone = new Map<number, JobDonePayload>();

/** 任务终态钩子（撤销栈消费）：jobId → onDone，触发即删，保证只回调一次 */
const doneHooks = new Map<number, (d: { ok: boolean; cancelled: boolean }) => void>();

function bumpAffectedOf(info: JobInfo) {
  const dirs = [
    ...(info.destDir ? [info.destDir] : []),
    ...(info.sourceParents ?? []),
  ];
  if (dirs.length) usePanes.getState().bumpAffected(dirs);
}
