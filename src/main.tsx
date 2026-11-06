import React from "react";
import ReactDOM from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import App from "./App";
import "./index.css";
// 样式加载顺序（2026-11-06 定案）：dev 按 import 序注入（本文件序 = index.css
// 后于 blueprint.css，覆写生效）；rolldown 打包时会把 blueprint.css 提升到入口
// main-*.css 并垫后加载，同权重压掉我们全部 .bp6-* 覆写（弹窗走 Blueprint 主题：
// 浅色 #f6f7f9 灰身白头/4px 圆角/0.7 深遮罩，深色 #1c2127）——打包版与 dev 表现
// 分裂的根因，由 vite.config.ts 的 cssOrderGuard 插件在产物生成时统一重排。

// 主窗口入口。截图族窗口（覆盖窗/贴图/滚动浮条/结果窗）走独立轻量入口
// shot.html（src/shot/boot.tsx），不加载本文件与主界面 bundle。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
