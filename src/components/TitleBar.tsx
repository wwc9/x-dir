import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Button,
  Menu,
  MenuDivider,
  MenuItem,
  PopoverNext,
} from "@blueprintjs/core";

import { api, THIS_PC } from "../lib/ipc";
import {
  Copy,
  FolderOpen,
  FolderTree,
  HardDrive,
  History,
  Info,
  LayoutTemplate,
  Minus,
  Moon,
  WandSparkles,
  Plus,
  Search,
  Settings,
  Square,
  Star,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { AppIcon, ic } from "./AppIcon";
import { AboutBadgeDot } from "./AboutDialog";
import { BrandLogo } from "./BrandLogo";
import { IslandPill } from "./IslandPill";
import { PresetPicker } from "./Sidebar";
import { DENSITY } from "../lib/tokens";
import { isUpdateAvailable } from "../lib/update";
import { useLayout } from "../stores/layout";
import { usePanes } from "../stores/panes";
import { setThemeWithFx, useSettings } from "../stores/settings";
import { useHistory } from "../stores/history";
import { useUi } from "../stores/ui";

const KNOWN = [
  { id: "desktop", label: "桌面" },
  { id: "documents", label: "文档" },
  { id: "downloads", label: "下载" },
];

/** 顶栏浏览记录弹层的展示上限（settings.recentFolders 存储上限 50 条，超出只存不显） */
const HISTORY_SHOW_MAX = 20;

interface DriveLite {
  letter: string;
  label: string;
}

/** 自绘顶栏：logo + 工具命令 + 拖拽区（活动路径 pill）+ 窗口控制，合为一行 */
export function TitleBar() {
  const [drives, setDrives] = useState<DriveLite[]>([]);
  const [known, setKnown] = useState<Record<string, string>>({});
  const [maximized, setMaximized] = useState(false);
  // 右键菜单独立页/全盘搜索页开合（整页互斥）+ 设置浮窗直达分类（状态在 useUi）
  const menuPage = useUi((s) => s.menuPage);
  const gsearchOpen = useUi((s) => s.globalSearch);
  const settingsTab = useUi((s) => s.settingsTab);
  const [presetOpen, setPresetOpen] = useState(false);
  // 切片订阅：顶栏只关心这几个字段。整店订阅（useSettings() 无 selector）会让
  // 拖列宽、搜索落历史等高频 set 整帧重渲染顶栏
  const treeVisible = useSettings((s) => s.navTreeVisible);
  const recentFolders = useSettings((s) => s.recentFolders);
  const theme = useSettings((s) => s.theme);
  const favorites = useSettings((s) => s.favorites);
  const uiZoom = useSettings((s) => s.uiZoom);
  // 更新检查结果（启动静默检查 / 关于浮窗写入）：有新版本时关于钮亮角标
  const updateCheck = useUi((s) => s.updateCheck);
  const hasNewVersion = isUpdateAvailable(updateCheck);
  const [histOpen, setHistOpen] = useState(false);
  const [favOpen, setFavOpen] = useState(false);
  // 跟随系统档的实时长亮态：只驱动切换按钮的图标/文案，文档类名由 applyTheme 统一管
  const [sysDark, setSysDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const activePath = useLayout((s) =>
    s.activePane()?.tabs[s.activePane()!.activeTab]?.path ?? THIS_PC,
  );

  useEffect(() => {
    api
      .getDrives()
      .then((ds) => setDrives(ds.map((d) => ({ letter: d.letter, label: d.label }))))
      .catch(() => undefined);
    for (const k of KNOWN) {
      api
        .getKnownFolder(k.id)
        .then((p) => setKnown((prev) => ({ ...prev, [k.id]: p })))
        .catch(() => undefined);
    }
    const w = getCurrentWindow();
    let un: (() => void) | undefined;
    let disposed = false;
    w.isMaximized().then(setMaximized).catch(() => undefined);
    w.listen("tauri://resize", () => {
      w.isMaximized().then(setMaximized).catch(() => undefined);
    }).then((u) => {
      if (disposed) u(); // 卸载先于 listen resolve：当场反注册，不泄漏
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  // 当前生效是否深色（含"跟随系统"档），决定切换按钮的朝向
  const isDark = theme === "dark" || (theme === "system" && sysDark);

  // ── 弹层按钮悬浮打开（2026-10-17）：浏览记录/收藏夹/布局预设悬浮即开 ──
  // 关闭 = 指针离开按钮与弹层（共享宽限 DENSITY.hoverCloseMs，横穿缝隙不闪跳），
  // 或再点按钮 / 点顶栏空白。整页（全盘搜索/定制）开着时悬浮不动作——弹层的
  // 导航目标作用于主界面窗格，路过顶栏不应把整页顶掉（点击路径仍 exitPages）。
  const hoverCloseTimer = useRef<number | null>(null);
  const cancelHoverClose = () => {
    if (hoverCloseTimer.current !== null) {
      clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  };
  useEffect(() => cancelHoverClose, []);
  /** 进入触发钮：清宽限、互斥开自己；on = 该弹层的 set(true) */
  const hoverEnter = (on: () => void) => () => {
    cancelHoverClose();
    if (useUi.getState().globalSearch || useUi.getState().menuPage) return;
    setHistOpen(false);
    setFavOpen(false);
    setPresetOpen(false);
    on();
  };
  /** 离开触发钮/弹层：宽限后关闭（期间进入任一悬浮面即取消） */
  const hoverLeave = (off: () => void) => () => {
    cancelHoverClose();
    hoverCloseTimer.current = window.setTimeout(() => {
      hoverCloseTimer.current = null;
      off();
    }, DENSITY.hoverCloseMs);
  };
  /** 弹层内容包裹层：进入取消关闭、离开续接宽限（按钮与弹层两段悬浮面拼接） */
  const hoverProps = (off: () => void) => ({
    onMouseEnter: cancelHoverClose,
    onMouseLeave: hoverLeave(off),
  });

  function navigateActive(path: string) {
    const pane = useLayout.getState().activePane();
    const tabId = pane?.tabs[pane.activeTab]?.id;
    if (tabId) usePanes.getState().navigate(tabId, path);
  }

  return (
    <header
      className="np-titlebar"
      data-tauri-drag-region
      onMouseDown={(e) => {
        // 地址栏编辑态退出（Explorer 口径）：拖拽区按下会进入原生拖拽循环，
        // Pane 的 window 级外点失焦监听在部分路径下不可依赖——顶栏统一显式失焦兜底
        const ae = document.activeElement;
        if (ae instanceof HTMLInputElement && ae.closest(".np-addrwrap")) ae.blur();
        // 顶栏带拖拽区（data-tauri-drag-region）：空白处按下会进入原生窗口拖动，
          // click 事件被拖动循环吞掉，Blueprint 的"点外关闭"收不到 → 弹层关不上。
          // 因此按下时主动关闭弹层；按在触发钮（.np-pop-trigger）上则交给按钮自身 toggle。
          // 弹层内容经 React portal 挂在 body，合成事件却沿 React 树冒泡回 header——
          // portal 内部（.bp6-portal）的按下必须排除，否则弹层在 mousedown 阶段被卸载，
          // mouseup 落空，MenuItem.onClick 永远收不到 click（收藏夹/历史菜单失灵的根因）
          const t = e.target as HTMLElement;
          if (!t.closest(".np-pop-trigger") && !t.closest(".bp6-portal")) {
            setHistOpen(false);
            setFavOpen(false);
            setPresetOpen(false);
          }
        }}
    >
      {/* 品牌标：九宫格对角渐变（与应用/任务栏图标同源，BrandLogo 与「关于」浮窗共用） */}
      <span className="np-logo">
        <BrandLogo />
      </span>
      <span className="np-title">X-Dir</span>

      <Button
        minimal
        size="small"
        icon={ic(FolderTree)}
        active={treeVisible}
        title="导航树（所有窗格共用）"
        onClick={() => {
          // 整页（全盘搜索/定制）打开时点主界面类按钮：先回主界面再执行
          useUi.getState().exitPages();
          useSettings.getState().update({ navTreeVisible: !treeVisible });
        }}
      />

      <PopoverNext
        isOpen={histOpen}
        onClose={() => setHistOpen(false)}
        placement="bottom-start"
        arrow={false}
        content={
          <div {...hoverProps(() => setHistOpen(false))}>
          <Menu className="np-hist-menu">
            {recentFolders.length === 0 && (
              <MenuItem text="暂无浏览记录" disabled />
            )}
            {recentFolders.slice(0, HISTORY_SHOW_MAX).map((p) => (
              <MenuItem
                key={p}
                icon={ic(FolderOpen)}
                text={p === THIS_PC ? "此电脑" : p}
                onClick={() => {
                  setHistOpen(false);
                  navigateActive(p);
                }}
              />
            ))}
            {recentFolders.length > HISTORY_SHOW_MAX && (
              <MenuItem
                text={`仅显示最近 ${HISTORY_SHOW_MAX} 条（共 ${recentFolders.length} 条）`}
                disabled
              />
            )}
            {recentFolders.length > 0 && (
              <>
                <MenuDivider />
                <MenuItem
                  icon={ic(Trash2)}
                  text="清空浏览记录"
                  onClick={() => {
                    useHistory.getState().clear();
                    setHistOpen(false);
                  }}
                />
              </>
            )}
          </Menu>
          </div>
        }
      >
        <Button
          minimal
          size="small"
          className="np-pop-trigger"
          icon={ic(History)}
          active={histOpen}
          title="浏览记录"
          onMouseEnter={hoverEnter(() => setHistOpen(true))}
          onMouseLeave={hoverLeave(() => setHistOpen(false))}
          onClick={() => {
            // 整页打开时先回主界面：浏览记录的导航目标作用于主界面窗格
            useUi.getState().exitPages();
            setHistOpen((o) => !o);
            setFavOpen(false);
            setPresetOpen(false);
          }}
        />
      </PopoverNext>

      <PopoverNext
        isOpen={favOpen}
        onClose={() => setFavOpen(false)}
        placement="bottom-start"
        arrow={false}
        content={
          <div {...hoverProps(() => setFavOpen(false))}>
          <Menu>
            {KNOWN.map((k) => (
              <MenuItem
                key={k.id}
                text={k.label}
                onClick={() => {
                  const p = known[k.id];
                  if (p) {
                    setFavOpen(false);
                    navigateActive(p);
                  }
                }}
              />
            ))}
            <MenuDivider />
            {drives.map((d) => (
              <MenuItem
                key={d.letter}
                icon={ic(HardDrive)}
                text={d.label ? `${d.label} (${d.letter})` : d.letter}
                onClick={() => {
                  setFavOpen(false);
                  navigateActive(d.letter + "\\");
                }}
              />
            ))}
            {favorites.length > 0 && <MenuDivider />}
            {favorites.map((f) => (
              <MenuItem
                key={f.path}
                text={f.name}
                labelElement={
                  <span
                    className="np-fav-remove"
                    title="移除收藏"
                    onClick={(e) => {
                      e.stopPropagation();
                      useSettings.getState().removeFavorite(f.path);
                    }}
                  >
                    <AppIcon icon={X} size={DENSITY.iconXs} />
                  </span>
                }
                onClick={() => {
                  setFavOpen(false);
                  navigateActive(f.path);
                }}
              />
            ))}
            <MenuDivider />
            <MenuItem
              icon={ic(Plus)}
              text="添加当前文件夹"
              onClick={() => {
                const p = useLayout.getState().activePath();
                if (p === THIS_PC) {
                  useUi.getState().toast("“此电脑”不能加入收藏", "error");
                } else {
                  useSettings.getState().addFavorite(p);
                }
                setFavOpen(false);
              }}
            />
          </Menu>
          </div>
        }
      >
        <Button
          minimal
          size="small"
          className="np-pop-trigger"
          icon={ic(Star)}
          active={favOpen}
          title="收藏夹"
          onMouseEnter={hoverEnter(() => setFavOpen(true))}
          onMouseLeave={hoverLeave(() => setFavOpen(false))}
          onClick={() => {
            // 整页打开时先回主界面：收藏夹导航目标作用于主界面窗格
            useUi.getState().exitPages();
            setFavOpen((o) => !o);
            setHistOpen(false);
            setPresetOpen(false);
          }}
        />
      </PopoverNext>

      {/* 语义分组分隔：浏览定位簇 | 全局模式簇 */}
      <span className="np-tb-sep" aria-hidden />

      <Button
        minimal
        size="small"
        icon={ic(Search)}
        active={gsearchOpen}
        title="全盘搜索（Ctrl+Shift+F）"
        onClick={() =>
          gsearchOpen
            ? useUi.getState().closeGlobalSearch()
            : useUi.getState().openGlobalSearch()
        }
      />

      <Button
        minimal
        size="small"
        icon={ic(WandSparkles)}
        active={menuPage}
        aria-label="定制"
        title="定制"
        onClick={() =>
          menuPage
            ? useUi.getState().closeMenuPage()
            : useUi.getState().openMenuPage()
        }
      />

      {/* 语义分组分隔：全局模式簇 | 应用级簇（2026-10-20 三次定案：应用级簇移至岛左侧，
          右簇只留 明暗切换 + 窗口控制） */}
      <span className="np-tb-sep" aria-hidden />

      {/* 布局预设（2026-10-12 自边栏移入）：16 宫格选择器，应用后弹层保持打开可连续试排 */}
      <PopoverNext
        isOpen={presetOpen}
        onClose={() => setPresetOpen(false)}
        placement="bottom-start"
        arrow={false}
        content={
          <div {...hoverProps(() => setPresetOpen(false))}>
            <PresetPicker />
          </div>
        }
      >
        <Button
          minimal
          size="small"
          className="np-pop-trigger"
          icon={ic(LayoutTemplate)}
          active={presetOpen}
          title="布局预设"
          onMouseEnter={hoverEnter(() => setPresetOpen(true))}
          onMouseLeave={hoverLeave(() => setPresetOpen(false))}
          onClick={() => {
            // 整页打开时先回主界面：预设排布作用于主界面窗格
            useUi.getState().exitPages();
            setPresetOpen((o) => !o);
            setHistOpen(false);
            setFavOpen(false);
          }}
        />
      </PopoverNext>

      <Button
        minimal
        size="small"
        icon={ic(Settings)}
        active={settingsTab !== null}
        aria-label="设置"
        title="设置"
        onClick={() => {
          // 整页打开时先回主界面：设置浮窗作用于主界面观感
          useUi.getState().exitPages();
          useUi.getState().openSettings("appearance");
        }}
      />

      {/* 关于 X-Dir：简介/开源地址/作者 + 更新检查；发现新版本时角标常亮提示 */}
      <Button
        minimal
        size="small"
        className="np-about-btn"
        icon={ic(Info)}
        aria-label="关于"
        title={
          hasNewVersion
            ? `关于 X-Dir（发现新版本 v${updateCheck?.manifest?.version}）`
            : "关于 X-Dir"
        }
        onClick={() => useUi.getState().openAbout()}
      >
        <AboutBadgeDot />
      </Button>

      <div
        className="np-drag"
        data-tauri-drag-region
        onDoubleClick={() => void getCurrentWindow().toggleMaximize()}
        title="拖动窗口 · 双击最大化/还原"
      >
        <IslandPill path={activePath} />
      </div>

      {/* 界面缩放指示：右簇首位常驻，点击重置 100%（Ctrl+滚轮/Ctrl+加减 调整后在此确认） */}
      <button
        className="np-zoompill"
        title={`界面缩放 ${Math.round(uiZoom * 100)}% · Ctrl+滚轮 / Ctrl+加减号调整 · 点击重置 100%`}
        onClick={() => useSettings.getState().update({ uiZoom: 1 })}
      >
        {Math.round(uiZoom * 100)}%
      </button>

      {/* 明暗切换：按当前生效主题二态翻转；"跟随系统"档仍在设置面板可选 */}
      <Button
        minimal
        size="small"
        icon={ic(isDark ? Sun : Moon)}
        title={isDark ? "切换为浅色主题" : "切换为深色主题"}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setThemeWithFx(isDark ? "light" : "dark", {
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
          });
        }}
      />

      {/* 窗口控制与功能钮之间：分组边界 + 安全间距（防误触窗口钮） */}
      <span className="np-tb-sep" aria-hidden />

      <button
        className="np-winbtn"
        title="最小化"
        onClick={() => void getCurrentWindow().minimize()}
      >
        <AppIcon icon={Minus} size={DENSITY.iconSm} />
      </button>
      <button
        className="np-winbtn"
        title={maximized ? "还原" : "最大化"}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        <AppIcon icon={maximized ? Copy : Square} size={DENSITY.iconSm} />
      </button>
      <button
        className="np-winbtn np-winbtn-close"
        title="关闭"
        onClick={() => void getCurrentWindow().close()}
      >
        <AppIcon icon={X} size={DENSITY.iconSm} />
      </button>
    </header>
  );
}
