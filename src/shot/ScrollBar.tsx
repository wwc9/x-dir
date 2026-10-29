// 滚动截图控制条（§3.6 二期 B 批；2026-10-29 改停靠选区正下方，PixPin
// 样式）：显示已捕获尺寸与滚动方向，完成 = 用已拼内容出结果，取消 / Esc =
// 丢弃。长图预览在侧边的 ScrollPreview 窗（label shot-scroll），本窗（label
// shot-bar）只发控制命令与接收进度事件更新尺寸显示。窗口几何由 Rust 侧决定。
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, X } from "lucide-react";

import { api } from "../lib/ipc";
import { initTooltip } from "../lib/tooltip";
import { AppIcon } from "../components/AppIcon";

export interface ScrollBarBoot {
  window: "scrollbar";
  /** 选区物理像素宽（尺寸显示 W × 已捕获高度） */
  w: number;
}

export function ScrollBar({ boot }: { boot: ScrollBarBoot }) {
  const [height, setHeight] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => initTooltip(), []);

  useEffect(() => {
    const un = listen<{ height: number }>("shot-scroll-progress", (e) =>
      setHeight(e.payload.height),
    );
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  const act = useCallback(
    (action: "finish" | "cancel") => {
      if (busy) return;
      setBusy(true);
      void api.shotScrollControl(action).catch(() => setBusy(false));
    },
    [busy],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        act("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        act("finish");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  return (
    <div className="np-shot-sbar">
      <span className="np-shot-sbar-dot" />
      <span className="np-shot-sbar-dim">
        {boot.w.toLocaleString()} × {height.toLocaleString()}
      </span>
      <span className="np-shot-sbar-dir" data-tip="横向滚动截图暂未支持">
        纵向
      </span>
      <span className="np-shot-sbar-spacer" />
      <button
        className="np-shot-btn primary"
        data-tip="用已拼内容出结果"
        data-kbd="Enter"
        disabled={busy}
        onClick={() => act("finish")}
      >
        <AppIcon icon={Check} />
        完成
      </button>
      <button
        className="np-shot-btn"
        data-tip="丢弃长图"
        data-kbd="Esc"
        disabled={busy}
        onClick={() => act("cancel")}
      >
        <AppIcon icon={X} />
        取消
      </button>
    </div>
  );
}
