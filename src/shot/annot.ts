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
  | "step"
  | "mosaic"
  | "blur";

/** 箭头头部样式：单线 V 翼 / 实心三角 / 空心三角 */
export type ArrowHead = "line" | "solid" | "hollow";
/** 箭头线条类型：直线 / 虚线 / 曲线（二次贝塞尔） */
export type ArrowLine = "solid" | "dashed" | "curve";
/** 序号徽标形状：圆形 / 方形 / 纯数字（无底） */
export type BadgeShape = "circle" | "square" | "plain";

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
  /** 序号标记专属：徽标数字（点按时按 nextStepSeq 递增分配）。x/y = 圆心 */
  seq?: number;
  /** 模糊专属：不透明度 0.15~1（滚轮调节，缺省 1 = 全糊；部分透明让原图
   *  隐约透出 = 毛玻璃弱化语义） */
  alpha?: number;
  /** 通用线型扩展（2026-10-30 标记增强）：虚线（矩形/椭圆/画笔/马克笔；
   *  箭头走 line 字段） */
  dash?: boolean;
  /** 矩形/椭圆：半透明实心填充（标注色 30%，空心↔实心切换） */
  filled?: boolean;
  /** 矩形：圆角半径（CSS px，绘制 ×scale，钳半短边） */
  radius?: number;
  /** 文字：高亮底色（标注色 30% 垫底） */
  highlight?: boolean;
  /** 文字：粗体 / 斜体 */
  bold?: boolean;
  italic?: boolean;
  /** 序号：徽标形状（缺省 circle，旧会话兼容） */
  badge?: BadgeShape;
  /** 马赛克/模糊：圆形区域（包围盒内切椭圆） */
  round?: boolean;
  /** 箭头：双向（首尾同头部样式） */
  two?: boolean;
}

/** 序号标记下一个数字：现有 step 徽标最大 seq + 1（无则 1）。撤销天然回退
 *  ——undo 摘掉的是最后落下的徽标（seq 恒为当时的最大值），max+1 自动
 *  复用其数字；重做带回原 seq 不受影响。同一截图会话内连续点按即 1,2,3… */
export function nextStepSeq(shapes: readonly Shape[]): number {
  let max = 0;
  for (const s of shapes) if (s.type === "step" && (s.seq ?? 1) > max) max = s.seq ?? 1;
  return max + 1;
}

/** 序号徽标文字/描边配色：底色相对亮度 < 0.6 用白、否则用近黑（黄/白底
 *  白字不可读）；非法色值按深色处理（配白字）。画布内容色同 fileIcons
 *  语义，不走 --np-* */
