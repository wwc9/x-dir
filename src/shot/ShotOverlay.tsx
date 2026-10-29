// 截图覆盖层（§3.6，常驻覆盖窗经 shot-session 事件驱动挂载）：定格截图铺底 +
// 智能窗口识别（进会话默认预选光标下窗口）+ 选区（拖拽/手柄调整/整体移动）+
// 标注（矩形/椭圆/箭头/画笔/马克笔/文字）+ 马赛克/模糊 + 复制/保存/贴图。
// 全链路物理像素坐标（×boot.scale 与 CSS 像素换算），与定格截图逐像素对齐。
// 定格帧经 shot_frame IPC 二进制直传 RGBA 原始字节，putImageData 直绘上屏
// （2026-10-27 感知延迟二期：无 BMP 落盘/asset 读回/浏览器解码三跳）。
//
// 双 canvas 分层：composite（离屏，底图 + 已确认标注按序压平——马赛克/模糊
// 取其像素，语义 = 后画的会把先画的糊掉，与 QQ 一致）→ base（静态显示）；
// live 承载遮罩/选区框/窗口高亮/绘制预览的高频重绘，mousemove 不触底图。
// 本窗脱离主界面体系（无 island/DialogHost），按钮提示复用主界面 np-tip
// 气泡（lib/tooltip 委托 data-tip/data-kbd，样式与 120ms 速度完全一致；
// 2026-10-28 定案，替代原生 title）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Copy,
  GalleryVerticalEnd,
  Frame,
  Grip,
  GripVertical,
  Highlighter,
  Layers,
  MousePointer2,
  Palette,
  Pencil,
  PenLine,
  Pin,
  Redo2,
  Save,
  Square,
  Type,
  Undo2,
  Waves,
  X,
} from "lucide-react";

import { api } from "../lib/ipc";
import { initTooltip } from "../lib/tooltip";
import { DENSITY } from "../lib/tokens";
import { AppIcon } from "../components/AppIcon";
import {
  SHOT_PALETTE,
  type HandleId,
  type MagColorFormat,
  type Sel,
  type Shape,
  drawCrosshair,
  drawMagnifier,
  drawShape,
  formatMagColor,
  handleAt,
  hitWindow,
  normalizeSel,
  resizeSel,
  type ShotTool,
} from "./annot";

export interface ShotBoot {
  window: "shot";
  mx: number;
  my: number;
  mw: number;
  mh: number;
  scale: number;
  /** 会话序号（常驻覆盖窗重挂 key） */
  seq: number;
  /** 定格时光标位置（显示器相对物理像素；默认预选光标下窗口） */
  cx: number;
  cy: number;
  windows: { x: number; y: number; w: number; h: number }[];
}

/** 三档线宽 / 字号（CSS 像素观感值） */
const STROKES = [2, 4, 7];
const FONTS = [16, 22, 30];
/** 阴影模糊半径 / 边框线宽档位（CSS 像素观感值，随 scale 增密） */
const SHADOW_W = [0, 10, 18, 30];
const BORDER_W = [0, 3, 6, 10];
const SHADOW_LV_LABEL = ["关", "弱", "中", "强"];

const TOOLS: { id: ShotTool; label: string; icon: typeof Square }[] = [
  { id: "select", label: "选择 / 移动选区", icon: MousePointer2 },
  { id: "rect", label: "矩形", icon: Square },
  { id: "ellipse", label: "椭圆", icon: Circle },
  { id: "arrow", label: "箭头", icon: ArrowUpRight },
  { id: "pen", label: "画笔", icon: Pencil },
  { id: "marker", label: "马克笔", icon: Highlighter },
  { id: "text", label: "文字", icon: Type },
  { id: "mosaic", label: "马赛克", icon: Grip },
  { id: "blur", label: "模糊", icon: Waves },
];

/** 开始一个标注草稿（pointerdown；坐标相对选区，物理像素） */
function startShape(
  tool: ShotTool,
  x: number,
  y: number,
  color: string,
  stroke: number,
): Shape | null {
  if (tool === "select") return null;
  return {
    type: tool as Exclude<ShotTool, "select">,
    x,
    y,
    w: 0,
    h: 0,
    pts: tool === "pen" || tool === "marker" ? [{ x, y }] : undefined,
    color,
    width: stroke,
  };
}

