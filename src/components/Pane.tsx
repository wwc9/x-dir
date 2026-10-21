import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  Button,
  InputGroup,
  MenuDivider,
  PopoverNext,
  Menu,
  MenuItem,
} from "@blueprintjs/core";

import { api, THIS_PC, type FileEntry, type MenuEntry, type ViewMode } from "../lib/ipc";
import { builtinByKey, entryVisible, type BuiltinFn } from "../lib/menuCommands";
import { getList } from "../lib/listRegistry";
import { fileNameOf, joinPath } from "../lib/path";
import { createEntry } from "../lib/operations";
import { dfsPanes, type PaneNode } from "../lib/layoutTree";
import { useLayout } from "../stores/layout";
import { usePanes } from "../stores/panes";
import { usePreview } from "../stores/preview";
import { useSettings } from "../stores/settings";
import { useT } from "../lib/i18n";
import { SEARCH_TYPE_OPTIONS } from "../lib/searchStream";
import { closePaneConfirmed, type MenuItem as UiMenuItem, useUi } from "../stores/ui";
import {
  ChevronRight,
  Computer,
  Filter,
  List,
  MoreHorizontal,
  Plus,
  Rows3,
  Search,
  X,
} from "lucide-react";
import { AppIcon, ic } from "./AppIcon";
import { NpSelect } from "./NpSelect";
import { DENSITY } from "../lib/tokens";
import { FileList } from "./FileList";
import { FN_ICONS } from "./MenuEditor";

const DND_MIME = "application/x-xdir";

const titleOf = (path: string) => (path === THIS_PC ? "此电脑" : fileNameOf(path));

/** 地址栏面包屑分段（纯函数）：Windows 路径按 \ 切分，盘符段显示 "E:"（Explorer
 *  口径不带斜杠）。超宽折叠不在此处做（按容器实测宽度在前端折叠态里收进 "…"） */
function crumbSegs(path: string): { label: string; target: string }[] {
  if (path === THIS_PC) return [];
  const parts = path.split("\\").filter(Boolean);
  if (!parts.length) return [{ label: path, target: path }];
  return parts.map((p, i) => ({
    label: p,
    target: `${parts.slice(0, i + 1).join("\\")}\\`,
  }));
}

/** 盘符卷标缓存（面包屑首段显示 "文件 (E:)" Explorer 口径；全局拉一次共用） */
const driveLabels = new Map<string, string>();
let driveLabelsPromise: Promise<void> | null = null;
function ensureDriveLabels(): Promise<void> {
  if (!driveLabelsPromise) {
    driveLabelsPromise = api
      .getDrives()
      .then((ds) => {
        for (const d of ds) driveLabels.set(`${d.letter}\\`, d.label);
      })
      .catch(() => undefined);
  }
  return driveLabelsPromise;
}

const VIEW_META: Record<ViewMode, { icon: typeof List; label: string }> = {
  list: { icon: List, label: "列表视图" },
  details: { icon: Rows3, label: "详细信息视图" },
};

/** 收纳档（仅出厂 12 键分档）：always = 地址栏左侧恒显；mid-wide <430px 收纳；
 *  only-wide <500px 收纳。未分档的键（用户新拖入的菜单功能）归入 only-wide */
const TOOL_TIER: Record<string, "always" | "mid-wide" | "only-wide"> = {
  up: "always",
  newFolder: "always",
  refresh: "always",
  view: "always",
  addr: "always",
  search: "mid-wide",
  splitH: "mid-wide",
  splitV: "mid-wide",
  swap: "mid-wide",
  copyPath: "only-wide",
  addFavorite: "only-wide",
  openTerminal: "only-wide",
};

