import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { onGlobalKeyDown } from "./lib/keyboard";
import { hotkeySpecs } from "./lib/hotkey";
import { initOleDnd } from "./lib/oleDispatch";
import { installMouseNav } from "./lib/mouseNav";
import { setupAutoScrollbar } from "./lib/autoScrollbar";
import { zoomStep } from "./lib/zoom";
import {
  UPDATE_PROMPT_DELAY_MS,
  checkForUpdate,
  isUpdateAvailable,
} from "./lib/update";
import { api, THIS_PC, type Settings } from "./lib/ipc";
import {
  applyPreset,
  dfsPanes,
  mkPane,
  mkSplit,
  type LayoutNode,
} from "./lib/layoutTree";

// --bench 基准模式下跳过会话恢复/自动保存（内存验收专用）
let benchMode = false;
import { useClipboard } from "./stores/clipboard";
import { useJobs } from "./stores/jobs";
import { useLayout } from "./stores/layout";
import { useUi } from "./stores/ui";
import { useIsland } from "./stores/island";
import { applyTheme, useSettings } from "./stores/settings";
import { initTooltip } from "./lib/tooltip";
import { AboutDialog } from "./components/AboutDialog";
import { ContextMenu } from "./components/ContextMenu";
import { DialogHost } from "./components/DialogHost";
import { GlobalSearchPage } from "./components/GlobalSearch";
import { LayoutView } from "./components/LayoutView";
import { NavTree } from "./components/NavTree";
import { QuickPreviewHost } from "./components/QuickPreview";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { MenuEditorPage } from "./components/MenuEditorPage";

