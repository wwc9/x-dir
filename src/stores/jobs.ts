import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { api, type FailReason } from "../lib/ipc";
import { t } from "../lib/i18n";
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
  /** 删除任务的 permanent 标志（Shift+Del）：解除占用重试需按原语义重删 */
  deletePermanent: boolean;
  /** 注册时刻（ETA 外推基准，lib/jobsEta；缺省 = 不估算） */
  startedAt?: number;
  /** 删除任务的原始路径清单（2026-11-25 回执「撤销」动作：按原路径精确
   *  还原回收站条目，独立于撤销栈顶不受期间其他操作影响）；仅删除任务携带 */
  paths?: string[];
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
  | "pdfinsertblank"
  | "pdfencrypt"
  | "pdfdecrypt"
  | "pdftopng"
  | "officetopdf"
  | "cleanmeta"
  | "officetotext"
  | "convertenc"
  | "converteol"
  | "split"
  | "combine"
  | "mergecsv"
  | "mergetexts"
  | "mergexlsx"
  | "xlsxsplits"
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

/** Rust JobDone 镜像（同上；reason = 删除失败的结构化归因，可缺省）。
 *  items = 传输类（copy/move）成功项的精确路径对（2026-11-06 撤销精确化）：
 *  from 源原路径 / to 实际落点（rename 策略含 "(2)" 后缀）；native 分支与
 *  其他任务类型不下发（undefined）——撤销栈据此跳过入栈防误删 */
interface JobDonePayload {
  jobId: number;
  ok: boolean;
  cancelled: boolean;
  failed: { path: string; message: string; reason?: FailReason }[];
  items?: { from: string; to: string }[];
  /** 终态附注（解压非法条目跳过数等） */
  note?: string;
}

