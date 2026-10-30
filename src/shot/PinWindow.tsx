// 贴图窗（§3.6，label pin-*）：截图选区钉在屏幕上的置顶小窗（Snipaste 惯例）。
// 拖动 = rAF 合帧 + 串行 setPosition（2026-10-30 两轮手感修复：①逐
// pointermove 发 IPC 会积压成批滞后（卡顿）→ 每帧最多一次只发最新位置；
// ②重叠的 SetWindowPos 互相竞争位图拷贝与 WebView2 重绘（闪动）→ 单飞行
// + 脏标串行。原生 WM_NCLBUTTONDOWN(HTCAPTION) 方案在 WebView 宿主被
// WebView2 子窗口鼠标重捕获竞态打断（实测走几步即停），不可用；
// data-tauri-drag-region 本应用实测不生效）。四周阴影余量区要求页面根
// 透明（同 ScrollFrame 先例），滚轮缩放（左上角锚定）、Alt+滚轮调不透明
// 度、双击 / Esc 关闭、右键自绘小菜单（复制图像 / 保存为… / 关闭）。
// 窗口物理尺寸与图像显示尺寸由前端经 window API 同步（capabilities 已
// 放行 set-position/set-size）。
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PhysicalPosition, PhysicalSize, getCurrentWindow } from "@tauri-apps/api/window";

import { api } from "../lib/ipc";

export interface PinBoot {
  window: "pin";
  file: string;
  /** 贴图原始物理像素尺寸 */
  w: number;
  h: number;
  scale: number;
  /** 初始缩放（长图贴图由 Rust 侧按 80% 屏幅算好；常规贴图缺省 1） */
  zoom?: number;
  /** 四周阴影余量（物理像素；缺省 0 兼容旧 boot）。窗口 = 图像区外扩 pad */
  pad?: number;
}

const ZOOM_MIN = 0.02; // 长图贴图初始 fit 可低于 0.1（20000px 高适配 ~800 屏高）
const ZOOM_MAX = 6;
const OPACITY_MIN = 0.25;

