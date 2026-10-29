// 滚动截图侧边预览窗（label shot-scroll；2026-10-29 PixPin 样式：纯预览，
// 控制按钮在选区正下方的控制条上）：进度事件驱动、shot_scroll_chunk 增量
// 拉取已拼行（原始 RGBA 二进制直传）画进 canvas，贴底自动跟随，最新拼接段
// 绿色高亮渐隐（np-shot-sprev-flash）。窗口几何由 Rust 侧决定。
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api } from "../lib/ipc";

export interface ScrollPreviewBoot {
  window: "scroll-preview";
  /** 选区物理像素尺寸（canvas 自然尺寸，显示按面板宽等比缩放） */
  w: number;
  h: number;
}

/** 新段绿色高亮时长（与 np-shot-flash 动画一致） */
const FLASH_MS = 900;

export function ScrollPreview({ boot }: { boot: ScrollPreviewBoot }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 已拉取行号（增量拉取游标） */
  const pulledRef = useRef(0);
  /** 用户贴底时新内容自动跟随；向上翻阅即暂停跟随，再滚回底部恢复 */
  const stickRef = useRef(true);
  const [fail, setFail] = useState(false);
  /** 最新拼接段的高亮区（canvas 显示坐标；null = 无） */
  const [flash, setFlash] = useState<{ top: number; height: number; key: number } | null>(null);
  /** 常驻窗复用：选区尺寸随会话变，boot 事件换装并整体重置 */
  const [dim, setDim] = useState({ w: boot.w, h: boot.h });
  useEffect(() => {
    const un = listen<{ w: number; h: number }>("shot-preview-boot", (e) => {
      setDim(e.payload);
      pulledRef.current = 0;
      stickRef.current = true;
      setFail(false);
      setFlash(null);
      const c = canvasRef.current;
      if (c) {
        c.width = e.payload.w;
        c.height = e.payload.h;
        c.getContext("2d")!.clearRect(0, 0, e.payload.w, e.payload.h);
      }
    });
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // 进度事件 → 防抖拉取增量行画到 canvas。canvas 增高会清空位图，此时全量
  // 重拉重画（本地 IPC memcpy，无编码开销）；高度按 1KiB 行台阶预分配，把
  // 清空重画摊薄到每翻倍一次
  useEffect(() => {
    let dead = false;
    let timer: number | null = null;
    let flashTimer: number | null = null;
    const pull = async (target: number) => {
      const c = canvasRef.current;
      const wrap = wrapRef.current;
      if (!c || !wrap || pulledRef.current >= target) return;
      try {
        const from = pulledRef.current;
        const buf = await api.shotScrollChunk(from);
        if (dead) return;
        const rows = new Uint8ClampedArray(buf);
        const n = rows.length / (dim.w * 4);
        if (n <= 0) return;
        const ctx = c.getContext("2d")!;
        const need = from + n;
        if (c.height < need) {
          // 增高 = 位图清空：全量重拉重画
          let nh = Math.max(c.height, 1024);
          while (nh < need) nh *= 2;
          c.height = nh;
          const all = new Uint8ClampedArray(await api.shotScrollChunk(0));
          const total = all.length / (dim.w * 4);
          if (total > 0) {
            ctx.putImageData(new ImageData(all, dim.w, total), 0, 0);
            pulledRef.current = total;
          }
        } else {
          ctx.putImageData(new ImageData(rows, dim.w, n), 0, from);
          pulledRef.current = need;
        }
        // 新段高亮（PixPin 样式）：canvas 显示缩放系数 = 包裹宽 / 自然宽
        const drawn = pulledRef.current;
        const k = wrap.clientWidth / dim.w;
        setFlash({ top: from * k, height: n * k, key: drawn });
        if (flashTimer !== null) window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => setFlash(null), FLASH_MS);
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
      if (flashTimer !== null) window.clearTimeout(flashTimer);
      void un.then((f) => f()).catch(() => undefined);
    };
  }, [dim.w]);

  return (
    <div className="np-shot-sprev">
      <div
        ref={viewRef}
        className="np-shot-sprev-view"
        onScroll={(e) => {
          const v = e.currentTarget;
          stickRef.current = v.scrollTop + v.clientHeight >= v.scrollHeight - 24;
        }}
      >
        <div ref={wrapRef} className="np-shot-sprev-wrap">
          <canvas ref={canvasRef} width={dim.w} height={dim.h} />
          {flash && (
            <div
              className="np-shot-sprev-flash"
              style={{ top: flash.top, height: Math.max(2, flash.height) }}
            />
          )}
        </div>
        {fail && <div className="np-shot-sprev-fail">预览同步失败（不影响拼接结果）</div>}
      </div>
    </div>
  );
}