export default function App() {
  const tree = useLayout((s) => s.tree);
  // 独立页（占满顶栏以下整区）：打开时替换侧栏 + 导航树 + 窗格区
  const menuPage = useUi((s) => s.menuPage);
  const gsearchOpen = useUi((s) => s.globalSearch);

  // 启动：加载设置 → 恢复上次会话（--bench 模式则开 2×5 压测布局）→ 初始化布局/事件/快捷键（§6.9）
  useEffect(() => {
    // StrictMode 卸载-重挂：首次运行的 async 链在 cleanup 之后才走到注册监听的
    // 行上（unsubJobs 等此时还是 undefined，cleanup 拦不住）——每个 await 后核对
    // disposed，晚了就当场反注册，绝不留下双份 Tauri 事件/OLE 监听
    let disposed = false;
    const offAutoScrollbar = setupAutoScrollbar();
    const offMouseNav = installMouseNav();
    let unsubJobs: (() => void) | undefined;
    let unsubOle: (() => void) | undefined;
    let unsubSettings: (() => void) | undefined;
    (async () => {
      try {
        await useSettings.getState().load();
        const st: Settings = useSettings.getState();

        // 系统级全局热键（§3.7）：全部热键单点全量注册（截图 + 剪贴板历史），
        // 失败静默（设置页改动时会重新注册并经灵动岛回执提示冲突）
        void api
          .hotkeysSync(hotkeySpecs(st))
          .catch(() => undefined);
        // 剪贴板历史监听（§3.7）：启停 + 护栏推送
        void api
          .cliphistConfigure(st.cliphistEnabled, st.cliphistCapacity, st.cliphistKeepDays)
          .catch(() => undefined);

        const args = await api.getLaunchArgs().catch<string[]>(() => []);
        const benchIdx = args.indexOf("--bench");
        let restored: LayoutNode | null = null;
        if (benchIdx >= 0 && args[benchIdx + 1]) {
          benchMode = true;
          const base = args[benchIdx + 1].replace(/[\\/]+$/, "");
          const cells = Array.from({ length: 10 }, (_, i) =>
            mkPane(`${base}\\pane-${String(i + 1).padStart(2, "0")}`),
          );
          // A/B 内存诊断：--bench-single 只开 1 窗格（临时，勿提交正式流程）
          if (args.includes("--bench-single")) {
            restored = cells[0];
          } else if (args.includes("--bench-3")) {
            restored = mkSplit("vertical", cells.slice(0, 3));
          } else {
            restored = mkSplit("horizontal", [
              mkSplit("vertical", cells.slice(0, 5)),
              mkSplit("vertical", cells.slice(5)),
            ]);
          }
        } else if (st.restoreLastSession) {
          try {
            const ws = await api.loadWorkspace("上次会话");
            restored = (ws.tree as LayoutNode) ?? null;
          } catch {
            // 无上次会话文件
          }
        }
        // 无会话可恢复时回落到"默认方案"：已保存过则用保存的布局，否则出厂 2×2
        if (!restored) {
          try {
            const d = await api.loadWorkspace("默认方案");
            restored = (d.tree as LayoutNode) ?? null;
          } catch {
            // 未保存过默认方案
          }
        }
        if (disposed) return;
        useLayout.getState().init(restored ?? applyPreset(mkPane(THIS_PC), "2x2"));
        // 恢复回执：灵动岛轻播报（首启无会话不播报）
        if (restored && st.restoreLastSession) {
          useIsland
            .getState()
            .pushReceipt("info", `已恢复上次会话 · ${dfsPanes(restored).length} 个窗格`);
        }
        unsubJobs = await useJobs.getState().init();
        if (disposed) {
          unsubJobs();
          unsubJobs = undefined;
          return;
        }
        // 剪贴板浮窗顶栏「设置」钮 → 唤起主窗直达设置面板（§3.7）
        const unSettings = await listen("cliphist-open-settings", () => {
          useUi.getState().openSettings("appearance");
        });
        if (disposed) {
          unSettings();
        } else {
          unsubSettings = unSettings;
        }
        unsubOle = await initOleDnd();
        if (disposed) {
          unsubOle();
          unsubOle = undefined;
          return;
        }
        window.addEventListener("keydown", onGlobalKeyDown);
        window.addEventListener("wheel", onZoomWheel, { passive: false });
        // V2：从 Explorer 复制后切回本窗口时同步系统剪贴板（CF_HDROP）
        window.addEventListener("focus", onFocusSyncClipboard);
        void useClipboard.getState().syncFromSystem();

        // 启动静默检查更新（双源拉取失败即静默，不打扰）：结果驱动顶栏关于钮角标；
        // 发现新版本且此刻无弹窗/整页占用时，短暂延迟后自动弹「关于」浮窗
        // 供用户选择 Gitee/GitHub 下载（Gitee 国内网络更快，浮窗内已注明）
        void checkForUpdate().then((c) => {
          if (disposed) return;
          useUi.getState().setUpdateCheck(c);
          if (isUpdateAvailable(c)) {
            window.setTimeout(() => {
              const ui = useUi.getState();
              if (
                ui.dialog ||
                ui.settingsTab ||
                ui.menuPage ||
                ui.globalSearch ||
                ui.aboutOpen
              ) {
                return; // 有界面占用：只留角标，用户点关于钮仍可见新版提示
              }
              ui.openAbout();
            }, UPDATE_PROMPT_DELAY_MS);
          }
        });
      } catch (e) {
        // 启动链路任何一步失败都兜底出默认布局，避免内容区白屏；错误上 toast 便于定位
        console.error(e);
        useUi.getState().toast(`启动恢复失败：${String(e)}`, "error");
        useLayout.getState().init(applyPreset(mkPane(THIS_PC), "2x2"));
      }
    })();
    return () => {
      disposed = true;
      offAutoScrollbar();
      offMouseNav();
      unsubJobs?.();
      unsubOle?.();
      unsubSettings?.();
      window.removeEventListener("keydown", onGlobalKeyDown);
      window.removeEventListener("wheel", onZoomWheel);
      window.removeEventListener("focus", onFocusSyncClipboard);
    };
  }, []);

  // "上次会话"自动保存：树变化防抖 1s（§6.9 原子写由后端完成）
  useEffect(() => {
    let t: number | undefined;
    const unsub = useLayout.subscribe((s) => {
      if (!s.tree || benchMode || !useSettings.getState().restoreLastSession) return;
      window.clearTimeout(t);
      t = window.setTimeout(
        () => api.saveWorkspace("上次会话", s.tree).catch(() => undefined),
        1000,
      );
    });
    return () => {
      unsub();
      window.clearTimeout(t);
    };
  }, []);

  // 跟随系统主题
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => applyTheme(useSettings.getState().theme);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);

  // 自绘悬浮提示全局单例（2026-10-21 定案 · 方案 B）：替代原生 title，见 lib/tooltip.ts
  useEffect(() => initTooltip(), []);

  return (
    <div className="np-shell">
      {/* 窗缘盖板×4（2026-10-17 顶缘 / 2026-10-21 扩四缘并拆小条）：弹层 portal 触发
          WebView2 固定层合成 glitch——顶缘 ~2px 蓝线 + backdrop 画不到的最外侧 ~1px
          亮边（合成器产物，elementsFromPoint 查无元素 = 逐像素实测定位）。画布色
          固定条盖住，遮罩在场时叠加同浓度遮罩色（index.css body:has 规则）；拆四条
          小条是为避免全视口大固定层在主题切换时与内容层栅格化不同步（弧波伪影） */}
      <div className="np-winedge np-winedge-top" aria-hidden />
      <div className="np-winedge np-winedge-bottom" aria-hidden />
      <div className="np-winedge np-winedge-left" aria-hidden />
      <div className="np-winedge np-winedge-right" aria-hidden />
      <TitleBar />
      <div className="np-body">
        {menuPage ? (
          <MenuEditorPage />
        ) : gsearchOpen ? (
          <GlobalSearchPage />
        ) : (
          <>
            <Sidebar />
            <NavTree />
            <main className="np-main">{tree ? <LayoutView node={tree} /> : null}</main>
          </>
        )}
      </div>
      <DialogHost />
      {/* 设置浮窗（Dialog）：常驻挂载，开合与直达分类由 useUi.settingsTab 驱动 */}
      <SettingsPanel />
      {/* 关于浮窗（Dialog）：常驻挂载，开合由 useUi.aboutOpen 驱动（顶栏信息钮/启动新版提示） */}
      <AboutDialog />
      <QuickPreviewHost />
      <ContextMenu />
      {benchMode && <BenchFps />}
    </div>
  );
}

