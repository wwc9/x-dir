// 快速预览状态（Quick Look 模型）：Space 唤起浮层，↑/↓ 在队列内循环切换，
// 队列 = 唤起时活动窗格列表中的全部文件。选中态同步由 keyboard.ts 完成。
// 单文件生命周期纪律（铁律 2/3）：同一时刻只渲染队列中的一条，关闭即清队列释放引用。

import { create } from "zustand";


import type { FileEntry } from "../lib/ipc";

interface PreviewStore {
  queue: FileEntry[];
  index: number;
  /** 预览是否打开（queue 非空即视为打开） */
  openPreview(queue: FileEntry[], index: number): void;
  close(): void;
  /** 循环切换（Quick Look 惯例：到尾回头） */
  next(): void;
  prev(): void;
  goto(i: number): void;
  current(): FileEntry | null;
}

function wrap(i: number, n: number): number {
  return n <= 0 ? 0 : ((i % n) + n) % n;
}

/** Space 唤起时的起始下标（纯函数）：选中集合中第一个命中队列的条目（按路径匹配，
 *  搜索结果跨目录同名时路径才唯一）；无命中回落 0 */
export function pickStartIndex(files: FileEntry[], selectedPaths: string[]): number {
  if (!selectedPaths.length) return 0;
  const sel = new Set(selectedPaths);
  const i = files.findIndex((f) => sel.has(f.path));
  return i >= 0 ? i : 0;
}

export const usePreview = create<PreviewStore>()((set, get) => ({
  queue: [],
  index: 0,

  openPreview(queue, index) {
    if (!queue.length) return;
    // 搜索视角与选中集保持原样（预览不打断搜索结果）；与搜索浮层的压叠由
    // .bp6-overlay 层级解决（浮层盖住搜索框），不走收起搜索（2026-10-17 二次定案）
    set({ queue, index: wrap(index, queue.length) });
  },

  close() {
    set({ queue: [], index: 0 });
  },

  next() {
    const { queue, index } = get();
    if (queue.length) set({ index: wrap(index + 1, queue.length) });
  },

  prev() {
    const { queue, index } = get();
    if (queue.length) set({ index: wrap(index - 1, queue.length) });
  },

  goto(i) {
    const { queue } = get();
    if (queue.length) set({ index: wrap(i, queue.length) });
  },

  current() {
    const { queue, index } = get();
    return queue[index] ?? null;
  },
}));
