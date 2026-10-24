// 滚动截图控制浮条（§3.6 二期 B 批，label shot-scroll）：显示已捕获高度，
// 完成 = 用已拼内容出结果，取消 / Esc = 丢弃。窗口生命周期由 Rust 侧管理
//（拼接收尾时关闭），本组件只发控制命令与接收进度事件。
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, GalleryVerticalEnd, X } from "lucide-react";

import { api } from "../lib/ipc";
import { AppIcon } from "../components/AppIcon";

export interface ScrollBarBoot {
  window: "scrollbar";
}

export function ScrollBar() {
  const [height, setHeight] = useState(0);
  const [busy, setBusy] = useState(false);

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
      <AppIcon icon={GalleryVerticalEnd} />
      <span className="np-shot-sbar-label">滚动截图中</span>
      <span className="np-shot-sbar-h">已捕获 {height.toLocaleString()} px</span>
      <button className="np-shot-btn primary" disabled={busy} onClick={() => act("finish")}>
        <AppIcon icon={Check} />
        完成
      </button>
      <button className="np-shot-btn" disabled={busy} onClick={() => act("cancel")}>
        <AppIcon icon={X} />
        取消
      </button>
    </div>
  );
}
