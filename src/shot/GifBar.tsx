// GIF 录制浮条（2026-11-19 新功能；label shot-bar 复用，boot 换装 gifbar，
// 与滚动控制条共用常驻窗生命周期）：显示录制时长 / 帧数 / 实时体积 / 当前
// fps（点击循环切档 8→12→15，下一帧起生效），完成 = 用已录内容出结果，
// 取消 / Esc = 丢弃并删临时文件，Enter = 完成。窗口几何由 Rust 侧决定。
// 进度经 shot-gif-progress 事件（≥1s 一发）实时刷新——原始尺寸模式下体积
// 实时可见是体量护栏（120s 上限由 Rust 侧自动收场）。
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, X } from "lucide-react";

import { api } from "../lib/ipc";
import { initTooltip } from "../lib/tooltip";
import { AppIcon } from "../components/AppIcon";

export interface GifBarBoot {
  window: "gifbar";
  fps: number;
}

const FPS_CYCLE = [8, 12, 15] as const;
const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
const fmtSecs = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function GifBar({ boot }: { boot: GifBarBoot }) {
  /** 常驻窗复用：boot 事件换装并整体重置 */
  const [fps, setFps] = useState(boot.fps);
  const [secs, setSecs] = useState(0);
  const [frames, setFrames] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [busy, setBusy] = useState(false);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;

  useEffect(() => {
    const un = listen<{ fps: number }>("shot-gif-bar-boot", (e) => {
      setFps(e.payload.fps);
      setSecs(0);
      setFrames(0);
      setBytes(0);
      setBusy(false);
    });
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  useEffect(() => initTooltip(), []);

  useEffect(() => {
    const un = listen<{ secs: number; frames: number; bytes: number; fps: number }>(
      "shot-gif-progress",
      (e) => {
        setSecs(e.payload.secs);
        setFrames(e.payload.frames);
        setBytes(e.payload.bytes);
        setFps(e.payload.fps);
      },
    );
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  const act = useCallback(
    (action: "finish" | "cancel") => {
      if (busy) return;
      setBusy(true);
      void api.shotGifControl(action).catch(() => setBusy(false));
    },
    [busy],
  );

  /** 点击循环切档（8→12→15→8），录制中即时生效（下一帧起） */
  const cycleFps = useCallback(() => {
    const next = FPS_CYCLE[(FPS_CYCLE.indexOf(fpsRef.current as 8 | 12 | 15) + 1) % FPS_CYCLE.length];
    setFps(next);
    void api.shotGifControl(`fps:${next}`).catch(() => undefined);
  }, []);

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
      <span className="np-shot-gbar-dot" />
      <span className="np-shot-sbar-dim">{fmtSecs(secs)}</span>
      <span className="np-shot-sbar-dim">
        {frames} 帧 · {fmtBytes(bytes)}
      </span>
      <button
        className="np-shot-gbar-fps"
        data-tip="切换帧率（下一帧起生效）"
        disabled={busy}
        onClick={cycleFps}
      >
        {fps}fps
      </button>
      <span className="np-shot-sbar-spacer" />
      <button
        className="np-shot-btn primary"
        data-tip="用已录内容出结果"
        data-kbd="Enter"
        disabled={busy}
        onClick={() => act("finish")}
      >
        <AppIcon icon={Check} />
        完成
      </button>
      <button
        className="np-shot-btn"
        data-tip="丢弃录制"
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
