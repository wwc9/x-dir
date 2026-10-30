// 贴图窗（§3.6，label pin-*）：截图选区钉在屏幕上的置顶小窗（Snipaste 惯例）。
// 拖动 = Rust 线程光标轮询会话（shot_pin_drag_start：125Hz 读系统光标直接
// 驱动 set_position，与 WebView 事件/IPC 完全解耦——JS 侧逐 pointermove 发
// setPosition 的方案无论合帧/串行都有坐标快照过期与到达时序不匀的抖动，
// 2026-10-30 三轮手感修复终案；松开左键自动收场，stop 命令仅冗余兜底）。
// 四周阴影余量区要求页面根透明（同 ScrollFrame 先例），滚轮缩放（左上角
// 锚定）、Alt+滚轮调不透明度、双击 / Esc 关闭、右键自绘小菜单（复制图像 /
// 保存为… / 关闭）。窗口物理尺寸与图像显示尺寸由前端经 window API 同步
// （capabilities 已放行 set-position/set-size）。
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PhysicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";

import { api } from "../lib/ipc";
import { initTooltip } from "../lib/tooltip";
import { DENSITY } from "../lib/tokens";
import { AppIcon } from "../components/AppIcon";

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
  /** 阴影余量（物理像素；CSS padding = pad/scale） */
  const pad = boot.pad ?? 0;

  useEffect(() => {
    // 窗口 transparent 的前提：页面根不铺底色（同 ScrollFrame 先例）——
    // index.css 的 body 背景会在阴影余量区铺出不透明底
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    // 顶部按钮条 data-tip 气泡（与主界面/覆盖窗同一套委托）
    initTooltip();
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
      // 左键按下交给 Rust 光标轮询会话拖动窗口（松键自动收场）
      void api.shotPinDragStart().catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu],
  );

  const endDrag = useCallback(() => {
    void api.shotPinDragStop().catch(() => undefined);
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

  /** 贴图原始像素（RGBA 快路用；null = 图未就绪）。willReadFrequently 画布
   *  一次 getImageData 拿全帧，免 toDataURL 的 JS 端 PNG 编码（4K ~300ms+，
   *  2026-10-30 响应速度优化） */
  const frameData = useCallback((): ImageData | null => {
    const img = imgRef.current;
    if (!img || !img.complete) return null;
    const c = document.createElement("canvas");
    c.width = boot.w;
    c.height = boot.h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, boot.w, boot.h);
    return ctx.getImageData(0, 0, c.width, c.height);
  }, [boot.w, boot.h]);

  const onMenuAction = useCallback(
    async (action: "copy" | "save" | "close") => {
      setMenu(null);
      if (action === "close") {
        void win.close().catch(() => undefined);
        return;
      }
      try {
        // 原始字节快路优先（与覆盖窗 finish 同族）：复制直写 CF_DIB，保存先
        // 暂存帧再开对话框（PNG 编码在 Rust 后台与对话框并行）；失败回落
        // dataURL 慢路
        const data = frameData();
        if (data) {
          try {
            if (action === "copy") {
              await api.shotCopyRaw(data.data, data.width, data.height);
              return;
            }
            await api.shotStageRaw(data.data, data.width, data.height);
            await api.shotSaveRaw();
            return;
          } catch {
            // 落到下方 dataURL 回落路径
          }
        }
        const url = await dataUrl();
        if (!url) return;
        if (action === "copy") await api.shotCopy(url);
        else await api.shotSaveData(url);
      } catch {
        // 原生对话框/剪贴板失败静默（贴图窗无提示体系）
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataUrl, frameData],
  );

  // 右上角关闭钮（2026-10-30 三次定案：弃四钮条，改悬停浮现单关闭钮——
  // 圆形半透明黑底 + 白 X，贴图右上角内侧 8px）：悬停整窗出现、离开 180ms
  // 退场（常显遮挡内容）；按下不抢拖拽
  const [barOn, setBarOn] = useState(false);
  const barHideTimer = useRef<number | null>(null);
  const onRootEnter = useCallback(() => {
    if (barHideTimer.current !== null) window.clearTimeout(barHideTimer.current);
    setBarOn(true);
  }, []);
  const onRootLeave = useCallback(() => {
    if (barHideTimer.current !== null) window.clearTimeout(barHideTimer.current);
    barHideTimer.current = window.setTimeout(() => setBarOn(false), 180);
  }, []);

  return (
    <div
      className="np-shot-pin"
      style={{ padding: pad / boot.scale }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={onRootEnter}
      onPointerLeave={onRootLeave}
      onDoubleClick={() => void win.close().catch(() => undefined)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({
          x: Math.min(e.clientX, window.innerWidth - 150),
          y: Math.min(e.clientY, window.innerHeight - 130),
        });
      }}
    >
      {barOn && (
        <button
          className="np-shot-pin-close"
          data-tip="关闭（Esc / 双击同效）"
          style={{ top: pad / boot.scale + 8, right: pad / boot.scale + 8 }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void win.close().catch(() => undefined)}
        >
          <AppIcon icon={X} size={DENSITY.iconSm} />
        </button>
      )}
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