export function stepBadgeColor(fillHex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(fillHex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return l < 0.6 ? "#ffffff" : "#101010";
}

/** 序号徽标几何：直径 = (16 + 线宽×2.6)×scale 只随线宽档变化，**与位数
 *  无关**（2026-10-30 二次定案：圈不被 10+/100+ 撑大，同尺寸圈视觉一致）；
 *  多位数改为收缩字号塞进同一直径（数字字宽 ≈ 0.58em，可容纳文本宽
 *  ≈ 0.78×直径），字号上限仍 = 直径×0.54（单位数观感） */
export function stepBadgeSize(
  width: number,
  scale: number,
  digits: number,
): { d: number; font: number } {
  const d = (16 + width * 2.6) * scale;
  const font = Math.min(d * 0.54, (d * 0.78) / (Math.max(1, digits) * 0.58));
  return { d, font: Math.round(font) };
}

/** 点到线段距离（命中测试用） */
function segDist(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 文字 bbox 估算（Shape 的 text 无 w/h，按字符宽近似：CJK 全宽、西文 0.55；
 *  字号与绘制同口径 ×scale 成物理像素） */
function textBox(s: Shape, scale: number): { x: number; y: number; w: number; h: number } {
  const fs = s.width * scale;
  const lines = (s.text ?? "").split("\n");
  let w = 0;
  for (const ln of lines) {
    let lw = 0;
    for (const ch of ln) lw += fs * (ch.charCodeAt(0) > 0xff ? 1.0 : 0.55);
    w = Math.max(w, lw);
  }
  return { x: s.x, y: s.y, w, h: lines.length * fs * 1.35 };
}

/** 标记包围盒（相对选区左上，物理像素，描边感知）：悬停选中框 / 命中
 *  估算共用。线形外扩半线宽（马克笔 ×3.5 同绘制）、箭头含箭头翼展、
 *  序号圈取徽标直径、文字走 textBox 估算 */
export function shapeBounds(
  s: Shape,
  scale: number,
): { x: number; y: number; w: number; h: number } {
  const lw = s.width * scale;
  switch (s.type) {
    case "rect":
    case "ellipse":
    case "mosaic":
    case "blur": {
      const pad = s.type === "rect" || s.type === "ellipse" ? lw / 2 : 0;
      return { x: s.x - pad, y: s.y - pad, w: s.w + pad * 2, h: s.h + pad * 2 };
    }
    case "arrow": {
      // 端点包围盒外扩箭头翼展（headLen 口径与 drawShape 一致）
      const headLen = Math.max(10 * scale, lw * 3);
      const x1 = Math.min(s.x, s.x + s.w) - headLen;
      const y1 = Math.min(s.y, s.y + s.h) - headLen;
      const x2 = Math.max(s.x, s.x + s.w) + headLen;
      const y2 = Math.max(s.y, s.y + s.h) + headLen;
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    case "pen":
    case "marker": {
      const pad = (s.type === "marker" ? lw * 3.5 : lw) / 2;
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      for (const p of s.pts ?? []) {
        x1 = Math.min(x1, p.x);
        y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x);
        y2 = Math.max(y2, p.y);
      }
      if (x1 === Infinity) return { x: s.x, y: s.y, w: 0, h: 0 };
      return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
    }
    case "text":
      return textBox(s, scale);
    case "step": {
      if ((s.badge ?? "circle") === "plain") return stepPlainBox(s, scale);
      const { d } = stepBadgeSize(s.width, scale, String(s.seq ?? 1).length);
      return { x: s.x - d / 2, y: s.y - d / 2, w: d, h: d };
    }
  }
}

/** 平移标记（2026-10-30 标记增强：已落标记拖动移位/克隆）：pen/marker
 *  连 pts 一起平移，其余 x/y 平移（w/h 是增量/尺寸不变） */
export function translateShape(s: Shape, dx: number, dy: number): Shape {
  if (s.pts?.length) {
    return {
      ...s,
      x: s.x + dx,
      y: s.y + dy,
      pts: s.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    };
  }
  return { ...s, x: s.x + dx, y: s.y + dy };
}

/** 快捷键清单角位选择（2026-10-30 用户定案：清单展示在选区遮罩黑色区
 *  域、四角取第一个与选区不相交者，全相交 = 不展示）。坐标全 CSS 像素
 *  （选区物理坐标调用前已 ÷scale）；pw/ph = 清单实测尺寸 */
export function keysCorner(
  s: { x: number; y: number; w: number; h: number } | null,
  vw: number,
  vh: number,
  pw: number,
  ph: number,
): "lt" | "rt" | "lb" | "rb" | null {
  if (!s) return null;
  const m = 12; // 距屏边
  const gap = 8; // 与选区最小间距
  const cands: ["lt" | "rt" | "lb" | "rb", number, number][] = [
    ["lb", m, vh - ph - m],
    ["rb", vw - pw - m, vh - ph - m],
    ["lt", m, m],
    ["rt", vw - pw - m, m],
  ];
  const sl = s.x - gap;
  const st = s.y - gap;
  const sr = s.x + s.w + gap;
  const sb = s.y + s.h + gap;
  for (const [id, x, y] of cands) {
    if (x + pw < sl || x > sr || y + ph < st || y > sb) return id;
  }
  return null;
}

/** 纯数字序号的 bbox 估算（数字字宽 ≈0.58em，字高 1.2em 居中） */
function stepPlainBox(s: Shape, scale: number): { x: number; y: number; w: number; h: number } {
  const fs = stepBadgeSize(s.width, scale, 1).d * 0.6;
  const digits = String(s.seq ?? 1).length;
  return {
    x: s.x - (digits * 0.58 * fs) / 2,
    y: s.y - (fs * 1.2) / 2,
    w: digits * 0.58 * fs,
    h: fs * 1.2,
  };
}

/** 标记命中测试：返回最上层命中图形的下标（后画的在上面，倒序探测）。
 *  px/py 与图形坐标同口径（相对选区左上，物理像素）；tol = 命中容差。
 *  线形（矩形/椭圆/箭头/笔迹）命中在描边带上而非包围盒内——大包围盒
 *  整面命中会遮挡下层标记，滚轮编辑指哪打哪 */
export function shapeAt(
  shapes: readonly Shape[],
  px: number,
  py: number,
  tol: number,
  scale = 1,
): number | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    const lw = s.width * scale;
    const t = tol + lw / 2;
    switch (s.type) {
      case "rect": {
        const insideBox =
          px >= s.x - t && px <= s.x + s.w + t && py >= s.y - t && py <= s.y + s.h + t;
        if (!insideBox) break;
        // 半透明实心（2026-10-30 标记增强）：整面包围盒命中
        if (s.filled) return i;
        // 边框带：四边最近距离；极小矩形（边距小于 2t）整体命中
        const dEdge = Math.min(
          Math.abs(px - s.x),
          Math.abs(px - (s.x + s.w)),
          Math.abs(py - s.y),
          Math.abs(py - (s.y + s.h)),
        );
        if (s.w <= 2 * t || s.h <= 2 * t || dEdge <= t) return i;
        break;
      }
      case "ellipse": {
        const rx = s.w / 2;
        const ry = s.h / 2;
        if (rx < 1 || ry < 1) break;
        const cx = s.x + rx;
        const cy = s.y + ry;
        // 沿射线取椭圆边界点，点到边界点的距离即描边带距离
        const dx = px - cx;
        const dy = py - cy;
        const r = Math.hypot(dx / rx, dy / ry);
        if (s.filled && r <= 1) return i; // 实心：内部全域命中
        if (r < 1e-6) return i;
        const bx = cx + dx / r;
        const by = cy + dy / r;
        if (Math.hypot(px - bx, py - by) <= t) return i;
        break;
      }
      case "arrow": {
        const x1 = s.x;
        const y1 = s.y;
        const x2 = s.x + s.w;
        const y2 = s.y + s.h;
        if ((s.line ?? "solid") === "curve") {
          // 二次贝塞尔采样折线（与绘制同控制点口径）
          const c = arrowCurveCtrl(x1, y1, x2, y2);
          let prev = { x: x1, y: y1 };
          for (let k = 1; k <= 8; k++) {
            const u = k / 8;
            const pxk =
              (1 - u) * (1 - u) * x1 + 2 * (1 - u) * u * c.cx + u * u * x2;
            const pyk =
              (1 - u) * (1 - u) * y1 + 2 * (1 - u) * u * c.cy + u * u * y2;
            if (segDist(px, py, prev.x, prev.y, pxk, pyk) <= t) return i;
            prev = { x: pxk, y: pyk };
          }
        } else if (segDist(px, py, x1, y1, x2, y2) <= t) return i;
        break;
      }
      case "pen":
      case "marker": {
        const mt = s.type === "marker" ? t * 3.5 : t;
        const pts = s.pts ?? [];
        for (let k = 1; k < pts.length; k++) {
          if (segDist(px, py, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) <= mt)
            return i;
        }
        break;
      }
      case "text": {
        const b = textBox(s, scale);
        if (px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol)
          return i;
        break;
      }
      case "step": {
        // 纯数字形：无底，按数字 bbox 估算（CJK 全宽近似不适用，数字 0.58em）
        if ((s.badge ?? "circle") === "plain") {
          const b = stepPlainBox(s, scale);
          if (px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol)
            return i;
          break;
        }
        const { d } = stepBadgeSize(s.width, scale, String(s.seq ?? 1).length);
        if (Math.hypot(px - s.x, py - s.y) <= d / 2 + tol) return i;
        break;
      }
      case "mosaic":
      case "blur": {
        if (s.round) {
          const rx = s.w / 2;
          const ry = s.h / 2;
          if (rx < 1 || ry < 1) break;
          const nx = (px - (s.x + rx)) / rx;
          const ny = (py - (s.y + ry)) / ry;
          if (nx * nx + ny * ny <= 1) return i;
          break;
        }
        if (px >= s.x - tol && px <= s.x + s.w + tol && py >= s.y - tol && py <= s.y + s.h + tol)
          return i;
        break;
      }
    }
  }
  return null;
}

