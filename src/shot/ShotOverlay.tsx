// 截图覆盖层（§3.6，常驻覆盖窗经 shot-session 事件驱动挂载）：定格截图铺底 +
// 智能窗口识别（进会话默认预选光标下窗口）+ 选区（拖拽/手柄调整/整体移动）+
// 标注（矩形/椭圆/箭头/画笔/马克笔/文字）+ 马赛克/模糊 + 复制/保存/贴图。
// 全链路物理像素坐标（×boot.scale 与 CSS 像素换算），与定格截图逐像素对齐。
//
// 双 canvas 分层：composite（离屏，底图 + 已确认标注按序压平——马赛克/模糊
// 取其像素，语义 = 后画的会把先画的糊掉，与 QQ 一致）→ base（静态显示）；
// live 承载遮罩/选区框/窗口高亮/绘制预览的高频重绘，mousemove 不触底图。
// 本窗脱离主界面体系（无 np-tip/island），按钮提示用原生 title 承载。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ArrowUpRight,
  Circle,
  Copy,
  Droplets,
  GalleryVerticalEnd,
  Grid2x2,
  Highlighter,
  MousePointer2,
  Pencil,
  Pin,
  Redo2,
  Save,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";

import { api } from "../lib/ipc";
import { AppIcon } from "../components/AppIcon";
import {
  SHOT_PALETTE,
  type HandleId,
  type Sel,
  type Shape,
  drawMagnifier,
  drawShape,
  handleAt,
  hitWindow,
  normalizeSel,
  resizeSel,
  type ShotTool,
} from "./annot";

export interface ShotBoot {
  window: "shot";
  file: string;
  mx: number;
  my: number;
  mw: number;
  mh: number;
  scale: number;
  /** 会话序号（常驻覆盖窗重挂 key） */
  seq: number;
  /** 会话定格时光标位置（显示器相对物理像素；默认预选光标下窗口） */
  cx: number;
  cy: number;
  windows: { x: number; y: number; w: number; h: number }[];
}

/** 三档线宽 / 字号（CSS 像素观感值） */
const STROKES = [2, 4, 7];
const FONTS = [16, 22, 30];

const TOOLS: { id: ShotTool; label: string; icon: typeof Square }[] = [
  { id: "select", label: "选择 / 移动选区", icon: MousePointer2 },
  { id: "rect", label: "矩形", icon: Square },
  { id: "ellipse", label: "椭圆", icon: Circle },
  { id: "arrow", label: "箭头", icon: ArrowUpRight },
  { id: "pen", label: "画笔", icon: Pencil },
  { id: "marker", label: "马克笔", icon: Highlighter },
  { id: "text", label: "文字", icon: Type },
  { id: "mosaic", label: "马赛克", icon: Grid2x2 },
  { id: "blur", label: "模糊", icon: Droplets },
];

