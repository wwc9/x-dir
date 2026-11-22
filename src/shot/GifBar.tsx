// GIF 录制浮条（2026-11-19 新功能；label shot-bar 复用，boot 换装 gifbar，
// 与滚动控制条共用常驻窗生命周期）。四态（2026-11-19/20 用户定案）：待命 =
// 选区已框定（遮罩窗标示）但不抓帧，可切 fps / 进度条开关 / 色数 / 有损 /
// 缩放，点「开始录制」才进录制态；录制 = 红点 + 时长/帧数/实时体积 +
// 暂停/保存/取消（2026-11-20 用户需求「增加暂停、取消、保存按钮」）；暂停 =
// 计时冻结不抓帧，可继续/保存/取消；生成中 = 完成后若开启进度条，逐帧合成
// 期间禁操作，结束后结果窗接管。进度经 shot-gif-progress 事件（≥1s 一发，
// paused 字段同步暂停态）实时刷新；状态跃迁经 shot-gif-phase 事件（Rust 侧
// start 处理/后处理开始时下发）。指针 = 录制画面叠加鼠标光标（Rust
// GetCursorInfo+GetDIBits 解码 SrcOver 叠画，待命/录制可切下一帧起生效，
// 市场惯例默认开）。停顿 = 静止段回放保留秒数（Rust 收尾静止段压缩读取
// GIF_STATIC_KEEP）。体积三旋钮：色数 = 全帧量化色数档（≤档位独特色精确
// 调色板零损失，开始录制后生效）；有损 = 近色容差档（容差内帧间微变按静止
// 跳过，下一帧起生效）；缩放 = 导出缩放档（捕获后区域平均重采样）。
// 工具栏图标化 + 设置收纳（2026-11-22 用户需求「gif/长截图工具栏样式与截图
// 主区域工具栏一致；设置项收纳进设置图标，每项带图标」）：动作钮 = 主工具栏
// np-shot-tool 图标语言（Play/Pause/Save/X，语义色 primary/danger 同源），
// 七个设置 chip 收纳进齿轮钮（Settings）展开的设置面板（np-shot-gset，行 =
// 图标 + 名称 + 当前值，点击循环切档），面板随 boot 下发的 flipped 朝远离
// 选区一侧展开（下方停靠向下、上翻场向上，column-reverse + 底缘锚定长高，
// Rust shot_bar_resize h/up 参数），永不遮进录制选区。Esc 优先收面板再取消。
// ⚠ busy 只作防双击：命令回执即复位（2026-11-20 用户反馈「点开始后无法
// 退出」根因——start 成功后 busy 恒 true，录制态按钮全 disabled 且键盘
// 通路被拦）。真正的状态权威是 Rust 侧 phase/progress 事件。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ChartNoAxesColumn,
  Gauge,
  Loader2,
  MousePointer2,
  Palette,
  Pause,
  Play,
  Save,
  Scaling,
  Settings,
  Timer,
  X,
  Zap,
} from "lucide-react";

import { api } from "../lib/ipc";
import { useBarTip } from "./barTip";
import { AppIcon } from "../components/AppIcon";
import { DENSITY } from "../lib/tokens";

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
  /** 全帧量化色数档初值（256/128/64，待命可设，开始录制后生效） */
  colors: number;
  /** 近色容差档初值（0=关 1=低 2=中 3=高，待命可设，下一帧起生效） */
  lossy: number;
  /** 导出缩放档初值（100/75/50，待命可设，开始录制后生效） */
  scale: number;
  /** 浮条上翻（选区贴屏底，条停靠选区上方）：设置面板向上展开 */
  flipped?: boolean;
}

type GifPhase = "ready" | "recording" | "processing";

