// 滚动截图选区框窗（label shot-frame）：整显示器透明窗，画选区外遮罩
// （PixPin 样式，四条 --np-overlay）+ 选区边框与 8 角/边中点。整窗点击穿透
// 由 Rust 侧 set_ignore_cursor_events 实现——窗下就是真实可交互窗口，选区
// 内滚轮直达（滚动截图的数据源），遮罩纯视觉；穿透窗的透明是功能性的，
// 运行时强制 html/body 背景透明（index.css 注入顺序会盖掉 shot.html 的
// 内联透明背景）。
import { useEffect } from "react";

export interface ScrollFrameBoot {
  window: "frame";
  /** 选区显示器相对物理像素矩形 */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export function ScrollFrame({ boot }: { boot: ScrollFrameBoot }) {
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);
  const s = boot.scale || 1;
  const sel = {
    left: boot.x / s,
    top: boot.y / s,
    width: boot.w / s,
    height: boot.h / s,
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
    </>
  );
}