export function PinWindow({ boot }: { boot: PinBoot }) {
  const win = getCurrentWindow();
  const [zoom, setZoom] = useState(boot.zoom ?? 1);
  const [opacity, setOpacity] = useState(1);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const zoomRef = useRef(boot.zoom ?? 1);
  const imgRef = useRef<HTMLImageElement>(null);
  /** 拖动状态：pointermove 累计目标位置，rAF 每帧最多发一次 setPosition */
  const dragRef = useRef<{ lx: number; ly: number } | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);
  /** setPosition 串行化：单飞行 + 脏标（重叠 SetWindowPos 竞争位图拷贝与
   *  WebView2 重绘，是拖动闪动来源） */
  const inflightRef = useRef(false);
  const dirtyRef = useRef(false);
  /** 阴影余量（物理像素；CSS padding = pad/scale） */
  const pad = boot.pad ?? 0;

  useEffect(() => {
    // 窗口 transparent 的前提：页面根不铺底色（同 ScrollFrame 先例）——
    // index.css 的 body 背景会在阴影余量区铺出不透明底
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void win.close().catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 缩放并同步窗口尺寸（物理 = 原始 × zoom + 四周阴影余量 2×pad） */
  const applyZoom = useCallback(
    (z: number) => {
      const zz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
      zoomRef.current = zz;
      setZoom(zz);
      void win
        .setSize(
          new PhysicalSize(
            Math.round(boot.w * zz) + pad * 2,
            Math.round(boot.h * zz) + pad * 2,
          ),
        )
        .catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boot.w, boot.h, pad],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (e.altKey) {
        setOpacity((o) =>
          Math.min(1, Math.max(OPACITY_MIN, o + (e.deltaY < 0 ? 0.05 : -0.05))),
        );
        return;
      }
      applyZoom(zoomRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    },
    [applyZoom],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // 菜单内点击放行（不吞）：先于 click 卸载菜单会让按钮 click 落空——
      // 2026-10-30 实测「右键 → 关闭贴图」失效的根因（pointerdown 关菜单
      // → 按钮随菜单卸载 → click 无人接）。菜单外的点击照旧收起菜单
      if ((e.target as Element).closest(".np-shot-pinmenu")) return;
      if (menu) {
        setMenu(null);
        return;
      }
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { lx: e.clientX, ly: e.clientY };
      // 权威起点取窗口实际外框位置（防止本地推算漂移）
      void win
        .outerPosition()
        .then((p) => {
          posRef.current = { x: p.x, y: p.y };
        })
        .catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      const pos = posRef.current;
      if (!d || !pos) return;
      // 累计位移（CSS→物理）；一帧内多次 pointermove 只保留最新目标
      pos.x += (e.clientX - d.lx) * boot.scale;
      pos.y += (e.clientY - d.ly) * boot.scale;
      d.lx = e.clientX;
      d.ly = e.clientY;
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          const p = posRef.current;
          if (!p) return;
          const send = () => {
            // 串行发送（单飞行 + 脏标）：重叠的 SetWindowPos 会互相竞争位图
            // 拷贝与 WebView2 重绘，是拖动闪动的主要来源
            inflightRef.current = true;
            void win
              .setPosition(new PhysicalPosition(Math.round(p.x), Math.round(p.y)))
              .catch(() => undefined)
              .finally(() => {
                inflightRef.current = false;
                if (dirtyRef.current) {
                  dirtyRef.current = false;
                  send();
                }
              });
          };
          if (inflightRef.current) {
            dirtyRef.current = true;
            return;
          }
          send();
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boot.scale],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    // 松手先补发最后一帧（挂起的 rAF 直接取消会丢末端位移，手感回跳）
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const p = posRef.current;
    if (p && !inflightRef.current) {
      inflightRef.current = true;
      void win
        .setPosition(new PhysicalPosition(Math.round(p.x), Math.round(p.y)))
        .catch(() => undefined)
        .finally(() => {
          inflightRef.current = false;
          if (dirtyRef.current) {
            dirtyRef.current = false;
            const p2 = posRef.current;
            if (p2) {
              void win
                .setPosition(new PhysicalPosition(Math.round(p2.x), Math.round(p2.y)))
                .catch(() => undefined);
            }
          }
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dataUrl = useCallback(async (): Promise<string | null> => {
    const img = imgRef.current;
    if (!img || !img.complete) return null;
    const c = document.createElement("canvas");
    c.width = boot.w;
    c.height = boot.h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, boot.w, boot.h);
    return c.toDataURL("image/png");
  }, [boot.w, boot.h]);

  const onMenuAction = useCallback(
    async (action: "copy" | "save" | "close") => {
      setMenu(null);
      if (action === "close") {
        void win.close().catch(() => undefined);
        return;
      }
      const url = await dataUrl();
      if (!url) return;
      try {
        if (action === "copy") await api.shotCopy(url);
        else await api.shotSaveData(url);
      } catch {
        // 原生对话框/剪贴板失败静默（贴图窗无提示体系）
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataUrl],
  );

  return (
    <div
      className="np-shot-pin"
      style={{ padding: pad / boot.scale }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => void win.close().catch(() => undefined)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({
          x: Math.min(e.clientX, window.innerWidth - 150),
          y: Math.min(e.clientY, window.innerHeight - 130),
        });
      }}
    >
      <img
        ref={imgRef}
        src={convertFileSrc(boot.file)}
        crossOrigin="anonymous"
        draggable={false}
        alt="贴图"
        // 首帧就绪回执：Rust 此时才 show（提前 show 闪黑屏）
        onLoad={() => void api.shotReady().catch(() => undefined)}
        style={{
          // 物理像素 → CSS 像素（÷scale）：boot.w/h 是物理数，直接作 CSS 宽
          // 在 150% 缩放下会 1.5× 溢出窗口被裁（2026-10-30 修）
          width: (boot.w * zoom) / boot.scale,
          height: (boot.h * zoom) / boot.scale,
          opacity,
        }}
      />
      {menu && (
        <div className="np-shot-pinmenu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => void onMenuAction("copy")}>复制图像</button>
          <button onClick={() => void onMenuAction("save")}>保存为…</button>
          <button onClick={() => void onMenuAction("close")}>关闭贴图</button>
          <div className="np-shot-pinmenu-hint">滚轮缩放 · Alt+滚轮不透明度</div>
        </div>
      )}
    </div>
  );
}
