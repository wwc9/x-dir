// GIF 录制浮条（2026-11-19 新功能；label shot-bar 复用，boot 换装 gifbar，
// 与滚动控制条共用常驻窗生命周期）。四态（2026-11-19/20 用户定案）：待命 =
// 选区已框定（遮罩窗标示）但不抓帧，可切 fps / 进度条开关，点「开始录制」
// 才进录制态；录制 = 红点 + 时长/帧数/实时体积 + 暂停/保存/取消（2026-11-20
// 用户需求「增加暂停、取消、保存按钮」）；暂停 = 计时冻结不抓帧，可继续/
// 保存/取消；生成中 = 完成后若开启进度条，逐帧合成期间禁操作，结束后结果窗
// 接管。进度经 shot-gif-progress 事件（≥1s 一发，paused 字段同步暂停态）
// 实时刷新；状态跃迁经 shot-gif-phase 事件（Rust 侧 start 处理/后处理开始
// 时下发）。窗口几何由 Rust 侧决定（宽 640 容按钮组：暂停/保存/取消 +
// fps/进度条/指针/停顿 四 chip；2026-11-20 反馈 310 时「开始录制」被窗缘
// 裁掉）。指针 chip = 录制画面叠加鼠标光标（Rust GetCursorInfo+GetDIBits
// 解码 SrcOver 叠画，待命/录制可切下一帧起生效，市场惯例默认开）。
// 停顿 chip = 静止段回放保留秒数（2026-11-20 用户需求「录制前可设置」，
// Rust 收尾静止段压缩读取 GIF_STATIC_KEEP，keep:N 动作循环 1/2/3/5/10）。
// ⚠ busy 只作防双击：命令回执即复位（2026-11-20 用户反馈「点开始后无法
// 退出」根因——start 成功后 busy 恒 true，录制态按钮全 disabled 且键盘
// 通路被拦）。真正的状态权威是 Rust 侧 phase/progress 事件。
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Pause, Play, Save, X } from "lucide-react";

import { api } from "../lib/ipc";
import { initTooltip } from "../lib/tooltip";
import { AppIcon } from "../components/AppIcon";

export interface GifBarBoot {
  window: "gifbar";
  fps: number;
  /** 底部进度条开关初值（待命态可切；开启 = 导出后逐帧合成底部进度条） */
  barOn: boolean;
  /** 底条步进档位初值（平滑 40 / 跳进 10，bar:on|low|off 三态） */
  barSteps: number;
  /** 鼠标指针叠画开关初值（待命/录制中可切，下一帧起生效） */
  cursorOn: boolean;
  /** 静止段保留秒数初值（待命/录制中可设，收尾压缩时生效） */
  staticKeep: number;
}

type GifPhase = "ready" | "recording" | "processing";

