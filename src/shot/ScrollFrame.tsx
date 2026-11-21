// 滚动截图选区框窗（label shot-frame）：整显示器透明窗，画选区外遮罩
// （PixPin 样式，四条 --np-overlay）+ 选区边框与 8 角/边中点。整窗点击穿透
// 由 Rust 侧 set_ignore_cursor_events 实现——窗下就是真实可交互窗口，选区
// 内滚轮直达（滚动截图的数据源），遮罩纯视觉；穿透窗的透明是功能性的，
// 运行时强制 html/body 背景透明（index.css 注入顺序会盖掉 shot.html 的
// 内联透明背景）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api } from "../lib/ipc";

export interface ScrollFrameBoot {
  window: "frame";
  /** 选区显示器相对物理像素矩形 */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

/** 浮条 tooltip 外渲染载荷（barTip.ts 通道）：按钮顶缘中心的虚拟屏逻辑坐标 */
interface BarTip {
  text: string;
  kbd: string | null;
  sx: number;
  sy: number;
}

/** 换算到本窗窗口内坐标后的渲染态 */
interface TipPos {
  text: string;
  kbd: string | null;
  x: number;
  y: number;
}

export function ScrollFrame({ boot }: { boot: ScrollFrameBoot }) {
  const [geom, setGeom] = useState<ScrollFrameBoot>(boot);
  // 浮条 tooltip 代渲染（2026-11-21 用户需求「像截图工具栏一样悬在按钮上方」）：
  // 本窗全屏穿透，气泡悬在按钮正上方不挡任何交互；换装（新会话）清残留
  const [tip, setTip] = useState<TipPos | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const un = listen<BarTip | null>("shot-bar-tip", (e) => {
      const p = e.payload;
      if (!p) {
        setTip(null);
        return;
      }
      setTip({
        text: p.text,
        kbd: p.kbd ?? null,
        // 虚拟屏坐标 → 本窗窗口内坐标（两窗同屏同 scale，逻辑坐标直减）
        x: p.sx - window.screenX,
        y: p.sy - window.screenY,
      });
    });
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);
  // 常驻窗复用：Rust 每场会话 show 前发几何事件换装（首场 __BOOT__ 已带同款）
  useEffect(() => {
    const un = listen<ScrollFrameBoot>("shot-frame-geom", (e) => {
      setGeom(e.payload);
      setTip(null);
    });
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);
  // 常驻窗停靠屏外（合成器不离场）：首绘/换装重绘后回执 Rust（shot_ready）
  // 才原子移动上屏——无感链路，2026-11-21 低配闪屏修复
  useEffect(() => {
    const a = requestAnimationFrame(() => {
      requestAnimationFrame(() => void api.shotReady().catch(() => undefined));
    });
    return () => cancelAnimationFrame(a);
  }, [geom.x, geom.y, geom.w, geom.h]);
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);
  const s = geom.scale || 1;
  // 气泡定位（布局前落位）：水平居中于按钮钳屏内，垂直悬在按钮上方 6px，
  // 贴屏顶翻到按钮下方
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const e = 8;
    const left = Math.max(e, Math.min(tip.x - w / 2, window.innerWidth - w - e));
    let top = tip.y - 6 - h;
    if (top < e) top = Math.min(tip.y + 6, window.innerHeight - h - e);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip]);
  const sel = {
    left: geom.x / s,
    top: geom.y / s,
    width: geom.w / s,
    height: geom.h / s,
  };
  return (
    <>
      {/* 选区外遮罩四条（上/下/左/右），PixPin 滚动截图样式 */}
      <div className="np-shot-smask" style={{ left: 0, top: 0, right: 0, height: sel.top }} />
      <div
        className="np-shot-smask"
        style={{ left: 0, top: sel.top + sel.height, right: 0, bottom: 0 }}
      />
      <div
        className="np-shot-smask"
        style={{ left: 0, top: sel.top, width: sel.left, height: sel.height }}
      />
      <div
        className="np-shot-smask"
        style={{ left: sel.left + sel.width, top: sel.top, right: 0, height: sel.height }}
      />
      <div className="np-shot-sframe" style={sel}>
        <i className="tl" />
        <i className="tt" />
        <i className="tr" />
        <i className="ll" />
        <i className="rr" />
        <i className="bl" />
        <i className="bb" />
        <i className="br" />
      </div>
      {/* 浮条气泡（np-tip 同款脸）：悬在按钮正上方，先离屏挂载再按实测尺寸
          定位（useLayoutEffect 布局前落位，无闪帧）；贴屏顶翻按钮下方 */}
      {tip && (
        <div
          ref={tipRef}
          className="np-tip np-tip-on"
          style={{ left: -9999, top: -9999 }}
        >
          {tip.text}
          {tip.kbd && <kbd>{tip.kbd}</kbd>}
        </div>
      )}
    </>
  );
}
