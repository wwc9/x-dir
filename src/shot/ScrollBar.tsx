// 滚动截图侧边预览窗（§3.6 二期 B 批，label shot-scroll；2026-10-29 由底部
// 浮条改为贴选区右/左侧的实时长图预览）：进度事件驱动、shot_scroll_chunk
// 增量拉取已拼行（原始 RGBA 二进制直传）画进 canvas，贴底自动跟随；完成 =
// 用已拼内容出结果，取消 / Esc = 丢弃。窗口几何由 Rust 侧决定，本组件只发
// 控制命令与接收进度事件。
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, X } from "lucide-react";

import { api } from "../lib/ipc";
import { initTooltip } from "../lib/tooltip";
import { AppIcon } from "../components/AppIcon";

export interface ScrollBarBoot {
  window: "scrollbar";
  /** 选区物理像素宽（预览 canvas 的自然宽度，显示按面板宽等比缩放） */
  w: number;
  h: number;
  scale: number;
}

export function ScrollBar({ boot }: { boot: ScrollBarBoot }) {
  const [height, setHeight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  /** 已拉取行号（增量拉取游标） */
  const pulledRef = useRef(0);
  /** 用户贴底时新内容自动跟随；向上翻阅即暂停跟随，再滚回底部恢复 */
  const stickRef = useRef(true);

  useEffect(() => initTooltip(), []);

  // 进度事件 → 防抖拉取增量行画到 canvas。canvas 增高会清空位图，此时全量
  // 重拉重画（本地 IPC memcpy，无编码开销）；高度按 1KiB 行台阶预分配，把
  // 清空重画摊薄到每翻倍一次
  useEffect(() => {
    let dead = false;
    let timer: number | null = null;
    const pull = async (target: number) => {
      const c = canvasRef.current;
      if (!c || pulledRef.current >= target) return;
      try {
        const from = pulledRef.current;
        const buf = await api.shotScrollChunk(from);
        if (dead) return;
        const rows = new Uint8ClampedArray(buf);
        const n = rows.length / (boot.w * 4);
        if (n <= 0) return;
        const ctx = c.getContext("2d")!;
        const need = from + n;
        if (c.height < need) {
          // 增高 = 位图清空：全量重拉重画
          let nh = Math.max(c.height, 1024);
          while (nh < need) nh *= 2;
          c.height = nh;
          const all = new Uint8ClampedArray(await api.shotScrollChunk(0));
          const total = all.length / (boot.w * 4);
          if (total > 0) {
            ctx.putImageData(new ImageData(all, boot.w, total), 0, 0);
            pulledRef.current = total;
            setHeight(total);
          }
        } else {
          ctx.putImageData(new ImageData(rows, boot.w, n), 0, from);
          pulledRef.current = need;
          setHeight(need);
        }
        const v = viewRef.current;
        if (v && stickRef.current) v.scrollTop = v.scrollHeight;
      } catch {
        if (!dead) setFail(true);
      }
    };
    const un = listen<{ height: number }>("shot-scroll-progress", (e) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void pull(e.payload.height), 80);
    });
    return () => {
      dead = true;
      if (timer !== null) window.clearTimeout(timer);
      void un.then((f) => f()).catch(() => undefined);
    };
  }, [boot.w]);

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
    <div className="np-shot-sprev">
      <div className="np-shot-sprev-head">
        <span className="np-shot-sprev-dot" />
        <span className="np-shot-sprev-label">
          {height > boot.h ? "滚动截图中" : "向下滚动开始"}
        </span>
        <span className="np-shot-sprev-h">{height.toLocaleString()} px</span>
      </div>
      <div
        ref={viewRef}
        className="np-shot-sprev-view"
        onScroll={(e) => {
          const v = e.currentTarget;
          stickRef.current = v.scrollTop + v.clientHeight >= v.scrollHeight - 24;
        }}
      >
        <canvas ref={canvasRef} width={boot.w} height={boot.h} />
      </div>
      <div className="np-shot-sprev-foot">
        <span className="np-shot-sprev-tip">
          {fail ? "预览同步失败（不影响拼接结果）" : "滚轮下滚拼接 · 上滚回看"}
        </span>
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
    </div>
  );
}
