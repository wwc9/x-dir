// 截图标注纯函数与绘制（§3.6）：选区归一/调整、箭头头部、窗口命中、
// 图形绘制。坐标全部为物理像素；颜色为画布内容色（随图保存的像素，
// 不随主题，非 UI 语义色——同 fileIcons 语义色逻辑，不适用 --np-* 禁令）。

export type ShotTool =
  | "select"
  | "rect"
  | "ellipse"
  | "arrow"
  | "pen"
  | "marker"
  | "text"
  | "mosaic"
  | "blur";

/** 箭头头部样式：单线 V 翼 / 实心三角 / 空心三角 */
export type ArrowHead = "line" | "solid" | "hollow";
/** 箭头线条类型：直线 / 虚线 / 曲线（二次贝塞尔） */
export type ArrowLine = "solid" | "dashed" | "curve";

export interface Shape {
  type: Exclude<ShotTool, "select">;
  /** 包围盒（相对选区左上角的物理像素；pen/marker 用 pts） */
  x: number;
  y: number;
  w: number;
  h: number;
  pts?: { x: number; y: number }[];
  color: string;
  /** 线宽 / 文字字号（CSS 像素，绘制时 ×scale） */
  width: number;
  text?: string;
  /** 箭头专属：头部样式 / 线条类型（缺省 = line/solid，旧会话图形兼容） */
  head?: ArrowHead;
  line?: ArrowLine;
}

/** 画布内容色板（QQ 标注惯用色系） */
export const SHOT_PALETTE = [
  "#e5484d",
  "#f76b15",
  "#ffc53d",
  "#46a758",
  "#00a2c7",
  "#3b82f6",
  "#ffffff",
  "#1c1c1c",
];

/** 拖拽矩形归一（负向拖拽翻正）并钳制到屏内；小于 minSize 视为点击（返回 null） */
export function normalizeSel(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  mw: number,
  mh: number,
  minSize = 6,
): { x: number; y: number; w: number; h: number } | null {
  const x = Math.max(0, Math.min(x1, x2));
  const y = Math.max(0, Math.min(y1, y2));
  const w = Math.min(mw, Math.max(x1, x2)) - x;
  const h = Math.min(mh, Math.max(y1, y2)) - y;
  if (w < minSize || h < minSize) return null;
  return { x, y, w, h };
}

export interface Sel {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** 8 个调整手柄中心（物理像素） */
export function selHandles(s: Sel): { id: HandleId; x: number; y: number }[] {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  return [
    { id: "nw", x: s.x, y: s.y },
    { id: "n", x: cx, y: s.y },
    { id: "ne", x: s.x + s.w, y: s.y },
    { id: "e", x: s.x + s.w, y: cy },
    { id: "se", x: s.x + s.w, y: s.y + s.h },
    { id: "s", x: cx, y: s.y + s.h },
    { id: "sw", x: s.x, y: s.y + s.h },
    { id: "w", x: s.x, y: cy },
  ];
}

/** 手柄命中测试（tol = 物理像素容差） */
export function handleAt(s: Sel, px: number, py: number, tol = 10): HandleId | null {
  for (const h of selHandles(s)) {
    if (Math.abs(px - h.x) <= tol && Math.abs(py - h.y) <= tol) return h.id;
  }
  return null;
}

/** 拖手柄调整选区（钳制屏内，保持 ≥ 最小尺寸） */
export function resizeSel(
  s: Sel,
  handle: HandleId,
  px: number,
  py: number,
  mw: number,
  mh: number,
): Sel {
  let x1 = s.x;
  let y1 = s.y;
  let x2 = s.x + s.w;
  let y2 = s.y + s.h;
  if (handle.includes("w")) x1 = Math.min(px, x2 - 8);
  if (handle.includes("e")) x2 = Math.max(px, x1 + 8);
  if (handle.includes("n")) y1 = Math.min(py, y2 - 8);
  if (handle.includes("s")) y2 = Math.max(py, y1 + 8);
  return {
    x: Math.max(0, x1),
    y: Math.max(0, y1),
    w: Math.min(mw, x2) - Math.max(0, x1),
    h: Math.min(mh, y2) - Math.max(0, y1),
  };
}

/** 箭头头部两翼端点（沿给定切向角的 ±25° 张角；曲线箭头末端切向 =
 *  端点 - 贝塞尔控制点，头部随切向自然转向） */
export function arrowWingsAt(
  tipX: number,
  tipY: number,
  angle: number,
  headLen: number,
): { ax: number; ay: number; bx: number; by: number } {
  const wing = (off: number) => ({
    x: tipX - headLen * Math.cos(angle + off),
    y: tipY - headLen * Math.sin(angle + off),
  });
  const a = wing(Math.PI / 7);
  const b = wing(-Math.PI / 7);
  return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
}

/** 箭头头部两翼端点（线段末端的 ±25° 张角） */
export function arrowHead(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  headLen: number,
): { ax: number; ay: number; bx: number; by: number } | null {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1) return null;
  return arrowWingsAt(x2, y2, Math.atan2(y2 - y1, x2 - x1), headLen);
}

