// 截图覆盖层（§3.6，常驻覆盖窗经 shot-session 事件驱动挂载）：定格截图铺底 +
// 智能窗口识别（进会话默认预选光标下窗口）+ 选区（拖拽/手柄调整/整体移动/
// WASD·方向键平移）+ 标注（矩形/椭圆/箭头〔点击弹面板选头部×线型〕/画笔·
// 马克笔〔一钮弹面板选笔型〕/文字/序号标记〔点按即落，同一截图自动递增〕）
// + 马赛克/模糊 + 复制/保存/贴图。
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
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  Circle,
  Frame,
  Grip,
  GripVertical,
  Highlighter,
  Layers,
  MousePointer2,
  MoveUpRight,
  Palette,
  Pencil,
  PenLine,
  Pin,
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
  type ArrowHead,
  type ArrowLine,
  type BadgeShape,
  type HandleId,
  type MagColorFormat,
  type Sel,
  type Shape,
  arrowWingsAt,
  arrowBaseAt,
  arrowCurveCtrl,
  drawCrosshair,
  drawMagnifier,
  drawShape,
  formatMagColor,
  handleAt,
  hitWindow,
  adjustShapeProp,
  nextStepSeq,
  normalizeSel,
  resizeSel,
  shapeAt,
  shapeBounds,
  translateShape,
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
/** 阴影模糊半径 / 边框线宽滑块量程（CSS 像素观感值，随 scale 增密；0 = 关） */
const SHADOW_W_MAX = 30;
const BORDER_W_MAX = 10;
/** 边框颜色色板（黑色在前 = 默认；与标注色板同色系） */
const BORDER_PALETTE = [
  "#000000",
  "#ffffff",
  "#e5484d",
  "#f76b15",
  "#ffc53d",
  "#46a758",
  "#00a2c7",
  "#3b82f6",
  "#1c1c1c",
];

/** 箭头样式面板文案（头部 × 线条两行独立设置） */
const ARROW_HEAD_LABELS: Record<ArrowHead, string> = {
  line: "箭头头部：单线",
  solid: "箭头头部：实心三角",
  hollow: "箭头头部：空心三角",
};
const ARROW_LINE_LABELS: Record<ArrowLine, string> = {
  solid: "箭头线条：直线",
  dashed: "箭头线条：虚线",
  curve: "箭头线条：曲线",
};

/** 箭头样式预览字形（28×16 SVG，currentColor 随按钮态着色；几何与
 *  annot.drawShape 同源——曲线控制点 / 头部两翼复用同一套纯函数） */function ArrowGlyph({ head, line }: { head: ArrowHead; line: ArrowLine }) {
  const f = (n: number) => Math.round(n * 10) / 10;
  const x1 = 3;
  const y1 = 13;
  const x2 = 25;
  const y2 = 3;
  const c = line === "curve" ? arrowCurveCtrl(x1, y1, x2, y2) : null;
  const ang = c ? Math.atan2(y2 - c.cy, x2 - c.cx) : Math.atan2(y2 - y1, x2 - x1);
  const g = arrowWingsAt(x2, y2, ang, 8);
  // 空心头：杆止于翼基线 + 两翼开放（与 drawShape 同口径，空腔透出）
  const base = head === "hollow" ? arrowBaseAt(x2, y2, ang, 8) : null;
  const ex = base ? f(base.x) : x2;
  const ey = base ? f(base.y) : y2;
  const body = c
    ? `M${x1} ${y1} Q${f(c.cx)} ${f(c.cy)} ${ex} ${ey}`
    : `M${x1} ${y1} L${ex} ${ey}`;
  const tri = `M${x2} ${y2} L${f(g.ax)} ${f(g.ay)} L${f(g.bx)} ${f(g.by)} Z`;
  return (
    <svg
      className="np-shot-arw"
      viewBox="0 0 28 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={head === "solid" ? 1.4 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={body} strokeDasharray={line === "dashed" ? "3 2.5" : undefined} />
      {head === "solid" ? (
        <path d={tri} fill="currentColor" />
      ) : (
        <>
          <path d={`M${x2} ${y2} L${f(g.ax)} ${f(g.ay)}`} />
          <path d={`M${x2} ${y2} L${f(g.bx)} ${f(g.by)}`} />
        </>
      )}
    </svg>
  );
}

/** 滚动截图图标（2026-10-30 用户定案样式：竖屏圆角矩形 + 内嵌上下双向
 *  箭头 = 「选区内上下滚动拼接」）。lucide 现库无此组合单图标，按 lucide
 *  同风格自绘（24 viewBox / stroke 2 / 圆角端点 / currentColor，同
 *  ArrowGlyph 先例非 lucide 不走 AppIcon）；rect 几何取自 RectangleVertical */
function ScrollShotGlyph() {
  return (
    <svg
      className="np-shot-scroll-ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="12" height="20" x="6" y="2" rx="2" />
      <path d="M12 6v12" />
      <path d="m9 9 3-3 3 3" />
      <path d="m9 15 3 3 3-3" />
    </svg>
  );
}

/** 序号标记工具图标（2026-10-30 三次定案：纯单徽——在二选一定案「单徽+
 *  放置加号」基础上去掉 + 号，只留居中数字圆徽）。lucide 无数字圆徽单
 *  图标，按 lucide 同风格自绘（同 ScrollShotGlyph/ArrowGlyph 先例）；
 *  数字用 text 无描边（fill currentColor，粗体随系统 UI 字体） */
function StepMarkGlyph() {
  return (
    <svg
      className="np-shot-step-ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <text
        x="12"
        y="12.8"
        fontSize="10"
        fontWeight="700"
        textAnchor="middle"
        dominantBaseline="middle"
        stroke="none"
        fill="currentColor"
      >
        1
      </text>
    </svg>
  );
}

/** 开始一个标注草稿（pointerdown；坐标相对选区，物理像素）。箭头附带
 *  当前的头部/线条样式设置；style = 2026-10-30 标记增强的通用样式
 *  （虚实/实心/圆角/双向/圆形区域） */