interface JobsStore {
  jobs: Record<number, JobInfo>;
  order: number[];
  /** 任务面板列表展开（灵动岛 pill 与其下方任务面板共用同一开关） */
  expanded: boolean;
  /** 会话级失败项清单（2026-11-27 审查修复：此前失败只 toast 首条、failed
   *  数组即丢——批量失败时无法定位其余失败项）。上限 500 条，新的顶前 */
  failures: { mode: JobMode; path: string; message: string; reason?: string }[];
  clearFailures(): void;
  toggleExpanded(): void;
  init(): Promise<() => void>;
  /** onDone：任务终态回调（ok/cancelled/items/failed），撤销栈用它在任务成功
   *  后入栈（items = 传输成功项路径对，非传输任务为 undefined）；failed =
   *  失败清单（解压密码重试据 reason === "password" 弹框，2026-11-08） */
  register(
    jobId: number,
    mode: JobMode,
    destDir: string | null,
    sourceParents: string[],
    onDone?: (d: {
      ok: boolean;
      cancelled: boolean;
      items?: { from: string; to: string }[];
      failed?: { path: string; message: string; reason?: string }[];
    }) => void,
    deletePermanent?: boolean,
    paths?: string[],
  ): void;
  /** 前端驱动任务（2026-11-11 PDF 转图片等渲染在渲染层的批量活）：负数
   *  jobId 与 Rust u32 永不冲突，进度由发起方经 updateLocal 推进，island/
   *  任务面板共用同一 JobInfo 形态；返回负数 id */
  registerLocal(mode: JobMode, destDir: string | null, sourceParents: string[]): number;
  /** 前端驱动任务进度推进（doneFiles/currentPath 等，仅本地 id 生效） */
  updateLocal(jobId: number, patch: Partial<JobInfo>): void;
  /** 前端驱动任务是否被请求取消（JobList 取消钮 → cancel 对负数 id 走此处） */
  isLocalCancelled(jobId: number): boolean;
  /** 前端驱动任务收尾：出列 + 脏目录刷新 + island 回执（ok=false 时 toast 首错） */
  finishLocal(
    jobId: number,
    ok: boolean,
    opts?: { note?: string; failed?: { path: string; message: string }[]; cancelled?: boolean },
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
  failures: [],

  clearFailures() {
    set({ failures: [] });
  },

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
        hook({ ok: d.ok, cancelled: d.cancelled, items: d.items, failed: d.failed });
      }
      let info = get().jobs[d.jobId];
      set((s) => {
        const jobs = { ...s.jobs };
        const order = s.order.filter((id) => id !== d.jobId);
        delete jobs[d.jobId];
        return { jobs, order };
      });
      // 取消优先判定（2026-11-28 二轮：cancelled + failed=[] 此前落进成功
      // 分支播「复制/移动/删除完成」，运行中点取消/排队取消/native 用户取消
      // 三条路径全部误报完成；且完成回执带「撤销」钮会按全量 paths 还原，
      // 半程取消时对未删除项报「已不在回收站」）
      if (d.cancelled) {
        useIsland.getState().pushReceipt("info", t("任务已取消"));
      } else if (d.failed?.length) {
        {
          // 失败清单留存（会话级，上限 500）：失败回执/对话框可回看全部
          // 失败项——此前只 toast 首条，批量失败无法定位其余（2026-11-27 修复）
          set((s) => ({
            failures: [
              ...d.failed!.map((f) => ({
                mode: (info?.mode ?? "copy") as JobMode,
                path: f.path,
                message: f.message,
                reason: f.reason,
              })),
              ...s.failures,
            ].slice(0, 500),
          }));
          useIsland.getState().pushReceipt("fail", t("{n} 项操作失败", { n: d.failed!.length }), {
            action: {
              label: t("查看详情"),
              run: () => {
                void import("./ui").then(({ useUi }) => {
                  useUi.getState().openDialog({ type: "jobFailures" });
                });
              },
            },
          });
          import("./ui").then(({ useUi }) => {
            // 带上首个失败项的文件名与原因，假失败/真失败都能一眼定位
            const first = d.failed![0];
            const name = first.path.split(/[\\/]/).pop() ?? first.path;
            const more = d.failed!.length > 1 ? ` 等 ${d.failed!.length} 项` : "";
            useUi.getState().toast(
              `${t("{n} 项操作失败", { n: d.failed!.length })}：${name}${more}（${first.message}）`,
              "error",
            );
          });
          // 删除任务失败含占用项 → 弹「解除占用」跟进（主路径：done 晚于
          // register 到达；此前只在 register 的 done 先到补漏路径弹过，
          // 慢于 invoke 往返的删除（大文件夹）永远等不到弹窗）
          if (info?.mode === "delete") {
            offerUnlock(d.failed, info.deletePermanent);
          }
        }
      } else if (info) {
        // 成功回执：灵动岛轻播报；解压/压缩附「打开」目标目录动作与附注，
        // 回收站删除附「撤销」动作（2026-11-25 用户需求）
        const label = `${t(JOB_LABELS[info.mode] ?? "任务")}${t("完成")}${d.note ? ` · ${d.note}` : ""}`;
        useIsland.getState().pushReceipt("ok", label, doneReceiptAction(info));
      }
      // 极快完成的任务：done 事件可能先于 invoke 返回的 jobId（register 尚未执行）。
      // 暂存等待 register；超时仍未等到（高负载下 invoke 可远超原 120ms 窗口）
      // 则按任务已终态收尾——直接从列表清除并刷新受影响目录，杜绝僵尸条目
      //（2026-11-01 审查修复：旧 120ms 定时器只做 bumpAffected，register 更
      // 晚到达时 lateDone 已被删，任务挂进列表后永远等不到第二次 job-done）
      if (!info) {
        lateDone.set(d.jobId, d);
        window.setTimeout(() => {
          const late = lateDone.get(d.jobId);
          if (!late) return; // register 已先行收尾
          lateDone.delete(d.jobId);
          const reg = get().jobs[d.jobId];
          if (!reg) return; // register 从未到达（无从知道受影响目录）——留待后端无补
          bumpAffectedOf(reg);
          set((s) => ({
            jobs: Object.fromEntries(
              Object.entries(s.jobs).filter(([id]) => Number(id) !== d.jobId),
            ),
            order: s.order.filter((id) => id !== d.jobId),
          }));
        }, 1000);
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

  register(jobId, mode, destDir, sourceParents, onDone, deletePermanent = false, paths?: string[]) {
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
            deletePermanent,
            startedAt: Date.now(),
            ...(paths ? { paths } : {}),
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
        hook({ ok: d.ok, cancelled: d.cancelled, items: d.items, failed: d.failed });
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
        // done 先于 register 的失败回执分支同样要给「解除占用」机会
        if (!d.cancelled && d.failed?.length && info.mode === "delete") {
          offerUnlock(d.failed, info.deletePermanent);
        }
        // 失败/取消回执已在 job-done 监听器播过；这里只补漏掉的成功回执
        if (!d.cancelled && !d.failed?.length) {
          useIsland.getState().pushReceipt(
            "ok",
            `${t(JOB_LABELS[info.mode] ?? "任务")}${t("完成")}${d.note ? ` · ${d.note}` : ""}`,
            doneReceiptAction(info),
          );
        }
      }
    }
  },

  cancel(jobId) {
    if (jobId < 0) {
      localCancelled.add(jobId);
      return;
    }
    api.cancelJob(jobId).catch(() => undefined);
  },

  registerLocal(mode, destDir, sourceParents) {
    const jobId = --localSeq;
    set((s) => ({
      jobs: {
        ...s.jobs,
        [jobId]: {
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
          deletePermanent: false,
          startedAt: Date.now(),
        } satisfies JobInfo,
      },
      order: [...s.order, jobId],
    }));
    return jobId;
  },

  updateLocal(jobId, patch) {
    if (jobId >= 0 || !get().jobs[jobId]) return;
    set((s) => ({
      jobs: { ...s.jobs, [jobId]: { ...s.jobs[jobId], ...patch } },
    }));
  },

  isLocalCancelled(jobId) {
    return localCancelled.has(jobId);
  },

  finishLocal(jobId, ok, opts) {
    const info = get().jobs[jobId];
    if (jobId >= 0 || !info) return;
    localCancelled.delete(jobId);
    set((s) => ({
      jobs: Object.fromEntries(
        Object.entries(s.jobs).filter(([id]) => Number(id) !== jobId),
      ),
      order: s.order.filter((id) => id !== jobId),
    }));
    bumpAffectedOf(info);
    const label = t(JOB_LABELS[info.mode] ?? "任务");
    if (opts?.cancelled) {
      useIsland.getState().pushReceipt("info", `${label}${t("已取消")}`);
    } else if (ok) {
      useIsland.getState().pushReceipt("ok", `${label}${t("完成")}${opts?.note ? ` · ${opts.note}` : ""}`);
    } else {
      if (opts?.failed?.length) {
        set((s1) => ({
          failures: [
            ...opts.failed!.map((f) => ({
              mode: info.mode,
              path: f.path,
              message: f.message,
            })),
            ...s1.failures,
          ].slice(0, 500),
        }));
      }
      useIsland.getState().pushReceipt("fail", `${label}${t("失败")}`, {
        action: {
          label: t("查看详情"),
          run: () => {
            void import("./ui").then(({ useUi }) => {
              useUi.getState().openDialog({ type: "jobFailures" });
            });
          },
        },
      });
      const first = opts?.failed?.[0];
      if (first) {
        import("./ui").then(({ useUi }) => {
          const name = first.path.split(/[\\/]/).pop() ?? first.path;
          const more = (opts?.failed?.length ?? 0) > 1 ? ` 等 ${opts?.failed?.length} 项` : "";
          useUi.getState().toast(`${label}${t("失败")}：${name}${more}（${first.message}）`, "error");
        });
      }
    }
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

/** 任务成功回执的动作钮（2026-11-25 扩展）：解压/压缩 = 「打开」目标目录；
 *  回收站删除 = 「撤销」——按原路径精确还原（restore_trash 按原路径匹配回收
 *  站现存条目），独立于撤销栈顶、不受期间其他操作影响；永久删除不可逆不给钮 */
function doneReceiptAction(info: JobInfo): {
  action: { label: string; run: () => void };
} | undefined {
  const dir = info.destDir;
  if (dir && (info.mode === "extract" || info.mode === "zip")) {
    return { action: { label: t("打开"), run: () => void api.openItem(dir) } };
  }
  if (info.mode === "delete" && !info.deletePermanent && info.paths?.length) {
    return { action: { label: t("撤销"), run: () => void undoDelete(info.paths!) } };
  }
  return undefined;
}

/** 删除回执「撤销」：还原 + 灵动岛人话回执（含回收站已清空的部分计数） */
function undoDelete(paths: string[]) {
  void api
    .restoreFromTrash(paths)
    .then((r) => {
      void import("./ui").then(({ useUi }) => {
        useUi
          .getState()
          .toast(
            r.missing
              ? t("已还原 {n} 项 · {m} 项已不在回收站", { n: r.restored, m: r.missing })
              : t("已还原 {n} 项", { n: r.restored }),
            "info",
          );
      });
    })
    .catch((e) => {
      void import("./ui").then(({ useUi }) => {
        useUi.getState().toast(t("还原失败：{e}", { e: String(e) }), "error");
      });
    });
}

/** 删除失败含「正被占用」项 → 弹「解除占用」对话框（关句柄后可重删）。
 *  由 job-done 收尾调用（含 done 先于 register 的补漏路径） */
function offerUnlock(failed: JobDonePayload["failed"], permanent: boolean) {
  const inUse = failed.filter((f) => f.reason === "inUse");
  if (!inUse.length) return;
  void import("./ui").then(({ useUi }) => {
    useUi.getState().openDialog({
      type: "unlock",
      items: inUse.map((f) => f.path),
      permanent,
    });
  });
}

/** done 事件先于 register 到达时的暂存（极快完成的小任务） */
const lateDone = new Map<number, JobDonePayload>();

/** 前端驱动任务（负数 id）的取消请求集 + id 发号器：渲染循环经
 *  isLocalCancelled 轮询退出；与 Rust u32 jobId 无冲突 */
const localCancelled = new Set<number>();
let localSeq = 0;

/** 任务终态钩子（撤销栈消费）：jobId → onDone，触发即删，保证只回调一次；
 *  items = 传输成功项路径对（非传输任务为 undefined）；failed = 失败清单 */
const doneHooks = new Map<
  number,
  (d: {
    ok: boolean;
    cancelled: boolean;
    items?: { from: string; to: string }[];
    failed?: { path: string; message: string; reason?: string }[];
  }) => void
>();

function bumpAffectedOf(info: JobInfo) {
  const dirs = [
    ...(info.destDir ? [info.destDir] : []),
    ...(info.sourceParents ?? []),
  ];
  if (dirs.length) usePanes.getState().bumpAffected(dirs, { immediate: true });
}