const FPS_CYCLE = [8, 12, 15] as const;
/** 静止段保留秒数循环档（停顿回放最多 N 秒） */
const KEEP_CYCLE = [1, 2, 3, 5, 10] as const;
const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
const fmtSecs = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function GifBar({ boot }: { boot: GifBarBoot }) {
  /** 常驻窗复用：boot 事件换装并整体重置 */
  const [fps, setFps] = useState(boot.fps);
  const [barOn, setBarOn] = useState(boot.barOn);
  const [barSteps, setBarSteps] = useState(boot.barSteps);
  const [cursorOn, setCursorOn] = useState(boot.cursorOn);
  const [staticKeep, setStaticKeep] = useState(boot.staticKeep);
  const [phase, setPhase] = useState<GifPhase>("ready");
  const [paused, setPaused] = useState(false);
  const [secs, setSecs] = useState(0);
  const [frames, setFrames] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [busy, setBusy] = useState(false);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

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
    const un = listen<{ fps: number; barOn?: boolean; barSteps?: number; cursorOn?: boolean; staticKeep?: number }>(
      "shot-gif-bar-boot",
      (e) => {
        setFps(e.payload.fps);
        if (typeof e.payload.barOn === "boolean") setBarOn(e.payload.barOn);
        if (typeof e.payload.barSteps === "number") setBarSteps(e.payload.barSteps);
        if (typeof e.payload.cursorOn === "boolean") setCursorOn(e.payload.cursorOn);
        if (typeof e.payload.staticKeep === "number") setStaticKeep(e.payload.staticKeep);
        setPhase("ready");
        setPaused(false);
        setSecs(0);
        setFrames(0);
        setBytes(0);
        setBusy(false);
      },
    );
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  useEffect(() => initTooltip(), []);

  useEffect(() => {
    const un = listen<{ secs: number; frames: number; bytes: number; fps: number; paused?: boolean }>(
      "shot-gif-progress",
      (e) => {
        setSecs(e.payload.secs);
        setFrames(e.payload.frames);
        setBytes(e.payload.bytes);
        setFps(e.payload.fps);
        if (typeof e.payload.paused === "boolean") setPaused(e.payload.paused);
      },
    );
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  const act = useCallback(
    (
      action:
        | "start"
        | "finish"
        | "cancel"
        | "pause"
        | "resume"
        | `fps:${8 | 12 | 15}`
        | `bar:${"on" | "off"}`
        | `cursor:${"on" | "off"}`
        | `keep:${number}`,
    ) => {
      if (busy) return;
      if (action === "start" || action === "finish" || action === "cancel") setBusy(true);
      void api
        .shotGifControl(action)
        .catch(() => setBusy(false))
        .finally(() => setBusy(false));
    },
    [busy],
  );

  /** 点击循环切档（8→12→15→8），待命/录制中即时生效（下一帧起） */
  const cycleFps = useCallback(() => {
    const next = FPS_CYCLE[(FPS_CYCLE.indexOf(fpsRef.current as 8 | 12 | 15) + 1) % FPS_CYCLE.length];
    setFps(next);
    void api.shotGifControl(`fps:${next}`).catch(() => undefined);
  }, []);

  /** 底条三态循环：平滑(40 级) → 跳进(10 级) → 关闭 → 平滑 */
  const cycleBar = useCallback(() => {
    if (!barOn) {
      setBarOn(true);
      setBarSteps(40);
      void api.shotGifControl("bar:on").catch(() => undefined);
      return;
    }
    if (barSteps >= 40) {
      setBarOn(true);
      setBarSteps(10);
      void api.shotGifControl("bar:low").catch(() => undefined);
      return;
    }
    setBarOn(false);
    void api.shotGifControl("bar:off").catch(() => undefined);
  }, [barOn, barSteps]);

  /** 指针叠画开关（待命/录制中可切，下一帧起生效） */
  const toggleCursor = useCallback(() => {
    const next = !cursorOn;
    setCursorOn(next);
    void api
      .shotGifControl(`cursor:${next ? "on" : "off"}`)
      .catch(() => setCursorOn(!next));
  }, [cursorOn]);

  /** 静止段保留秒数（待命/录制中可设，收尾压缩时生效）：循环 1→2→3→5→10→1 */
  const cycleKeep = useCallback(() => {
    const next = KEEP_CYCLE[(KEEP_CYCLE.indexOf(staticKeep as 1 | 2 | 3 | 5 | 10) + 1) % KEEP_CYCLE.length];
    setStaticKeep(next);
    void api.shotGifControl(`keep:${next}`).catch(() => undefined);
  }, [staticKeep]);

  /** 暂停/继续（录制中即时生效：暂停不抓帧、计时冻结；本地先换面，
   *  Rust 跃迁进度事件回填权威态） */
  const togglePause = useCallback(() => {
    const next = !pausedRef.current;
    setPaused(next);
    void api.shotGifControl(next ? "pause" : "resume").catch(() => setPaused(!next));
  }, []);

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
        <span className={paused ? "np-shot-gbar-dot is-paused" : "np-shot-gbar-dot"} />
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
          {paused && <span className="np-shot-sbar-warn">已暂停</span>}
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
          data-tip="底部进度条：平滑（40 级增量）/跳进（10 级，填充呈阶梯）/关闭，点击切换"
          onClick={cycleBar}
        >
          进度条 {!barOn ? "关" : barSteps >= 40 ? "平滑" : "跳进"}
        </button>
      )}
      {phase !== "processing" && (
        <button
          className="np-shot-gbar-fps"
          data-tip="录制中的停顿回放最多保留的秒数（点击切换，保存时生效）"
          onClick={cycleKeep}
        >
          停顿 {staticKeep}s
        </button>
      )}
      {phase !== "processing" && (
        <button
          className="np-shot-gbar-fps"
          data-tip="录制画面中叠加鼠标指针（下一帧起生效）"
          onClick={toggleCursor}
        >
          指针 {cursorOn ? "开" : "关"}
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
            className="np-shot-btn"
            data-tip={paused ? "继续录制（计时恢复累计）" : "暂停录制（已录内容保留，计时冻结）"}
            disabled={busy}
            onClick={togglePause}
          >
            <AppIcon icon={paused ? Play : Pause} />
            {paused ? "继续" : "暂停"}
          </button>
          <button
            className="np-shot-btn primary"
            data-tip="结束录制并生成 GIF"
            data-kbd="Enter"
            disabled={busy}
            onClick={() => act("finish")}
          >
            <AppIcon icon={Save} />
            保存
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
