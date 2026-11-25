// 拖拽落点语义角标（2026-11-25 用户需求）：OLE 拖拽期间的修饰键跟踪。
// Chromium 的拖拽循环会把键盘事件转发给页面（Explorer 同款「拖拽中按 Ctrl
// 切复制」的 OS 级协商由 OLE 完成，这里只负责 UI 角标随按随切）；拖拽未激活
// （useDnd.point 为空）时恒 false 并摘除监听。
import { useEffect, useState } from "react";

import { useDnd } from "../stores/dnd";

/** 拖拽进行中时跟踪 Ctrl 按住态（keydown/keyup 捕获阶段同步 e.ctrlKey） */
export function useDragCtrl(): boolean {
  const active = useDnd((s) => s.point !== null);
  const [ctrl, setCtrl] = useState(false);
  useEffect(() => {
    if (!active) {
      setCtrl(false);
      return;
    }
    const sync = (e: KeyboardEvent) => setCtrl(e.ctrlKey);
    window.addEventListener("keydown", sync, true);
    window.addEventListener("keyup", sync, true);
    return () => {
      window.removeEventListener("keydown", sync, true);
      window.removeEventListener("keyup", sync, true);
    };
  }, [active]);
  return ctrl;
}
