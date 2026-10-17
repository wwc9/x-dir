// 撤销/重做栈（Ctrl+Z / Ctrl+Y 或 Ctrl+Shift+Z）：只收可逆操作——删除到回收站
// （还原）、重命名（改回）、应用内移动（移回）、新建文件夹（移入回收站，可再还原）。
// 栈式 LIFO，全局一份（TC 惯例）；永久删除/复制/粘贴不入栈（不可逆或幂等）。
// 重做 = 把撤销弹出的条目按"原方向"再执行一遍并压回撤销栈；新操作入栈即清空重做。
import { create } from "zustand";

import { api } from "./ipc";
import { fileNameOf, joinPath, parentPath } from "./path";
import { usePanes } from "../stores/panes";
import { useUi } from "../stores/ui";
import { useJobs } from "../stores/jobs";

export type UndoEntry =
  | { kind: "rename"; from: string; to: string }
  | { kind: "trash"; paths: string[] }
  | { kind: "move"; sources: string[]; destDir: string }
  | { kind: "newfolder"; path: string };

const MAX_STACK = 50;

interface UndoStore {
  stack: UndoEntry[];
  redoStack: UndoEntry[];
  /** 最近一次撤销的描述（toast 用），无待撤销为 null */
  peekLabel(): string | null;
  /** 最近一次重做的描述（原方向语义），无待重做为 null */
  peekRedoLabel(): string | null;
  push(e: UndoEntry): void;
  clear(): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/** 条目的一句话描述（peekLabel 逆操作语义 / peekRedoLabel 原方向语义共用）；
 *  重命名恒显示新名（撤销与重做描述的是同一次改名） */
function labelOf(e: UndoEntry): string {
  switch (e.kind) {
    case "rename":
      return `重命名 "${fileNameOf(e.to)}"`;
    case "trash":
      return e.paths.length === 1
        ? `删除 "${fileNameOf(e.paths[0])}"`
        : `删除 ${e.paths.length} 项`;
    case "move":
      return e.sources.length === 1
        ? `移动 "${fileNameOf(e.sources[0])}"`
        : `移动 ${e.sources.length} 项`;
    case "newfolder":
      return `新建 "${fileNameOf(e.path)}"`;
  }
}

export const useUndo = create<UndoStore>()((set, get) => ({
  stack: [],
  redoStack: [],

  peekLabel() {
    const top = get().stack[get().stack.length - 1];
    return top ? labelOf(top) : null;
  },

  peekRedoLabel() {
    const top = get().redoStack[get().redoStack.length - 1];
    return top ? labelOf(top) : null;
  },

  push(e) {
    set((s) => ({
      stack: [...s.stack, e].slice(-MAX_STACK),
      redoStack: [], // 新操作使重做分支失效（编辑器惯例）
    }));
  },

  clear() {
    set({ stack: [], redoStack: [] });
  },

  async undo() {
    const { stack } = get();
    const top = stack[stack.length - 1];
    if (!top) return;
    set({ stack: stack.slice(0, -1), redoStack: [...get().redoStack, top] });
    const label = get().peekLabel() ?? "";
    try {
      switch (top.kind) {
        case "rename": {
          await api.renameItem(top.to, fileNameOf(top.from));
          bump([parentPath(top.to), parentPath(top.from)]);
          useUi.getState().toast(`已撤销：${label || "重命名"}`);
          break;
        }
        case "trash": {
          const r = await api.restoreFromTrash(top.paths);
          bump(top.paths.map(parentPath));
          if (r.restored > 0) {
            useUi
              .getState()
              .toast(
                `已撤销：${label || "删除"}（从回收站恢复 ${r.restored} 项${
                  r.missing ? `，${r.missing} 项未找到` : ""
                }）`,
              );
          } else {
            useUi
              .getState()
              .toast("回收站中未找到可恢复项（可能已清空或任务未完成）", "error");
          }
          break;
        }
        case "move": {
          // 移回原父目录；同名冲突自动改名（撤销不弹冲突框）
          const byParent = new Map<string, string[]>();
          for (const s of top.sources) {
            const dest = joinPath(top.destDir, fileNameOf(s));
            const parent = parentPath(s);
            if (!parent) continue;
            byParent.set(parent, [...(byParent.get(parent) ?? []), dest]);
          }
          for (const [parent, paths] of byParent) {
            const { jobId } = await api.moveItems(paths, parent, "rename", false);
            useJobs.getState().register(jobId, "move", parent, paths.map(parentPath).filter((p): p is string => !!p));
          }
          bump([...byParent.keys(), top.destDir]);
          useUi.getState().toast(`已撤销：${label || "移动"}`);
          break;
        }
        case "newfolder": {
          // 移入回收站而非永久删除：误撤销仍可从回收站找回
          const { jobId } = await api.deleteItems([top.path], false);
          const parent = parentPath(top.path);
          useJobs.getState().register(jobId, "delete", null, parent ? [parent] : []);
          bump(parent ? [parent] : []);
          useUi.getState().toast(`已撤销：${label || "新建"}（已移入回收站）`);
          break;
        }
      }
    } catch (e) {
      useUi.getState().toast(`撤销失败：${String(e)}`, "error");
    }
  },

  /** 重做：按原方向再执行一遍（成功即压回撤销栈，撤销/重做可往复） */
  async redo() {
    const { redoStack } = get();
    const top = redoStack[redoStack.length - 1];
    if (!top) return;
    set({ redoStack: redoStack.slice(0, -1) });
    try {
      switch (top.kind) {
        case "rename": {
          await api.renameItem(top.from, fileNameOf(top.to));
          bump([parentPath(top.to), parentPath(top.from)]);
          get().push(top);
          useUi.getState().toast(`已重做：${labelOf(top)}`);
          break;
        }
        case "trash": {
          const { jobId } = await api.deleteItems(top.paths, false);
          const parents = top.paths.map(parentPath).filter((p): p is string => !!p);
          useJobs.getState().register(jobId, "delete", null, parents, ({ ok, cancelled }) => {
            if (ok && !cancelled) get().push(top);
          });
          bump(parents);
          break;
        }
        case "move": {
          const { jobId } = await api.moveItems(top.sources, top.destDir, "rename", false);
          const sourceParents = top.sources
            .map(parentPath)
            .filter((p): p is string => !!p);
          useJobs.getState().register(jobId, "move", top.destDir, sourceParents, ({ ok, cancelled }) => {
            if (ok && !cancelled) get().push(top);
          });
          bump([...sourceParents, top.destDir]);
          break;
        }
        case "newfolder": {
          const parent = parentPath(top.path);
          if (!parent) return;
          await api.createDir(parent, fileNameOf(top.path));
          get().push(top);
          bump([parent]);
          useUi.getState().toast(`已重做：${labelOf(top)}`);
          break;
        }
      }
    } catch (e) {
      useUi.getState().toast(`重做失败：${String(e)}`, "error");
    }
  },
}));

/** 撤销涉及的目录：让对应窗格立即重拉 */
function bump(dirs: (string | null)[]): void {
  const live = dirs.filter((d): d is string => !!d);
  if (live.length) usePanes.getState().bumpAffected(live);
}
