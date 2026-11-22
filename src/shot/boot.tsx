// 截图族窗口统一轻量入口（shot.html，§3.6 性能 2026-10-27）：截图覆盖窗
// （常驻隐藏）、贴图、滚动选区框窗、滚动预览窗、滚动控制条、结果窗都加载
// 本页，不加载完整文件管理器 bundle（App + Blueprint + stores）。常驻覆盖窗
// 以 idle 空壳待命，会话数据经 shot-session 事件驱动挂载 ShotOverlay；Rust
// 侧等 shot_page_ready 回执（两个监听都注册完成之后才回执）才下发会话，事件
// 不丢。其余各窗仍走 initialization_script 注入的 window.__BOOT__ 一次性挂载。
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";

import "../index.css";
import { api } from "../lib/ipc";
import { suppressDefaultContextMenu } from "../lib/contextMenu";
import { ShotOverlay, type ShotBoot } from "./ShotOverlay";
import { PinWindow, type PinBoot } from "./PinWindow";
import { ScrollBar, type ScrollBarBoot } from "./ScrollBar";
import { ScrollPreview, type ScrollPreviewBoot } from "./ScrollPreview";
import { ScrollFrame, type ScrollFrameBoot } from "./ScrollFrame";
import { GifBar, type GifBarBoot } from "./GifBar";
import { ShotResult, type ResultBoot } from "./ShotResult";

// WebView2 默认右键菜单屏蔽（2026-11-11）：截图覆盖窗右键退出 / 贴图自绘
// 菜单都走 pointer 事件，不受影响
suppressDefaultContextMenu();

declare global {
  interface Window {
    __BOOT__?:
      | PinBoot
      | ScrollBarBoot
      | ScrollPreviewBoot
      | ScrollFrameBoot
      | GifBarBoot
      | ResultBoot
      | { window: "shot-idle" };
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
        await listen<ShotBoot>("shot-session", (e) => {
          setSession(e.payload);
        }),
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

/** 控制条宿主（shot-bar 窗滚动/GIF 共用）：预热 __BOOT__ 固定 gifbar 占位，
 *  复用会话靠 boot 事件换装——scroll 会话发 shot-bar-boot、gif 会话发
 *  shot-gif-bar-boot，谁在监听取决于当前挂载的组件（2026-11-22 回归：预热
 *  后首场 scroll 会话 GifBar 不监听 shot-bar-boot → 浮条停在罩内 → 长截图
 *  没有工具栏也无法退出）。宿主常驻监听两路事件按最新载荷切换组件：异类
 *  会话在此重挂（状态全量重置，语义正确），同类会话换装仍由各组件自己的
 *  boot 监听处理（不重挂） */
function BarHost({ initial }: { initial: GifBarBoot | ScrollBarBoot }) {
  const [boot, setBoot] = useState<GifBarBoot | ScrollBarBoot>(initial);
  useEffect(() => {
    let dead = false;
    const offs: (() => void)[] = [];
    (async () => {
      offs.push(
        await listen<{ w: number }>("shot-bar-boot", (e) =>
          setBoot({ window: "scrollbar", w: e.payload.w }),
        ),
        await listen<Omit<GifBarBoot, "window">>("shot-gif-bar-boot", (e) =>
          setBoot({ window: "gifbar", ...e.payload }),
        ),
      );
      if (dead) {
        offs.forEach((f) => f());
      }
    })();
    return () => {
      dead = true;
      offs.forEach((f) => f());
    };
  }, []);
  return boot.window === "scrollbar" ? (
    <ScrollBar key="scrollbar" boot={boot} />
  ) : (
    <GifBar key="gifbar" boot={boot} />
  );
}

const boot = window.__BOOT__;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  !boot || boot.window === "shot-idle" ? (
    <ShotHost />
  ) : boot.window === "pin" ? (
    <PinWindow boot={boot} />
  ) : boot.window === "frame" ? (
    <ScrollFrame boot={boot} />
  ) : boot.window === "scrollbar" || boot.window === "gifbar" ? (
    <BarHost initial={boot} />
  ) : boot.window === "scroll-preview" ? (
    <ScrollPreview boot={boot} />
  ) : (
    <ShotResult boot={boot} />
  ),
);
