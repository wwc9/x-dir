// GIF 录制浮条（2026-11-19 新功能；label shot-bar 复用，boot 换装 gifbar，
// 与滚动控制条共用常驻窗生命周期）。三态（2026-11-19 用户定案「点开始才录」）：
// 待命 = 选区已框定（遮罩窗标示）但不抓帧，可切 fps / 进度条开关，点「开始
// 录制」才进录制态；录制 = 红点 + 时长/帧数/实时体积 + fps 切档 + 完成/取消；
// 生成中 = 完成后若开启进度条，逐帧合成期间禁操作，结束后结果窗接管。
// 进度经 shot-gif-progress 事件（≥1s 一发）实时刷新；状态跃迁经 shot-gif-phase
// 事件（Rust 侧 start 处理/后处理开始时下发）。窗口几何由 Rust 侧决定。
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Loader2, Play, X } from "lucide-react";

import { api } from "../lib/ipc";
import { initTooltip } from "../lib/tooltip";
import { AppIcon } from "../components/AppIcon";

export interface GifBarBoot {
  window: "gifbar";
  fps: number;
  /** 底部进度条开关初值（待命态可切；开启 = 导出后逐帧合成底部进度条） */
  barOn: boolean;
}

type GifPhase = "ready" | "recording" | "processing";

const FPS_CYCLE = [8, 12, 15] as const;
const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
const fmtSecs = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function GifBar({ boot }: { boot: GifBarBoot }) {
  /** 常驻窗复用：boot 事件换装并整体重置 */
  const [fps, setFps] = useState(boot.fps);
  const [barOn, setBarOn] = useState(boot.barOn);
  const [phase, setPhase] = useState<GifPhase>("ready");
  const [secs, setSecs] = useState(0);
  const [frames, setFrames] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [busy, setBusy] = useState(false);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;

  // Rust 侧状态跃迁（start 被处理 / 进度条后处理开始）→ 浮条换面
  useEffect(() => {
    const un = listen<{ phase: GifPhase }>("shot-gif-phase", (e) => {
      setPhase(e.payload.phase);
    });
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const un = listen<{ fps: number; barOn?: boolean }>("shot-gif-bar-boot", (e) => {
      setFps(e.payload.fps);
      if (typeof e.payload.barOn === "boolean") setBarOn(e.payload.barOn);
      setPhase("ready");
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
    (action: "start" | "finish" | "cancel" | `fps:${8 | 12 | 15}` | `bar:${"on" | "off"}`) => {
      if (busy) return;
      if (action === "start" || action === "finish" || action === "cancel") setBusy(true);
      void api.shotGifControl(action).catch(() => setBusy(false));
    },
    [busy],
  );

  /** 点击循环切档（8→12→15→8），待命/录制中即时生效（下一帧起） */
  const cycleFps = useCallback(() => {
    const next = FPS_CYCLE[(FPS_CYCLE.indexOf(fpsRef.current as 8 | 12 | 15) + 1) % FPS_CYCLE.length];
    setFps(next);
    void api.shotGifControl(`fps:${next}`).catch(() => undefined);
  }, []);

  /** 进度条开关（仅待命态可切，控制导出后是否合成底部进度条） */
  const toggleBar = useCallback(() => {
    const next = !barOn;
    setBarOn(next);
    void api.shotGifControl(`bar:${next ? "on" : "off"}`).catch(() => undefined);
  }, [barOn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase === "processing") return; // 生成中不可中断（流式重编码）
      if (e.key === "Escape") {
        e.preventDefault();
        act("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        act(phase === "ready" ? "start" : "finish");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, phase]);

  return (
    <div className="np-shot-sbar">
      {phase === "recording" ? (
        <span className="np-shot-gbar-dot" />
      ) : (
        <span className="np-shot-sbar-dot" />
      )}
      {phase === "processing" ? (
        <>
          <AppIcon icon={Loader2} className="np-spin" />
          <span className="np-shot-sbar-dim">进度条合成中…</span>
        </>
      ) : phase === "ready" ? (
        <span className="np-shot-sbar-dim">待命 · 点击开始录制</span>
      ) : (
        <>
          <span className="np-shot-sbar-dim">{fmtSecs(secs)}</span>
          <span className="np-shot-sbar-dim">
            {frames} 帧 · {fmtBytes(bytes)}
          </span>
        </>
      )}
      {phase !== "processing" && (
        <button className="np-shot-gbar-fps" data-tip="切换帧率（下一帧起生效）" onClick={cycleFps}>
          {fps}fps
        </button>
      )}
      {phase === "ready" && (
        <button
          className="np-shot-gbar-fps"
          data-tip="导出 GIF 末尾合成底部进度条（随回放填充）"
          onClick={toggleBar}
        >
          进度条 {barOn ? "开" : "关"}
        </button>
      )}
      <span className="np-shot-sbar-spacer" />
      {phase === "ready" ? (
        <>
          <button
            className="np-shot-btn primary"
            data-tip="开始录制选区实时画面"
            data-kbd="Enter"
            disabled={busy}
            onClick={() => act("start")}
          >
            <AppIcon icon={Play} />
            开始录制
          </button>
          <button
            className="np-shot-btn"
            data-tip="关闭 GIF 录制"
            data-kbd="Esc"
            disabled={busy}
            onClick={() => act("cancel")}
          >
            <AppIcon icon={X} />
            取消
          </button>
        </>
      ) : phase === "recording" ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}
