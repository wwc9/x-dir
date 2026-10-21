// 表头列宽把手（FileList / GlobalSearch 共用）。拖拽生命周期挂在模块级，
// 不随窗格/弹窗组件卸载重建；宽度读写经 ctl 回调注入（两侧寄存不同的 settings 键）。
// 拖拽中只写内存（setLive），松手 commit 持久化，避免每帧写 settings.json。
import type { MouseEvent as ReactMouseEvent } from "react";

let colDragMoved = false;

/** 排序按钮 click 守卫：列宽拖拽结束后误触发的排序切换返回 true */
export function colDragClickGuard(): boolean {
  const moved = colDragMoved;
  colDragMoved = false;
  return moved;
}

export interface ColResizeCtl<T extends string> {
  getW(key: T): number;
  setLive(key: T, w: number): void;
  commit(): void;
  reset(key: T): void;
}

export function startColResize<T extends string>(
  e: ReactMouseEvent,
  key: T,
  ctl: ColResizeCtl<T>,
) {
  e.stopPropagation();
  e.preventDefault();
  const startX = e.clientX;
  const startW = ctl.getW(key);
  colDragMoved = false;
  const onMove = (ev: MouseEvent) => {
    const dx = ev.clientX - startX;
    if (Math.abs(dx) > 2) colDragMoved = true;
    ctl.setLive(key, startW + dx);
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.classList.remove("np-col-resizing");
    ctl.commit();
    // 拖完松手落在排序按钮上时，随后的 click 在守卫里被吃掉后再复位
    window.setTimeout(() => {
      colDragMoved = false;
    }, 0);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  document.body.classList.add("np-col-resizing");
}

export function ColGrip<T extends string>({ col, ctl }: { col: T; ctl: ColResizeCtl<T> }) {
  return (
    <span
      className="np-col-grip"
      data-tip="拖动调整列宽 · 双击恢复默认"
      onMouseDown={(e) => startColResize(e, col, ctl)}
      onDoubleClick={() => ctl.reset(col)}
    />
  );
}