/** 曲线箭头二次贝塞尔控制点：起终点中点沿方向左侧法线偏移 22% 线长
 *  （弓高随箭头长短自适应；统一偏向行进方向左侧，成图方向可预期） */
export function arrowCurveCtrl(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { cx: number; cy: number } {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return { cx: mx - (y2 - y1) * 0.22, cy: my + (x2 - x1) * 0.22 };
}

/** 可截目标命中：候选按 z 序（前→后）排列且已经过 Rust 侧可见层过滤
 *  （被盖住的后层窗口不在列表中），取第一个包含点的矩形；末尾为整显示器
 *  桌面兜底，自然最后命中 */
export function hitWindow(
  windows: { x: number; y: number; w: number; h: number }[],
  px: number,
  py: number,
): { x: number; y: number; w: number; h: number } | null {
  for (const r of windows) {
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) {
      return r;
    }
  }
  return null;
}

// ── 放大镜/取色器（PixPin 惯例：无选区跟随态与拖拽态显示，确认选区即隐）───

/** 取样网格边长（源物理像素）与放大倍率：13px × 16 = 208px 取景框，
 *  块 16px——内容比旧 10×15 更大更易读（PixPin 参考口径） */
export const MAGNIFIER_SRC = 13;
export const MAGNIFIER_ZOOM = 16;
/** 取景框与光标的最小间距（物理像素） */
export const MAGNIFIER_GAP = 18;

export type MagColorFormat = "hex" | "rgb";
export type MagCoordMode = "global" | "relative";

