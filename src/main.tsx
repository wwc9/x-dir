import React from "react";
import ReactDOM from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import App from "./App";
import { ShotOverlay, type ShotBoot } from "./shot/ShotOverlay";
import { PinWindow, type PinBoot } from "./shot/PinWindow";
import { ScrollBar, type ScrollBarBoot } from "./shot/ScrollBar";
import { ShotResult, type ResultBoot } from "./shot/ShotResult";
import "./index.css";

// 截图会话窗（§3.6）：Rust 建窗时经 initialization_script 注入 window.__BOOT__
// 携带定格截图路径与显示器参数；主窗口无此注入，渲染常规文件管理器界面。
declare global {
  interface Window {
    __BOOT__?: ShotBoot | PinBoot | ScrollBarBoot | ResultBoot;
  }
}
const boot = window.__BOOT__;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  boot?.window === "shot" ? (
    <ShotOverlay boot={boot} />
  ) : boot?.window === "pin" ? (
    <PinWindow boot={boot} />
  ) : boot?.window === "scrollbar" ? (
    <ScrollBar />
  ) : boot?.window === "result" ? (
    <ShotResult boot={boot} />
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
