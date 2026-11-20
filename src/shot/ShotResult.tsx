// 滚动长图结果窗（§3.6 二期 B 批，label shot-result）：图在窗内滚动查看 +
// 缩放（Ctrl+滚轮 / 按钮 / 适配宽度，默认 min(100%, 适配宽)——2026-10-29
// 用户定案：长图不再被窗体等比压缩成细窄条，窗体尺寸由 Rust 侧独立钳制）。
// 底部工具条缩放 / 贴图 / 复制 / 保存 / 关闭。截断（动态内容中断或高度上限）
// 时顶部提示条说明。长图文件由 Rust 侧在本窗销毁时清理；贴图会先在 Rust 侧
// 复制专属副本，不受本窗清理影响。
// GIF 录制分支（2026-11-19，boot.kind = "gif"）：复制（动画无位图语义）/
// 贴图（静态窗）不适用 → 按钮组换「打开所在文件夹 + 保存（.gif 过滤器）」；
// 保存传 kind="gif" 走 GIF 过滤器与默认名。播放控制（2026-11-20 用户需求
// 「预览支持播放」）：WebView2 有 ImageDecoder 时走 GifPlayer Canvas 播放器
// （暂停/恢复不重头，空格或按钮），缺失回退 <img> 原生动画；初始缩放整体
// 适配（高也进视口，配合 Rust 侧按 GIF 尺寸开窗），长图仍只适配宽（定案）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Check,
  Copy,
  FolderOpen,
  Maximize,
  Pause,
  Pin,
  Play,
  Save,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { api } from "../lib/ipc";
import { AppIcon } from "../components/AppIcon";
import { GifPlayer } from "./GifPlayer";

export interface ResultBoot {
  window: "result";
  file: string;
  /** 长图原始物理像素尺寸 */
  w: number;
  h: number;
  /** true = 因动态内容 / 高度上限中途截断 */
  truncated: boolean;
  /** "gif" = GIF 录制结果（动画播放 + 保存/打开文件夹按钮组）；缺省 = 滚动长图 */
  kind?: "gif";
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 5;

export function ShotResult({ boot }: { boot: ResultBoot }) {
  const win = getCurrentWindow();
  /** GIF 录制结果：动画无复制/贴图语义，按钮组换打开文件夹 + 保存 */
  const isGif = boot.kind === "gif";
  const [busy, setBusy] = useState<"" | "copy" | "save" | "pin" | "reveal">("");
  const [tip, setTip] = useState<string | null>(null);
  /** 缩放倍率（1 = 物理像素 1:1 的 CSS 观感尺寸）；null = 待首帧量视口 */
  const [zoom, setZoom] = useState<number | null>(null);
  /** GIF 播放状态（GifPlayer Canvas 播放器；暂停停当前帧、恢复不重头） */
  const [playing, setPlaying] = useState(true);
  /** GIF 帧数（ImageDecoder tracks 回执，状态条展示） */
  const [frameCount, setFrameCount] = useState<number | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  /** 图的 CSS 自然宽 = 物理宽 / DPI（结果窗缩放随窗口所在显示器） */
  const naturalCss = boot.w / window.devicePixelRatio;
  const naturalH = boot.h / window.devicePixelRatio;
  /** WebView2 内置 GIF 逐帧解码器（缺失回退 img 原生动画） */
  const hasDecoder = typeof window.ImageDecoder === "function";
  const gifPlayable = isGif && hasDecoder;

  // 初始 = min(100%, 适配视口宽)；GIF 分支整体适配（高也进视口，配合 Rust
  // 按 GIF 尺寸开窗；钳小窗不滚动），长图保持只适配宽（2026-10-29 定案）
  useLayoutEffect(() => {
    const v = viewRef.current;
    if (v) {
      const fitW = (v.clientWidth - 24) / naturalCss;
      const fitH = gifPlayable ? (v.clientHeight - 24) / naturalH : Infinity;
      setZoom(Math.min(1, fitW, fitH));
    }
  }, [naturalCss, naturalH, gifPlayable]);

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
      if (e.key === "Escape") {
        void win.close().catch(() => undefined);
      } else if (gifPlayable && e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gifPlayable]);