/** #rrggbb → rgba() 串（网格线/中心像素淡染用）；非法输入退回白色 */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 取色值格式化：hex 大写 / rgb() 逗号串（Shift 切换） */
export function formatMagColor(
  rgba: readonly [number, number, number, number],
  format: MagColorFormat,
): string {
  const [r, g, b] = rgba;
  if (format === "rgb") return `rgb(${r}, ${g}, ${b})`;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** 放大镜坐标格式化：全局 = 显示器物理坐标；相对 = 相对 origin（选区/拖拽
 *  矩形左上，P 切换；无 origin 时退回全局） */
export function formatMagCoords(
  ix: number,
  iy: number,
  mode: MagCoordMode,
  origin?: { x: number; y: number },
): string {
  if (mode === "relative" && origin) return `相对 (${ix - origin.x}, ${iy - origin.y})`;
  return `(${ix}, ${iy})`;
}

/** 信息面板文字度量（barH 与绘制共用同一套，防止两处漂移） */
function magPanelMetrics(scale: number): { fs: number; lineH: number; pad: number; lines: number } {
  const fs = Math.max(13, Math.round(13 * scale));
  const lineH = Math.round(fs * 1.5);
  return { fs, lineH, pad: Math.round(fs * 0.5), lines: 5 };
}

/** 放大镜取景框边长 / 信息面板高度（物理像素） */
export function magnifierBox(scale = 1): { box: number; barH: number } {
  const box = MAGNIFIER_SRC * MAGNIFIER_ZOOM;
  const { lineH, pad, lines } = magPanelMetrics(scale);
  return { box, barH: pad * 2 + lineH * lines };
}

/** 放大镜布局：默认落在光标右下，越屏翻转；极小屏钳到原点兜底 */
export function magnifierLayout(
  px: number,
  py: number,
  mw: number,
  mh: number,
  scale = 1,
): { boxX: number; boxY: number; barY: number } {
  const { box, barH } = magnifierBox(scale);
  const total = box + barH;
  let boxX = px + MAGNIFIER_GAP;
  let boxY = py + MAGNIFIER_GAP;
  if (boxX + box > mw) boxX = px - MAGNIFIER_GAP - box;
  if (boxY + total > mh) boxY = py - MAGNIFIER_GAP - total;
  return {
    boxX: Math.max(0, boxX),
    boxY: Math.max(0, boxY),
    barY: Math.max(0, boxY) + box,
  };
}

export interface MagnifierOpts {
  /** 主题 accent（十字线 / 像素网格 / 中心像素淡染同色） */
  color: string;
  colorFormat: MagColorFormat;
  coordMode: MagCoordMode;
  /** 相对坐标原点（选区/拖拽矩形左上） */
  origin?: { x: number; y: number };
  /** 拖拽态尺寸标签（并入坐标行） */
  sizeLabel?: string;
}

/** 放大镜绘制：取景框（最近邻放大定格图 + 主题蓝像素网格 + 中心像素高亮
 *  + 主题蓝发丝十字）+ 多行信息面板（坐标 / 色块+色值 / 快捷键提示——
 *  Shift 切换颜色格式、C 复制颜色值、P 全局/相对坐标，参考 PixPin）。
 *  src = 合成画布（含已画标注，所见即所得）。scale 用于线宽/字号增密：
 *  高 DPI 下 1 物理像素的发丝线会被缩放摊淡（E2E 实证 4K@150% 仅 ~65%
 *  覆盖率），随 scale 加粗才够醒目。返回光标处取色值（C 复制用） */
export function drawMagnifier(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement | null,
  px: number,
  py: number,
  mw: number,
  mh: number,
  scale: number,
  opts: MagnifierOpts,
): { rgba: [number, number, number, number] } {
  const { box, barH } = magnifierBox(scale);
  const { boxX, boxY, barY } = magnifierLayout(px, py, mw, mh, scale);
  // 像素网格对齐：取样中心取整，避免源矩形亚像素采样发虚
  const ix = Math.max(0, Math.min(mw - 1, Math.round(px)));
  const iy = Math.max(0, Math.min(mh - 1, Math.round(py)));
  const half = (MAGNIFIER_SRC - 1) / 2;
  const zb = MAGNIFIER_ZOOM;
  const lw = Math.max(1, Math.round(scale));
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(boxX, boxY, box, box);
  if (src) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, ix - half, iy - half, MAGNIFIER_SRC, MAGNIFIER_SRC, boxX, boxY, box, box);
    ctx.imageSmoothingEnabled = true;
  }
  // 像素网格（主题蓝淡线）
  ctx.strokeStyle = hexToRgba(opts.color, 0.25);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < MAGNIFIER_SRC; i++) {
    const g = boxX + i * zb + 0.5;
    const gy = boxY + i * zb + 0.5;
    ctx.moveTo(g, boxY);
    ctx.lineTo(g, boxY + box);
    ctx.moveTo(boxX, gy);
    ctx.lineTo(boxX + box, gy);
  }
  ctx.stroke();
  // 中心像素高亮：主题蓝淡染 + accent 描边（取色即所指）
  const px0 = boxX + half * zb;
  const py0 = boxY + half * zb;
  ctx.fillStyle = hexToRgba(opts.color, 0.35);
  ctx.fillRect(px0, py0, zb, zb);
  ctx.strokeStyle = opts.color;
  ctx.strokeRect(px0 + lw / 2, py0 + lw / 2, zb - lw, zb - lw);
  // 主题蓝发丝十字（过中心，与全局十字线同色同口径）
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = lw;
  const cx = boxX + box / 2;
  const cy = boxY + box / 2;
  const half2 = lw / 2;
  ctx.beginPath();
  ctx.moveTo(Math.round(cx - half2) + 0.5, boxY);
  ctx.lineTo(Math.round(cx - half2) + 0.5, boxY + box);
  ctx.moveTo(boxX, Math.round(cy - half2) + 0.5);
  ctx.lineTo(boxX + box, Math.round(cy - half2) + 0.5);
  ctx.stroke();
  // 内白外黑双层描边，任何底色都可辨
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#fff";
  ctx.strokeRect(boxX + 0.5, boxY + 0.5, box - 1, box - 1);
  ctx.strokeStyle = "#000";
  ctx.strokeRect(boxX - 0.5, boxY - 0.5, box + 1, box + 1);
  // 取色（合成画布 1×1 读回）
  let rgba: [number, number, number, number] = [0, 0, 0, 255];
  const sctx = src?.getContext("2d");
  if (sctx) {
    const d = sctx.getImageData(ix, iy, 1, 1).data;
    rgba = [d[0], d[1], d[2], d[3]];
  }
  // 信息面板：坐标(+拖拽尺寸) / 色块+色值 / 三行快捷键提示（参考 PixPin）
  const { fs, lineH, pad } = magPanelMetrics(scale);
  const colorText = formatMagColor(rgba, opts.colorFormat);
  const lines = [
    formatMagCoords(ix, iy, opts.coordMode, opts.origin) +
      (opts.sizeLabel ? `  ${opts.sizeLabel}` : ""),
    colorText,
    "Shift: 切换颜色格式",
    "C: 复制颜色值",
    "P: 全局/相对坐标",
  ];
  ctx.font = `${fs}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  const textW = Math.max(
    ...lines.filter((_, i) => i !== 1).map((t) => ctx.measureText(t).width),
    0,
  );
  const sw = Math.round(fs * 0.9);
  const barW = Math.min(
    mw - boxX,
    Math.max(box, Math.round(pad + sw + 10 + textW + pad)),
  );
  ctx.fillStyle = "rgba(0,0,0,0.8)";
  ctx.fillRect(boxX, barY, barW, barH);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (let i = 0; i < lines.length; i++) {
    const ly = barY + pad + lineH * (i + 0.5);
    if (i === 1) {
      ctx.fillStyle = colorText;
      ctx.fillRect(boxX + pad, ly - sw / 2, sw, sw);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.strokeRect(boxX + pad + 0.5, ly - sw / 2 + 0.5, sw - 1, sw - 1);
      ctx.fillStyle = "#fff";
      ctx.fillText(lines[i], boxX + pad + sw + 10, ly);
    } else {
      ctx.fillStyle = "#fff";
      ctx.fillText(lines[i], boxX + pad, ly);
    }
  }
  ctx.restore();
  return { rgba };
}

/** 全局十字线（启动截图后的定位 / 水平对比）：过光标的
 *  整幅水平 + 垂直发丝线，随光标移动。跟随态专属——确认选区或开始拖拽后
 *  由选区边框 + 尺寸信息接管，十字线即隐。线宽随 scale 增密（同放大镜
 *  发丝线口径，round+0.5 像素网格对齐）；color 由调用方传主题 accent，
 *  与选区边框同色 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  mw: number,
  mh: number,
  scale = 1,
  color = "#ff453a",
): void {
  const x = Math.round(Math.max(0, Math.min(mw - 1, px))) + 0.5;
  const y = Math.round(Math.max(0, Math.min(mh - 1, py))) + 0.5;
  const lw = Math.max(1, Math.round(scale));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(mw, y);
  ctx.moveTo(x, 0);
  ctx.lineTo(x, mh);
  ctx.stroke();
  ctx.restore();
}

// ── 绘制（物理像素坐标系；线宽/字号 ×scale 还原 CSS 观感）─────────────────

/** 文字换行绘制（\n 显式换行），返回实际占用高度 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
): number {
  const lines = text.split("\n");
  ctx.font = `${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  const lh = fontSize * 1.35;
  lines.forEach((ln, i) => ctx.fillText(ln, x, y + i * lh));
  return lines.length * lh;
}