const FPS_CYCLE = [8, 12, 15] as const;
/** 静止段保留秒数循环档（停顿回放最多 N 秒） */
const KEEP_CYCLE = [1, 2, 3, 5, 10] as const;
/** 色数循环档（全帧量化上限；≤档位独特色走精确调色板零损失） */
const COLORS_CYCLE = [256, 128, 64] as const;
/** 近色容差循环档（自研 lossy：0 关 / 64 低 / 256 中 / 900 高 平方距阈） */
const LOSSY_CYCLE = [0, 1, 2, 3] as const;
const LOSSY_LABEL: Record<number, string> = { 0: "关", 1: "低", 2: "中", 3: "高" };
/** 导出缩放循环档（捕获后区域平均重采样，像素数平方级下降） */
const SCALE_CYCLE = [100, 75, 50] as const;
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
  const [colors, setColors] = useState(boot.colors);
  const [lossy, setLossy] = useState(boot.lossy);
  const [scale, setScale] = useState(boot.scale);
  const [flipped, setFlipped] = useState(boot.flipped ?? false);
  /** 设置面板开合（齿轮钮收纳：帧率/进度条/色数/有损/缩放/停顿/指针） */
  const [open, setOpen] = useState(false);
  /** 换装序号：常驻窗停靠屏外，每次 boot 换装重绘后回执 Rust 才上屏（无感链路） */
  const [dress, setDress] = useState(0);
  const [synth, setSynth] = useState<{ done: number; total: number; eta: number } | null>(null);
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
  // 内容自适应尺寸测量基座（宽 = 行 16px 档量化，高 = 容器实高）
  const barRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const sentW = useRef(0);
  const sentH = useRef(0);
  const prevPhase = useRef<GifPhase>(phase);

  // Rust 侧状态跃迁（start 被处理 / 进度条后处理开始）→ 浮条换面
  useEffect(() => {
    const un = listen<{ phase: GifPhase }>("shot-gif-phase", (e) => {
      setPhase(e.payload.phase);
    });
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // 生成中禁操作：面板随相位收起（尺寸回落由测量链路自动跟随）
  useEffect(() => {
    if (phase === "processing") setOpen(false);
  }, [phase]);

  // 底条合成进度/ETA（Rust append_progress_bar_with_steps 逐帧下发）
  useEffect(() => {
    const un = listen<{ done: number; total: number; eta: number }>("shot-gif-synth", (e) =>
      setSynth(e.payload),
    );
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const un = listen<{
      fps: number;
      barOn?: boolean;
      barSteps?: number;
      cursorOn?: boolean;
      staticKeep?: number;
      colors?: number;
      lossy?: number;
      scale?: number;
      flipped?: boolean;
    }>("shot-gif-bar-boot", (e) => {
      setFps(e.payload.fps);
      if (typeof e.payload.barOn === "boolean") setBarOn(e.payload.barOn);
      if (typeof e.payload.barSteps === "number") setBarSteps(e.payload.barSteps);
      if (typeof e.payload.cursorOn === "boolean") setCursorOn(e.payload.cursorOn);
      if (typeof e.payload.staticKeep === "number") setStaticKeep(e.payload.staticKeep);
      if (typeof e.payload.colors === "number") setColors(e.payload.colors);
      if (typeof e.payload.lossy === "number") setLossy(e.payload.lossy);
      if (typeof e.payload.scale === "number") setScale(e.payload.scale);
      setFlipped(e.payload.flipped ?? false);
      setOpen(false);
      setDress((d) => d + 1);
      setSynth(null);
      setPhase("ready");
      setPaused(false);
      setSecs(0);
      setFrames(0);
      setBytes(0);
      setBusy(false);
      sentW.current = 0; // 新会话允许缩宽/缩高（内容组随相位变）
      sentH.current = 0;
    });
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // tooltip 走遮罩窗外渲染通道（useBarTip）：浮条窗 44px 高悬不出上方气泡；
  // 相位切换（chip 组更换）时清残留气泡
  const hideBarTip = useBarTip();
  useEffect(hideBarTip, [phase]);

  // 内容自适应尺寸（2026-11-21 宽 / 2026-11-22 高）：宽 = 行实宽 + 透明环
  // 留（左右 16×2，CSS margin 同值）16px 档量化、高 = 卡实高 + 环留（上 4 +
  // 下 28 = 32），回传 Rust 缩放窗口（缩宽条中心稳定 / 上翻场底缘锚定）；
  // 同相位宽只增不减防录制文本逐秒抖动，高逐值比对面板开合即变无抖动源
  useLayoutEffect(() => {
    if (prevPhase.current !== phase) {
      prevPhase.current = phase;
      sentW.current = 0;
      sentH.current = 0;
    }
    const row = rowRef.current;
    const el = barRef.current;
    if (!row || !el) return;
    const w = Math.ceil((row.offsetWidth + 32) / 16) * 16;
    const h = el.offsetHeight + 32;
    if (w > 0 && (w > sentW.current || (sentW.current > 0 && h !== sentH.current))) {
      sentW.current = Math.max(sentW.current, w);
      sentH.current = h;
      void api.shotBarResize(w, h, flipped).catch(() => undefined);
    }
  });

  // 常驻窗停靠屏外（合成器不离场）：首绘/换装重绘后回执 Rust（shot_ready）
  // 才原子移动上屏——无感链路，2026-11-21 低配闪屏修复
  useEffect(() => {
    const a = requestAnimationFrame(() => {
      requestAnimationFrame(() => void api.shotReady().catch(() => undefined));
    });
    return () => cancelAnimationFrame(a);
  }, [dress]);

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

  /** 色数档（待命可设，开始录制后生效）：循环 256→128→64→256 */
  const cycleColors = useCallback(() => {
    const next = COLORS_CYCLE[(COLORS_CYCLE.indexOf(colors as 256 | 128 | 64) + 1) % COLORS_CYCLE.length];
    setColors(next);
    void api.shotGifControl(`colors:${next}`).catch(() => setColors(colors));
  }, [colors]);

  /** 近色容差档（待命可设，下一帧起生效）：循环 关→低→中→高→关 */
  const cycleLossy = useCallback(() => {
    const next = LOSSY_CYCLE[(LOSSY_CYCLE.indexOf(lossy as 0 | 1 | 2 | 3) + 1) % LOSSY_CYCLE.length];
    setLossy(next);
    const name = (["off", "low", "mid", "high"] as const)[next];
    void api.shotGifControl(`lossy:${name}`).catch(() => setLossy(lossy));
  }, [lossy]);

  /** 导出缩放档（待命可设，开始录制后生效）：循环 100→75→50→100 */
  const cycleScale = useCallback(() => {
    const next = SCALE_CYCLE[(SCALE_CYCLE.indexOf(scale as 100 | 75 | 50) + 1) % SCALE_CYCLE.length];
    setScale(next);
    void api.shotGifControl(`scale:${next}`).catch(() => setScale(scale));
  }, [scale]);

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
        if (open) setOpen(false); // Esc 优先收设置面板，再取消会话
        else act("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        act(phase === "ready" ? "start" : "finish");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, phase, open]);

  return (
    <div ref={barRef} className={flipped ? "np-shot-sbar is-up" : "np-shot-sbar"}>
      <div ref={rowRef} className="np-shot-sbar-row">
        {phase === "recording" ? (
          <span className={paused ? "np-shot-gbar-dot is-paused" : "np-shot-gbar-dot"} />
        ) : (
          <span className="np-shot-sbar-dot" />
        )}
        {phase === "processing" ? (
          <>
            <AppIcon icon={Loader2} className="np-spin" />
            <span className="np-shot-sbar-dim">
              {synth
                ? `合成中 ${synth.done}/${synth.total} · 预计 ${synth.eta}s`
                : "进度条合成中…"}
            </span>
          </>
        ) : phase === "ready" ? (
          <span className="np-shot-sbar-dim">待命</span>
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
          <button
            className={`np-shot-tool ${open ? "on" : ""}`}
            data-tip="录制设置"
            onClick={() => setOpen((o) => !o)}
          >
            <AppIcon icon={Settings} size={DENSITY.iconLg} />
          </button>
        )}
        <span className="np-shot-sbar-spacer" />
        {phase === "ready" ? (
          <>
            <button
              className="np-shot-tool np-shot-primary"
              data-tip="开始录制选区实时画面"
              data-kbd="Enter"
              disabled={busy}
              onClick={() => act("start")}
            >
              <AppIcon icon={Play} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-danger"
              data-tip="关闭 GIF 录制"
              data-kbd="Esc"
              disabled={busy}
              onClick={() => act("cancel")}
            >
              <AppIcon icon={X} size={DENSITY.iconLg} />
            </button>
          </>
        ) : phase === "recording" ? (
          <>
            <button
              className="np-shot-tool"
              data-tip={paused ? "继续录制" : "暂停录制（计时冻结）"}
              disabled={busy}
              onClick={togglePause}
            >
              <AppIcon icon={paused ? Play : Pause} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-primary"
              data-tip="结束录制并生成 GIF"
              data-kbd="Enter"
              disabled={busy}
              onClick={() => act("finish")}
            >
              <AppIcon icon={Save} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-danger"
              data-tip="丢弃录制"
              data-kbd="Esc"
              disabled={busy}
              onClick={() => act("cancel")}
            >
              <AppIcon icon={X} size={DENSITY.iconLg} />
            </button>
          </>
        ) : null}
      </div>
      {open && phase !== "processing" && (
        <div className="np-shot-gset">
          <button className="np-shot-gset-row" data-tip="切换帧率（下一帧生效）" onClick={cycleFps}>
            <AppIcon icon={Gauge} />
            <span>帧率</span>
            <span className="np-shot-gset-val">{fps}fps</span>
          </button>
          {phase === "ready" && (
            <>
              <button
                className="np-shot-gset-row"
                data-tip="底部进度条：平滑 / 跳进 / 关"
                onClick={cycleBar}
              >
                <AppIcon icon={ChartNoAxesColumn} />
                <span>进度条</span>
                <span className="np-shot-gset-val">
                  {!barOn ? "关" : barSteps >= 40 ? "平滑" : "跳进"}
                </span>
              </button>
              <button
                className="np-shot-gset-row"
                data-tip="全帧量化色数（独特色零损失）"
                onClick={cycleColors}
              >
                <AppIcon icon={Palette} />
                <span>色数</span>
                <span className="np-shot-gset-val">{colors}色</span>
              </button>
              <button
                className="np-shot-gset-row"
                data-tip="近色容差：帧间微变按静止跳过"
                onClick={cycleLossy}
              >
                <AppIcon icon={Zap} />
                <span>有损</span>
                <span className="np-shot-gset-val">{LOSSY_LABEL[lossy]}</span>
              </button>
              <button
                className="np-shot-gset-row"
                data-tip="导出缩放（体积随像素平方级降）"
                onClick={cycleScale}
              >
                <AppIcon icon={Scaling} />
                <span>缩放</span>
                <span className="np-shot-gset-val">{scale}%</span>
              </button>
            </>
          )}
          <button
            className="np-shot-gset-row"
            data-tip="静止段回放保留秒数（保存时生效）"
            onClick={cycleKeep}
          >
            <AppIcon icon={Timer} />
            <span>停顿</span>
            <span className="np-shot-gset-val">{staticKeep}s</span>
          </button>
          <button
            className="np-shot-gset-row"
            data-tip="叠画鼠标指针（下一帧生效）"
            onClick={toggleCursor}
          >
            <AppIcon icon={MousePointer2} />
            <span>指针</span>
            <span className="np-shot-gset-val">{cursorOn ? "开" : "关"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