function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

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
  const toPhys = (e: { clientX: number; clientY: number }) => ({
    px: e.clientX * scale,
    py: e.clientY * scale,
  });

  const baseRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const compRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
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
  /** 光标最近位置（不随模式清空，回跟随态时放大镜立即就位） */
  const lastPosRef = useRef<{ x: number; y: number } | null>({ x: boot.cx, y: boot.cy });

  // 预选跟随模式（PixPin/QQ 惯例，2026-10-27）：进会话默认选中光标下窗口，
  // 鼠标移动时选中框自动跟随切换其他窗口（此时无工具栏，光标恒十字）；用户
  // 按下鼠标即开始自定义框选（跟随结束），单击/拖拽松开确认选区、工具栏直出；
  // Esc 逐层取消到清选区时回到跟随模式
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
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    if (!s) {
      ctx.fillRect(0, 0, boot.mw, boot.mh);
    } else {
      ctx.fillRect(0, 0, boot.mw, s.y);
      ctx.fillRect(0, s.y + s.h, boot.mw, boot.mh - s.y - s.h);
      ctx.fillRect(0, s.y, s.x, s.h);
      ctx.fillRect(s.x + s.w, s.y, boot.mw - s.x - s.w, s.h);
      // 选区边框 + 四角/边中手柄
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
    // 放大镜/取色器（PixPin 惯例）：跟随态与拖拽态显示，确认选区后隐藏；
    // 取样合成画布，已画标注同样可见（所见即所得）
    const mag = magRef.current;
    const magVisible = !!mag && (followingRef.current || !!dragRef.current);
    // 拖拽中的选区框；尺寸并入放大镜信息条（PixPin 同款），无放大镜才单画 pill
    const d = dragRef.current;
    if (d) {
      const r = normalizeSel(d.x1, d.y1, d.x2, d.y2, boot.mw, boot.mh, 1);
      if (r) {
        ctx.fillStyle = hexToRgba(accent, 0.08);
        ctx.fillRect(r.x, r.y, r.w, r.h);
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
    // 进行中的标注预览（坐标相对选区，clip 内）
    const dr = drawRef.current;
    if (dr && s && dr.type !== "text") {
      ctx.save();
      ctx.beginPath();
      ctx.rect(s.x, s.y, s.w, s.h);
      ctx.clip();
      drawShape(ctx, dr, s.x, s.y, scale);
      ctx.restore();
    }
    if (mag && magVisible) {
      const sizeLabel = d
        ? `${Math.round(Math.abs(d.x2 - d.x1))} × ${Math.round(Math.abs(d.y2 - d.y1))}`
        : undefined;
      drawMagnifier(ctx, compRef.current, mag.x, mag.y, boot.mw, boot.mh, scale, sizeLabel);
    }
  }, [boot.mw, boot.mh, scale]);

  useEffect(() => {
    const img = new Image();
    // asset 协议与页面跨源：必须以 CORS 模式加载（asset 协议已回
    // Access-Control-Allow-Origin），否则 canvas 被污染，toDataURL 抛
    // SecurityError，复制/贴图/保存全部静默失效
    img.crossOrigin = "anonymous";
    img.src = convertFileSrc(boot.file);
    img
      .decode()
      .then(() => {
        imgRef.current = img;
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
        // 首帧上屏后再让 Rust show 窗口：提前 show 出来的是未渲染的空
        // WebView2（黑底）。双 rAF 确保画布已被合成器呈现
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            void api.shotReady().catch(() => undefined);
            // 常驻窗隐藏期间 WebView2 挂起合成器，show 后首帧可能仍是空白
            // 占位（E2E 实证：遮罩/定格图不入帧，直到下一次指针事件触发
            // 重绘）。show 完成后窗口可见、rAF 恢复，再强制重绘一拍确保
            // 定格图 + 蒙层真正上屏
            requestAnimationFrame(() => {
              redrawBase();
              redrawLive();
            });
          }),
        );
      })
      .catch(() => {
        setSavedTip("截图加载失败");
        // 加载失败也要把窗口放出来展示错误提示，别留在不可见状态
        void api.shotReady().catch(() => undefined);
      });
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

  const exportDataUrl = useCallback((s: Sel): string | null => {
    const comp = compRef.current;
    if (!comp) return null;
    const c = document.createElement("canvas");
    c.width = s.w;
    c.height = s.h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(comp, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
    return c.toDataURL("image/png");
  }, []);

  const finish = useCallback(
    async (action: "copy" | "pin" | "save") => {
      const s = selRef.current;
      if (!s || busy) return;
      const dataUrl = exportDataUrl(s);
      if (!dataUrl) return;
      setBusy(true);
      try {
        if (action === "copy") {
          await api.shotCopy(dataUrl);
          closeWindow();
        } else if (action === "pin") {
          await api.shotPin(dataUrl, boot.mx + s.x, boot.my + s.y, s.w, s.h);
          closeWindow();
        } else {
          const saved = await api.shotSaveData(dataUrl);
          if (saved) {
            setSavedTip(`已保存 ${saved.split(/[\\/]/).pop()}`);
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
    [boot.mx, boot.my, busy, closeWindow, exportDataUrl],
  );

  // ── 滚动长截图（§3.6 二期 B 批）：以当前选区开滚动会话，覆盖窗由 Rust 侧
  // 隐藏并接管后续流程（浮条窗 → 拼接 → 结果窗）────────────────────────────
  const startScroll = useCallback(() => {
    const s = selRef.current;
    if (!s || busy) return;
    setBusy(true);
    void api
      .shotScrollBegin(Math.round(s.x), Math.round(s.y), Math.round(s.w), Math.round(s.h), boot.mx, boot.my)
      .catch((e) => {
        setSavedTip(`滚动截图启动失败：${String(e)}`);
        setBusy(false);
      });
  }, [busy, boot.mx, boot.my]);

  // ── 撤销 / 重做 ──────────────────────────────────────────────────────────
  const undo = useCallback(() => {
    if (!shapes.length) return;
    setRedoStack((r) => [...r, shapes]);
    setShapes(shapes.slice(0, -1));
  }, [shapes]);

  const redo = useCallback(() => {
    if (!redoStack.length) return;
    setShapes(redoStack[redoStack.length - 1]);
    setRedoStack((r) => r.slice(0, -1));
  }, [redoStack]);

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

  /** 逐层取消（Esc / 右键）：文字 → 绘制 → 拖拽 → 工具 → 选区 → 关闭 */
  const cancelOneStep = useCallback(() => {
    if (busy) return;
    if (editingRef.current) {
      editingRef.current = null;
      setEditing(null);
      return;
    }
    if (drawRef.current) {
      drawRef.current = null;
      redrawLive();
      return;
    }
    if (dragRef.current) {
      dragRef.current = null;
      redrawLive();
      return;
    }
    if (tool !== "select") {
      setTool("select");
      return;
    }
    if (selRef.current) {
      // 清选区回到跟随模式：继续移动鼠标自动切换目标窗口（QQ 语义）；
      // 放大镜随即在原光标位恢复（PixPin 惯例）
      setFollowing(true);
      followingRef.current = true;
      setSel(null);
      selRef.current = null;
      magRef.current = lastPosRef.current;
      redrawLive();
      return;
    }
    closeWindow();
  }, [busy, closeWindow, redrawLive, tool]);

  // ── 指针交互 ─────────────────────────────────────────────────────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (busy) return;
      if (e.button === 2) {
        cancelOneStep();
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
    [busy, tool, color, strokeIdx, redrawBase, redrawLive, commitText, cancelOneStep],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
    if (busy) return;
    const { px, py } = toPhys(e);
    lastPosRef.current = { x: px, y: py };
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
        if (d.type !== "pen" && d.type !== "marker") {
          // 包围盒归正（负向拖拽翻正）
          const nx = d.w < 0 ? d.x + d.w : d.x;
          const ny = d.h < 0 ? d.y + d.h : d.y;
          d.x = nx;
          d.y = ny;
          d.w = Math.abs(d.w);
          d.h = Math.abs(d.h);
        }
        setRedoStack([]);
        setShapes((prev) => [...prev, d]);
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
        cancelOneStep();
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
  }, [cancelOneStep, commitText, undo, redo, finish]);

  // ── 工具栏定位（选区下方 12px，放不下换上方；水平居中钳制屏内）──────────
  const [tbPos, setTbPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const tb = toolbarRef.current;
    const s = sel;
    if (!tb || !s) {
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
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="np-shot-size">
            {Math.round(sel.w)} × {Math.round(sel.h)}
          </span>
          <span className="np-shot-sep" />
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`np-shot-tool ${tool === t.id ? "on" : ""}`}
              title={t.label}
              onClick={() => setTool(t.id)}
            >
              <AppIcon icon={t.icon} />
            </button>
          ))}
          <span className="np-shot-sep" />
          {SHOT_PALETTE.map((c) => (
            <button
              key={c}
              className={`np-shot-dot ${color === c ? "on" : ""}`}
              style={{ background: c }}
              title="标注颜色"
              onClick={() => setColor(c)}
            />
          ))}
          <span className="np-shot-sep" />
          {strokeBtns.map((w) => (
            <button
              key={w.v}
              className={`np-shot-tool ${strokeIdx === w.v ? "on" : ""}`}
              title={w.title}
              onClick={() => setStrokeIdx(w.v)}
            >
              <span className="np-shot-wdot" style={{ width: w.px, height: w.px }} />
            </button>
          ))}
          <span className="np-shot-sep" />
          <button className="np-shot-tool" title="撤销（Ctrl+Z）" disabled={!shapes.length} onClick={undo}>
            <AppIcon icon={Undo2} />
          </button>
          <button className="np-shot-tool" title="重做（Ctrl+Y）" disabled={!redoStack.length} onClick={redo}>
            <AppIcon icon={Redo2} />
          </button>
          <span className="np-shot-sep" />
          <button
            className="np-shot-tool np-shot-primary"
            title="贴图：钉在屏幕上"
            onClick={() => void finish("pin")}
          >
            <AppIcon icon={Pin} />
          </button>
          <button
            className="np-shot-tool np-shot-primary"
            title="复制到剪贴板（Enter / 双击选区）"
            onClick={() => void finish("copy")}
          >
            <AppIcon icon={Copy} />
          </button>
          <button
            className="np-shot-tool np-shot-primary"
            title="保存为 PNG 文件"
            onClick={() => void finish("save")}
          >
            <AppIcon icon={Save} />
          </button>
          <button
            className="np-shot-tool np-shot-primary"
            title="滚动截图：自动滚动选区拼接长图"
            onClick={startScroll}
          >
            <AppIcon icon={GalleryVerticalEnd} />
          </button>
          <button
            className="np-shot-tool np-shot-danger"
            title="取消截图（Esc）"
            onClick={closeWindow}
          >
            <AppIcon icon={X} />
          </button>
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
