// 截图族窗口统一轻量入口（shot.html，§3.6 性能 2026-10-27）：截图覆盖窗
// （常驻隐藏）、贴图、滚动浮条、结果窗都加载本页，不加载完整文件管理器
// bundle（App + Blueprint + stores）。常驻覆盖窗以 idle 空壳待命，会话数据
// 经 shot-session 事件驱动挂载 ShotOverlay；Rust 侧等 shot_page_ready 回执
// （两个监听都注册完成之后才回执）才下发会话，事件不丢。其余三窗仍走
// initialization_script 注入的 window.__BOOT__ 一次性挂载。
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";

import "../index.css";
import { api } from "../lib/ipc";
import { ShotOverlay, type ShotBoot } from "./ShotOverlay";
import { PinWindow, type PinBoot } from "./PinWindow";
import { ScrollBar, type ScrollBarBoot } from "./ScrollBar";
import { ShotResult, type ResultBoot } from "./ShotResult";

declare global {
  interface Window {
    __BOOT__?: PinBoot | ScrollBarBoot | ResultBoot | { window: "shot-idle" };
  }
}

/** 常驻覆盖窗宿主：idle 空白待命（窗口本身隐藏），会话事件驱动挂载/卸载
 *  ShotOverlay；seq 变更即重挂（就地重拍时全新会话状态） */
function ShotHost() {
  const [session, setSession] = useState<ShotBoot | null>(null);
  useEffect(() => {
    let dead = false;
    const offs: (() => void)[] = [];
    (async () => {
      offs.push(
        await listen<ShotBoot>("shot-session", (e) => setSession(e.payload)),
        await listen("shot-session-end", () => setSession(null)),
      );
      if (dead) {
        offs.forEach((f) => f());
        return;
      }
      // 两个监听都已注册才放行 Rust 下发会话（事件先于监听会丢）
      void api.shotPageReady().catch(() => undefined);
    })();
    return () => {
      dead = true;
      offs.forEach((f) => f());
    };
  }, []);
  return session ? <ShotOverlay key={session.seq} boot={session} /> : null;
}

const boot = window.__BOOT__;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  !boot || boot.window === "shot-idle" ? (
    <ShotHost />
  ) : boot.window === "pin" ? (
    <PinWindow boot={boot} />
  ) : boot.window === "scrollbar" ? (
    <ScrollBar />
  ) : (
    <ShotResult boot={boot} />
  ),
);