function onFocusSyncClipboard() {
  void useClipboard.getState().syncFromSystem();
}

/** Ctrl+滚轮 / 触控板捏合缩放：deltaY 累积过阈值才步进一档，
 *  避免捏合事件粒度过细导致缩放连跳；preventDefault 拦下页面原生缩放 */
let zoomAcc = 0;
function onZoomWheel(e: WheelEvent) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoomAcc += e.deltaY;
  if (Math.abs(zoomAcc) < 40) return;
  const dir = zoomAcc < 0 ? 1 : -1;
  zoomAcc = 0;
  const s = useSettings.getState();
  s.update({ uiZoom: zoomStep(s.uiZoom, dir) });
}

/** rAF 帧率计（最近 30 帧滑动平均），仅供 --bench 验收读数；
 *  镜像到原生窗口标题（≥500ms 节流，避免高频 IPC），便于外部脚本采样 */
function BenchFps() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    const win: number[] = [];
    let last = performance.now();
    let raf = 0;
    let lastTitleAt = 0;
    let lastTitle = -1;
    const tick = (t: number) => {
      const dt = t - last;
      last = t;
      win.push(dt);
      if (win.length > 30) win.shift();
      if (win.length === 30) {
        const avg = win.reduce((a, b) => a + b, 0) / win.length;
        const v = Math.round(1000 / avg);
        setFps(v);
        if (v !== lastTitle && t - lastTitleAt > 500) {
          lastTitle = v;
          lastTitleAt = t;
          // 附 V8 JS 堆（performance.memory），便于区分渲染进程内存构成
          const mem = (
            performance as Performance & {
              memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
            }
          ).memory;
          const heap = mem ? `·JS堆${Math.round(mem.usedJSHeapSize / 1048576)}M` : "";
          void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
            getCurrentWindow().setTitle(`X-Dir ${v}FPS ${heap}`),
          );
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="np-bench-fps" title="滚动帧率（最近 30 帧平均，验收标准 ≥55）">
      {fps} FPS
    </div>
  );
}