export function ShotOverlay({ boot }: { boot: ShotBoot }) {
  const scale = boot.scale;
  // 物理像素取整：非整数 DPI 下 clientX × scale 会带浮点误差（信息条出现
  // 606.00001525878906 这类值），截图本就该落在整数像素网格上——交互坐标
  // 统一在源头取整（选区/标注/贴图落位随之更锐利）
  const toPhys = (e: { clientX: number; clientY: number }) => ({
    px: Math.round(e.clientX * scale),
    py: Math.round(e.clientY * scale),
  });

  const baseRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const compRef = useRef<HTMLCanvasElement | null>(null);
  /** 定格帧画布（RGBA 直绘，语义等同旧 img 元素，供 comp 底图拷贝） */
  const imgRef = useRef<CanvasImageSource | null>(null);
  const accentRef = useRef("#3574f0");
  const dragRef = useRef<DragState | null>(null);
  const moveRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeRef = useRef<HandleId | null>(null);
  const drawRef = useRef<Shape | null>(null);
  const composingRef = useRef(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  /** 放大镜锚点（最近一次光标物理坐标；跟随/拖拽态显示，确认选区即隐；
   *  以定格时光标位初始化——首帧即有放大镜，不等鼠标先动一下） */
  const magRef = useRef<{ x: number; y: number } | null>({ x: boot.cx, y: boot.cy });
  /** 放大镜取色状态：色值格式（Shift 切换）/ 坐标模式（P 切换）/ 最近取样值（C 复制） */
  const colorFmtRef = useRef<MagColorFormat>("hex");
  const coordRelRef = useRef(false);
  const magColorRef = useRef<readonly [number, number, number, number] | null>(null);
  /** 导出装饰：阴影 / 边框档位（0=关 1=弱 2=中 3=强，点击循环切换） */
  const [shadowLv, setShadowLv] = useState(0);
  const [borderLv, setBorderLv] = useState(0);

  // 预选跟随模式（PixPin/QQ 惯例，2026-10-27）：进会话默认选中光标下窗口，
  // 鼠标移动时选中框自动跟随切换其他窗口（此时无工具栏，光标恒十字）；用户
  // 按下鼠标即开始自定义框选（跟随结束），单击/拖拽松开确认选区、工具栏直出；
  // Esc / 右键立即退出截图（用户定案，不再逐层取消）
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const [sel, setSel] = useState<Sel | null>(() =>
    hitWindow(boot.windows, boot.cx, boot.cy),
  );
  const [tool, setTool] = useState<ShotTool>("select");
  const [color, setColor] = useState(SHOT_PALETTE[0]);
  const [strokeIdx, setStrokeIdx] = useState(1);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [redoStack, setRedoStack] = useState<Shape[][]>([]);
  const [editing, setEditing] = useState<{ x: number; y: number; value: string } | null>(null);
  const [savedTip, setSavedTip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  /** 事件线程直读的镜像（React state 更新是异步的，指针流需要即时值） */
  const selRef = useRef<Sel | null>(null);
  const shapesRef = useRef<Shape[]>([]);
  const editingRef = useRef(editing);
  selRef.current = sel;
  shapesRef.current = shapes;
  editingRef.current = editing;

  // ── np-tip 悬浮提示（与本窗画布交互无冲突：委托 data-tip/data-kbd）───────
  useEffect(() => initTooltip(), []);

  // ── 画布初始化与重绘 ──────────────────────────────────────────────────────
  const redrawComposite = useCallback(() => {
    const comp = compRef.current;
    const img = imgRef.current;
    if (!comp || !img) return;
    const ctx = comp.getContext("2d")!;
    ctx.clearRect(0, 0, boot.mw, boot.mh);
    ctx.drawImage(img, 0, 0);
    const s = selRef.current;
    if (s) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(s.x, s.y, s.w, s.h);
      ctx.clip();
      for (const sh of shapesRef.current) drawShape(ctx, sh, s.x, s.y, scale);
      ctx.restore();
    }
  }, [boot.mw, boot.mh, scale]);

  const redrawBase = useCallback(() => {
    redrawComposite();
    const base = baseRef.current;
    const comp = compRef.current;
    if (!base || !comp) return;
    const ctx = base.getContext("2d")!;
    ctx.clearRect(0, 0, boot.mw, boot.mh);
    ctx.drawImage(comp, 0, 0);
  }, [boot.mw, boot.mh, redrawComposite]);

  /** live 层：遮罩（选区外）/ 窗口高亮 / 拖拽框与尺寸 / 绘制预览 */
  const redrawLive = useCallback(() => {
    const live = liveRef.current;
    if (!live) return;
    const ctx = live.getContext("2d")!;
    const accent = accentRef.current;
    ctx.clearRect(0, 0, boot.mw, boot.mh);
    const s = selRef.current;
    const dNow = dragRef.current;
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    // 遮罩挖孔：确认选区优先；左键拖拽中 = 实时拖拽矩形——区域内无遮罩、
    // 区域外遮罩（PixPin/QQ 惯例，2026-10-27 用户定案）
    const hole = s ?? (dNow ? normalizeSel(dNow.x1, dNow.y1, dNow.x2, dNow.y2, boot.mw, boot.mh, 1) : null);
    if (!hole) {
      ctx.fillRect(0, 0, boot.mw, boot.mh);
    } else {
      ctx.fillRect(0, 0, boot.mw, hole.y);
      ctx.fillRect(0, hole.y + hole.h, boot.mw, boot.mh - hole.y - hole.h);
      ctx.fillRect(0, hole.y, hole.x, hole.h);
      ctx.fillRect(hole.x + hole.w, hole.y, boot.mw - hole.x - hole.w, hole.h);
      if (s) {
        // 选区边框 + 四角/边中手柄（仅确认选区；拖拽中只有边框）
        const bw = Math.max(1, Math.round(scale));
        ctx.strokeStyle = accent;
        ctx.lineWidth = bw;
        ctx.strokeRect(s.x, s.y, s.w, s.h);
        const hsz = 4 * scale;
        ctx.fillStyle = "#fff";
        ctx.lineWidth = Math.max(1, scale);
        for (const hd of [
          [s.x, s.y],
          [s.x + s.w / 2, s.y],
          [s.x + s.w, s.y],
          [s.x + s.w, s.y + s.h / 2],
          [s.x + s.w, s.y + s.h],
          [s.x + s.w / 2, s.y + s.h],
          [s.x, s.y + s.h],
          [s.x, s.y + s.h / 2],
        ]) {
          ctx.fillRect(hd[0] - hsz / 2, hd[1] - hsz / 2, hsz, hsz);
          ctx.strokeRect(hd[0] - hsz / 2, hd[1] - hsz / 2, hsz, hsz);
        }
      }
    }
    // 信息条（参考 PixPin，锚定选区左上角，有选区即常驻）：预选带「窗口」
    // 前缀；拖拽/已确认 = 选区原点+尺寸。锚定优先级：选区外左上 → 选区外
    // 左下（仅预选/已确认）→ 选区内左上
    const pillRect = dNow ? hole : s;
    const pillAnchor = (
      rc: { x: number; y: number; w: number; h: number },
      pw: number,
      ph: number,
      allowBottom: boolean,
    ) => {
      const x = Math.max(8, Math.min(rc.x, boot.mw - pw - 8));
      let y = rc.y - ph - 4;
      if (y >= 8) return { x, y };
      if (allowBottom) {
        y = rc.y + rc.h + 4;
        if (y + ph <= boot.mh - 8) return { x, y };
      }
      return { x: Math.max(8, Math.min(rc.x + 4, boot.mw - pw - 8)), y: rc.y + 4 };
    };
    const drawPill = (
      text: string,
      rc: { x: number; y: number; w: number; h: number },
      allowBottom: boolean,
    ) => {
      const fs = Math.max(13, Math.round(14 * scale));
      ctx.font = `${fs}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      const tw = ctx.measureText(text).width;
      const padX = Math.round(13 * scale);
      const pw = Math.round(tw + padX * 2);
      const ph = Math.round(fs * 1.9);
      const p = pillAnchor(rc, pw, ph, allowBottom);
      // 半透明黑色圆角胶囊（PixPin 参考口径）
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      const r = ph / 2;
      ctx.beginPath();
      ctx.moveTo(p.x + r, p.y);
      ctx.arcTo(p.x + pw, p.y, p.x + pw, p.y + ph, r);
      ctx.arcTo(p.x + pw, p.y + ph, p.x, p.y + ph, r);
      ctx.arcTo(p.x, p.y + ph, p.x, p.y, r);
      ctx.arcTo(p.x, p.y, p.x + pw, p.y, r);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(text, p.x + padX, p.y + ph / 2);
    };
    // 有选区即常驻：预选（含桌面兜底全屏）带「窗口」前缀，拖拽/已确认 =
    // 选区原点+尺寸（截全屏同样可见）
    if (pillRect) {
      if (followingRef.current && !dNow) {
        drawPill(
          `窗口 (${pillRect.x}, ${pillRect.y}) · ${pillRect.w} × ${pillRect.h}`,
          pillRect,
          true,
        );
      } else {
        drawPill(
          `${pillRect.x}, ${pillRect.y}  ${pillRect.w} × ${pillRect.h} px`,
          pillRect,
          !dNow,
        );
      }
    }
    // 阴影/边框预览（已确认选区）：选区外围实时呈现导出效果
    const sbw = Math.round(SHADOW_W[shadowLv] * scale);
    const bbw = Math.round(BORDER_W[borderLv] * scale);
    if (s && !followingRef.current && !dNow && (sbw || bbw)) {
      ctx.save();
      if (sbw) {
        ctx.filter = `blur(${Math.round(sbw / 3)}px)`;
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.lineWidth = sbw;
        ctx.strokeRect(s.x - sbw / 2, s.y - sbw / 2, s.w + sbw, s.h + sbw);
        ctx.filter = "none";
      }
      if (bbw) {
        ctx.strokeStyle = accentRef.current;
        ctx.lineWidth = bbw;
        ctx.strokeRect(s.x - bbw / 2, s.y - bbw / 2, s.w + bbw, s.h + bbw);
      }
      ctx.restore();
    }
    // 全局十字线（启动后定位/水平对比）：跟随态过光标整幅发丝线随光标移动
    // （预选跟随态 sel 恒非空，不能以 !s 为条件），按下拖拽/确认选区后即隐
    // ——此时选区边框 + 尺寸信息接管。颜色 = 主题 accent（与选区边框同色）
    const mag0 = magRef.current;
    if (followingRef.current && !dNow && mag0) {
      drawCrosshair(ctx, mag0.x, mag0.y, boot.mw, boot.mh, scale, accentRef.current);
    }
    // 放大镜/取色器（PixPin 惯例）：跟随态与拖拽态显示，确认选区后隐藏；
    // 取样合成画布，已画标注同样可见（所见即所得）
    const mag = magRef.current;
    const magVisible = !!mag && (followingRef.current || !!dragRef.current);
    // 拖拽中的选区边框（区域内部已在遮罩挖孔中透出定格图，不再叠 8% 着色）；
    // 尺寸并入放大镜信息条（PixPin 同款），无放大镜才单画 pill
    const d = dragRef.current;
    if (d) {
      const r = normalizeSel(d.x1, d.y1, d.x2, d.y2, boot.mw, boot.mh, 1);
      if (r) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = Math.max(1, Math.round(scale));
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
      if (!magVisible) {
        const label = `${Math.round(Math.abs(d.x2 - d.x1))} × ${Math.round(Math.abs(d.y2 - d.y1))}`;
        const fs = 12 * scale;
        ctx.font = `${fs}px "Segoe UI", sans-serif`;
        const tw = ctx.measureText(label).width;
        let lx = d.x2 + 10 * scale;
        let ly = d.y2 + 14 * scale;
        if (lx + tw + 12 * scale > boot.mw) lx = Math.max(4 * scale, d.x2 - tw - 22 * scale);
        if (ly > boot.mh - 10 * scale) ly = d.y2 - 14 * scale;
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.fillRect(lx, ly - fs, tw + 12 * scale, fs * 1.7);
        ctx.fillStyle = "#fff";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(label, lx + 6 * scale, ly + fs * 0.35);
      }
    }
    // 进行中的标注预览（坐标相对选区，clip 内）。马赛克/模糊采样 comp 层——
    // 拖拽中实时出效果（live 层挖孔区透明，采样它预览不可见）
    const dr = drawRef.current;
    if (dr && s && dr.type !== "text") {
      ctx.save();
      ctx.beginPath();
      ctx.rect(s.x, s.y, s.w, s.h);
      ctx.clip();
      drawShape(ctx, dr, s.x, s.y, scale, compRef.current ?? undefined);
      ctx.restore();
    }
    if (mag && magVisible) {
      const sizeLabel = d
        ? `${Math.round(Math.abs(d.x2 - d.x1))} × ${Math.round(Math.abs(d.y2 - d.y1))}`
        : undefined;
      magColorRef.current =
        drawMagnifier(ctx, compRef.current, mag.x, mag.y, boot.mw, boot.mh, scale, {
          sizeLabel,
          color: accentRef.current,
          colorFormat: colorFmtRef.current,
          coordMode: coordRelRef.current ? "relative" : "global",
          origin: hole ? { x: hole.x, y: hole.y } : undefined,
        })?.rgba ?? null;
    }
  }, [boot.mw, boot.mh, scale]);

  useEffect(() => {
    let dead = false;
    void (async () => {
      // 定格帧二进制直传（RGBA 原始字节）→ 离屏画布 putImageData 一次成底，
      // 无 BMP 落盘/asset 协议读回/浏览器解码三跳（各 ~100ms 级）
      const buf = await api.shotFrame();
      if (dead) return;
      if (buf.byteLength !== boot.mw * boot.mh * 4) {
        setSavedTip("截图加载失败");
        // 加载失败也要把窗口放出来展示错误提示，别留在不可见状态
        void api.shotReady().catch(() => undefined);
        return;
      }
      const frame = document.createElement("canvas");
      frame.width = boot.mw;
      frame.height = boot.mh;
      frame
        .getContext("2d")!
        .putImageData(new ImageData(new Uint8ClampedArray(buf), boot.mw, boot.mh), 0, 0);
      imgRef.current = frame;
      for (const c of [baseRef.current, liveRef.current]) {
        if (c) {
          c.width = boot.mw;
          c.height = boot.mh;
        }
      }
      const comp = document.createElement("canvas");
      comp.width = boot.mw;
      comp.height = boot.mh;
      compRef.current = comp;
      accentRef.current =
        getComputedStyle(document.documentElement).getPropertyValue("--np-accent").trim() ||
        "#3574f0";
      setReady(true);
      // 首帧上屏后再让 Rust 移窗上屏；双 rAF 确保画布已被合成器呈现
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          void api.shotReady().catch(() => undefined);
          // 常驻窗停靠屏幕外期间 WebView2 合成器持续在场（不 SW_HIDE），此
          // 处强制重绘一拍只是兜底（驱动异常等极端时序下保证定格图上屏）
          requestAnimationFrame(() => {
            redrawBase();
            redrawLive();
          });
        }),
      );
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready) redrawBase();
  }, [ready, shapes, sel, redrawBase]);
  useEffect(() => {
    if (ready) redrawLive();
  }, [ready, redrawLive]);

  // ── 完成动作 ─────────────────────────────────────────────────────────────
  const closeWindow = useCallback(() => {
    void api.shotClose().catch(() => undefined);
  }, []);

  /** 导出画布 = 裁剪 + 可选装饰（阴影/边框，外扩余量，输出尺寸大于选区）。
   *  装饰开启时导出不再与定格帧逐像素一致（四周多出阴影/边框），调用方
   *  需绕过零 IPC 快路走画布管线 */
  /** 选区合成结果裁剪成独立画布（copy 的像素源，尺寸 = 选区物理像素） */
  const cropCanvas = useCallback(
    (s: Sel): HTMLCanvasElement | null => {
      const comp = compRef.current;
      if (!comp) return null;
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(s.w));
      c.height = Math.max(1, Math.round(s.h));
      c.getContext("2d")!.drawImage(comp, s.x, s.y, s.w, s.h, 0, 0, c.width, c.height);
      return c;
    },
    [],
  );

  const exportCanvas = useCallback(
    (s: Sel): HTMLCanvasElement | null => {
      const base = cropCanvas(s);
      if (!base) return null;
      const sbw = Math.round(SHADOW_W[shadowLv] * scale);
      const bbw = Math.round(BORDER_W[borderLv] * scale);
      if (!sbw && !bbw) return base;
      const m = Math.ceil(sbw * 1.4 + bbw);
      const out = document.createElement("canvas");
      out.width = s.w + m * 2;
      out.height = s.h + m * 2;
      const octx = out.getContext("2d");
      if (!octx) return base;
      if (sbw) {
        octx.save();
        octx.shadowColor = "rgba(0,0,0,0.45)";
        octx.shadowBlur = sbw;
        octx.shadowOffsetY = Math.round(sbw * 0.25);
        octx.fillStyle = "#fff";
        octx.fillRect(m, m, s.w, s.h);
        octx.restore();
      }
      octx.drawImage(base, m, m);
      if (bbw) {
        octx.strokeStyle = color;
        octx.lineWidth = bbw;
        octx.strokeRect(m - bbw / 2, m - bbw / 2, s.w + bbw, s.h + bbw);
      }
      return out;
    },
    [cropCanvas, shadowLv, borderLv, color, scale],
  );

  const exportDataUrl = useCallback(
    (s: Sel): string | null => exportCanvas(s)?.toDataURL("image/png") ?? null,
    [exportCanvas],
  );

  const finish = useCallback(
    async (action: "copy" | "pin" | "save") => {
      const s = selRef.current;
      if (!s || busy) return;
      setBusy(true);
      // 零 IPC 快路公共参数：选区整数矩形（150% 缩放下坐标可能带半像素，
      // 取整对齐像素网格）+ 无标注判定（含未提交的文字输入）——合成结果
      // 像素与 Rust 侧会话定格帧一致，三个动作都能只传矩形由 Rust 进程内裁剪
      // 阴影/边框开启时导出带外扩装饰（尺寸大于选区），必须走画布管线
      const deco = shadowLv > 0 || borderLv > 0;
      const noMarks = !shapesRef.current.length && !editingRef.current && !deco;
      const rx = Math.round(s.x);
      const ry = Math.round(s.y);
      const rw = Math.max(1, Math.round(s.w));
      const rh = Math.max(1, Math.round(s.h));
      try {
        if (action === "copy") {
          // 复制零 IPC 快路：Rust 裁剪定格帧直写剪贴板，写完才收场——免
          // getImageData（GPU→CPU 同步回读）与 RGBA 跨进程拷贝，点击→剪贴板
          // 就绪 ~50ms，且消除旧「先收场、贴上时还没写完」的竞态；失败回落
          // 下方合成直传 / dataURL 路径
          if (noMarks) {
            try {
              await api.shotCopyCrop(rx, ry, rw, rh);
              closeWindow();
              return;
            } catch {
              // 落到下方直传路径
            }
          }
          closeWindow();
          const c = exportCanvas(s);
          if (c) {
            const img = c
              .getContext("2d", { willReadFrequently: true })!
              .getImageData(0, 0, c.width, c.height);
            try {
              await api.shotCopyRaw(img.data, c.width, c.height);
              return;
            } catch {
              // 直传失败落到 dataURL 路径（慢但可靠）
            }
          }
          const dataUrl = exportDataUrl(s);
          if (dataUrl) {
            await api.shotCopy(dataUrl);
          }
          return;
        }
        // 保存/贴图零 IPC 快路优先：只传选区整数矩形、由 Rust 进程内裁剪；
        // 任一环节失败回落下方合成直传 / dataURL 路径
        if (action === "pin") {
          if (noMarks) {
            try {
              await api.shotPinCrop(rx, ry, rw, rh, boot.mx + rx, boot.my + ry);
              closeWindow();
              return;
            } catch {
              // 落到下方直传/dataURL 路径
            }
          }
          const c = exportCanvas(s);
          if (c) {
            const img = c
              .getContext("2d", { willReadFrequently: true })!
              .getImageData(0, 0, c.width, c.height);
            try {
              await api.shotPinRaw(img.data, c.width, c.height, boot.mx + rx, boot.my + ry);
              closeWindow();
              return;
            } catch {
              // 落到下方 dataURL 路径
            }
          }
          await api.shotPin(exportDataUrl(s)!, boot.mx + rx, boot.my + ry, rw, rh);
          closeWindow();
        } else {
          let saved: string | null = null;
          let staged = false; // 暂存成功 = 取消对话框时不能回落（否则弹两次对话框）
          if (noMarks) {
            try {
              await api.shotStageCrop(rx, ry, rw, rh);
              saved = await api.shotSaveRaw();
              staged = true;
            } catch {
              staged = false; // 落到下方合成直传路径
            }
          }
          if (!staged) {
            const c = exportCanvas(s);
            if (c) {
              const img = c
                .getContext("2d", { willReadFrequently: true })!
                .getImageData(0, 0, c.width, c.height);
              try {
                await api.shotStageRaw(img.data, c.width, c.height);
                saved = await api.shotSaveRaw();
                staged = true;
              } catch {
                staged = false; // 落到下方 dataURL 路径
              }
            }
          }
          if (!staged) {
            saved = await api.shotSaveData(exportDataUrl(s)!);
          }
          if (saved) {
            setSavedTip(`已保存 ${saved.split(/[\/]/).pop()}`);
            setTimeout(() => closeWindow(), 1400);
          } else {
            setBusy(false); // 取消保存对话框，回到截图
          }
        }
      } catch (e) {
        setSavedTip(`操作失败：${String(e)}`);
        setBusy(false);
      }
    },
    [boot.mx, boot.my, busy, closeWindow, cropCanvas, exportDataUrl],
  );

  // ── 滚动长截图（§3.6 二期 B 批）：以当前选区开滚动会话，覆盖窗由 Rust 侧
  // 隐藏并接管后续流程（浮条窗 → 拼接 → 结果窗）。两段式：begin 装钩+收场，
  // launch 建浮条起循环（间隙让主循环把覆盖窗停靠消息处理完，防 build 卡死）
  const startScroll = useCallback(() => {
    const s = selRef.current;
    if (!s || busy) return;
    setBusy(true);
    void (async () => {
      try {
        await api.shotScrollBegin(
          Math.round(s.x),
          Math.round(s.y),
          Math.round(s.w),
          Math.round(s.h),
          boot.mx,
          boot.my,
        );
        await api.shotScrollLaunch();
      } catch (e) {
        setSavedTip(`滚动截图启动失败：${String(e)}`);
        setBusy(false);
      }
    })();
  }, [busy, boot.mx, boot.my]);

  // ── 撤销 / 重做 ──────────────────────────────────────────────────────────
  // 两者都同步刷 live 层：redrawBase 不覆盖 live，若 live 有历史预览残影，
  // 撤销删掉 base 图形后残影仍可见（看似"剩一条撤销不干净"）
  const undo = useCallback(() => {
    if (!shapes.length) return;
    setRedoStack((r) => [...r, shapes]);
    setShapes(shapes.slice(0, -1));
    redrawLive();
  }, [shapes, redrawLive]);

  const redo = useCallback(() => {
    if (!redoStack.length) return;
    setShapes(redoStack[redoStack.length - 1]);
    setRedoStack((r) => r.slice(0, -1));
    redrawLive();
  }, [redoStack, redrawLive]);

  // ── 文字编辑（防重入：textarea blur 与画布 pointerdown 可能先后触发）──────
  const commitText = useCallback(() => {
    const ed = editingRef.current;
    if (!ed) return;
    editingRef.current = null;
    setEditing(null);
    const s = selRef.current;
    if (ed.value.trim() && s) {
      const shape: Shape = {
        type: "text",
        x: ed.x,
        y: ed.y,
        w: 0,
        h: 0,
        color,
        width: FONTS[strokeIdx],
        text: ed.value,
      };
      setRedoStack([]);
      setShapes((prev) => [...prev, shape]);
    }
  }, [color, strokeIdx]);

  const beginTextEdit = useCallback(
    (px: number, py: number) => {
      const s = selRef.current;
      if (!s) return;
      const lx = px - s.x;
      const ly = py - s.y;
      setEditing({ x: lx, y: ly, value: "" });
    },
    [],
  );

  /** 立即退出（Esc / 右键，2026-10-27 用户定案）：任意状态直接收场，
   *  不再逐层取消（旧语义：文字 → 绘制 → 拖拽 → 工具 → 选区 → 关闭）。
   *  busy（复制/保存进行中）期间不响应，避免打断另存对话框流程 */
  const exitShot = useCallback(() => {
    if (busy) return;
    closeWindow();
  }, [busy, closeWindow]);

  // ── 指针交互 ─────────────────────────────────────────────────────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (busy) return;
      if (e.button === 2) {
        exitShot();
        return;
      }
      if (e.button !== 0) return;
      const { px, py } = toPhys(e);
      if (editingRef.current) {
        commitText();
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      // 跟随模式下按下 = 自定义框选起点（无论点在预选框内外，PixPin 语义：
      // 按下即脱离跟随，拖拽松开或单击确认新选区）
      if (followingRef.current) {
        followingRef.current = false;
        setFollowing(false);
        dragRef.current = { x1: px, y1: py, x2: px, y2: py };
        setSel(null);
        selRef.current = null;
        setShapes([]);
        shapesRef.current = [];
        setRedoStack([]);
        redrawBase();
        redrawLive();
        return;
      }
      const s = selRef.current;
      // 手柄调整 > 选区内移动（select 工具）> 选区内标注 > 重新框选
      if (s) {
        const hd = handleAt(s, px, py);
        if (hd) {
          resizeRef.current = hd;
          return;
        }
        const inside = px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h;
        if (inside && tool === "select") {
          moveRef.current = { dx: px - s.x, dy: py - s.y };
          return;
        }
        if (inside && tool !== "select") {
          drawRef.current = startShape(tool, px - s.x, py - s.y, color, STROKES[strokeIdx]);
          redrawLive();
          return;
        }
      }
      // 重新框选：清旧选区与标注（QQ 语义 = 全新会话）
      dragRef.current = { x1: px, y1: py, x2: px, y2: py };
      setSel(null);
      selRef.current = null;
      setShapes([]);
      shapesRef.current = [];
      setRedoStack([]);
      redrawBase();
      redrawLive();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, tool, color, strokeIdx, redrawBase, redrawLive, commitText, exitShot],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
    if (busy) return;
    const { px, py } = toPhys(e);
    // 放大镜锚点（跟随/拖拽态显示，确认选区即隐）
    magRef.current =
      followingRef.current || dragRef.current ? { x: px, y: py } : null;
      // 光标形态（跟随模式恒十字准星；确认后才区分手柄/移动）
      const el = e.currentTarget as HTMLElement;
      const s0 = selRef.current;
      if (followingRef.current) {
        el.style.cursor = "crosshair";
      } else if (tool === "select" && s0) {
        const hd = handleAt(s0, px, py);
        const inside = px >= s0.x && px < s0.x + s0.w && py >= s0.y && py < s0.y + s0.h;
        el.style.cursor =
          hd === "n" || hd === "s"
            ? "ns-resize"
            : hd === "e" || hd === "w"
              ? "ew-resize"
              : hd === "nw" || hd === "se"
                ? "nwse-resize"
                : hd === "ne" || hd === "sw"
                  ? "nesw-resize"
                  : inside
                    ? "move"
                    : "crosshair";
      } else {
        el.style.cursor = "crosshair";
      }
      const s = selRef.current;
      if (dragRef.current) {
        dragRef.current.x2 = px;
        dragRef.current.y2 = py;
        redrawLive();
        return;
      }
      if (resizeRef.current && s) {
        const ns = resizeSel(s, resizeRef.current, px, py, boot.mw, boot.mh);
        setSel(ns);
        selRef.current = ns;
        redrawBase();
        redrawLive();
        return;
      }
      if (moveRef.current && s) {
        const nx = Math.max(0, Math.min(px - moveRef.current.dx, boot.mw - s.w));
        const ny = Math.max(0, Math.min(py - moveRef.current.dy, boot.mh - s.h));
        const ns = { ...s, x: nx, y: ny };
        setSel(ns);
        selRef.current = ns;
        redrawBase();
        redrawLive();
        return;
      }
      if (drawRef.current && s) {
        const d = drawRef.current;
        if (d.type === "pen" || d.type === "marker") {
          d.pts?.push({ x: px - s.x, y: py - s.y });
        } else if (d.type !== "text") {
          d.w = px - s.x - d.x;
          d.h = py - s.y - d.y;
        }
        redrawLive();
        return;
      }
      // 预选跟随：选中框实时切到鼠标下窗口（面积最小者优先）；无窗口则空选区
      if (followingRef.current) {
        const hw = hitWindow(boot.windows, px, py);
        const cur = selRef.current;
        const same =
          (!hw && !cur) ||
          (hw && cur && hw.x === cur.x && hw.y === cur.y && hw.w === cur.w && hw.h === cur.h);
        if (!same) {
          setSel(hw);
          selRef.current = hw;
        }
        redrawLive();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, tool, boot.mw, boot.mh, boot.windows, redrawBase, redrawLive],
  );

  const onPointerUp = useCallback(() => {
    if (dragRef.current) {
      const d = dragRef.current;
      dragRef.current = null;
      magRef.current = null; // 选区已确认，放大镜退场（PixPin 语义）
      const r = normalizeSel(d.x1, d.y1, d.x2, d.y2, boot.mw, boot.mh);
      if (r) {
        setSel(r);
        selRef.current = r;
      } else {
        // 单击：命中窗口 = 选中窗口矩形，否则取消选区
        const hw = hitWindow(boot.windows, d.x2, d.y2);
        setSel(hw);
        selRef.current = hw;
      }
      redrawLive();
      return;
    }
    if (resizeRef.current || moveRef.current) {
      resizeRef.current = null;
      moveRef.current = null;
      return;
    }
    const s = selRef.current;
    const d = drawRef.current;
    if (d && s) {
      drawRef.current = null;
      if (d.type === "text") {
        beginTextEdit(s.x + d.x, s.y + d.y);
        return;
      }
      const meaningful =
        d.type === "pen" || d.type === "marker"
          ? (d.pts?.length ?? 0) > 1
          : Math.abs(d.w) > 3 || Math.abs(d.h) > 3;
      if (meaningful) {
        if (d.type !== "pen" && d.type !== "marker" && d.type !== "arrow") {
          // 包围盒归正（负向拖拽翻正）。箭头不参与：w/h 是方向向量，
          // 归正会把负向拖拽的箭头翻成反向（实测踩坑）
          const nx = d.w < 0 ? d.x + d.w : d.x;
          const ny = d.h < 0 ? d.y + d.h : d.y;
          d.x = nx;
          d.y = ny;
          d.w = Math.abs(d.w);
          d.h = Math.abs(d.h);
        }
        setRedoStack([]);
        setShapes((prev) => [...prev, d]);
        // 提交后清 live 层：预览笔画只在 live，不清则残留成已撤销图形的
        // 「影子」（撤销后 base 已删、live 影子仍在，看似撤销不干净）
        redrawLive();
      } else {
        redrawLive();
      }
    }
  }, [boot.mw, boot.mh, boot.windows, redrawLive, beginTextEdit]);

  // ── 键盘 ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitShot();
        return;
      }
      if (composingRef.current) return;
      if (editingRef.current) {
        if (e.key === "Enter") {
          e.preventDefault();
          commitText();
        }
        return;
      }
      // 放大镜快捷键（跟随/拖拽态）：Shift 切换色值格式 / C 复制色值 /
      // P 全局/相对坐标（PixPin 参考口径；带修饰键的组合不劫持）
      const magColor = magColorRef.current;
      const magOn = (followingRef.current || dragRef.current) && magColor !== null;
      if (magOn && magColor && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "Shift") {
          e.preventDefault();
          colorFmtRef.current = colorFmtRef.current === "hex" ? "rgb" : "hex";
          redrawLive();
          return;
        }
        if (e.key === "p" || e.key === "P") {
          e.preventDefault();
          coordRelRef.current = !coordRelRef.current;
          redrawLive();
          return;
        }
        if (e.key === "c" || e.key === "C") {
          e.preventDefault();
          const text = formatMagColor(magColor, colorFmtRef.current);
          void navigator.clipboard
            ?.writeText(text)
            .then(() => {
              setSavedTip(`已复制 ${text}`);
              setTimeout(() => setSavedTip(null), 1200);
            })
            .catch(() => undefined);
          return;
        }
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (ctrl && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "Enter" && selRef.current) {
        e.preventDefault();
        void finish("copy");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitShot, commitText, undo, redo, finish, redrawLive]);

  // ── 工具栏定位（选区下方 12px，放不下换上方；水平居中钳制屏内）──────────
  const [tbPos, setTbPos] = useState<{ left: number; top: number } | null>(null);
  const tbDragRef = useRef<{ dx: number; dy: number } | null>(null);
  /** 拖动过的工具栏粘住手动位置，直到选区重建（新截图/重新框选）才回自动位 */
  const tbDraggedRef = useRef(false);
  /** 弹层设置面板：颜色/线宽/阴影/边框，锚定触发按钮正上方（越界翻转/钳屏） */
  const [panel, setPanel] = useState<{
    kind: "color" | "width" | "shadow" | "border";
    cx: number;
    btnTop: number;
    btnBottom: number;
    left: number;
    top: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openPanel =
    (kind: "color" | "width" | "shadow" | "border") =>
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setPanel((prev) =>
        prev?.kind === kind
          ? null
          : {
              kind,
              cx: r.x + r.width / 2,
              btnTop: r.top,
              btnBottom: r.bottom,
              left: r.x + r.width / 2,
              top: r.top - 70,
            },
      );
    };
  useLayoutEffect(() => {
    const tb = toolbarRef.current;
    const s = sel;
    if (!tb || !s || tbDraggedRef.current) {
      if (!s) {
        setPanel(null);
        tbDraggedRef.current = false;
      }
      setTbPos(null);
      return;
    }
    const r = tb.getBoundingClientRect();
    const sw = boot.mw / scale;
    const sh = boot.mh / scale;
    const cx = (s.x + s.w / 2) / scale;
    const left = Math.max(8, Math.min(cx - r.width / 2, sw - r.width - 8));
    const below = (s.y + s.h) / scale + 12;
    const top = below + r.height + 8 <= sh ? below : Math.max(8, s.y / scale - r.height - 12);
    setTbPos({ left, top });
  }, [sel, ready, scale, boot.mw, boot.mh, shapes, tool, color, strokeIdx]);

  // 工具栏拖动：按住非按钮区（容器空白/尺寸标签/分隔线）拖动，钳制屏内
  const onTbPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("button, .np-shot-palette")) return;
    const tb = toolbarRef.current;
    if (!tb || !tbPos) return;
    e.preventDefault();
    tbDragRef.current = { dx: e.clientX - tbPos.left, dy: e.clientY - tbPos.top };
    tb.setPointerCapture(e.pointerId);
  };
  const onTbPointerMove = (e: React.PointerEvent) => {
    const dg = tbDragRef.current;
    const tb = toolbarRef.current;
    if (!dg || !tb) return;
    const left = Math.max(8, Math.min(e.clientX - dg.dx, (boot.mw / scale) - tb.offsetWidth - 8));
    const top = Math.max(8, Math.min(e.clientY - dg.dy, (boot.mh / scale) - tb.offsetHeight - 8));
    tbDraggedRef.current = true;
    setTbPos({ left, top });
  };
  const onTbPointerUp = (e: React.PointerEvent) => {
    if (!tbDragRef.current) return;
    tbDragRef.current = null;
    toolbarRef.current?.releasePointerCapture(e.pointerId);
  };

  // 弹层面板：工具栏外点击即收
  useEffect(() => {
    if (!panel) return;
    const close = (ev: PointerEvent) => {
      if (!toolbarRef.current?.contains(ev.target as Node)) setPanel(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [panel]);
  // 面板挂载后按实际宽高钳制：水平居中于触发钮且不出屏；按钮正上方放不下
  // （工具栏被拖到贴屏顶）翻到按钮下方
  useLayoutEffect(() => {
    if (!panel) return;
    const el = panelRef.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(panel.cx - w / 2, vw - w - 8));
    let top = panel.btnTop - h - 6;
    if (top < 8) top = Math.min(panel.btnBottom + 6, vh - h - 8);
    if (left !== panel.left || top !== panel.top) setPanel({ ...panel, left, top });
  }, [panel]);

  const strokeBtns =
    tool === "text"
      ? FONTS.map((f, i) => ({ v: i, px: Math.round(f / 6), title: `字号 ${f}px` }))
      : tool === "mosaic" || tool === "blur"
        ? [
            { v: 0, px: 4, title: "弱" },
            { v: 1, px: 7, title: "中" },
            { v: 2, px: 11, title: "强" },
          ]
        : STROKES.map((w, i) => ({ v: i, px: Math.round(w / 1.6) + 2, title: "粗细" }));

  return (
    <div
      className="np-shot"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => {
        if (sel && tool === "select") void finish("copy");
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={baseRef} />
      <canvas ref={liveRef} />
      {editing && sel && (
        <textarea
          className="np-shot-text"
          style={{
            left: (sel.x + editing.x) / scale,
            top: (sel.y + editing.y) / scale,
            fontSize: FONTS[strokeIdx],
            color,
            width: Math.max(60, Math.min(360, (sel.w - editing.x) / scale - 8)),
          }}
          value={editing.value}
          autoFocus
          spellCheck={false}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onCompositionStart={() => (composingRef.current = true)}
          onCompositionEnd={() => (composingRef.current = false)}
          onBlur={commitText}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
      {sel && !busy && !following && (
        <div
          ref={toolbarRef}
          className="np-shot-toolbar"
          style={{
            visibility: tbPos ? "visible" : "hidden",
            left: tbPos?.left ?? -9999,
            top: tbPos?.top ?? -9999,
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            onTbPointerDown(e);
          }}
          onPointerMove={onTbPointerMove}
          onPointerUp={onTbPointerUp}
        >
          <span className="np-shot-grip" data-tip="拖动工具栏">
            <AppIcon icon={GripVertical} size={DENSITY.iconLg} />
          </span>
          <div className="np-shot-tb-rows">
          <div className="np-shot-tb-row">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`np-shot-tool ${tool === t.id ? "on" : ""}`}
                data-tip={t.label}
                onClick={() => setTool(t.id)}
              >
                <AppIcon icon={t.icon} size={DENSITY.iconLg} />
                </button>
            ))}
            <button
              className="np-shot-tool"
              data-tip="撤销"
              data-kbd="Ctrl+Z"
              disabled={!shapes.length}
              onClick={undo}
            >
              <AppIcon icon={Undo2} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool"
              data-tip="重做"
              data-kbd="Ctrl+Y"
              disabled={!redoStack.length}
              onClick={redo}
            >
              <AppIcon icon={Redo2} size={DENSITY.iconLg} />
            </button>
          </div>
          <div className="np-shot-tb-row">
            <button
              className={`np-shot-tool ${panel?.kind === "color" ? "on" : ""}`}
              data-tip="标注颜色"
              onClick={openPanel("color")}
            >
              <AppIcon icon={Palette} size={DENSITY.iconLg} />
            </button>
            <button
              className={`np-shot-tool ${panel?.kind === "width" ? "on" : ""}`}
              data-tip="线条宽度"
              onClick={openPanel("width")}
            >
              <AppIcon icon={PenLine} size={DENSITY.iconLg} />
            </button>
            <button
              className={`np-shot-tool ${shadowLv ? "on" : ""}`}
              data-tip="阴影"
              onClick={openPanel("shadow")}
            >
              <AppIcon icon={Layers} size={DENSITY.iconLg} />
            </button>
            <button
              className={`np-shot-tool ${borderLv ? "on" : ""}`}
              data-tip="边框"
              onClick={openPanel("border")}
            >
              <AppIcon icon={Frame} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-primary"
              data-tip="贴图：钉在屏幕上"
              onClick={() => void finish("pin")}
            >
              <AppIcon icon={Pin} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-primary"
              data-tip="复制到剪贴板 · 双击选区同效"
              data-kbd="Enter"
              onClick={() => void finish("copy")}
            >
              <AppIcon icon={Copy} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-primary"
              data-tip="保存为 PNG 文件"
              onClick={() => void finish("save")}
            >
              <AppIcon icon={Save} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-primary"
              data-tip="滚动截图：滚轮下滚拼接长图"
              onClick={startScroll}
            >
              <AppIcon icon={GalleryVerticalEnd} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-danger"
              data-tip="取消截图"
              data-kbd="Esc"
              onClick={closeWindow}
            >
              <AppIcon icon={X} size={DENSITY.iconLg} />
            </button>
          </div>
          </div>
          {panel && (
            <div
              ref={panelRef}
              className="np-shot-palette"
              style={{ position: "fixed", left: panel.left, top: panel.top }}
            >
              <div className="np-shot-pal-row">
                {panel.kind === "color" &&
                  SHOT_PALETTE.map((c) => (
                    <button
                      key={c}
                      className={`np-shot-dot ${color === c ? "on" : ""}`}
                      style={{ background: c }}
                      data-tip="标注颜色"
                      onClick={() => {
                        setColor(c);
                        setPanel(null);
                      }}
                    />
                  ))}
                {panel.kind === "width" &&
                  strokeBtns.map((w) => (
                    <button
                      key={w.v}
                      className={`np-shot-tool ${strokeIdx === w.v ? "on" : ""}`}
                      data-tip={w.title}
                      onClick={() => {
                        setStrokeIdx(w.v);
                        setPanel(null);
                      }}
                    >
                      <span className="np-shot-wdot" style={{ width: w.px, height: w.px }} />
                    </button>
                  ))}
                {(panel.kind === "shadow" || panel.kind === "border") &&
                  SHADOW_LV_LABEL.map((lbl, v) => (
                    <button
                      key={v}
                      className={`np-shot-tool ${
                        (panel.kind === "shadow" ? shadowLv : borderLv) === v ? "on" : ""
                      }`}
                      data-tip={lbl}
                      onClick={() => {
                        (panel.kind === "shadow" ? setShadowLv : setBorderLv)(v);
                        setPanel(null);
                      }}
                    >
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
      {savedTip && <div className="np-shot-saved">{savedTip}</div>}
      {following && !sel && !busy && (
        <div className="np-shot-hint">移动选择窗口 · 按住拖拽自定义区域 · Esc 退出</div>
      )}
      {!following && !sel && !busy && <div className="np-shot-hint">拖拽框选区域 · 点击选中窗口 · Esc 退出</div>}
    </div>
  );
}

interface DragState {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
