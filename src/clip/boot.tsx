// 剪贴板历史浮窗入口（clipboard.html，§3.7）：独立轻量窗口，由 Rust 侧
// 常驻停靠屏幕外并管理上屏/收起（热键呼出），本页只挂载列表组件——不加载
// 完整文件管理器 bundle，样式共用 index.css。
import ReactDOM from "react-dom/client";

import "../index.css";
import { ClipHistWindow } from "./ClipHistWindow";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ClipHistWindow />,
);
