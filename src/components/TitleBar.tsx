import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Button,
  Menu,
  MenuDivider,
  MenuItem,
  PopoverNext,
  Switch,
} from "@blueprintjs/core";

import { api, THIS_PC } from "../lib/ipc";
import {
  CalendarDays,
  Camera,
  ClipboardList,
  Copy,
  Ellipsis,
  FolderBookmark,
  FolderOpen,
  FolderTree,
  HardDrive,
  History,
  Info,
  Languages,
  LayoutTemplate,
  Minus,
  Moon,
  WandSparkles,
  Plus,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  VenetianMask,
  X,
  ZoomIn,
} from "lucide-react";
import { AppIcon, ic } from "./AppIcon";
import { AboutBadgeDot } from "./AboutDialog";
import { BrandLogo } from "./BrandLogo";
import { IslandPill } from "./IslandPill";
import { PresetPicker, PRESET_LIST } from "./Sidebar";
import { Seg } from "./ImgDialogs";
import { DENSITY } from "../lib/tokens";
import { isUpdateAvailable } from "../lib/update";
import { useLayout } from "../stores/layout";
import { usePanes } from "../stores/panes";
import { setThemeWithFx, useSettings } from "../stores/settings";
import { useT } from "../lib/i18n";
import { zoomStep } from "../lib/zoom";
import { useHistory } from "../stores/history";
import { useUi } from "../stores/ui";

const KNOWN = [
  { id: "desktop", label: "桌面" },
  { id: "documents", label: "文档" },
  { id: "downloads", label: "下载" },
];

/** 顶栏浏览记录弹层的展示上限（settings.recentFolders 存储上限 50 条，超出只存不显） */
const HISTORY_SHOW_MAX = 20;

/** 顶栏收纳档位（顶栏 content-box 宽 px）——与 index.css「顶栏渐进收纳」段
 *  同名档位保持同值，改一处必须改另一处。更多钮 = 左段被收纳功能的聚合
 *  入口（2026-11-18 用户定案「左段图标隐藏后纳入更多按钮」）；各项并入
 *  菜单的档位与对应按钮的 CSS 收纳档同值。档位在 TSX 侧算是因为弹层经
 *  portal 挂 body，容器查询够不着 portal 内容 */
const TB_MORE_AT = 900; // 更多钮出现 = 快捷组收纳档
const TB_MORE_POP = 780; // 弹层三件套（浏览记录/收藏/布局预设）并入菜单档
const TB_MORE_TREE = 380; // 导航树并入菜单档（同档还收标题与主题钮）
const TB_MORE_SEARCH = 280; // 全盘搜索并入菜单档
const TB_FLOOR = 250; // 物理下限：更多钮自身隐藏

interface DriveLite {
  letter: string;
  label: string;
}