/** 滚轮逐档调节单个标记（2026-10-30 定案：悬停指哪调哪）。dir = +1 增大 /
 *  -1 减小；返回调节后的拷贝 + HUD 文案；无连续可调维度的图形返回 null。
 *  各类型量程与步长：
 *  线形（矩形/椭圆/箭头/画笔/马克笔）width 1~30 步 1；
 *  文字字号 10~80 步 2；序号圈 1~20 步 1（直径 16+w×2.6 css）；
 *  马赛克格子 2~20 步 1；模糊不透明度 15%~100% 步 5% */
export function adjustShapeProp(
  s: Shape,
  dir: 1 | -1,
): { shape: Shape; label: string } | null {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  switch (s.type) {
    case "rect":
    case "ellipse":
    case "arrow":
    case "pen":
    case "marker": {
      const w = clamp(s.width + dir, 1, 30);
      return { shape: { ...s, width: w }, label: `线宽 ${w}px` };
    }
    case "text": {
      const w = clamp(s.width + dir * 2, 10, 80);
      return { shape: { ...s, width: w }, label: `字号 ${w}px` };
    }
    case "step": {
      const w = clamp(s.width + dir, 1, 20);
      return {
        shape: { ...s, width: w },
        label: `序号圈 ${Math.round(16 + w * 2.6)}px`,
      };
    }
    case "mosaic": {
      const w = clamp(s.width + dir, 2, 20);
      return { shape: { ...s, width: w }, label: `马赛克 ${Math.max(4, w * 3)}px 格` };
    }
    case "blur": {
      const a = clamp((s.alpha ?? 1) * 100 + dir * 5, 15, 100) / 100;
      return {
        shape: { ...s, alpha: a },
        label: `模糊不透明度 ${Math.round(a * 100)}%`,
      };
    }
    default:
      return null;
  }
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

/** 空心箭头翼基线与杆轴的交点（杆的止点）：尖沿轴回退 headLen×cos(±25°
 *  张角)。空心头必须让杆停在这里且两翼开放描边——杆穿到尖会把空腔填满
 *  看不出空心（2026-10-30 用户反馈修复） */
export function arrowBaseAt(
  tipX: number,
  tipY: number,
  angle: number,
  headLen: number,
): { x: number; y: number } {
  const back = headLen * Math.cos(Math.PI / 7);
  return { x: tipX - Math.cos(angle) * back, y: tipY - Math.sin(angle) * back };
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

/** 马赛克/模糊的裁剪区域（2026-10-30 标记增强）：方形 = 包围盒矩形，
 *  圆形 = 内切椭圆（打码人脸等更自然）；调用方负责 save/restore */
function clipRegion(
  ctx: CanvasRenderingContext2D,
  s: Shape,
  ox: number,
  oy: number,
): void {
  ctx.beginPath();
  if (s.round) {
    ctx.ellipse(
      s.x + ox + s.w / 2,
      s.y + oy + s.h / 2,
      Math.abs(s.w / 2),
      Math.abs(s.h / 2),
      0,
      0,
      Math.PI * 2,
    );
  } else {
    ctx.rect(s.x + ox, s.y + oy, s.w, s.h);
  }
  ctx.clip();
}

/** 文字换行绘制（\n 显式换行），返回实际占用高度；deco = "italic bold "
 *  前缀（2026-10-30 标记增强） */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  deco = "",
): number {
  const lines = text.split("\n");
  ctx.font = `${deco}${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
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
    case "rect": {
      const x = s.x + ox;
      const y = s.y + oy;
      const r = Math.min(
        (s.radius ?? 0) * scale,
        Math.abs(s.w) / 2,
        Math.abs(s.h) / 2,
      );
      if (s.filled) {
        // 半透明实心（2026-10-30 标记增强）：30% 标注色，不遮内容
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        if (r > 0) ctx.roundRect(x, y, s.w, s.h, r);
        else ctx.rect(x, y, s.w, s.h);
        ctx.fill();
        ctx.restore();
      }
      if (s.dash) ctx.setLineDash([s.width * scale * 2.5, s.width * scale * 1.8]);
      if (r > 0) {
        ctx.beginPath();
        ctx.roundRect(x, y, s.w, s.h, r);
        ctx.stroke();
      } else {
        ctx.strokeRect(x, y, s.w, s.h);
      }
      ctx.setLineDash([]);
      break;
    }
    case "ellipse": {
      const cx = s.x + ox + s.w / 2;
      const cy = s.y + oy + s.h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
      if (s.filled) {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fill();
        ctx.restore();
      }
      if (s.dash) ctx.setLineDash([s.width * scale * 2.5, s.width * scale * 1.8]);
      ctx.stroke();
      ctx.setLineDash([]);
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
      const headLen = Math.max(10 * scale, lw * 3);
      // 空心头（2026-10-30 修）：杆止于翼基线（尖回退 headLen×cos25°）、
      // 两翼开放描边不画底边——旧画法杆穿到尖 + 三角闭合描边，空腔被杆
      // 填满看不出空心
      const hollow = head === "hollow";
      // 双向（2026-10-30 标记增强）：尾端切向（曲线 = 起点 - 控制点）
      const tang2 = c
        ? Math.atan2(y1 - c.cy, x1 - c.cx)
        : Math.atan2(y1 - y2, x1 - x2);
      // 空心头：杆两端各止于翼基线（双向时空心尾同样退基线，空腔透出）
      const end = hollow ? arrowBaseAt(x2, y2, ang, headLen) : { x: x2, y: y2 };
      const start = hollow && s.two
        ? arrowBaseAt(x1, y1, tang2, headLen)
        : { x: x1, y: y1 };
      if (line === "dashed") ctx.setLineDash([lw * 2.5, lw * 1.8]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      if (c) ctx.quadraticCurveTo(c.cx, c.cy, end.x, end.y);
      else ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (Math.hypot(x2 - x1, y2 - y1) < 1) break;
      // 头部绘制（尖点 + 切向）：solid 实心三角 / line·hollow 两翼开放
      const paintHead = (tx: number, ty: number, tang: number) => {
        const hg = arrowWingsAt(tx, ty, tang, headLen);
        if (head === "solid") {
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(hg.ax, hg.ay);
          ctx.lineTo(hg.bx, hg.by);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(hg.ax, hg.ay);
          ctx.moveTo(tx, ty);
          ctx.lineTo(hg.bx, hg.by);
          ctx.stroke();
        }
      };
      paintHead(x2, y2, ang);
      if (s.two) paintHead(x1, y1, tang2);
      break;
    }
    case "pen":
    case "marker": {
      if (!s.pts?.length) break;
      if (s.type === "marker") {
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = s.width * scale * 3.5;
      }
      if (s.dash) ctx.setLineDash([s.width * scale * 2.5, s.width * scale * 1.8]);
      ctx.beginPath();
      ctx.moveTo(s.pts[0].x + ox, s.pts[0].y + oy);
      for (const p of s.pts.slice(1)) ctx.lineTo(p.x + ox, p.y + oy);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case "text": {
      const deco = s.bold || s.italic ? `${s.italic ? "italic " : ""}${s.bold ? "bold " : ""}` : "";
      if (s.highlight) {
        // 高亮底色（2026-10-30 标记增强）：标注色 30% 垫底，含少量内边距
        const b = textBox(s, scale);
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillRect(
          b.x + ox - 3 * scale,
          b.y + oy - 2 * scale,
          b.w + 6 * scale,
          b.h + 4 * scale,
        );
        ctx.restore();
      }
      drawText(ctx, s.text ?? "", s.x + ox, s.y + oy, s.width * scale, s.color, deco);
      break;
    }
    case "step": {
      // 序号徽标：x/y = 中心。形状三档（2026-10-30 标记增强）：圆形（缺省）
      // / 方形（圆角方）/ 纯数字（无底，反差描边轮廓保可读）；有底形 =
      // 实心底 + 同色系反差描边与文字（stepBadgeColor 亮度判定）
      const seq = s.seq ?? 1;
      const badge = s.badge ?? "circle";
      const cx = s.x + ox;
      const cy = s.y + oy;
      const contrast = stepBadgeColor(s.color);
      if (badge === "plain") {
        const fs = Math.round(stepBadgeSize(s.width, scale, 1).d * 0.6);
        ctx.font = `bold ${fs}px "Segoe UI", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = Math.max(2, fs * 0.14);
        ctx.strokeStyle = contrast;
        ctx.strokeText(String(seq), cx, cy);
        ctx.fillStyle = s.color;
        ctx.fillText(String(seq), cx, cy);
        break;
      }
      const { d, font } = stepBadgeSize(s.width, scale, String(seq).length);
      ctx.beginPath();
      if (badge === "square") {
        const r = d * 0.22;
        ctx.roundRect(cx - d / 2, cy - d / 2, d, d, r);
      } else {
        ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.lineWidth = Math.max(1, scale);
      ctx.strokeStyle = contrast;
      ctx.stroke();
      ctx.fillStyle = contrast;
      ctx.font = `bold ${font}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(seq), cx, cy + font * 0.04);
      break;
    }
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
      ctx.save();
      clipRegion(ctx, s, ox, oy);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, sw, sh, s.x + ox, s.y + oy, s.w, s.h);
      ctx.imageSmoothingEnabled = true;
      ctx.restore();
      break;
    }
    case "blur": {
      ctx.save();
      clipRegion(ctx, s, ox, oy);
      // 滚轮可调不透明度（缺省 1）：部分透明 = 原图隐约透出的毛玻璃弱化
      ctx.globalAlpha = s.alpha ?? 1;
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
