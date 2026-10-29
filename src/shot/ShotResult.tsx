// 滚动长图结果窗（§3.6 二期 B 批，label shot-result）：图在窗内滚动查看 +
// 缩放（Ctrl+滚轮 / 按钮 / 适配宽度，默认 min(100%, 适配宽)——2026-10-29
// 用户定案：长图不再被窗体等比压缩成细窄条，窗体尺寸由 Rust 侧独立钳制）。
// 底部工具条缩放 / 贴图 / 复制 / 保存 / 关闭。截断（动态内容中断或高度上限）
// 时顶部提示条说明。长图文件由 Rust 侧在本窗销毁时清理；贴图会先在 Rust 侧
// 复制专属副本，不受本窗清理影响。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Copy, Maximize, Pin, Save, X, ZoomIn, ZoomOut } from "lucide-react";

import { api } from "../lib/ipc";
import { AppIcon } from "../components/AppIcon";

export interface ResultBoot {
  window: "result";
  file: string;
  /** 长图原始物理像素尺寸 */
  w: number;
  h: number;
  /** true = 因动态内容 / 高度上限中途截断 */
  truncated: boolean;
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 5;

export function ShotResult({ boot }: { boot: ResultBoot }) {
  const win = getCurrentWindow();
  const [busy, setBusy] = useState<"" | "copy" | "save" | "pin">("");
  const [tip, setTip] = useState<string | null>(null);
  /** 缩放倍率（1 = 物理像素 1:1 的 CSS 观感尺寸）；null = 待首帧量视口 */
  const [zoom, setZoom] = useState<number | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  /** 图的 CSS 自然宽 = 物理宽 / DPI（结果窗缩放随窗口所在显示器） */
  const naturalCss = boot.w / window.devicePixelRatio;

  // 初始 = min(100%, 适配视口宽)
  useLayoutEffect(() => {
    const v = viewRef.current;
    if (v) setZoom(Math.min(1, (v.clientWidth - 24) / naturalCss));
  }, [naturalCss]);

  // Ctrl+滚轮缩放（视口层非被动监听才能 preventDefault 拦下浏览器整页缩放）
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) =>
        z === null ? z : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * Math.exp(-e.deltaY * 0.0015))),
      );
    };
    v.addEventListener("wheel", onWheel, { passive: false });
    return () => v.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void win.close().catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fitWidth = useCallback(() => {
    const v = viewRef.current;
    if (v) setZoom(Math.min(1, (v.clientWidth - 24) / naturalCss));
  }, [naturalCss]);

  const run = useCallback(
    async (action: "copy" | "save" | "pin") => {
      if (busy) return;
      setBusy(action);
      try {
        if (action === "copy") {
          await api.shotResultCopy(boot.file);
          void win.close().catch(() => undefined);
        } else if (action === "save") {
          const saved = await api.shotResultSave(boot.file);
          if (saved) {
            setTip(`已保存 ${saved.split(/[\\/]/).pop()}`);
            setBusy("");
            setTimeout(() => void win.close().catch(() => undefined), 1400);
          } else {
            setBusy(""); // 取消保存对话框
          }
        } else {
          // 贴图出现在结果窗中心（窗口物理位置 + 物理尺寸）
          const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
          await api.shotPinFile(boot.file, pos.x + size.width / 2, pos.y + size.height / 2);
          void win.close().catch(() => undefined);
        }
      } catch (e) {
        setTip(`操作失败：${String(e)}`);
        setBusy("");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, boot.file],
  );

  return (
    <div className="np-shot-result">
      {boot.truncated && (
        <div className="np-shot-result-trunc">
          内容动态变化或已达高度上限，长图在此截断（可框选更小区域重试）
        </div>
      )}
      <div ref={viewRef} className="np-shot-result-view">
        <img
          src={convertFileSrc(boot.file)}
          crossOrigin="anonymous"
          alt="滚动长图"
          draggable={false}
          // 首帧就绪回执：Rust 此时才 show（提前 show 闪黑屏）
          onLoad={() => void api.shotReady().catch(() => undefined)}
          style={{ width: zoom === null ? undefined : naturalCss * zoom }}
        />
      </div>
      <div className="np-shot-result-bar">
        <span className="np-shot-result-dim">
          {boot.w.toLocaleString()} × {boot.h.toLocaleString()} px
        </span>
        <button
          className="np-shot-btn"
          data-tip="缩小"
          disabled={busy !== "" || zoom === null || zoom <= ZOOM_MIN}
          onClick={() => setZoom((z) => (z ? Math.max(ZOOM_MIN, z / 1.25) : z))}
        >
          <AppIcon icon={ZoomOut} />
        </button>
        <span className="np-shot-zoom-pct">{zoom === null ? "—" : `${Math.round(zoom * 100)}%`}</span>
        <button
          className="np-shot-btn"
          data-tip="放大"
          disabled={busy !== "" || zoom === null || zoom >= ZOOM_MAX}
          onClick={() => setZoom((z) => (z ? Math.min(ZOOM_MAX, z * 1.25) : z))}
        >
          <AppIcon icon={ZoomIn} />
        </button>
        <button
          className="np-shot-btn"
          data-tip="缩放至适配窗宽（不放大超过 100%）"
          data-kbd="Ctrl+滚轮"
          disabled={busy !== ""}
          onClick={fitWidth}
        >
          <AppIcon icon={Maximize} />
          适配
        </button>
        {tip ? (
          <span className="np-shot-result-tip">{tip}</span>
        ) : (
          <span className="np-shot-result-tip">Esc 关闭 · Ctrl+滚轮缩放</span>
        )}
        <button className="np-shot-btn" disabled={busy !== ""} onClick={() => void run("pin")}>
          <AppIcon icon={Pin} />
          贴图
        </button>
        <button
          className="np-shot-btn primary"
          disabled={busy !== ""}
          onClick={() => void run("copy")}
        >
          <AppIcon icon={Copy} />
          复制
        </button>
        <button className="np-shot-btn" disabled={busy !== ""} onClick={() => void run("save")}>
          <AppIcon icon={busy === "save" ? Check : Save} />
          保存
        </button>
        <button
          className="np-shot-btn danger"
          disabled={busy !== ""}
          onClick={() => void win.close().catch(() => undefined)}
        >
          <AppIcon icon={X} />
          关闭
        </button>
      </div>
    </div>
  );
}