function startShape(
  tool: ShotTool,
  x: number,
  y: number,
  color: string,
  stroke: number,
  arw?: { head: ArrowHead; line: ArrowLine; two: boolean },
  style?: {
    dash?: boolean;
    filled?: boolean;
    radius?: number;
    round?: boolean;
  },
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
    head: tool === "arrow" ? (arw?.head ?? "line") : undefined,
    line: tool === "arrow" ? (arw?.line ?? "solid") : undefined,
    two: tool === "arrow" ? (arw?.two ?? false) : undefined,
    dash:
      tool === "rect" || tool === "ellipse" || tool === "pen" || tool === "marker"
        ? (style?.dash ?? false)
        : undefined,
    filled: tool === "rect" || tool === "ellipse" ? (style?.filled ?? false) : undefined,
    radius: tool === "rect" ? (style?.radius ?? 0) : undefined,
    round: tool === "mosaic" || tool === "blur" ? (style?.round ?? false) : undefined,
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
  /** 悬停标记下标（滚轮编辑目标指示）：pointermove 探测 shapeAt，命中
   *  变化才重绘 live 层画选中框；undo/redo/重选后失效置 null */
  const hoverRef = useRef<number | null>(null);
  /** 已落标记拖动移位（2026-10-30 标记增强）：idx + 上帧指针位；snapshot
   *  = 抓取时的形状快照，首个实际位移才 pushUndo（点一下不动不污染栈） */
  const moveMarkRef = useRef<{
    idx: number;
    lastX: number;
    lastY: number;
    snapshot: Shape[];
    moved: boolean;
  } | null>(null);
  /** 标注显隐 toggle（2026-10-30 标记增强）：Tab 临时隐藏全部标注看原图，
   *  仅影响显示层（comp/导出仍含标注） */
  const hiddenRef = useRef(false);
  /** 悬停标记右键菜单（2026-10-30 标记增强）：删除/克隆/置前/置后 */
  const [markMenu, setMarkMenu] = useState<{ x: number; y: number } | null>(null);
  const markMenuIdxRef = useRef<number | null>(null);
  /** 文字再编辑（2026-10-30 标记增强）：双击已落文字回编辑态，提交时
   *  原位替换（idx 非空）而非追加新文字 */
  const editingIdxRef = useRef<number | null>(null);
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
  const [shadowW, setShadowW] = useState(0);
  const [borderW, setBorderW] = useState(0);
  const [borderColor, setBorderColor] = useState("#000000");
  /** 标注偏好持久化：读自 settings.json（装饰三键 + 滚轮记忆五键），改动
   *  防抖 400ms 经 shot_save_prefs 白名单补丁写回（多次改动按键合并，
   *  只发最后一次）；收场动作前 flushPrefs 立即冲刷——防抖窗内退出应用
   *  会丢末次调节（2026-10-30 用户复报排查补） */
  const prefsTimer = useRef<number | null>(null);
  const pendingPrefs = useRef<Record<string, unknown>>({});
  const flushPrefs = useCallback(() => {
    if (prefsTimer.current !== null) {
      window.clearTimeout(prefsTimer.current);
      prefsTimer.current = null;
    }
    const batch = pendingPrefs.current;
    if (Object.keys(batch).length) {
      pendingPrefs.current = {};
      void api.shotSavePrefs(batch).catch(() => undefined);
    }
  }, []);
  const savePrefs = useCallback(
    (patch: Record<string, unknown>) => {
      Object.assign(pendingPrefs.current, patch);
      if (prefsTimer.current !== null) window.clearTimeout(prefsTimer.current);
      prefsTimer.current = window.setTimeout(() => {
        prefsTimer.current = null;
        flushPrefs();
      }, 400);
    },
    [flushPrefs],
  );
  useEffect(() => {
    let dead = false;
    void api
      .getSettings()
      .then((st) => {
        if (dead) return;
        const clampv = (v: unknown, max: number) => {
          const n = Math.round(Number(v));
          return Number.isFinite(n) ? Math.min(Math.max(0, n), max) : 0;
        };
        setShadowW(clampv(st?.shotShadowW, SHADOW_W_MAX));
        setBorderW(clampv(st?.shotBorderW, BORDER_W_MAX));
        if (typeof st?.shotBorderColor === "string" && st.shotBorderColor) {
          setBorderColor(st.shotBorderColor);
        }
        // 滚轮记忆（2026-10-30 定案）：逐类型宽度/尺寸/不透明度从 settings
        // 读回（会话内即成为新图形默认值），越界值退回中间档默认
        const clampw = (v: unknown, lo: number, hi: number, d: number) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
        };
        setStrokeW(clampw(st?.shotStrokeW, 1, 30, STROKES[1]));
        setTextFont(clampw(st?.shotTextFont, 10, 80, FONTS[1]));
        setStepW(clampw(st?.shotStepW, 1, 20, STROKES[1]));
        setMosaicW(clampw(st?.shotMosaicW, 2, 20, STROKES[1]));
        setBlurAlpha(clampw(st?.shotBlurAlpha, 0.15, 1, 1));
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      if (prefsTimer.current !== null) window.clearTimeout(prefsTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  /** 画笔/马克笔合并为一钮（2026-10-30 二次定案）：点击按钮 = 激活笔族并
   *  立即弹出 pen 面板选择笔型（图标固定 Pencil 不随笔型切换）；从其他
   *  工具切入 = 恢复上次笔型 */
  const [penType, setPenType] = useState<"pen" | "marker">("pen");
  /** 箭头样式（头部 × 线条，独立两行设置；箭头钮再次点击开面板） */
  const [headStyle, setHeadStyle] = useState<ArrowHead>("line");
  const [lineStyle, setLineStyle] = useState<ArrowLine>("solid");
  const [color, setColor] = useState(SHOT_PALETTE[0]);
  /** 逐类型线宽/尺寸（连续值，滚轮调节后随动并持久化——「滚轮记忆」
   *  2026-10-30 定案；旧三档预设索引表达不了 1~30 连续值已弃）。三档
   *  预设面板点击也写这些值（会话级，不持久化）；blurW 例外：模糊半径
   *  只由预设档控制（滚轮调的是 alpha），保持会话级 */
  const [strokeW, setStrokeW] = useState(STROKES[1]); // 线形 1~30
  const [textFont, setTextFont] = useState(FONTS[1]); // 10~80
  const [stepW, setStepW] = useState(STROKES[1]); // 序号圈 1~20
  const [mosaicW, setMosaicW] = useState(STROKES[1]); // 马赛克 2~20
  const [blurW, setBlurW] = useState(STROKES[1]); // 模糊半径（预设档）
  const [blurAlpha, setBlurAlpha] = useState(1); // 0.15~1 持久化
  /** 2026-10-30 标记增强·样式维度（会话级，不持久化）：矩形/椭圆实心与
   *  虚线、矩形圆角、箭头双向、文字高亮/粗斜体、序号形状、马赛克/模糊
   *  圆形区域——新图形落笔时快照进 Shape */
  const [fillOn, setFillOn] = useState(false);
  const [dashOn, setDashOn] = useState(false);
  const [rectRadius, setRectRadius] = useState(0);
  const [twoWay, setTwoWay] = useState(false);
  const [txtHL, setTxtHL] = useState(false);
  const [txtBold, setTxtBold] = useState(false);
  const [txtItalic, setTxtItalic] = useState(false);
  const [badgeShape, setBadgeShape] = useState<BadgeShape>("circle");
  const [maskRound, setMaskRound] = useState(false);
  const [shapes, setShapes] = useState<Shape[]>([]);
  /** 撤销栈 = 每次变更（落新图形 / 滚轮编辑一阵）前的完整快照。旧模型只有
   *  「摘最后一个图形」语义，滚轮编辑后 Ctrl+Z 会整删被调的图形而非回退
   *  参数——2026-10-30 滚轮编辑引入，快照模型对两类操作统一 */
  const [undoStack, setUndoStack] = useState<Shape[][]>([]);
  const [redoStack, setRedoStack] = useState<Shape[][]>([]);
  const [editing, setEditing] = useState<{ x: number; y: number; value: string } | null>(null);
  const [savedTip, setSavedTip] = useState<string | null>(null);
  /** 拖拽尺寸 HUD 的自动清除定时器（pointermove 高频更新，到达静止后收起） */
  const hudDragTimer = useRef<number | null>(null);
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
    if (s && !hiddenRef.current) {
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
    const sbw = Math.round(shadowW * scale);
    const bbw = Math.round(borderW * scale);
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
        ctx.strokeStyle = borderColor;
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
    // 悬停标记选中框（滚轮编辑目标指示，2026-10-30）：accent 虚线包围盒
    // + 内侧留白，随标记滚轮调节后的新尺寸即时重画
    const hov = hoverRef.current;
    if (hov !== null && s && !followingRef.current && !dragRef.current) {
      const hs = shapesRef.current[hov];
      if (hs) {
        const b = shapeBounds(hs, scale);
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.lineWidth = Math.max(1, Math.round(scale));
        ctx.setLineDash([5 * scale, 3 * scale]);
        ctx.strokeRect(
          s.x + b.x - 3 * scale,
          s.y + b.y - 3 * scale,
          b.w + 6 * scale,
          b.h + 6 * scale,
        );
        ctx.setLineDash([]);
        ctx.restore();
      }
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
      const sbw = Math.round(shadowW * scale);
      const bbw = Math.round(borderW * scale);
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
        octx.strokeStyle = borderColor;
        octx.lineWidth = bbw;
        octx.strokeRect(m - bbw / 2, m - bbw / 2, s.w + bbw, s.h + bbw);
      }
      return out;
    },
    [cropCanvas, shadowW, borderW, borderColor, color, scale],
  );

  const exportDataUrl = useCallback(
    (s: Sel): string | null => exportCanvas(s)?.toDataURL("image/png") ?? null,
    [exportCanvas],
  );

  const finish = useCallback(
    async (action: "copy" | "pin" | "save") => {
      const s = selRef.current;
      if (!s || busy) return;
      // 收场前冲刷未落盘的滚轮记忆/装饰偏好（防抖窗内退出会丢末次调节）
      flushPrefs();
      setBusy(true);
      // 零 IPC 快路公共参数：选区整数矩形（150% 缩放下坐标可能带半像素，
      // 取整对齐像素网格）+ 无标注判定（含未提交的文字输入）——合成结果
      // 像素与 Rust 侧会话定格帧一致，三个动作都能只传矩形由 Rust 进程内裁剪
      // 阴影/边框开启时导出带外扩装饰（尺寸大于选区），必须走画布管线
      const deco = shadowW > 0 || borderW > 0;
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
          // 闪动修复（2026-10-30）：先挂 pin-shown 监听再触发建窗——贴图窗
          // 在专用线程建（WebView2 数百毫秒），期间蒙层保持在场盖住裸奔期；
          // Rust 在贴图窗 show 后发 pin-shown，到达（或 2.5s 兜底）才收蒙层，
          // 视觉上贴图原地顶替选区、遮罩随后退场。旧时序点击即收蒙层 =
          // 整屏遮罩闪没 + 贴图迟到半秒的双重闪动
          let pinClosed = false;
          let unPin: (() => void) | null = null;
          const closeAfterPin = () => {
            if (pinClosed) return;
            pinClosed = true;
            unPin?.();
            closeWindow();
          };
          void listen<void>("pin-shown", closeAfterPin).then((u) => {
            if (pinClosed) u();
            else unPin = u;
          });
          window.setTimeout(closeAfterPin, 2500);
          if (noMarks) {
            try {
              await api.shotPinCrop(rx, ry, rw, rh, boot.mx + rx, boot.my + ry);
              return; // 收场交 pin-shown / 兜底定时器
            } catch {
              // 落到下方直传/dataURL 路径
            }
          }
          // 贴图 = 精确选区内容（cropCanvas，含标注）：窗口尺寸/落位与所见
          // 选区逐像素一致——不走 exportCanvas（阴影/边框装饰会外扩画布，
          // 贴图比选区大一圈且偏移，2026-10-30 定案装饰只属于复制/保存）
          const c = cropCanvas(s);
          if (c) {
            const img = c
              .getContext("2d", { willReadFrequently: true })!
              .getImageData(0, 0, c.width, c.height);
            try {
              await api.shotPinRaw(img.data, c.width, c.height, boot.mx + rx, boot.my + ry);
              return; // 同上
            } catch {
              // 落到下方 dataURL 路径
            }
          }
          const pinUrl = cropCanvas(s)?.toDataURL("image/png");
          await api.shotPin(pinUrl!, boot.mx + rx, boot.my + ry, rw, rh);
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
    [boot.mx, boot.my, busy, closeWindow, cropCanvas, exportDataUrl, flushPrefs],
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
  // 快照模型：undo 恢复 undoStack 顶快照、当前态压入 redo；redo 对称。
  // 两者都同步刷 live 层：redrawBase 不覆盖 live，若 live 有历史预览残影，
  // 撤销删掉 base 图形后残影仍可见（看似"剩一条撤销不干净"）
  const undo = useCallback(() => {
    if (!undoStack.length) return;
    const snap = undoStack[undoStack.length - 1];
    setUndoStack((u) => u.slice(0, -1));
    setRedoStack((r) => [...r, shapesRef.current]);
    setShapes(snap);
    hoverRef.current = null; // 快照回退后下标失效
    redrawLive();
  }, [undoStack, redrawLive]);

  const redo = useCallback(() => {
    if (!redoStack.length) return;
    const snap = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u, shapesRef.current]);
    setShapes(snap);
    hoverRef.current = null;
    redrawLive();
  }, [redoStack, redrawLive]);

  /** 落新图形 / 编辑前记账：压撤销快照 + 清重做（标准编辑器语义）。
   *  滚轮调节按「一阵」合帧（600ms 内连滚只记首帧快照），否则每格滚轮
   *  一个撤销项会把栈灌满 */
  const wheelEditRef = useRef<{ at: number } | null>(null);
  const pushUndo = useCallback((cur: Shape[]) => {
    setUndoStack((u) => [...u, cur]);
    setRedoStack([]);
  }, []);
  const noteWheelEdit = useCallback(() => {
    const now = Date.now();
    const burst = wheelEditRef.current && now - wheelEditRef.current.at <= 600;
    wheelEditRef.current = { at: now };
    return burst;
  }, []);

  // ── 标记操作（2026-10-30 标记增强）：删除/换色/克隆/置前/置后/显隐，
  //     全部走快照栈记账（滚轮编辑同语义）；换色复用 600ms 编辑阵合帧 ──
  const delMark = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= shapesRef.current.length) return;
      pushUndo(shapesRef.current);
      shapesRef.current = shapesRef.current.filter((_, i) => i !== idx);
      setShapes(shapesRef.current);
      hoverRef.current = null;
      redrawLive();
    },
    [pushUndo, redrawLive],
  );

  const recolorMark = useCallback(
    (idx: number, c: string) => {
      const cur = shapesRef.current[idx];
      if (!cur) return;
      if (cur.color === c) return;
      if (!noteWheelEdit()) pushUndo(shapesRef.current);
      shapesRef.current = shapesRef.current.slice();
      shapesRef.current[idx] = { ...cur, color: c };
      setShapes(shapesRef.current);
      setColor(c); // 同步为新图形默认色
      redrawLive();
    },
    [pushUndo, noteWheelEdit, redrawLive],
  );

  const cloneMark = useCallback(
    (idx: number) => {
      const src = shapesRef.current[idx];
      if (!src) return;
      pushUndo(shapesRef.current);
      // 菜单克隆带 8css 斜下偏移可见「复制出一枚」；Alt+拖动克隆则跟手
      const off = Math.round(8 * scale);
      const clone = translateShape({ ...src, pts: src.pts?.map((p) => ({ ...p })) }, off, off);
      shapesRef.current = [...shapesRef.current, clone];
      hoverRef.current = shapesRef.current.length - 1;
      setShapes(shapesRef.current);
      redrawLive();
    },
    [pushUndo, redrawLive, scale],
  );

  const zorderMark = useCallback(
    (idx: number, front: boolean) => {
      if (idx < 0 || idx >= shapesRef.current.length) return;
      pushUndo(shapesRef.current);
      const arr = shapesRef.current.slice();
      const [it] = arr.splice(idx, 1);
      if (front) arr.push(it);
      else arr.unshift(it);
      shapesRef.current = arr;
      hoverRef.current = front ? arr.length - 1 : 0;
      setShapes(arr);
      redrawLive();
    },
    [pushUndo, redrawLive],
  );

  /** Tab 显隐全部标注：仅显示层（base 不画标注看原图），comp/导出仍含
   *  标注；隐藏态禁一切标记交互（悬停/滚轮/删除/换色） */
  const toggleHidden = useCallback(() => {
    hiddenRef.current = !hiddenRef.current;
    hoverRef.current = null;
    setSavedTip(hiddenRef.current ? "标注已隐藏（Tab 恢复）" : "标注已恢复");
    setTimeout(() => setSavedTip(null), 1200);
    redrawBase();
    redrawLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redrawBase, redrawLive]);

  /** 右键菜单动作分发（2026-10-30 标记增强） */
  const markOp = useCallback(
    (op: "del" | "clone" | "front" | "back") => {
      const idx = markMenuIdxRef.current;
      markMenuIdxRef.current = null;
      setMarkMenu(null);
      if (idx === null || !shapesRef.current[idx]) return;
      if (op === "del") delMark(idx);
      else if (op === "clone") cloneMark(idx);
      else zorderMark(idx, op === "front");
    },
    [delMark, cloneMark, zorderMark],
  );

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
        width: textFont,
        text: ed.value,
        highlight: txtHL || undefined,
        bold: txtBold || undefined,
        italic: txtItalic || undefined,
      };
      // 双击再编辑（2026-10-30 标记增强）：editingIdx 非空 = 原位替换
      const idx = editingIdxRef.current;
      editingIdxRef.current = null;
      pushUndo(shapesRef.current);
      if (idx !== null && shapesRef.current[idx]) {
        shapesRef.current = shapesRef.current.slice();
        shapesRef.current[idx] = shape;
        setShapes(shapesRef.current);
      } else {
        setShapes((prev) => [...prev, shape]);
      }
    } else {
      editingIdxRef.current = null;
    }
  }, [color, textFont, txtHL, txtBold, txtItalic, pushUndo]);

  const beginTextEdit = useCallback(
    (px: number, py: number) => {
      const s = selRef.current;
      if (!s) return;
      const lx = px - s.x;
      const ly = py - s.y;
      editingIdxRef.current = null;
      setEditing({ x: lx, y: ly, value: "" });
    },
    [],
  );

  /** 双击已落文字回编辑态（2026-10-30 标记增强）：带入原文与原位，提交替换 */
  const reEditText = useCallback((idx: number) => {
    const s = selRef.current;
    const sh = shapesRef.current[idx];
    if (!s || !sh || sh.type !== "text") return;
    editingIdxRef.current = idx;
    setEditing({ x: sh.x, y: sh.y, value: sh.text ?? "" });
  }, []);

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
      // 悬停标记右键菜单内点击放行（菜单按钮自处理）；菜单外任意按下收起
      if ((e.target as Element).closest(".np-shot-markmenu")) return;
      if (markMenu) setMarkMenu(null);
      if (e.button === 2) {
        // 右键在悬停标记上 = 上下文菜单（删除/克隆/置前/置后），否则退出
        const s0 = selRef.current;
        const hov = hoverRef.current;
        if (s0 && hov !== null && !hiddenRef.current) {
          const { px: rx, py: ry } = toPhys(e);
          const idx = shapeAt(shapesRef.current, rx - s0.x, ry - s0.y, 8 * scale, scale);
          if (idx !== null) {
            markMenuIdxRef.current = idx;
            hoverRef.current = idx;
            setMarkMenu({
              x: Math.min(e.clientX, window.innerWidth - 150),
              y: Math.min(e.clientY, window.innerHeight - 160),
            });
            redrawLive();
            return;
          }
        }
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
        setUndoStack([]);
        setRedoStack([]);
        hoverRef.current = null;
        moveMarkRef.current = null;
        wheelEditRef.current = null;
        redrawBase();
        redrawLive();
        return;
      }
      const s = selRef.current;
      // 手柄调整 > 已落标记抓取（移动/Alt 克隆）> 选区内移动（select 工具）
      // > 选区内标注 > 重新框选
      if (s) {
        const hd = handleAt(s, px, py);
        if (hd) {
          resizeRef.current = hd;
          return;
        }
        const inside = px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h;
        // 已落标记抓取（2026-10-30 标记增强）：悬停标记上按下 = 拖动移位
        // （Alt+按下 = 克隆后拖动克隆体）；画新标记要落在没有旧标记的地方
        // ——实心形整面命中即整面可抓，属于该交互的既定取舍
        if (inside && !hiddenRef.current) {
          const hovIdx = hoverRef.current;
          if (hovIdx !== null && shapesRef.current[hovIdx]) {
            let idx = hovIdx;
            if (e.altKey) {
              const src = shapesRef.current[hovIdx];
              const clone: Shape = {
                ...src,
                pts: src.pts?.map((p) => ({ ...p })),
              };
              pushUndo(shapesRef.current);
              shapesRef.current = [...shapesRef.current, clone];
              idx = shapesRef.current.length - 1;
              setShapes(shapesRef.current);
            }
            moveMarkRef.current = {
              idx,
              lastX: px,
              lastY: py,
              snapshot: shapesRef.current,
              moved: false,
            };
            hoverRef.current = idx;
            redrawLive();
            return;
          }
        }
        if (inside && tool === "select") {
          moveRef.current = { dx: px - s.x, dy: py - s.y };
          return;
        }
        // 序号标记：点按即落（无拖拽草稿——徽标尺寸由线宽档决定，与落点
        // 无关），数字按 nextStepSeq 自动递增；撤销摘掉最后徽标后数字回退
        // 复用。x/y = 中心（drawShape step 分支口径）
        if (inside && tool === "step") {
          const shape: Shape = {
            type: "step",
            x: px - s.x,
            y: py - s.y,
            w: 0,
            h: 0,
            color,
            width: stepW,
            seq: nextStepSeq(shapesRef.current),
            badge: badgeShape,
          };
          pushUndo(shapesRef.current);
          shapesRef.current = [...shapesRef.current, shape];
          hoverRef.current = shapesRef.current.length - 1; // 落标即选中（光标就在其上）
          moveMarkRef.current = null;
          setShapes(shapesRef.current);
          redrawLive();
          return;
        }
        if (inside && tool !== "select") {
          // 逐类型当前宽度：马赛克/模糊有独立档位（模糊半径只走预设，
          // 滚轮调的是 alpha），其余线形共用 strokeW；模糊草稿带上滚轮
          // 记忆的不透明度（drawShape blur 分支消费）
          const curW = tool === "mosaic" ? mosaicW : tool === "blur" ? blurW : strokeW;
          const draft = startShape(
            tool,
            px - s.x,
            py - s.y,
            color,
            curW,
            { head: headStyle, line: lineStyle, two: twoWay },
            { dash: dashOn, filled: fillOn, radius: rectRadius, round: maskRound },
          );
          if (draft && tool === "blur") draft.alpha = blurAlpha;
          drawRef.current = draft;
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
      setUndoStack([]);
      setRedoStack([]);
      hoverRef.current = null;
      moveMarkRef.current = null;
      setMarkMenu(null);
      wheelEditRef.current = null;
      redrawBase();
      redrawLive();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      busy,
      tool,
      color,
      strokeW,
      mosaicW,
      blurW,
      stepW,
      headStyle,
      lineStyle,
      twoWay,
      dashOn,
      fillOn,
      rectRadius,
      maskRound,
      badgeShape,
      blurAlpha,
      markMenu,
      scale,
      redrawBase,
      redrawLive,
      commitText,
      exitShot,
    ],
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
      if (moveMarkRef.current && s) {
        // 已落标记拖动移位：首帧记账（点住不动不进撤销栈），之后整形平移
        const mm = moveMarkRef.current;
        const dx = px - mm.lastX;
        const dy = py - mm.lastY;
        if (dx || dy) {
          if (!mm.moved) {
            mm.moved = true;
            pushUndo(mm.snapshot);
          }
          mm.lastX = px;
          mm.lastY = py;
          shapesRef.current = shapesRef.current.slice();
          shapesRef.current[mm.idx] = translateShape(shapesRef.current[mm.idx], dx, dy);
          setShapes(shapesRef.current);
          redrawLive();
        }
        return;
      }
      if (drawRef.current && s) {
        const d = drawRef.current;
        if (d.type === "pen" || d.type === "marker") {
          d.pts?.push({ x: px - s.x, y: py - s.y });
        } else if (d.type !== "text") {
          let w = px - s.x - d.x;
          let h = py - s.y - d.y;
          // Shift 约束（2026-10-30 标记增强）：框形 = 正方形（马赛克/模糊
          // 同理），箭头 = 角度吸附 45° 系
          if (e.shiftKey) {
            if (d.type === "arrow") {
              const len = Math.hypot(w, h);
              const a = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
              w = Math.cos(a) * len;
              h = Math.sin(a) * len;
            } else {
              const m = Math.max(Math.abs(w), Math.abs(h));
              w = Math.sign(w || 1) * m;
              h = Math.sign(h || 1) * m;
            }
          }
          d.w = w;
          d.h = h;
          // 拖拽实时尺寸 HUD（同标记增强）：框形 W×H，箭头线长
          const label =
            d.type === "arrow"
              ? `${Math.round(Math.hypot(d.w, d.h))}px`
              : `${Math.round(Math.abs(d.w))} × ${Math.round(Math.abs(d.h))} px`;
          setSavedTip(label);
          if (hudDragTimer.current !== null) window.clearTimeout(hudDragTimer.current);
          hudDragTimer.current = window.setTimeout(() => setSavedTip(null), 700);
        }
        redrawLive();
        return;
      }
      // 悬停标记探测（滚轮编辑目标指示）：到此处时各拖拽/绘制分支均已
      // return，只剩自由移动态；跟随态不探测（无标注可悬停）；标注隐藏
      // 时不探测（不可见即不可交互）。命中变化才重绘 live
      if (!followingRef.current && s) {
        const idx = hiddenRef.current
          ? null
          : shapeAt(shapesRef.current, px - s.x, py - s.y, 8 * scale, scale);
        if (idx !== hoverRef.current) {
          hoverRef.current = idx;
          redrawLive();
        }
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
    [busy, tool, boot.mw, boot.mh, boot.windows, redrawBase, redrawLive, pushUndo],
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
    // 已落标记拖动收场（未移动 = 一次普通点按，不记账）
    if (moveMarkRef.current) {
      moveMarkRef.current = null;
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
        pushUndo(shapesRef.current);
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
      // Tab = 显隐全部标注（2026-10-30 标记增强，仅显示层）
      if (e.key === "Tab" && !busy) {
        e.preventDefault();
        toggleHidden();
        return;
      }
      // Del/Backspace = 删除悬停标记（不依赖选中工具）
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !busy &&
        hoverRef.current !== null &&
        !hiddenRef.current
      ) {
        e.preventDefault();
        delMark(hoverRef.current);
        return;
      }
      // 1~8 = 悬停标记换色（色板位序，同步为新图形默认色）
      if (
        /^[1-8]$/.test(e.key) &&
        !busy &&
        hoverRef.current !== null &&
        !hiddenRef.current
      ) {
        e.preventDefault();
        recolorMark(hoverRef.current, SHOT_PALETTE[Number(e.key) - 1]);
        return;
      }
      // WASD / 方向键微调（2026-10-30 定案）：跟随态（十字准星）/拖拽中 =
      // 移动真实光标（Rust SetCursorPos，指针流自然接管十字线/放大镜/预选
      // 窗口跟随与拖拽终点）；已确认选区 = 整体平移选区框（标注坐标相对
      // 选区，随框联动）。Shift = 10 物理像素大步；带修饰键组合不劫持
      const NUDGE: Record<string, [number, number]> = {
        arrowleft: [-1, 0],
        a: [-1, 0],
        arrowright: [1, 0],
        d: [1, 0],
        arrowup: [0, -1],
        w: [0, -1],
        arrowdown: [0, 1],
        s: [0, 1],
      };
      const nd = NUDGE[e.key.toLowerCase()];
      if (nd && !e.ctrlKey && !e.metaKey && !e.altKey && !busy) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        if (followingRef.current || dragRef.current) {
          const cur = magRef.current ?? { x: boot.cx, y: boot.cy };
          // 目标钳制在显示器内并换算回实际允许位移（贴边按键不再外移）
          const tx = Math.max(0, Math.min(cur.x + nd[0] * step, boot.mw - 1));
          const ty = Math.max(0, Math.min(cur.y + nd[1] * step, boot.mh - 1));
          const dx = tx - cur.x;
          const dy = ty - cur.y;
          if (dx || dy) void api.shotNudgeCursor(dx, dy).catch(() => undefined);
        } else {
          const s = selRef.current;
          if (s && !drawRef.current && !resizeRef.current && !moveRef.current) {
            const ns = {
              ...s,
              x: Math.max(0, Math.min(s.x + nd[0] * step, boot.mw - s.w)),
              y: Math.max(0, Math.min(s.y + nd[1] * step, boot.mh - s.h)),
            };
            setSel(ns);
            selRef.current = ns;
            redrawBase();
            redrawLive();
          }
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
      // Ctrl+P = 贴图（与 Enter=复制同族的完成动作快捷键）
      if (ctrl && e.key.toLowerCase() === "p" && selRef.current) {
        e.preventDefault();
        void finish("pin");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitShot, commitText, undo, redo, finish, redrawLive, busy, toggleHidden, delMark, recolorMark]);

  // ── 滚轮调节标记（2026-10-30 定案：悬停指哪调哪）────────────────────────
  // 光标悬停在哪个标记上滚轮就调哪个（shapeAt 线形命中描边带、面形命中包围
  // 盒），逐档增减（adjustShapeProp）：线形线宽 / 文字字号 / 序号圈尺寸 /
  // 马赛克格子 / 模糊不透明度；HUD 显示当前值，600ms 连滚合为一阵撤销。
  // 原生监听（passive:false）——React 合成 wheel 在部分环境按 passive 挂载，
  // preventDefault 无效会带着页面滚（覆盖层虽无滚动条，防御性收掉）
  const hudTimer = useRef<number | null>(null);
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (busy || e.ctrlKey || e.metaKey || e.altKey) return;
      if (hiddenRef.current) return;
      const s = selRef.current;
      if (!s) return;
      const px = Math.round(e.clientX * scale);
      const py = Math.round(e.clientY * scale);
      const inside = px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h;
      if (!inside) return;
      const idx = shapeAt(shapesRef.current, px - s.x, py - s.y, 8 * scale, scale);
      if (idx === null) return;
      e.preventDefault();
      const cur = shapesRef.current[idx];
      const dir: 1 | -1 = e.deltaY < 0 ? 1 : -1;
      // Shift+滚轮 = 矩形圆角（2026-10-30 标记增强；主滚轮仍是线宽）
      if (e.shiftKey && cur.type === "rect") {
        const r = Math.min(24, Math.max(0, (cur.radius ?? 0) + dir * 2));
        if (r === (cur.radius ?? 0)) return;
        if (!noteWheelEdit()) pushUndo(shapesRef.current);
        shapesRef.current = shapesRef.current.slice();
        shapesRef.current[idx] = { ...cur, radius: r };
        setShapes(shapesRef.current);
        redrawLive();
        setSavedTip(`圆角 ${r}px`);
        if (hudTimer.current !== null) window.clearTimeout(hudTimer.current);
        hudTimer.current = window.setTimeout(() => setSavedTip(null), 900);
        return;
      }
      const adj = adjustShapeProp(cur, dir);
      if (!adj) return;
      const changed =
        adj.shape.width !== cur.width || adj.shape.alpha !== cur.alpha;
      if (!changed) return; // 已在量程端点，不记账不重绘
      if (!noteWheelEdit()) pushUndo(shapesRef.current);
      const next = shapesRef.current.slice();
      next[idx] = adj.shape;
      shapesRef.current = next;
      setShapes(next);
      redrawLive(); // 选中框随调节后的新尺寸即时重画
      // 滚轮记忆（2026-10-30 定案）：调节值同步为本类型新图形的默认值
      // （会话内立即生效）并按键防抖持久化到 settings.json（下次会话沿用）
      switch (adj.shape.type) {
        case "rect":
        case "ellipse":
        case "arrow":
        case "pen":
        case "marker":
          setStrokeW(adj.shape.width);
          savePrefs({ shotStrokeW: adj.shape.width });
          break;
        case "text":
          setTextFont(adj.shape.width);
          savePrefs({ shotTextFont: adj.shape.width });
          break;
        case "step":
          setStepW(adj.shape.width);
          savePrefs({ shotStepW: adj.shape.width });
          break;
        case "mosaic":
          setMosaicW(adj.shape.width);
          savePrefs({ shotMosaicW: adj.shape.width });
          break;
        case "blur":
          setBlurAlpha(adj.shape.alpha ?? 1);
          savePrefs({ shotBlurAlpha: adj.shape.alpha ?? 1 });
          break;
      }
      setSavedTip(adj.label);
      if (hudTimer.current !== null) window.clearTimeout(hudTimer.current);
      hudTimer.current = window.setTimeout(() => setSavedTip(null), 900);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
      if (hudTimer.current !== null) window.clearTimeout(hudTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, scale, pushUndo, noteWheelEdit, redrawLive]);

  // ── 工具栏定位（选区下方 12px，放不下换上方；水平居中钳制屏内）──────────
  const [tbPos, setTbPos] = useState<{ left: number; top: number } | null>(null);
  const tbDragRef = useRef<{ dx: number; dy: number } | null>(null);
  /** 拖动过的工具栏粘住手动位置，直到选区重建（新截图/重新框选）才回自动位 */
  const tbDraggedRef = useRef(false);
  /** 弹层设置面板：颜色/线宽/阴影/边框/箭头样式/笔型，锚定触发按钮正上方（越界翻转/钳屏） */
  const [panel, setPanel] = useState<{
    kind: "color" | "width" | "shadow" | "border" | "arrow" | "pen" | "shape" | "text" | "step" | "mask";
    cx: number;
    btnTop: number;
    btnBottom: number;
    left: number;
    top: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openPanel =
    (kind: "color" | "width" | "shadow" | "border" | "arrow" | "pen" | "shape" | "text" | "step" | "mask") =>
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
  }, [sel, ready, scale, boot.mw, boot.mh, shapes, tool, color, strokeW, textFont]);

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

  /** 宽度预设三档（2026-10-30 起值为连续量：v = 绝对值，选中态按值比较——
   *  滚轮调到档间值时无高亮，点预设回落到档值） */
  const strokeBtns =
    tool === "text"
      ? FONTS.map((f) => ({ v: f, px: Math.round(f / 6), title: `字号 ${f}px` }))
      : tool === "mosaic" || tool === "blur"
        ? STROKES.map((f, i) => ({ v: f, px: 4 + i * 3.5, title: ["弱", "中", "强"][i] }))
        : STROKES.map((f) => ({ v: f, px: Math.round(f / 1.6) + 2, title: "粗细" }));
  const curToolW =
    tool === "text"
      ? textFont
      : tool === "mosaic"
        ? mosaicW
        : tool === "blur"
          ? blurW
          : strokeW;
  const applyWidthPreset = (v: number) => {
    if (tool === "text") setTextFont(v);
    else if (tool === "mosaic") setMosaicW(v);
    else if (tool === "blur") setBlurW(v);
    else setStrokeW(v);
  };

  /** 工具行按钮（画笔/马克笔、箭头 = 点击立即弹设置面板选择，
   *  2026-10-30 二次定案：不做图标随动切换） */
  const penActive = tool === "pen" || tool === "marker";
  const toolBtns: {
    id: ShotTool;
    label: string;
    icon?: typeof Square;
    /** 自绘图标（lucide 无对应单图标时；优先于 icon 渲染） */
    glyph?: React.ReactNode;
    on: boolean;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  }[] = [
    { id: "select", label: "选择 / 移动选区", icon: MousePointer2, on: tool === "select", onClick: () => setTool("select") },
    {
      id: "rect",
      label: "矩形（点击设置样式）",
      icon: Square,
      on: tool === "rect",
      onClick: (e) => {
        setTool("rect");
        openPanel("shape")(e);
      },
    },
    {
      id: "ellipse",
      label: "椭圆（点击设置样式）",
      icon: Circle,
      on: tool === "ellipse",
      onClick: (e) => {
        setTool("ellipse");
        openPanel("shape")(e);
      },
    },
    {
      id: "arrow",
      label: "箭头（点击设置样式）",
      icon: MoveUpRight,
      on: tool === "arrow",
      onClick: (e) => {
        setTool("arrow");
        openPanel("arrow")(e);
      },
    },
    {
      id: "pen",
      label: "画笔 / 马克笔（点击选笔型）",
      icon: Pencil,
      on: penActive,
      onClick: (e) => {
        setTool(penType);
        openPanel("pen")(e);
      },
    },
    {
      id: "text",
      label: "文字（点击设置样式）",
      icon: Type,
      on: tool === "text",
      onClick: (e) => {
        setTool("text");
        openPanel("text")(e);
      },
    },
    {
      id: "step",
      label: "序号标记（同一截图自动递增）",
      glyph: <StepMarkGlyph />,
      on: tool === "step",
      onClick: (e) => {
        setTool("step");
        openPanel("step")(e);
      },
    },
    {
      id: "mosaic",
      label: "马赛克（点击设置样式）",
      icon: Grip,
      on: tool === "mosaic",
      onClick: (e) => {
        setTool("mosaic");
        openPanel("mask")(e);
      },
    },
    {
      id: "blur",
      label: "模糊（点击设置样式）",
      icon: Waves,
      on: tool === "blur",
      onClick: (e) => {
        setTool("blur");
        openPanel("mask")(e);
      },
    },
  ];

  return (
    <div
      className="np-shot"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => {
        // 双击已落文字 = 回编辑态（2026-10-30 标记增强）；其余维持
        // 双击选区 = 复制并关闭
        const hov = hoverRef.current;
        if (
          sel &&
          hov !== null &&
          !hiddenRef.current &&
          shapesRef.current[hov]?.type === "text"
        ) {
          e.preventDefault();
          reEditText(hov);
          return;
        }
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
            fontSize: textFont,
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
          data-tip-up=""
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
            {toolBtns.map((t) => (
              <button
                key={t.id}
                className={`np-shot-tool ${t.on ? "on" : ""}`}
                data-tip={t.label}
                onClick={t.onClick}
              >
                {t.glyph ?? <AppIcon icon={t.icon!} size={DENSITY.iconLg} />}
              </button>
            ))}
            <button
              className="np-shot-tool"
              data-tip="撤销"
              data-kbd="Ctrl+Z"
              disabled={!undoStack.length}
              onClick={undo}
            >
              <AppIcon icon={Undo2} size={DENSITY.iconLg} />
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
              className={`np-shot-tool ${shadowW ? "on" : ""}`}
              data-tip={`阴影 ${shadowW}px`}
              onClick={openPanel("shadow")}
            >
              <AppIcon icon={Layers} size={DENSITY.iconLg} />
            </button>
            <button
              className={`np-shot-tool ${borderW ? "on" : ""}`}
              data-tip={`边框 ${borderW}px`}
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
              data-tip="滚动截图：滚轮下滚拼接长图"
              onClick={startScroll}
            >
              <ScrollShotGlyph />
            </button>
            {/* 行尾三钮（2026-10-30 定案）：保存 → 关闭 → 复制并关闭 */}
            <button
              className="np-shot-tool np-shot-primary"
              data-tip="保存为 PNG 文件"
              onClick={() => void finish("save")}
            >
              <AppIcon icon={Save} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-danger"
              data-tip="取消截图"
              data-kbd="Esc"
              onClick={closeWindow}
            >
              <AppIcon icon={X} size={DENSITY.iconLg} />
            </button>
            <button
              className="np-shot-tool np-shot-ok"
              data-tip="复制并关闭 · 双击选区同效"
              data-kbd="Enter"
              onClick={() => void finish("copy")}
            >
              <AppIcon icon={Check} size={DENSITY.iconLg} />
            </button>
          </div>
          </div>
          {panel && (
            <div
              ref={panelRef}
              className="np-shot-palette"
              style={{ position: "fixed", left: panel.left, top: panel.top }}
            >
              {panel.kind === "pen" && (
                <div className="np-shot-pal-row">
                  {(["pen", "marker"] as const).map((p) => (
                    <button
                      key={p}
                      className={`np-shot-tool ${penType === p ? "on" : ""}`}
                      data-tip={p === "pen" ? "画笔" : "马克笔"}
                      onClick={() => {
                        setPenType(p);
                        setTool(p);
                        setPanel(null);
                      }}
                    >
                      <AppIcon icon={p === "pen" ? Pencil : Highlighter} size={DENSITY.iconLg} />
                    </button>
                  ))}
                </div>
              )}
              {panel.kind === "arrow" && (
                <div className="np-shot-pal-row">
                  {(["line", "solid", "hollow"] as ArrowHead[]).map((h) => (
                    <button
                      key={`h-${h}`}
                      className={`np-shot-tool ${headStyle === h ? "on" : ""}`}
                      data-tip={ARROW_HEAD_LABELS[h]}
                      onClick={() => setHeadStyle(h)}
                    >
                      <ArrowGlyph head={h} line="solid" />
                    </button>
                  ))}
                </div>
              )}
              {panel.kind === "arrow" && (
                <div className="np-shot-pal-row">
                  {(["solid", "dashed", "curve"] as ArrowLine[]).map((l) => (
                    <button
                      key={`l-${l}`}
                      className={`np-shot-tool ${lineStyle === l ? "on" : ""}`}
                      data-tip={ARROW_LINE_LABELS[l]}
                      onClick={() => setLineStyle(l)}
                    >
                      <ArrowGlyph head="line" line={l} />
                    </button>
                  ))}
                </div>
              )}
              {/* 双向箭头（2026-10-30 标记增强）：首尾同头部样式 */}
              {panel.kind === "arrow" && (
                <div className="np-shot-pal-row">
                  <button
                    className={`np-shot-tool ${!twoWay ? "on" : ""}`}
                    data-tip="单向"
                    onClick={() => setTwoWay(false)}
                  >
                    <span className="np-shot-tglyph">→</span>
                  </button>
                  <button
                    className={`np-shot-tool ${twoWay ? "on" : ""}`}
                    data-tip="双向"
                    onClick={() => setTwoWay(true)}
                  >
                    <span className="np-shot-tglyph">↔</span>
                  </button>
                </div>
              )}
              {/* 矩形/椭圆样式（2026-10-30 标记增强）：空心↔半透明实心、
                  直↔虚线、矩形圆角（Shift+滚轮也可调已落矩形圆角） */}
              {panel.kind === "shape" && (
                <>
                  <div className="np-shot-pal-row">
                    <button
                      className={`np-shot-tool ${!fillOn ? "on" : ""}`}
                      data-tip="空心"
                      onClick={() => setFillOn(false)}
                    >
                      <span
                        className="np-shot-sw"
                        style={{
                          borderRadius: tool === "ellipse" ? "50%" : 3,
                          border: "2px solid currentColor",
                        }}
                      />
                    </button>
                    <button
                      className={`np-shot-tool ${fillOn ? "on" : ""}`}
                      data-tip="半透明实心"
                      onClick={() => setFillOn(true)}
                    >
                      <span
                        className="np-shot-sw"
                        style={{
                          borderRadius: tool === "ellipse" ? "50%" : 3,
                          background: "currentColor",
                        }}
                      />
                    </button>
                    <button
                      className={`np-shot-tool ${!dashOn ? "on" : ""}`}
                      data-tip="实线"
                      onClick={() => setDashOn(false)}
                    >
                      <span className="np-shot-line" />
                    </button>
                    <button
                      className={`np-shot-tool ${dashOn ? "on" : ""}`}
                      data-tip="虚线"
                      onClick={() => setDashOn(true)}
                    >
                      <span className="np-shot-line np-shot-line-dash" />
                    </button>
                  </div>
                  {tool === "rect" && (
                    <div className="np-shot-slider">
                      <input
                        type="range"
                        min={0}
                        max={24}
                        step={1}
                        value={rectRadius}
                        onChange={(e) => setRectRadius(Number(e.target.value))}
                      />
                      <span className="np-shot-slider-val">
                        {rectRadius === 0 ? "直角" : `圆角 ${rectRadius}px`}
                      </span>
                    </div>
                  )}
                </>
              )}
              {/* 文字样式（2026-10-30 标记增强）：高亮底色 / 粗体 / 斜体 */}
              {panel.kind === "text" && (
                <div className="np-shot-pal-row">
                  <button
                    className={`np-shot-tool ${!txtHL ? "on" : ""}`}
                    data-tip="无底色"
                    onClick={() => setTxtHL(false)}
                  >
                    <span className="np-shot-tglyph">A</span>
                  </button>
                  <button
                    className={`np-shot-tool ${txtHL ? "on" : ""}`}
                    data-tip="高亮底色"
                    onClick={() => setTxtHL(true)}
                  >
                    <span className="np-shot-tglyph np-shot-tglyph-hl">A</span>
                  </button>
                  <button
                    className={`np-shot-tool ${txtBold ? "on" : ""}`}
                    data-tip="粗体"
                    onClick={() => setTxtBold(!txtBold)}
                  >
                    <span className="np-shot-tglyph" style={{ fontWeight: 700 }}>
                      B
                    </span>
                  </button>
                  <button
                    className={`np-shot-tool ${txtItalic ? "on" : ""}`}
                    data-tip="斜体"
                    onClick={() => setTxtItalic(!txtItalic)}
                  >
                    <span className="np-shot-tglyph" style={{ fontStyle: "italic" }}>
                      I
                    </span>
                  </button>
                </div>
              )}
              {/* 序号徽标形状（2026-10-30 标记增强）：圆形 / 方形 / 纯数字 */}
              {panel.kind === "step" && (
                <div className="np-shot-pal-row">
                  {(
                    [
                      ["circle", "圆形"],
                      ["square", "方形"],
                      ["plain", "纯数字"],
                    ] as [BadgeShape, string][]
                  ).map(([b, t]) => (
                    <button
                      key={b}
                      className={`np-shot-tool ${badgeShape === b ? "on" : ""}`}
                      data-tip={t}
                      onClick={() => setBadgeShape(b)}
                    >
                      {b === "plain" ? (
                        <span className="np-shot-tglyph">1</span>
                      ) : (
                        <span
                          className="np-shot-sw"
                          style={{
                            borderRadius: b === "circle" ? "50%" : 3,
                            background: "currentColor",
                          }}
                        />
                      )}
                    </button>
                  ))}
                </div>
              )}
              {/* 马赛克/模糊区域形状（2026-10-30 标记增强）：方形 / 圆形 */}
              {panel.kind === "mask" && (
                <div className="np-shot-pal-row">
                  <button
                    className={`np-shot-tool ${!maskRound ? "on" : ""}`}
                    data-tip="方形区域"
                    onClick={() => setMaskRound(false)}
                  >
                    <span className="np-shot-sw" style={{ borderRadius: 3, background: "currentColor" }} />
                  </button>
                  <button
                    className={`np-shot-tool ${maskRound ? "on" : ""}`}
                    data-tip="圆形区域"
                    onClick={() => setMaskRound(true)}
                  >
                    <span className="np-shot-sw" style={{ borderRadius: "50%", background: "currentColor" }} />
                  </button>
                </div>
              )}
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
                      className={`np-shot-tool ${curToolW === w.v ? "on" : ""}`}
                      data-tip={w.title}
                      onClick={() => {
                        applyWidthPreset(w.v);
                        setPanel(null);
                      }}
                    >
                      <span className="np-shot-wdot" style={{ width: w.px, height: w.px }} />
                    </button>
                  ))}
                {panel.kind === "border" && (
                  <div className="np-shot-slider np-shot-bdcolors">
                    {BORDER_PALETTE.map((c) => (
                      <button
                        key={c}
                        className={`np-shot-dot ${borderColor === c ? "on" : ""}`}
                        style={{ background: c }}
                        data-tip="边框颜色"
                        onClick={() => {
                          setBorderColor(c);
                          savePrefs({ shotBorderColor: c });
                        }}
                      />
                    ))}
                  </div>
                )}
                {(panel.kind === "shadow" || panel.kind === "border") && (
                  <div className="np-shot-slider">
                    <input
                      type="range"
                      min={0}
                      max={panel.kind === "shadow" ? SHADOW_W_MAX : BORDER_W_MAX}
                      step={1}
                      value={panel.kind === "shadow" ? shadowW : borderW}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        (panel.kind === "shadow" ? setShadowW : setBorderW)(v);
                        savePrefs(
                          panel.kind === "shadow"
                            ? { shotShadowW: v }
                            : { shotBorderW: v },
                        );
                      }}
                    />
                    <span className="np-shot-slider-val">
                      {panel.kind === "shadow" ? shadowW : borderW}px
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {/* HUD（滚轮调节当前值 / 保存提示）：选区存在时锚定选区内顶部居中
          （2026-10-30 定案「选区内部中上方」），无选区回退窗顶居中 */}
      {savedTip && (
        <div
          className="np-shot-saved"
          style={
            sel
              ? { left: (sel.x + sel.w / 2) / scale, top: sel.y / scale + 12 }
              : undefined
          }
        >
          {savedTip}
        </div>
      )}
      {/* 悬停标记右键菜单（2026-10-30 标记增强）：删除/克隆/置前/置后 */}
      {markMenu && (
        <div className="np-shot-markmenu" style={{ left: markMenu.x, top: markMenu.y }}>
          <button onClick={() => markOp("del")}>删除标记</button>
          <button onClick={() => markOp("clone")}>克隆标记</button>
          <button onClick={() => markOp("front")}>置前</button>
          <button onClick={() => markOp("back")}>置后</button>
          <div className="np-shot-pinmenu-hint">拖动移位 · Alt+拖动克隆 · 1-8 换色 · Del 删除</div>
        </div>
      )}
      {following && !sel && !busy && (
        <div className="np-shot-hint">
          移动选择窗口 · 按住拖拽自定义区域 · WASD/方向键微调准星 · Esc 退出
        </div>
      )}
      {!following && !sel && !busy && (
        <div className="np-shot-hint">拖拽框选区域 · 点击选中窗口 · WASD/方向键移动选区 · Esc 退出</div>
      )}
    </div>
  );
}

interface DragState {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
