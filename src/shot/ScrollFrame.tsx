// 滚动截图选区框窗（label shot-frame）：与选区矩形精确重合的透明窗，只画
// 边框与 8 角/边中点，锚定「正在拼接的区域」的视觉。整窗点击穿透由 Rust 侧
// set_ignore_cursor_events 实现——窗下就是真实可交互窗口，滚轮直达（滚动
// 截图的数据源），本组件除背景透明化外无任何逻辑。
import { useEffect } from "react";

export function ScrollFrame() {
  useEffect(() => {
    // index.css 的 body{background:var(--np-bg)} 按样式表注入顺序会盖掉
    // shot.html 的内联透明背景，此处以内联样式夺回（否则框窗变不透明色块，
    // 选区下的真实窗口被挡死——穿透窗的透明是功能性的，非观感）
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);
  return (
    <div className="np-shot-sframe">
      <i className="tl" />
      <i className="tt" />
      <i className="tr" />
      <i className="ll" />
      <i className="rr" />
      <i className="bl" />
      <i className="bb" />
      <i className="br" />
    </div>
  );
}
