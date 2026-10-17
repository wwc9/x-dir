// V3 OLE 拖拽高亮状态：Rust IDropTarget::DragOver 推送的 CSS 坐标（已节流），
// FileList 订阅后与自身矩形判定是否显示落点高亮。

import { create } from "zustand";

interface DndStore {
  point: { x: number; y: number } | null;
  setPoint(p: { x: number; y: number } | null): void;
}

export const useDnd = create<DndStore>()((set) => ({
  point: null,
  setPoint(p) {
    set({ point: p });
  },
}));