export function Pane({ pane }: { pane: PaneNode }) {
  const active = useLayout((s) => s.activePaneId === pane.id);
  const swapFrom = useUi((s) => s.swapFrom);
  // 窗格工具栏配置（定制「窗格工具栏」区；启用条目有序，未列入不显示）
  const toolbarEntries = useSettings((s) => s.toolbarEntries);
  const tab = pane.tabs[pane.activeTab];
  const path = tab?.path ?? THIS_PC;
  const ui = usePanes((s) => s.tabs[tab?.id ?? ""]);
  const viewMode: ViewMode = ui?.viewMode ?? "details";
  const [addr, setAddr] = useState(path);
  const [sugg, setSugg] = useState<string[]>([]);
  const [suggIdx, setSuggIdx] = useState(-1);
  const [addrFocused, setAddrFocused] = useState(false);
  // 聚焦后是否实际键入过：仅键入后才请求补全（点击聚焦不弹下拉）
  const [addrDirty, setAddrDirty] = useState(false);
  const addrRef = useRef<HTMLInputElement>(null);
  // 地址栏容器（面包屑覆盖层的宿主）：覆盖层点击进编辑态时经它查 input，
  // 不依赖 Blueprint inputRef（实测 v6 下 ref 可能为空，Alt+D 的 DOM 查询路径才可靠）
  const addrWrapRef = useRef<HTMLDivElement>(null);
  /** 地址栏 input 元素（inputRef 失效时回落 DOM 查询）：聚焦/失焦统一走这里 */
  const addrInputEl = (): HTMLInputElement | null =>
    addrRef.current ??
    (addrWrapRef.current?.querySelector("input") as HTMLInputElement | null);

  const searching = (ui?.search ?? null) !== null;
  const filtering = (ui?.filter ?? null) !== null;

  // ── 视图过滤条（Ctrl+E）本地输入：200ms 防抖提交到 panes.filter，
  //    FileList 以 nameFilter 取数；关闭即清本地态与在途防抖 ──
  const [ftext, setFtext] = useState("");
  const fDebounce = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (filtering) return;
    window.clearTimeout(fDebounce.current);
    setFtext("");
  }, [filtering]);
  const commitFilter = (v: string) => {
    setFtext(v);
    window.clearTimeout(fDebounce.current);
    fDebounce.current = window.setTimeout(() => {
      // 防抖落袋前过滤可能已被 Esc 关闭：不再复写为开启态
      if (usePanes.getState().tabs[tabId]?.filter != null) {
        usePanes.getState().setFilter(tabId, v);
      }
    }, 200);
  };

  // ── 面包屑超宽折叠（Explorer 式）：默认渲染完整层级段，实测容器放不下时把
  //    前段收进 "…"（点它弹出被隐藏的上级菜单）；换路径即复原重测 ──
  const [crumbCollapsed, setCrumbCollapsed] = useState(false);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const crumbPathRef = useRef(path);
  if (crumbPathRef.current !== path) {
    // 渲染期派生状态复位（React 规范模式）：新路径先按完整面包屑出图，避免闪帧
    crumbPathRef.current = path;
    if (crumbCollapsed) setCrumbCollapsed(false);
  }
  useLayoutEffect(() => {
    if (crumbCollapsed) return; // 折叠态保持到下一次换路径（与 Explorer 一致，不随拉宽复原）
    const el = crumbsRef.current;
    if (!el) return; // 编辑态覆盖层未挂载，失焦重测
    const check = () => {
      // 折叠只在"确有可隐藏段"（>3 段）时生效：3 段以内塞不下就让末段
      // 就地省略号——否则 "…" 后面没有隐藏层级，纯占位反而更挤
      if (el.scrollWidth > el.clientWidth + 1 && crumbSegs(path).length > 3) {
        setCrumbCollapsed(true);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [crumbCollapsed, path, addrFocused]);
  // 盘符卷标（面包屑首段 "文件 (E:)"）：全局一次拉取，到位后刷新一次
  const [, bumpDriveLabels] = useState(0);
  useEffect(() => {
    void ensureDriveLabels().then(() => bumpDriveLabels((x) => x + 1));
  }, []);
  // 地址栏编辑态外点退出（Explorer 口径）：点击地址栏以外任意区域即失焦回到
  // 面包屑。显式 blur 兜底——列表空白框选等 mousedown preventDefault 会拦掉
  // 浏览器默认失焦，单靠 onBlur 不保证退出
  // 地址栏编辑态外点退出（Explorer 口径）：点击地址栏以外任意区域即失焦回到
  // 面包屑。显式 blur 兜底——列表空白框选等 mousedown preventDefault 会拦掉
  // 浏览器默认失焦，单靠 onBlur 不保证退出。
  // 来源判定必须用 composedPath：进入编辑态的同一下点击会同步卸载覆盖层，
  // 事件冒泡到 window 时目标节点已脱离 DOM（parentElement=null），
  // closest(".np-addrwrap") 恒为 null → 会被误判为外点、刚聚焦即被 blur
  useEffect(() => {
    if (!addrFocused) return;
    const onDown = (e: MouseEvent) => {
      const inWrap = (e.composedPath() as Element[]).some(
        (n) => n instanceof Element && n.classList?.contains("np-addrwrap"),
      );
      if (inWrap) return;
      addrInputEl()?.blur();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrFocused]);

  // 工具栏启用条件（与菜单统一为「选中依赖」语义）：不限/无选中 = 恒可用
  // （功能自身兼容有/无选中，或作用于当前文件夹）；选中项 = 按当前窗格选中项
  // 做完整条件判定（对象/数量/扩展名，entryVisible），未满足 = 按钮置灰。
  // 窗格工具（up/view/addr/search/split/swap）天生文件夹作用域，恒可用
  const TOOL_FOLDER = new Set(["up", "view", "addr", "search", "splitH", "splitV", "swap"]);
  const toolReady = (en: MenuEntry, key: string) => {
    if (TOOL_FOLDER.has(key) || en.area !== "sel") return true;
    return entryVisible(en.cond, "sel", getSelItems());
  };

  useEffect(() => {
    if (!tab) return;
    const st = useSettings.getState();
    usePanes
      .getState()
      .ensure(tab.id, { viewMode: st.defaultView, sort: st.defaultSort });
  }, [tab]);

  useEffect(() => {
    setAddr(path);
    if (!tab) return;
    const p = usePanes.getState().tabs[tab.id];
    // 恢复工作区后初始化历史栈（§6.3.2）
    if (p && p.historyIndex < 0) usePanes.getState().navigate(tab.id, path);
  }, [tab, path]);

  // 地址栏自动补全（V2 §3.2）：文件系统子目录建议 + 本地历史/收藏前缀匹配。
  // 仅在聚焦后实际键入（addrDirty）才请求建议，且过滤与当前输入相同的项——
  // 单纯点击地址栏不弹下拉（补全自身路径没有意义）
  useEffect(() => {
    if (!addrFocused || !addrDirty || addr === THIS_PC || !addr.includes("\\")) {
      setSugg([]);
      setSuggIdx(-1);
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      const lower = addr.toLowerCase();
      const local = localSuggestions(lower, ui?.history ?? []);
      api
        .suggestPaths(addr)
        .then((fs) => {
          if (stale) return;
          const merged = [...new Set([...fs, ...local])]
            .filter((s) => s.toLowerCase() !== addr.toLowerCase())
            .slice(0, 10);
          setSugg(merged);
          setSuggIdx(-1);
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addr, addrFocused, addrDirty]);

  // FileList 在子组件 effect 中注册菜单执行器（listRegistry）：挂载后强制刷新
  // 一次，依赖执行器的工具栏按钮才能在首帧后拿到非空解析
  const [, bumpRegistered] = useState(0);
  useEffect(() => bumpRegistered((x) => x + 1), []);

  if (!tab) return null;
  const tabId = tab.id;
  // 搜索类型（搜索浮层的类型选择；组合 ext: 词随查询下发，关闭搜索后保留）
  const searchType = usePanes((st) => st.tabs[tabId]?.searchType ?? "all");
  /** 当前窗格选中条目（FileEntry）：工具栏菜单功能的执行与条件判定上下文 */
  const getSelItems = (): FileEntry[] => {
    const sel = ui?.selected ?? [];
    if (!sel.length) return [];
    const snap = getList(tabId)?.getSnapshot();
    if (!snap) return [];
    const byPath = new Map(snap.entries.map((e) => [e.path, e]));
    return sel.map((p) => byPath.get(p)).filter((e): e is FileEntry => !!e);
  };
  const go = (p: string) => usePanes.getState().navigate(tabId, p);
  const openInTerminal = () => {
    // shell 选择存设置（powershell/cmd），Rust 端按档启动（wt 命令行/经典控制台）
    api
      .openTerminal(path, useSettings.getState().terminal)
      .catch((e: unknown) => {
        const msg = (e as { message?: string })?.message ?? String(e);
        useUi.getState().toast(msg, "error");
      });
  };
  // 收藏本窗格当前目录（与顶栏收藏夹同一份 favorites）
  const addFavorite = () => {
    useSettings.getState().addFavorite(path);
    useUi.getState().toast("已加入收藏");
  };
  // 复制本窗格当前路径到剪贴板
  const copyPath = () => {
    navigator.clipboard
      .writeText(path)
      .then(() => useUi.getState().toast("路径已复制"))
      .catch(() => useUi.getState().toast("复制失败", "error"));
  };

  // ── 窗格工具栏（共享功能库：settings.toolbarEntries 有序 MenuEntry，
  //    定制页拖拽编排；全部内置功能可入，未满足启用条件的按钮置灰）──
  const toolDefs = toolbarEntries
    .map((en) => ({ en, fn: builtinByKey(en.id.slice("builtin:".length)) }))
    .filter((d): d is { en: MenuEntry; fn: BuiltinFn } => !!d.fn);
  const cmdTools = toolDefs.filter((d) => TOOL_TIER[d.fn.key] !== "always");  // 收纳档命令工具（窄窗格隐藏，进「更多」菜单）
  const collapsibleTools = cmdTools;
  /** 窗格原生执行的功能键（其余内置功能走 FileList 菜单执行器，按选中项执行） */
  const NATIVE_TOOL_KEYS = new Set([
    "up",
    "newFolder",
    "refresh",
    "search",
    "splitH",
    "splitV",
    "swap",
    "copyPath",
    "addFavorite",
    "openTerminal",
  ]);

  const toolDisabled = (key: string) => {
    const needsPath =
      key === "up" ||
      key === "newFolder" ||
      key === "copyPath" ||
      key === "addFavorite" ||
      key === "openTerminal";
    return (needsPath && path === THIS_PC) || (key === "up" && path.length <= 3);
  };
  const runTool = (key: string) => {
    switch (key) {
      case "up":
        usePanes.getState().up(tabId);
        break;
      case "newFolder":
        void createEntry(path, "dir", () => usePanes.getState().bumpRefresh(tabId));
        break;
      case "refresh":
        usePanes.getState().bumpRefresh(tabId);
        break;
      case "search":
        usePanes.getState().setSearch(tabId, searching ? null : "");
        break;
      case "splitH":
        useLayout.getState().splitAt(pane.id, "horizontal");
        break;
      case "splitV":
        useLayout.getState().splitAt(pane.id, "vertical");
        break;
      case "swap": {
        const u = useUi.getState();
        if (u.swapFrom === pane.id) u.cancelSwap();
        else u.beginSwap(pane.id);
        break;
      }
      case "copyPath":
        copyPath();
        break;
      case "addFavorite":
        addFavorite();
        break;
      case "openTerminal":
        openInTerminal();
        break;
      default:
        // 菜单功能：FileList 执行器按当前选中上下文解析执行
        {
          const mi = getList(tabId)?.builtinMenuItem?.(key, getSelItems());
          if (mi && !mi.disabled) mi.action?.();
        }
    }
  };
  // 搜索浮层的外点退出：豁免仅限搜索框本体与窗格内的结果行/表头（排序、列宽
  // 属于搜索结果的操作）；其余一律退出——含本窗格空白处（如「此电脑」页面）。
  // 快速预览打开期间暂停外点退出：关闭预览/点预览遮罩的按下不属于"去别处操作"，
  // 不该退掉搜索结果（2026-10-17；预览关闭后恢复监听）
  useEffect(() => {
    if (!searching) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (usePreview.getState().queue.length) return;
      if (t.closest(".np-search-anchor") || t.closest(".np-search-pop")) return;
      // 类型选择下拉（portal 弹层）的点击属于搜索操作，不退出搜索
      if (t.closest(".np-search-type-pop")) return;
      const inPane = !!t.closest(`[data-pane-id="${pane.id}"]`);
      if (inPane && (t.closest(".np-row") || t.closest(".np-head-clip"))) return;
      usePanes.getState().setSearch(tabId, null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [searching, pane.id, tabId]);
  // 浮层水平跟随搜索键：实测锚点相对导航栏的偏移；收纳档位/窗格宽变化经
  // ResizeObserver 重测，右缘钳制在导航栏内（320px 浮层 + 8px 边距）
  const searchAnchorRef = useRef<HTMLDivElement>(null);
  const [searchPopX, setSearchPopX] = useState(0);
  useLayoutEffect(() => {
    if (!searching) return;
    const measure = () => {
      const el = searchAnchorRef.current;
      const nav = el?.closest(".np-nav");
      if (!el || !nav) return;
      const x = el.getBoundingClientRect().left - nav.getBoundingClientRect().left;
      // 浮层 320px 宽（输入框 + 类型选择，2026-10-17）：右缘钳制留 8px 边距
      setSearchPopX(Math.max(0, Math.min(x, nav.clientWidth - 328)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    const nav = searchAnchorRef.current?.closest(".np-nav");
    if (nav) ro.observe(nav);
    return () => ro.disconnect();
  }, [searching]);
  const t = useT();
  const toolTitle = (key: string) => {
    switch (key) {
      case "up":
        return t("上一级（Backspace）");
      case "newFolder":
        return t("新建文件夹（Ctrl+Shift+N）");
      case "search":
        return t("搜索当前文件夹（Ctrl+F）");
      case "swap":
        return t("交换窗格（点选目标窗格换位）");
      case "openTerminal":
        return t("在终端打开当前文件夹");
      case "addFavorite":
        return t("收藏当前文件夹");
      default:
        return t(builtinByKey(key)?.label ?? key);
    }
  };
  const tierCls = (key: string) =>
    TOOL_TIER[key] === "always"
      ? "np-nav-mid"
      : TOOL_TIER[key] === "mid-wide"
        ? "np-nav-mid-wide"
        : "np-nav-only-wide";
  const renderTool = ({ en, fn }: { en: MenuEntry; fn: BuiltinFn }) => {
    const key = fn.key;
    const ready = toolReady(en, key);
    const off = !ready || toolDisabled(key);
    // 地址框（固定条目，不可移除、可排序）：占用主位，键入/补全/回车导航。
    // 非聚焦态叠加面包屑覆盖层（np-addr-crumbs，:focus-within 隐藏），Explorer Win11
    // 口径：自左向右 = 此电脑（显示器图标）› 盘符（卷标）› 目录段 › 尾箭头（当前
    // 文件夹的子文件夹下拉）；超宽把前段收进 "…"（点击弹出被隐藏的上级），
    // 点空白进入编辑态显示完整路径
    if (key === "addr") {
      const crumbs = crumbSegs(path);
      // 双保险：≤3 段时折叠态本不该进入（热更新残留等），此时隐藏段为空，
      // "…" 是死按钮——渲染端一并拦掉
      const collapsed = crumbCollapsed && crumbs.length > 3;
      const shownCrumbs = collapsed ? crumbs.slice(-3) : crumbs;
      const hiddenCrumbs = collapsed ? crumbs.slice(0, -3) : [];
      // 盘符段卷标（仅未折叠时可见）：driveLabels 命中显示 "文件 (E:)"，否则 "E:"
      const driveRoot = crumbs[0]?.target ?? "";
      const vol = driveLabels.get(driveRoot);
      const driveLabel = vol ? `${vol} (${driveRoot[0]}:)` : crumbs[0]?.label ?? "";

      /** 箭头下拉：展示 target 的直接子文件夹（此电脑虚拟页 = 盘符列表），
       *  Explorer Win11 式逐层深入导航 */
      const openChildMenu = (target: string, x: number, y: number) => {
        if (target === THIS_PC) {
          void api
            .getDrives()
            .then((ds) => {
              useUi.getState().openMenu(
                ds.map((d) => ({
                  label: d.label ? `${d.label} (${d.letter})` : d.letter,
                  action: () => go(`${d.letter}\\`),
                })),
                x,
                y,
              );
            })
            .catch(() => undefined);
          return;
        }
        void api
          .listDirs(target, false)
          .then((dirs) => {
            if (!dirs.length) return;
            useUi.getState().openMenu(
              dirs.map((d) => ({
                label: d,
                action: () => go(joinPath(target, d)),
              })),
              x,
              y,
            );
          })
          .catch(() => undefined);
      };
      /** 层间箭头 = 前一段的子文件夹下拉按钮（分隔与导航二合一，替代纯分隔符） */
      const arrow = (prevTarget: string) => (
        <button
          className="np-crumb-tail"
          data-tip={t("浏览子文件夹")}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openChildMenu(prevTarget, r.left, r.bottom + 4);
          }}
        >
          <AppIcon icon={ChevronRight} size={DENSITY.iconXs} />
        </button>
      );

      const nodes: { key: string; el: ReactElement }[] = [];
      // 此电脑根节点：仅图标（悬停提示），点击回此电脑虚拟页
      nodes.push({
        key: "pc",
        el: (
          <button className="np-crumb" data-tip={t("此电脑")} onClick={() => go(THIS_PC)}>
            <AppIcon icon={Computer} size={DENSITY.iconSm} />
          </button>
        ),
      });
      shownCrumbs.forEach((c, ci) => {
        // 段前的箭头 = 上一层的子文件夹下拉（全局段下标：折叠态 shown 取末 3 段）
        const gi = collapsed ? crumbs.length - 3 + ci : ci;
        const prevTarget = gi === 0 ? THIS_PC : crumbs[gi - 1].target;
        nodes.push({ key: `a${gi}`, el: arrow(prevTarget) });
        const label = gi === 0 ? driveLabel : c.label;
        nodes.push({
          key: `s${gi}`,
          el: (
            <button
              className={`np-crumb${gi === crumbs.length - 1 ? " np-crumb-last" : ""}`}
              data-tip={c.target}
              onClick={() => go(c.target)}
            >
              <span className="np-ellipsis">{label}</span>
            </button>
          ),
        });
      });
      if (collapsed) {
        nodes.splice(1, 0, {
          key: "more",
          el: (
            <button
              className="np-crumb np-crumb-more"
              data-tip={t("更多上级目录")}
              onClick={(e) => {
                if (!hiddenCrumbs.length) return;
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                useUi.getState().openMenu(
                  hiddenCrumbs.map((h) => ({
                    label: h.label,
                    action: () => go(h.target),
                  })),
                  r.left,
                  r.bottom + 4,
                );
              }}
            >
              …
            </button>
          ),
        });
      }
      return (
        <div
          key={en.id}
          className="np-addrwrap"
          data-tip={path}
          ref={addrWrapRef}
          onMouseDown={(e) => {
            // 编辑态 = 原生输入行为；面包屑按钮（层级段/箭头/省略号）自带 onClick。
            // 其余空白 = 进入编辑态（全选完整路径）。处理器挂容器而非覆盖层：
            // 覆盖层点击会冒泡到这里，事件路由再多一层兜底。
            // 聚焦双保险：Blueprint inputRef 实测可能为空，回落 DOM 查询（Alt+D 同路径）；
            // preventDefault 防止浏览器把焦点转给其它可聚焦目标
            if (addrFocused) return;
            if ((e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            addrInputEl()?.focus();
          }}
        >
          <InputGroup
            size="small"
            className="np-addr"
            data-address={pane.id}
            inputRef={addrRef}
            // "此电脑"用占位符而非值：写成 value 会让键入从三个汉字后面继续拼，回车必失败
            value={addr === THIS_PC ? "" : addr}
            placeholder={addr === THIS_PC ? "此电脑" : undefined}
            intent={ui?.error ? "danger" : undefined}
            data-tip={ui?.error ?? undefined}
            onChange={(e) => {
              setAddr(e.target.value);
              setAddrDirty(true);
            }}
            onFocus={(e) => {
              setAddrFocused(true);
              setAddrDirty(false);
              // Explorer 惯例：聚焦即全选路径文本（点击/Tab/Alt+D 一致）；
              // 已聚焦后再点击不触发 focus，浏览器正常落 caret，可微调光标
              e.target.select();
            }}
            onBlur={() => {
              setAddrFocused(false);
              setAddrDirty(false);
              setSugg([]);
            }}
            onKeyDown={(e) => {
              if (sugg.length) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSuggIdx((i) => Math.min(sugg.length - 1, i + 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSuggIdx((i) => Math.max(-1, i - 1));
                  return;
                }
                if (e.key === "Tab" && suggIdx >= 0) {
                  e.preventDefault();
                  setAddr(sugg[suggIdx]);
                  return;
                }
              }
              if (e.key === "Enter") {
                if (addr.trim()) go(addr.trim());
                (e.target as HTMLInputElement).blur();
              }
              // Esc 还原路径并失焦（清空建议，快捷键清单 addr-revert 语义）
              if (e.key === "Escape") {
                setAddr(path);
                (e.target as HTMLInputElement).blur();
              }
            }}
            spellCheck={false}
          />
          {!addrFocused && crumbs.length > 0 && (
            <div ref={crumbsRef} className="np-addr-crumbs">
              {nodes.map((n) => (
                <Fragment key={n.key}>{n.el}</Fragment>
              ))}
            </div>
          )}
        </div>
      );
    }
    // 递归搜索键：搜索框以浮层锚在其正下方（2026-10-15，不占导航栏布局；
    // 点击本窗格以外区域自动退出，见下方 mousedown 监听）。浮层本体挂在
    // 导航栏层级渲染（与本栏补全下拉同款定位，避免被下邻行遮挡），
    // 水平位置由 searchAnchorRef 实测跟随
    if (key === "search") {
      return (
        <div key={en.id} ref={searchAnchorRef} className={`${tierCls(key)} np-search-anchor`}>
          <Button
            minimal
            size="small"
            icon={ic(Search)}
            active={searching}
            disabled={toolDisabled(key)}
            data-tip={`${toolTitle(key)}${t("（再点一次或 Esc 退出）")}`}
            onClick={() => runTool(key)}
          />
        </div>
      );
    }
    // 视图类型下拉（F3 仍可循环切换）；PopoverNext 不透传 className，档位类挂 wrapper
    if (key === "view") {
      return (
        <div key={en.id} className={tierCls(key)}>
          <PopoverNext
            placement="bottom-start"
            arrow={false}
            content={
              <Menu>
                {(Object.keys(VIEW_META) as ViewMode[]).map((m) => (
                  <MenuItem
                    key={m}
                    icon={ic(VIEW_META[m].icon)}
                    text={VIEW_META[m].label}
                    active={m === viewMode}
                    onClick={() => usePanes.getState().setView(tabId, m)}
                  />
                ))}
              </Menu>
            }
          >
            <Button
              minimal
              size="small"
              icon={ic(FN_ICONS[key] ?? List)}
              disabled={toolDisabled(key)}
              data-tip={toolTitle(key)}
            />
          </PopoverNext>
        </div>
      );
    }
    // 通用菜单功能（定制页拖入）：执行项按当前选中上下文解析（FileList 执行器）；
    // 带子菜单的功能（颜色标记/旋转/编码/归类/互传窗格）用弹出菜单承载。
    // PopoverNext 不透传 className，档位类挂 wrapper
    if (!NATIVE_TOOL_KEYS.has(key)) {
      const mi = getList(tabId)?.builtinMenuItem?.(key, getSelItems());
      const btn = (extra?: { onClick?: () => void }) => (
        <Button
          minimal
          size="small"
          className={`${tierCls(key)}${off ? " np-tool-off" : ""}`}
          icon={ic(FN_ICONS[key] ?? List)}
          disabled={off}
          data-tip={`${toolTitle(key)}${ready ? "" : t("（启用条件未满足）")}`}
          onClick={extra?.onClick}
        />
      );
      if (mi?.sub?.length) {
        return (
          <div key={en.id} className={tierCls(key)}>
            <PopoverNext
              placement="bottom-start"
              arrow={false}
              content={
                <Menu>
                  {mi.sub.map((it: UiMenuItem, i: number) =>
                    it.sep ? (
                      <MenuDivider key={i} />
                    ) : (
                      <MenuItem
                        key={i}
                        text={it.label}
                        disabled={it.disabled}
                        intent={it.danger ? "danger" : undefined}
                        onClick={() => it.action?.()}
                      />
                    ),
                  )}
                </Menu>
              }
            >
              {btn()}
            </PopoverNext>
          </div>
        );
      }
      return (
        <Button
          key={en.id}
          minimal
          size="small"
          className={`${tierCls(key)}${off ? " np-tool-off" : ""}`}
          icon={ic(FN_ICONS[key] ?? List)}
          disabled={off}
          data-tip={`${toolTitle(key)}${ready ? "" : t("（启用条件未满足）")}`}
          onClick={() => {
            const m = getList(tabId)?.builtinMenuItem?.(key, getSelItems());
            if (m && !m.disabled) m.action?.();
          }}
        />
      );
    }
    return (
      <Button
        key={en.id}
        minimal
        size="small"
        className={`${tierCls(key)}${off ? " np-tool-off" : ""}`}
        icon={ic(FN_ICONS[key] ?? List)}
        active={
          key === "search"
            ? searching
            : key === "swap"
              ? swapFrom === pane.id
              : undefined
        }
        disabled={off}
        data-tip={`${toolTitle(key)}${ready ? "" : t("（启用条件未满足）")}`}
        onClick={() => runTool(key)}
      />
    );
  };

  const pickSuggestion = (p: string) => {
    setSugg([]);
    setSuggIdx(-1);
    setAddr(p);
    go(p);
    addrInputEl()?.blur();
  };

  return (
    <div
      data-pane-id={pane.id}
      onMouseDown={() => {
        // 交换选择模式：点到的窗格即目标（点源窗格=取消），换位后不改变激活归属
        const ui = useUi.getState();
        if (ui.swapFrom) {
          const from = ui.swapFrom;
          ui.cancelSwap();
          if (from !== pane.id) useLayout.getState().exchangePanes(from, pane.id);
          return;
        }
        useLayout.getState().setActive(pane.id);
      }}
      className={`np-pane ${active ? "np-pane-active" : ""} ${
        swapFrom && swapFrom !== pane.id ? "np-swap-pick" : ""
      }`}
    >
      {/* 导航栏（§7.1：仅作用于本窗格）；历史经地址栏右侧下拉。
          工具栏由「定制」页编排（settings.toolbarEntries）*/}
      <div className="np-nav">
        {toolDefs.map(renderTool)}
        {/* 递归搜索浮层：挂导航栏层级（与补全下拉同款定位，不被下邻行遮挡），
            left 由锚点实测下发 */}
        {searching && (
          <div className="np-search-pop" style={{ left: searchPopX }}>
            <div className="np-search-row">
              <InputGroup
                size="small"
                className="np-search"
                data-search={pane.id}
                autoFocus
                leftElement={ic(Search)}
                value={ui?.search ?? ""}
                placeholder={t("递归搜索…")}
                onChange={(e) => usePanes.getState().setSearch(tabId, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") usePanes.getState().setSearch(tabId, null);
                }}
                spellCheck={false}
              />
              <NpSelect
                value={searchType}
                data-tip={t("类型（选文件/文件夹或常用类型，等同于 ext: 过滤）")}
                options={SEARCH_TYPE_OPTIONS}
                popoverClassName="np-search-type-pop"
                onChange={(v) => usePanes.getState().setSearchType(tabId, v)}
              />
            </div>
          </div>
        )}
        {/* 自动补全下拉（V2 §3.2；仅聚焦且有待选时出现；绝对定位不占布局） */}
        {addrFocused && sugg.length > 0 && (
          <div className="np-sugg">
            {sugg.map((s, i) => (
              <div
                key={s}
                className={`np-sugg-item ${i === suggIdx ? "on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault(); // 抢在输入框 blur 前生效
                  pickSuggestion(s);
                }}
              >
                <span className="np-ellipsis">{s}</span>
              </div>
            ))}
          </div>
        )}
        {/* 「更多」收纳菜单：常驻 DOM，仅 300–499px 档显示（PopoverNext 不透传
            className，档位类挂 wrapper）；内容 = 命令区可收纳工具，随自定义联动 */}
        <div className="np-nav-more">
          <PopoverNext
            placement="bottom-end"
            arrow={false}
            content={
              <Menu>
                {collapsibleTools.map(({ en, fn }) => {
                  // 菜单功能按当前选中上下文解析；带子菜单的功能挂二级菜单
                  const mi = NATIVE_TOOL_KEYS.has(fn.key)
                    ? null
                    : getList(tabId)?.builtinMenuItem?.(fn.key, getSelItems());
                  if (mi?.sub?.length) {
                    return (
                      <MenuItem
                        key={en.id}
                        icon={ic(FN_ICONS[fn.key] ?? List)}
                        text={fn.label}
                        disabled={toolDisabled(fn.key) || !toolReady(en, fn.key)}
                      >
                        <Menu>
                          {mi.sub.map((it: UiMenuItem, i: number) =>
                            it.sep ? (
                              <MenuDivider key={i} />
                            ) : (
                              <MenuItem
                                key={i}
                                text={it.label}
                                disabled={it.disabled}
                                intent={it.danger ? "danger" : undefined}
                                onClick={() => it.action?.()}
                              />
                            ),
                          )}
                        </Menu>
                      </MenuItem>
                    );
                  }
                  return (
                    <MenuItem
                      key={en.id}
                      icon={ic(FN_ICONS[fn.key] ?? List)}
                      text={fn.label}
                      active={
                        fn.key === "search"
                          ? searching
                          : fn.key === "swap"
                            ? swapFrom === pane.id
                            : undefined
                      }
                      disabled={toolDisabled(fn.key) || !toolReady(en, fn.key)}
                      onClick={() => runTool(fn.key)}
                    />
                  );
                })}
              </Menu>
            }
          >
            <Button minimal size="small" icon={ic(MoreHorizontal)} data-tip={t("更多")} />
          </PopoverNext>
        </div>
        <Button
          minimal
          size="small"
          icon={ic(X)}
          disabled={dfsPanes(useLayout.getState().tree!).length <= 1}
          onClick={() => closePaneConfirmed(pane.id)}
          data-tip={t("关闭窗格")} data-kbd="Ctrl+Shift+W"
        />
      </div>

      {/* 标签条 */}
      <div
        className="np-tabbar"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DND_MIME)) e.preventDefault();
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData(DND_MIME);
          if (!raw) return;
          try {
            const d = JSON.parse(raw) as {
              tabMove?: { fromPaneId: string; tabIndex: number };
            };
            if (d.tabMove) {
              // 标签跨窗格拖动（文件拖放已走 V3 OLE 管线，标签条落点见 lib/oleDispatch）
              useLayout.getState().moveTab(d.tabMove.fromPaneId, d.tabMove.tabIndex, pane.id);
            }
          } catch {
            /* 忽略 */
          }
        }}
      >
        {pane.tabs.map((t, i) => (
          <div
            key={t.id}
            className={`np-tab ${i === pane.activeTab ? "np-tab-on" : ""}`}
            onClick={() => useLayout.getState().activateTab(pane.id, i)}
            onAuxClick={(e) => {
              // 鼠标中键关闭标签（浏览器/资源管理器习惯）；阻止冒泡避免触发激活
              if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                useLayout.getState().closeTab(pane.id, i);
              }
            }}
            onContextMenu={(e) => {
              // 标签右键菜单：复制 / 关闭其他 / 关闭右侧（复制=同路径新标签原位插入）
              e.preventDefault();
              useLayout.getState().setActive(pane.id);
              const items: UiMenuItem[] = [
                {
                  label: "复制标签",
                  action: () => useLayout.getState().duplicateTab(pane.id, i),
                },
                {
                  label: "关闭标签",
                  action: () => useLayout.getState().closeTab(pane.id, i),
                },
              ];
              if (pane.tabs.length > 1) {
                items.push({ sep: true });
                items.push({
                  label: "关闭其他标签",
                  action: () => useLayout.getState().closeOtherTabs(pane.id, i),
                });
                if (i < pane.tabs.length - 1) {
                  items.push({
                    label: "关闭右侧标签",
                    action: () => useLayout.getState().closeTabsRight(pane.id, i),
                  });
                }
              }
              useUi.getState().openMenu(items, e.clientX, e.clientY);
            }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                DND_MIME,
                JSON.stringify({ tabMove: { fromPaneId: pane.id, tabIndex: i } }),
              );
              e.dataTransfer.effectAllowed = "move";
            }}
          >
            <span className="np-ellipsis">{titleOf(t.path)}</span>
            <span
              className="np-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                useLayout.getState().closeTab(pane.id, i);
              }}
            >
              <AppIcon icon={X} size={DENSITY.iconXs} />
            </span>
          </div>
        ))}
        <Button
          minimal
          size="small"
          icon={ic(Plus)}
          aria-label={t("新建标签")}
          onClick={() => useLayout.getState().newTab(pane.id)}
        />
      </div>

      {/* 视图过滤条（Ctrl+E）：就地收窄当前目录（Rust 端 nameFilter，不递归）；
          递归搜索打开期间让位（结果视图自有一套过滤语义）；"此电脑"页无名称可过滤 */}
      {filtering && !searching && path !== THIS_PC && (
        <div className="np-filterbar">
          <AppIcon icon={Filter} size={DENSITY.iconSm} />
          <input
            className="np-filter-input"
            data-filter={pane.id}
            value={ftext}
            placeholder={t("过滤当前文件夹（名称 / 拼音首字母，多词空格分隔）")}
            onChange={(e) => commitFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                usePanes.getState().setFilter(tabId, null);
              }
            }}
            spellCheck={false}
          />
          <span className="np-filter-count">{(ui?.total ?? 0).toLocaleString()} 项</span>
          <button
            className="np-filter-clear"
            data-tip={t("退出过滤")} data-kbd="Esc"
            onClick={() => usePanes.getState().setFilter(tabId, null)}
          >
            <AppIcon icon={X} size={DENSITY.iconXs} />
          </button>
        </div>
      )}

      <FileList tabId={tabId} paneId={pane.id} path={path} active={active} />
    </div>
  );
}

/** 本地建议源：本标签历史 + 收藏，按输入前缀过滤 */
function localSuggestions(lower: string, history: string[]): string[] {
  const favs = useSettings.getState().favorites.map((f) => f.path);
  const pool = [...history, ...favs];
  const out: string[] = [];
  for (const p of pool) {
    if (p === THIS_PC) continue;
    if (p.toLowerCase().startsWith(lower) && p.toLowerCase() !== lower && !out.includes(p)) {
      out.push(p);
    }
    if (out.length >= 5) break;
  }
  return out;
}
