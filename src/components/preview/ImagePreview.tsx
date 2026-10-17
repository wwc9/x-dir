// 图片预览：webview 原生解码 + 手写滚轮缩放/拖拽平移（不引第三方缩放库）。
// 初始 = fit 窗口（整图完整可见，大图缩小、小图原尺寸不放大），滚轮以光标为锚缩放，
// 拖拽平移，双击回到 fit；窗口尺寸变化时未交互则自动重新 fit。
// 滚轮即缩放（不占用 Ctrl——Ctrl+滚轮已被 App 级 UI 缩放占用）。

import { useEffect, useRef, useState } from "react";

interface Transform {
  s: number;
  x: number;
  y: number;
}

const MIN_S = 0.02;
const MAX_S = 40;

export function ImagePreview({
  src,
  alt,
  rotateSignal = 0,
  onError,
}: {
  src: string;
  alt: string;
  /** 宿主"旋转"按钮的递增信号：每 +1 顺时针转 90°（内部跳过初始值） */
  rotateSignal?: number;
  onError(): void;
}) {
  const [t, setT] = useState<Transform>({ s: 1, x: 0, y: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [rot, setRot] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number } | null>(null);
  const interacted = useRef(false);
  const rotRef = useRef(0);
  const prevSignal = useRef(0);

  // fit 比例：整图入窗，不放大小图；旋转 90°/270° 时宽高互换；SVG 无固有尺寸按 0.9 宽
  const hasNatural = natural.w > 0;
  const baseW = hasNatural ? natural.w : Math.max(1, Math.floor(box.w * 0.9));
  const swapped = rot % 180 !== 0;
  const fit =
    hasNatural && box.w > 0
      ? Math.min(
          (swapped ? box.h : box.w) / natural.w,
          (swapped ? box.w : box.h) / natural.h,
          1,
        )
      : 1;

  // 换图：清交互态与旋转，等 onLoad 重算 fit
  useEffect(() => {
    interacted.current = false;
    rotRef.current = 0;
    prevSignal.current = rotateSignal;
    setRot(0);
    setNatural({ w: 0, h: 0 });
    setT({ s: 1, x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // 宿主旋转信号：递增即顺时针 90°（跳过挂载时的初始值）
  useEffect(() => {
    if (rotateSignal !== prevSignal.current) {
      prevSignal.current = rotateSignal;
      setRot((r) => {
        const nr = (r + 90) % 360;
        rotRef.current = nr;
        return nr;
      });
    }
  }, [rotateSignal]);

  // 容器尺寸跟随（窗口缩放/首次挂载）。用 clientWidth/Height（布局尺寸，不受
  // Dialog 入场 transform 动画影响——gBCR 会在动画期抓到 0.5 倍且 RO 不再补发）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // 未交互时跟随 fit（首载 / 容器变化）
  useEffect(() => {
    if (!interacted.current && fit > 0) setT({ s: fit, x: 0, y: 0 });
  }, [fit]);

  // 滚轮缩放（以光标为锚点）；preventDefault 需非 passive 监听
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      interacted.current = true;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left - r.width / 2;
      const my = e.clientY - r.top - r.height / 2;
      setT((p) => {
        const s = Math.min(MAX_S, Math.max(MIN_S, p.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        const k = s / p.s;
        return { s, x: mx - (mx - p.x) * k, y: my - (my - p.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 防闪烁：fit 尚未套上时先隐藏一帧
  const ready = interacted.current || Math.abs(t.s - fit) < 0.001;

  return (
    <div
      ref={wrapRef}
      className="np-pv-zoomwrap"
      onDoubleClick={() => {
        interacted.current = false;
        setT({ s: fit, x: 0, y: 0 });
      }}
      onPointerDown={(e) => {
        interacted.current = true;
        drag.current = { px: e.clientX - t.x, py: e.clientY - t.y };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current)
          setT((p) => ({ ...p, x: e.clientX - drag.current!.px, y: e.clientY - drag.current!.py }));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      <img
        className="np-pv-img"
        src={src}
        alt={alt}
        draggable={false}
        onError={onError}
        onLoad={(e) =>
          setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }
        width={baseW}
        style={{
          visibility: ready ? "visible" : "hidden",
          // translate 在 rotate 之前：平移保持屏幕轴向；旋转只作用于内容
          transform: `translate(-50%, -50%) translate(${t.x}px, ${t.y}px) rotate(${rot}deg) scale(${t.s})`,
        }}
      />
    </div>
  );
}
