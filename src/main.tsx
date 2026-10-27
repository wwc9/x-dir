import React from "react";
import ReactDOM from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import App from "./App";
import "./index.css";

// 主窗口入口。截图族窗口（覆盖窗/贴图/滚动浮条/结果窗）走独立轻量入口
// shot.html（src/shot/boot.tsx），不加载本文件与主界面 bundle。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