  /** 首帧/加载就绪回执：Rust 此时才 show（提前 show 闪黑屏） */
  const handleReady = useCallback(() => {
    void api.shotReady().catch(() => undefined);
  }, []);

  const fitWidth = useCallback(() => {
    const v = viewRef.current;
    if (v) setZoom(Math.min(1, (v.clientWidth - 24) / naturalCss));
  }, [naturalCss]);

  const run = useCallback(
    async (action: "copy" | "save" | "pin" | "reveal") => {
      if (busy) return;
      setBusy(action);
      try {
        if (action === "copy") {
          await api.shotResultCopy(boot.file);
          void win.close().catch(() => undefined);
        } else if (action === "save") {
          const saved = await api.shotResultSave(boot.file, isGif ? "gif" : undefined);
          if (saved) {
            setTip(`已保存 ${saved.split(/[\\/]/).pop()}`);
            setBusy("");
            setTimeout(() => void win.close().catch(() => undefined), 1400);
          } else {
            setBusy(""); // 取消保存对话框
          }
        } else if (action === "reveal") {
          await api.shotResultReveal(boot.file);
          setBusy(""); // 文件夹打开后结果窗保留（用户可能回来删除/再保存）
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
    [busy, boot.file, isGif],
  );

  return (
    <div className="np-shot-result">
      {boot.truncated && (
        <div className="np-shot-result-trunc">
          内容动态变化或已达高度上限，长图在此截断（可框选更小区域重试）
        </div>
      )}
      <div ref={viewRef} className="np-shot-result-view">
        {gifPlayable ? (
          <GifPlayer
            file={boot.file}
            w={boot.w}
            h={boot.h}
            zoom={zoom}
            naturalCss={naturalCss}
            playing={playing}
            onReady={handleReady}
            onFrames={setFrameCount}
          />
        ) : (
          <img
            src={convertFileSrc(boot.file)}
            crossOrigin="anonymous"
            alt={isGif ? "GIF 录制" : "滚动长图"}
            draggable={false}
            // 首帧就绪回执：Rust 此时才 show（提前 show 闪黑屏）
            onLoad={handleReady}
            style={{ width: zoom === null ? undefined : naturalCss * zoom }}
          />
        )}
      </div>
      <div className="np-shot-result-bar">
        <span className="np-shot-result-dim">
          {boot.w.toLocaleString()} × {boot.h.toLocaleString()} px
          {gifPlayable && frameCount !== null ? ` · ${frameCount.toLocaleString()} 帧` : ""}
        </span>
        {gifPlayable && (
          <button
            className="np-shot-btn"
            data-tip={playing ? "暂停动画（空格）" : "播放动画（空格）"}
            data-kbd="Space"
            disabled={busy !== ""}
            onClick={() => setPlaying((p) => !p)}
          >
            <AppIcon icon={playing ? Pause : Play} />
            {playing ? "暂停" : "播放"}
          </button>
        )}
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
        {isGif ? (
          <button
            className="np-shot-btn"
            data-tip="在资源管理器中定位 GIF 文件"
            disabled={busy !== ""}
            onClick={() => void run("reveal")}
          >
            <AppIcon icon={FolderOpen} />
            打开文件夹
          </button>
        ) : (
          <button className="np-shot-btn" disabled={busy !== ""} onClick={() => void run("pin")}>
            <AppIcon icon={Pin} />
            贴图
          </button>
        )}
        {!isGif && (
          <button
            className="np-shot-btn primary"
            disabled={busy !== ""}
            onClick={() => void run("copy")}
          >
            <AppIcon icon={Copy} />
            复制
          </button>
        )}
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