/** 自绘顶栏（2026-11-11 方案 A 三段居中定案）：三段网格挂 np-tb-grid 内衬层
 *  （2026-11-18 改：容器查询不能样式化容器自身，且中岛撤收后右轨 1fr 转
 *  auto、左轨独享全部余量——旧 1fr auto 1fr 的空轨白吃一半余量，深水档左段
 *  提前挤爆）——左 = 品牌 + 三组（每组三个图标，2026-11-14 用户定案）：弹层
 *  组（浏览记录/收藏/布局预设）| 视图与捕获组（导航树/全盘搜索/截图）| 会话
 *  工具组（剪贴板/工作日历/定制）；中 = 灵动岛居中于左右按钮群之间的空白区
 *  （2026-11-24 用户定案，auto 1fr auto 三段网格，非窗口正中）；右 = 设置/关于 +
 *  系统态（缩放/主题/语言）+ 窗口控制。高缩放渐进收纳口径单源 index.css
 *  「顶栏渐进收纳」段：分组分隔线挂同名 data-tb 随组同收（孤儿线防护），
 *  被收纳的左段图标并入「更多」聚合钮（菜单项档位见 TB_MORE_* 常量），
 *  深水档保三段 = logo | 更多钮 | 设置+窗口控制（2026-11-18 用户定案）。
 *  段容器与段尾 np-tb-fill 弹性补白均带拖拽区：顶栏空白处可拖动窗口、
 *  双击最大化/还原 */
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
  const lang = useSettings((s) => s.lang);
  // 截图/剪贴板热键键位（tooltip 键帽随设置实时跟随）
  const shotEnabled = useSettings((s) => s.shotEnabled);
  const shotHotkey = useSettings((s) => s.shotHotkey);
  const cliphistHotkey = useSettings((s) => s.cliphistHotkey);
  // 工作日历（2026-11-13）：开合态 + 热键键位（tooltip 键帽随设置实时跟随）
  const calendarOpen = useUi((s) => s.calendarOpen);
  const calendarEnabled = useSettings((s) => s.calendarEnabled);
  const calendarHotkey = useSettings((s) => s.calendarHotkey);
  const t = useT();
  // 更新检查结果（启动静默检查 / 关于浮窗写入）：有新版本时关于钮亮角标
  const updateCheck = useUi((s) => s.updateCheck);
  const hasNewVersion = isUpdateAvailable(updateCheck);
  // 关于钮角标显示条件（与 AboutBadgeDot 内部判定同源）：children 必须在
  // 不显示时传 false——传 <AboutBadgeDot/>（内部渲染 null）会被 Blueprint
  // 判定"有文字内容"，图标失去 icon-only 负边距补偿，关于钮两侧多出空白
  const aboutOpen = useUi((s) => s.aboutOpen);
  const dotVisible = !aboutOpen && hasNewVersion;
  const [histOpen, setHistOpen] = useState(false);
  const [favOpen, setFavOpen] = useState(false);
  // 显示与外观快捷面板（2026-11-23 三钮合一）：缩放/主题/语言/毛玻璃悬浮直设
  const [qsOpen, setQsOpen] = useState(false);
  const glassOn = useSettings((s) => s.windowGlass === "on");
  // 更多钮（左段收纳聚合入口）：开合态 + 顶栏实际宽驱动档位。按钮显隐由
  // TSX 条件渲染（菜单项并入档位也靠它），CSS 容器查询只管各功能钮本体
  const [moreOpen, setMoreOpen] = useState(false);
  const tbRef = useRef<HTMLElement | null>(null);
  const [tbW, setTbW] = useState(0);
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

  // 顶栏宽度观测：contentRect.width = content-box 宽，与容器查询同口径基准
  useEffect(() => {
    const el = tbRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setTbW(es[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 更多钮档位（与 index.css 收纳梯度同名档，常量见 TB_MORE_*）：出现区间
  // = 快捷组收纳档 → 物理下限之前；各功能项并入档与对应按钮的 CSS 收纳档同值
  const moreShown = tbW > TB_FLOOR && tbW <= TB_MORE_AT;
  const morePop = moreShown && tbW <= TB_MORE_POP;
  const moreTree = moreShown && tbW <= TB_MORE_TREE;
  const moreSearch = moreShown && tbW <= TB_MORE_SEARCH;

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
    setMoreOpen(false);
    setQsOpen(false);
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

  /** 空白拖拽区双击 = 最大化/还原（三段各自的弹性补白与中段共享同一处理） */
  const toggleMaxDbl = () => void getCurrentWindow().toggleMaximize();

  return (
    <header
      ref={tbRef}
      className="np-titlebar"
      data-tauri-drag-region
      data-tip-down=""
      onMouseDown={(e) => {
        // 地址栏编辑态退出（Explorer 口径）：拖拽区按下会进入原生拖拽循环，
        // Pane 的 window 级外点失焦监听在部分路径下不可依赖——顶栏统一显式失焦兜底
        const ae = document.activeElement;
        if (ae instanceof HTMLInputElement && ae.closest(".np-addrwrap")) ae.blur();
        // 顶栏带拖拽区（data-tauri-drag-region）：空白处按下会进入原生窗口拖动，
          // click 事件被拖动循环吞掉，Blueprint 的"点外关闭"收不到 → 弹层关不上。
          // 因此按下时主动关闭弹层；按在触发钮（.np-pop-trigger / 更多钮
          // data-tb=more——后者不带该类，≤780 弹层收纳规则按类隐藏，更多钮
          // 必须存活）上则交给按钮自身 toggle。
          // 弹层内容经 React portal 挂在 body，合成事件却沿 React 树冒泡回 header——
          // portal 内部（.bp6-portal）的按下必须排除，否则弹层在 mousedown 阶段被卸载，
          // mouseup 落空，MenuItem.onClick 永远收不到 click（收藏夹/历史菜单失灵的根因）
          const t = e.target as HTMLElement;
          if (
            !t.closest(".np-pop-trigger") &&
            !t.closest('[data-tb="more"]') &&
            !t.closest(".bp6-portal")
          ) {
            setHistOpen(false);
            setFavOpen(false);
            setPresetOpen(false);
            setMoreOpen(false);
            setQsOpen(false);
          }
        }}
    >
      {/* 三段网格内衬：gap 区拖拽由本层承载（属性语义与 header 同），详见
          .np-tb-grid 注释 */}
      <div className="np-tb-grid" data-tauri-drag-region>
      {/* ── 左段：品牌 + 弹层组 + 模式组 ── */}
      <div className="np-tb-side np-tb-l" data-tauri-drag-region>
      {/* 品牌标：九宫格对角渐变（与应用/任务栏图标同源，BrandLogo 与「关于」浮窗共用） */}
      <span className="np-logo">
        <BrandLogo />
      </span>
      <span className="np-title">X-Dir</span>
      {/* 分隔线随弹层组同收（data-tb=pop，≤780）：组界消失线不留孤儿 */}
      <span className="np-tb-sep" aria-hidden data-tb="pop" />

      <PopoverNext
        isOpen={histOpen}
        onClose={() => setHistOpen(false)}
        placement="bottom-start"
        arrow={false}
        content={
          <div {...hoverProps(() => setHistOpen(false))}>
          <Menu className="np-hist-menu">
            {recentFolders.length === 0 && (
              <MenuItem text={t("暂无浏览记录")} disabled />
            )}
            {recentFolders.slice(0, HISTORY_SHOW_MAX).map((p) => (
              <MenuItem
                key={p}
                icon={ic(FolderOpen)}
                text={p === THIS_PC ? t("此电脑") : p}
                onClick={() => {
                  setHistOpen(false);
                  navigateActive(p);
                }}
              />
            ))}
            {recentFolders.length > HISTORY_SHOW_MAX && (
              <MenuItem
                text={t("仅显示最近 {a} 条（共 {b} 条）", {
                  a: HISTORY_SHOW_MAX,
                  b: recentFolders.length,
                })}
                disabled
              />
            )}
            {recentFolders.length > 0 && (
              <>
                <MenuDivider />
                <MenuItem
                  icon={ic(Trash2)}
                  text={t("清空浏览记录")}
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
          data-tip={t("浏览记录")}
          onMouseEnter={hoverEnter(() => setHistOpen(true))}
          onMouseLeave={hoverLeave(() => setHistOpen(false))}
          onClick={() => {
            // 整页打开时先回主界面：浏览记录的导航目标作用于主界面窗格
            useUi.getState().exitPages();
            setHistOpen((o) => !o);
            setFavOpen(false);
            setPresetOpen(false);
            setMoreOpen(false);
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
                text={t(k.label)}
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
                    data-tip={t("移除收藏")}
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
              text={t("添加当前文件夹")}
              onClick={() => {
                const p = useLayout.getState().activePath();
                if (p === THIS_PC) {
                  useUi.getState().toast(t("“此电脑”不能加入收藏"), "error");
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
          icon={ic(FolderBookmark)}
          active={favOpen}
          data-tip={t("收藏夹")}
          onMouseEnter={hoverEnter(() => setFavOpen(true))}
          onMouseLeave={hoverLeave(() => setFavOpen(false))}
          onClick={() => {
            // 整页打开时先回主界面：收藏夹导航目标作用于主界面窗格
            useUi.getState().exitPages();
            setFavOpen((o) => !o);
            setHistOpen(false);
            setPresetOpen(false);
            setMoreOpen(false);
          }}
        />
      </PopoverNext>

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
          data-tip={t("窗格布局预设")}
          onMouseEnter={hoverEnter(() => setPresetOpen(true))}
          onMouseLeave={hoverLeave(() => setPresetOpen(false))}
          onClick={() => {
            // 整页打开时先回主界面：预设排布作用于主界面窗格
            useUi.getState().exitPages();
            setPresetOpen((o) => !o);
            setHistOpen(false);
            setFavOpen(false);
            setMoreOpen(false);
          }}
        />
      </PopoverNext>

      {/* 语义分组分隔：快捷弹层组 | 模式切换组（2026-10-20 四次定案 · 方案 B 弹层组最前；
          data-tb=pop 随弹层组同收） */}
      <span className="np-tb-sep" aria-hidden data-tb="pop" />

      <Button
        minimal
        size="small"
        icon={ic(FolderTree)}
        data-tb="tree"
        active={treeVisible}
        data-tip={t("显示/隐藏导航树（所有窗格共用）")}
        onClick={() => {
          // 整页（全盘搜索/定制）打开时点主界面类按钮：先回主界面再执行
          useUi.getState().exitPages();
          useSettings.getState().update({ navTreeVisible: !treeVisible });
        }}
      />

      {/* 全盘搜索（深水档左段最后一钮，2026-11-18 用户定案三段结构不灭的落点） */}
      <Button
        minimal
        size="small"
        icon={ic(Search)}
        data-tb="search"
        active={gsearchOpen}
        aria-label={t("全盘搜索")}
        data-tip={t("全盘搜索")} data-kbd="Ctrl+Shift+F"
        onClick={() =>
          gsearchOpen
            ? useUi.getState().closeGlobalSearch()
            : useUi.getState().openGlobalSearch()
        }
      />

      {/* 截图（2026-11-06）：与系统热键同效——定格光标所在显示器并打开覆盖窗；
          按钮不受 shotEnabled 门控（热键可关，手动入口常开），键帽只在热键
          启用时展示当前键位 */}
      <Button
        minimal
        size="small"
        icon={ic(Camera)}
        data-tb="quick"
        aria-label={t("截图")}
        data-tip={t("截图")} data-kbd={shotEnabled ? shotHotkey : undefined}
        onClick={() => {
          void api.shotBegin().catch((e) => useUi.getState().toast(String(e), "error"));
        }}
      />

      {/* 语义分组分隔：视图与捕获组 | 会话工具组（2026-11-14 用户定案 3/3/3；
          data-tb=quick 随会话工具组同收，≤900 先撤） */}
      <span className="np-tb-sep" aria-hidden data-tb="quick" />

      {/* 剪贴板历史（2026-11-06）：与系统热键同入口的开/关浮窗；开 = 抓主窗
          为粘贴目标、光标显示器居中上屏，已开 = 收浮窗 */}
      <Button
        minimal
        size="small"
        icon={ic(ClipboardList)}
        data-tb="quick"
        aria-label={t("剪贴板历史")}
        data-tip={t("剪贴板历史")} data-kbd={cliphistHotkey}
        onClick={() => {
          void api.cliphistToggle().catch((e) => useUi.getState().toast(String(e), "error"));
        }}
      />

      {/* 工作日历（2026-11-13）：与系统热键同入口的开/关整页；按钮不受
          calendarEnabled 门控（热键可关，手动入口常开），键帽只在热键启用时展示 */}
      <Button
        minimal
        size="small"
        icon={ic(CalendarDays)}
        data-tb="quick"
        active={calendarOpen}
        aria-label={t("工作日历")}
        data-tip={t("工作日历")} data-kbd={calendarEnabled ? calendarHotkey : undefined}
        onClick={() => {
          if (calendarOpen) useUi.getState().closeCalendar();
          else useUi.getState().openCalendar();
        }}
      />

      {/* 定制（右键菜单与工具栏编辑入口，会话工具组末位） */}
      <Button
        minimal
        size="small"
        icon={ic(WandSparkles)}
        data-tb="quick"
        active={menuPage}
        aria-label={t("定制")}
        data-tip={t("定制右键菜单与工具栏")}
        onClick={() =>
          menuPage
            ? useUi.getState().closeMenuPage()
            : useUi.getState().openMenuPage()
        }
      />

      {/* 更多（2026-11-18 用户定案：左段图标被收纳后并入此钮保住入口）。
          点按开合（非悬浮），项随收纳档位并入：≤780 弹层三件套（子菜单）、
          ≤380 导航树、≤280 全盘搜索；截图/剪贴板/日历/定制恒在（更多钮只
          出现在快捷组收纳档之后）。宽度驱动见 TB_MORE_* 常量 */}
      {moreShown && (
        <PopoverNext
          isOpen={moreOpen}
          onClose={() => setMoreOpen(false)}
          placement="bottom-start"
          arrow={false}
          content={
            <Menu>
              {morePop && (
                <MenuItem icon={ic(History)} text={t("浏览记录")}>
                  {recentFolders.length === 0 && (
                    <MenuItem text={t("暂无浏览记录")} disabled />
                  )}
                  {recentFolders.slice(0, HISTORY_SHOW_MAX).map((p) => (
                    <MenuItem
                      key={p}
                      icon={ic(FolderOpen)}
                      text={p === THIS_PC ? t("此电脑") : p}
                      onClick={() => {
                        setMoreOpen(false);
                        useUi.getState().exitPages();
                        navigateActive(p);
                      }}
                    />
                  ))}
                  {recentFolders.length > HISTORY_SHOW_MAX && (
                    <MenuItem
                      text={t("仅显示最近 {a} 条（共 {b} 条）", {
                        a: HISTORY_SHOW_MAX,
                        b: recentFolders.length,
                      })}
                      disabled
                    />
                  )}
                  {recentFolders.length > 0 && (
                    <MenuItem
                      icon={ic(Trash2)}
                      text={t("清空浏览记录")}
                      onClick={() => {
                        useHistory.getState().clear();
                        setMoreOpen(false);
                      }}
                    />
                  )}
                </MenuItem>
              )}
              {morePop && (
                <MenuItem icon={ic(FolderBookmark)} text={t("收藏夹")}>
                  {KNOWN.map((k) => (
                    <MenuItem
                      key={k.id}
                      text={t(k.label)}
                      onClick={() => {
                        const p = known[k.id];
                        if (p) {
                          setMoreOpen(false);
                          useUi.getState().exitPages();
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
                        setMoreOpen(false);
                        useUi.getState().exitPages();
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
                          data-tip={t("移除收藏")}
                          onClick={(e) => {
                            e.stopPropagation();
                            useSettings.getState().removeFavorite(f.path);
                          }}
                        >
                          <AppIcon icon={X} size={DENSITY.iconXs} />
                        </span>
                      }
                      onClick={() => {
                        setMoreOpen(false);
                        useUi.getState().exitPages();
                        navigateActive(f.path);
                      }}
                    />
                  ))}
                  <MenuDivider />
                  <MenuItem
                    icon={ic(Plus)}
                    text={t("添加当前文件夹")}
                    onClick={() => {
                      const p = useLayout.getState().activePath();
                      if (p === THIS_PC) {
                        useUi.getState().toast(t("“此电脑”不能加入收藏"), "error");
                      } else {
                        useSettings.getState().addFavorite(p);
                      }
                      setMoreOpen(false);
                    }}
                  />
                </MenuItem>
              )}
              {morePop && (
                <MenuItem icon={ic(LayoutTemplate)} text={t("窗格布局预设")}>
                  {PRESET_LIST.map((p) => (
                    <MenuItem
                      key={p.id}
                      text={t(p.label)}
                      onClick={() => {
                        setMoreOpen(false);
                        useUi.getState().exitPages();
                        useLayout.getState().preset(p.id);
                      }}
                    />
                  ))}
                </MenuItem>
              )}
              {(morePop || moreTree || moreSearch) && <MenuDivider />}
              {moreTree && (
                <MenuItem
                  icon={ic(FolderTree)}
                  text={t("显示/隐藏导航树（所有窗格共用）")}
                  onClick={() => {
                    setMoreOpen(false);
                    useUi.getState().exitPages();
                    useSettings.getState().update({ navTreeVisible: !treeVisible });
                  }}
                />
              )}
              {moreSearch && (
                <MenuItem
                  icon={ic(Search)}
                  text={t("全盘搜索")}
                  onClick={() => {
                    setMoreOpen(false);
                    if (gsearchOpen) useUi.getState().closeGlobalSearch();
                    else useUi.getState().openGlobalSearch();
                  }}
                />
              )}
              {(moreTree || moreSearch) && <MenuDivider />}
              <MenuItem
                icon={ic(Camera)}
                text={t("截图")}
                onClick={() => {
                  setMoreOpen(false);
                  void api.shotBegin().catch((e) => useUi.getState().toast(String(e), "error"));
                }}
              />
              <MenuItem
                icon={ic(ClipboardList)}
                text={t("剪贴板历史")}
                onClick={() => {
                  setMoreOpen(false);
                  void api.cliphistToggle().catch((e) => useUi.getState().toast(String(e), "error"));
                }}
              />
              <MenuItem
                icon={ic(CalendarDays)}
                text={t("工作日历")}
                onClick={() => {
                  setMoreOpen(false);
                  if (calendarOpen) useUi.getState().closeCalendar();
                  else useUi.getState().openCalendar();
                }}
              />
              <MenuItem
                icon={ic(WandSparkles)}
                text={t("定制")}
                onClick={() => {
                  setMoreOpen(false);
                  if (menuPage) useUi.getState().closeMenuPage();
                  else useUi.getState().openMenuPage();
                }}
              />
            </Menu>
          }
        >
          <Button
            minimal
            size="small"
            icon={ic(Ellipsis)}
            active={moreOpen}
            data-tb="more"
            aria-label={t("更多")}
            data-tip={t("更多")}
            onClick={() => {
              setMoreOpen((o) => !o);
              setHistOpen(false);
              setFavOpen(false);
              setPresetOpen(false);
            }}
          />
        </PopoverNext>
      )}

      {/* 左段尾弹性拖拽补白：接管左段右侧大片空白（拖动窗口 / 双击最大化） */}
      <span
        className="np-tb-fill"
        data-tauri-drag-region
        onDoubleClick={toggleMaxDbl}
        data-tip={t("拖动窗口 · 双击最大化/还原")}
      />
      </div>

      {/* ── 中段：灵动岛（活动路径 pill / 任务通道），居中于左右按钮群之间的空白区 ── */}
      <div
        className="np-tb-mid"
        data-tauri-drag-region
        onDoubleClick={toggleMaxDbl}
        data-tip={t("拖动窗口 · 双击最大化/还原")}
      >
        <IslandPill path={activePath} />
      </div>

      {/* ── 右段：设置/关于 + 显示与外观快捷面板 + 窗口控制 ── */}
      <div className="np-tb-side np-tb-r" data-tauri-drag-region>
      <span
        className="np-tb-fill"
        data-tauri-drag-region
        onDoubleClick={toggleMaxDbl}
        data-tip={t("拖动窗口 · 双击最大化/还原")}
      />

      <Button
        minimal
        size="small"
        icon={ic(Settings)}
        active={settingsTab !== null}
        aria-label={t("设置")}
        data-tip={t("设置")}
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
        aria-label={t("关于")}
        data-tip={
          hasNewVersion
            ? t("关于 X-Dir（发现新版本 {v}）", {
                v: `v${updateCheck?.manifest?.version}`,
              })
            : t("关于 X-Dir")
        }
        onClick={() => useUi.getState().openAbout()}
      >
        {dotVisible ? <AboutBadgeDot /> : false}
      </Button>

      {/* 显示与外观快捷面板（2026-11-23 用户定案「三钮合一 + 悬浮直接设置」）：
          缩放/主题/语言/窗口毛玻璃四项收纳进单一功能钮（用户选定面具图标
          lucide VenetianMask），悬浮即开（沿用弹层组悬浮约定），全部控件与
          设置浮窗同一 store 双向同步；毛玻璃开关回执与设置页逐字一致（§4.8） */}
      <PopoverNext
        isOpen={qsOpen}
        onClose={() => setQsOpen(false)}
        placement="bottom-end"
        arrow={false}
        content={
          <div {...hoverProps(() => setQsOpen(false))}>
            <div className="np-qs-panel">
              <div className="np-qs-row">
                <AppIcon icon={ZoomIn} size={DENSITY.iconSm} className="np-qs-ic" />
                <span className="np-qs-label">{t("界面缩放")}</span>
                <span className="np-qs-step">
                  <button
                    className="np-qs-stepbtn"
                    aria-label={t("缩小")}
                    data-tip={t("缩小")}
                    data-kbd="Ctrl+-"
                    onClick={() => useSettings.getState().update({ uiZoom: zoomStep(uiZoom, -1) })}
                  >
                    −
                  </button>
                  <button
                    className="np-qs-val"
                    aria-label={t("点击重置 100%")}
                    data-tip={t("点击重置 100%")}
                    data-kbd="Ctrl+0"
                    onClick={() => useSettings.getState().update({ uiZoom: 1 })}
                  >
                    {Math.round(uiZoom * 100)}%
                  </button>
                  <button
                    className="np-qs-stepbtn"
                    aria-label={t("放大")}
                    data-tip={t("放大")}
                    data-kbd="Ctrl+="
                    onClick={() => useSettings.getState().update({ uiZoom: zoomStep(uiZoom, 1) })}
                  >
                    +
                  </button>
                </span>
              </div>
              <div className="np-qs-row">
                <AppIcon icon={Moon} size={DENSITY.iconSm} className="np-qs-ic" />
                <span className="np-qs-label">{t("主题")}</span>
                {/* 共享 Seg（滑块层供 accent 胶囊）；揭示特效取选中按钮圆心 */}
                <Seg<"light" | "dark" | "system">
                  value={theme}
                  options={[
                    { value: "light", label: t("浅色") },
                    { value: "dark", label: t("深色") },
                    { value: "system", label: t("跟随系统") },
                  ]}
                  onChange={(th, e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setThemeWithFx(th, {
                      x: r.left + r.width / 2,
                      y: r.top + r.height / 2,
                    });
                  }}
                />
              </div>
              <div className="np-qs-row">
                <AppIcon icon={Languages} size={DENSITY.iconSm} className="np-qs-ic" />
                <span className="np-qs-label">{t("语言")}</span>
                {/* 专属字面量「中文」：不得复用尺寸档的 t("中")（其 EN 词条是 Medium） */}
                <Seg<"zh" | "en">
                  value={lang}
                  options={[
                    { value: "zh", label: t("中文") },
                    { value: "en", label: "EN" },
                  ]}
                  onChange={(l) => useSettings.getState().update({ lang: l })}
                />
              </div>
              <div className="np-qs-row">
                <AppIcon icon={Sparkles} size={DENSITY.iconSm} className="np-qs-ic" />
                <span className="np-qs-label">{t("窗口毛玻璃")}</span>
                <Switch
                  checked={glassOn}
                  onChange={(e) => {
                    const m = e.currentTarget.checked ? "on" : "off";
                    useSettings.getState().update({ windowGlass: m });
                    useUi
                      .getState()
                      .toast(`${t("窗口毛玻璃")}：${m === "off" ? t("关") : t("开")}`);
                  }}
                />
              </div>
              <div className="np-qs-hint">{t("改动即时生效，与设置浮窗同步")}</div>
            </div>
          </div>
        }
      >
        <Button
          minimal
          size="small"
          className="np-pop-trigger"
          icon={ic(VenetianMask)}
          active={qsOpen}
          aria-label={t("显示与外观")}
          data-tip={t("显示与外观")}
          onMouseEnter={hoverEnter(() => setQsOpen(true))}
          onMouseLeave={hoverLeave(() => setQsOpen(false))}
          onClick={() => {
            setQsOpen((o) => !o);
            setHistOpen(false);
            setFavOpen(false);
            setPresetOpen(false);
            setMoreOpen(false);
          }}
        />
      </PopoverNext>

      {/* 窗口控制与功能钮之间：分组边界 + 安全间距（防误触窗口钮） */}
      <span className="np-tb-sep" aria-hidden />

      <button
        className="np-winbtn"
        data-tip={t("最小化")}
        onClick={() => void getCurrentWindow().minimize()}
      >
        <AppIcon icon={Minus} size={DENSITY.iconSm} />
      </button>
      <button
        className="np-winbtn"
        data-tip={maximized ? t("还原") : t("最大化")}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        <AppIcon icon={maximized ? Copy : Square} size={DENSITY.iconSm} />
      </button>
      <button
        className="np-winbtn np-winbtn-close"
        data-tip={t("关闭窗口")}
        onClick={() => void getCurrentWindow().close()}
      >
        <AppIcon icon={X} size={DENSITY.iconSm} />
      </button>
      </div>
      </div>
    </header>
  );
}