/** 单个图形绘制到 ctx（坐标已含选区偏移） */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  s: Shape,
  ox: number,
  oy: number,
  scale: number,
  /** 马赛克/模糊的采样源：默认自画（已提交路径），预览传合成画布 comp——
   *  live 层挖孔区域是透明像素，采样它预览不可见（实测踩坑） */
  source: HTMLCanvasElement = ctx.canvas,
): void {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width * scale;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  switch (s.type) {
    case "rect":
      ctx.strokeRect(s.x + ox, s.y + oy, s.w, s.h);
      break;
    case "ellipse": {
      ctx.beginPath();
      ctx.ellipse(
        s.x + ox + s.w / 2,
        s.y + oy + s.h / 2,
        Math.abs(s.w / 2),
        Math.abs(s.h / 2),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "arrow": {
      const x1 = s.x + ox;
      const y1 = s.y + oy;
      const x2 = s.x + ox + s.w;
      const y2 = s.y + oy + s.h;
      const lw = s.width * scale;
      const line = s.line ?? "solid";
      const head = s.head ?? "line";
      // 曲线箭头：二次贝塞尔；末端切向 = 端点 - 控制点，头部随切向转向
      const c = line === "curve" ? arrowCurveCtrl(x1, y1, x2, y2) : null;
      const ang = c
        ? Math.atan2(y2 - c.cy, x2 - c.cx)
        : Math.atan2(y2 - y1, x2 - x1);
      if (line === "dashed") ctx.setLineDash([lw * 2.5, lw * 1.8]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      if (c) ctx.quadraticCurveTo(c.cx, c.cy, x2, y2);
      else ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (Math.hypot(x2 - x1, y2 - y1) < 1) break;
      const headLen = Math.max(10 * scale, lw * 3);
      const g = arrowWingsAt(x2, y2, ang, headLen);
      if (head === "solid" || head === "hollow") {
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(g.ax, g.ay);
        ctx.lineTo(g.bx, g.by);
        ctx.closePath();
        if (head === "solid") ctx.fill();
        else ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(g.ax, g.ay);
        ctx.moveTo(x2, y2);
        ctx.lineTo(g.bx, g.by);
        ctx.stroke();
      }
      break;
    }
    case "pen":
    case "marker": {
      if (!s.pts?.length) break;
      if (s.type === "marker") {
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = s.width * scale * 3.5;
      }
      ctx.beginPath();
      ctx.moveTo(s.pts[0].x + ox, s.pts[0].y + oy);
      for (const p of s.pts.slice(1)) ctx.lineTo(p.x + ox, p.y + oy);
      ctx.stroke();
      break;
    }
    case "text":
      drawText(ctx, s.text ?? "", s.x + ox, s.y + oy, s.width * scale, s.color);
      break;
    case "mosaic": {
      // 取合成画布当前内容打码：下采样再上采样（像素化）。source 由调用方
      // 指定（预览传 comp 层——live 层挖孔区域是透明像素，采样它预览不可见）
      const tile = Math.max(4, s.width * 3) * scale;
      const sw = Math.max(1, Math.round(s.w / tile));
      const sh = Math.max(1, Math.round(s.h / tile));
      const off = document.createElement("canvas");
      off.width = sw;
      off.height = sh;
      const octx = off.getContext("2d");
      if (!octx) break;
      octx.drawImage(source, s.x + ox, s.y + oy, s.w, s.h, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, sw, sh, s.x + ox, s.y + oy, s.w, s.h);
      ctx.imageSmoothingEnabled = true;
      break;
    }
    case "blur": {
      ctx.save();
      ctx.beginPath();
      ctx.rect(s.x + ox, s.y + oy, s.w, s.h);
      ctx.clip();
      ctx.filter = `blur(${Math.max(3, s.width * scale * 1.5)}px)`;
      // 外扩绘制避免边缘泛出透明晕
      const m = s.width * scale * 3;
      ctx.drawImage(
        source,
        s.x + ox,
        s.y + oy,
        s.w,
        s.h,
        s.x + ox - m / 2,
        s.y + oy - m / 2,
        s.w + m,
        s.h + m,
      );
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}
