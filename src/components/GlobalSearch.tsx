import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, InputGroup, PopoverNext } from "@blueprintjs/core";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Filter,
  FolderOpen,
  LoaderCircle,
  PanelRight,
  Search,
  SearchX,
  SquareArrowOutUpRight,
} from "lucide-react";

import {
  api,
  THIS_PC,
  type FileEntry,
  type GlobalSearchResult,
  type SearchBatchEvent,
  type SearchTypeFilter,
} from "../lib/ipc";
import { formatSize, formatTime } from "../lib/format";
import { extOf, fileIcon, typeName } from "../lib/fileIcons";
import { PREVIEW_LABELS, previewKind, type PreviewKind } from "../lib/previewKind";
import {
  clampGsPreviewW,
  detailsContentWidth,
  gsMtimeVisible,
  type GsColKey,
} from "../lib/columns";
import { parentPath } from "../lib/path";
import { DENSITY } from "../lib/tokens";
import { dfsPanes } from "../lib/layoutTree";
import { transfer } from "../lib/operations";
import {
  EMPTY_STREAM,
  applyBatch,
  composeTypeFilterQuery,
  SEARCH_TYPE_OPTIONS,
  highlightParts,
  nextGlobalSearchReq,
  pushSearchHistory,
  sortResults,
  type ResultSortKey,
  type SortDir,
  type StreamState,
} from "../lib/searchStream";
import { useLayout } from "../stores/layout";
import { useIcons } from "../stores/icons";
import { usePanes } from "../stores/panes";
import {
  commitGsCols,
  resetGsCol,
  setGsColLive,
  useGsColWidths,
} from "../stores/columns";
import { useSettings } from "../stores/settings";
import { useIsland } from "../stores/island";
import { confirmDialog, useUi, type MenuItem } from "../stores/ui";
import { AppIcon, ic } from "./AppIcon";
import { ColGrip, type ColResizeCtl } from "./ColGrip";
import { FadeInIcon } from "./FileList";
import { IndexModeBar, useIndexStatus } from "./IndexMode";
import { NpSelect } from "./NpSelect";
import { PreviewBody } from "./preview/PreviewBody";

const MAX_OPTIONS = [500, 2000, 5000];

/** 类型单一选择器选项（2026-10-16 七次定案）：单一平铺清单——常用类型均为文件，
 *  文件夹并入同列，不再分组；无磁盘范围选择（恒全库） */


/** 搜索结果列宽控制（寄存 settings.gsearchColWidths，与窗格列表 colWidths 相互独立） */
const gsColCtl: ColResizeCtl<GsColKey> = {
  getW: (k) => useSettings.getState().gsearchColWidths[k],
  setLive: setGsColLive,
  commit: commitGsCols,
  reset: resetGsCol,
};

/** 预览面板宽度拖拽（生命周期模块级，同列宽把手）：向左拖加宽面板，
 *  拖拽中只写内存，松手经 update() 持久化；cursor/禁选中复用 np-col-resizing */
function startPreviewResize(e: ReactMouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = useSettings.getState().gsearchPreviewWidth;
  const onMove = (ev: MouseEvent) => {
    useSettings.setState({ gsearchPreviewWidth: clampGsPreviewW(startW + (startX - ev.clientX)) });
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.classList.remove("np-col-resizing");
    useSettings
      .getState()
      .update({ gsearchPreviewWidth: useSettings.getState().gsearchPreviewWidth });
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  document.body.classList.add("np-col-resizing");
}
const EMPTY_RES: GlobalSearchResult = {
  entries: [],
  truncated: false,
  scanned: 0,
  elapsedMs: 0,
  engine: "scan",
  fallbackReason: null,
};

/** 搜索结果行图标：真实图标开启时与文件列表同规则（路径表 → 扩展名共享表 →
 *  空位淡入，stores/icons 负缓存防重复请求），关闭时回退 Lucide 语义图标 */
function SearchRowIcon({
  entry,
  realIcons,
  iconMap,
  extMap,
}: {
  entry: FileEntry;
  realIcons: boolean;
  iconMap: Record<string, string>;
  extMap: Record<string, string>;
}) {
  if (realIcons) {
    const u = iconMap[entry.path] ?? extMap[extOf(entry.name)] ?? undefined;
    if (u) return <FadeInIcon src={u} />;
    return <span className="np-icon-slot" />;
  }
  const spec = fileIcon(entry.name, entry.isDir, false);
  return <AppIcon icon={spec.icon} size={DENSITY.iconMd} colorVar={spec.colorVar} />;
}

/** 全盘搜索宿主（Everything 式）：居中 Dialog + 虚拟结果列表。
 *  唤起：顶栏按钮 / Ctrl+Shift+F（lib/keyboard）；索引模式可用时毫秒级出结果，
 *  否则 Rust 端并行遍历（流式回吐命中批次，边扫边看）。 */
export function GlobalSearchPage() {
  const open = useUi((s) => s.globalSearch);
  const close = useUi((s) => s.closeGlobalSearch);
  const [query, setQuery] = useState("");
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const [res, setRes] = useState<GlobalSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  // 搜索进行中上报灵动岛（顶栏流式命中数；对话框关闭后仍持续至终态）
  useEffect(() => {
    useIsland
      .getState()
      .setGsearch(loading ? stream.entries.length : null);
  }, [loading, stream.entries.length]);
  const [sel, setSel] = useState(0);
  const [sortKey, setSortKey] = useState<ResultSortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  /** 多选集（按路径存，排序/二次过滤下稳定）；sel = 焦点行（预览跟随 + 锚点） */
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const anchorRef = useRef(0);
  /** 类型单一选择器（2026-10-16 六次定案，原 类型 seg + 常用类型 二合一如 Everything
   *  Filters 菜单）：all/files/dirs 直发 typeFilter；常用类型键组合成 ext: 词 */
  const [typeSel, setTypeSel] = useState<string>("all");
  const [maxResults, setMaxResults] = useState(500);
  /** 结果二次过滤（纯客户端）：结果集大时按名称/拼音首字母就地收窄，不再发起搜索 */
  const [rowFilter, setRowFilter] = useState("");
  /** 预览面板展示的下标：仅单击/键盘选中后跟随（悬浮不高亮选中、不触发预览），
   *  160ms 防抖合并按住方向键的连续取数 */
  const [pvIndex, setPvIndex] = useState<number | null>(null);
  const [pvEntry, setPvEntry] = useState<FileEntry | null>(null);
  const history = useSettings((s) => s.recentSearches);
  const realIcons = useSettings((s) => s.realIcons);
  const previewOpen = useSettings((s) => s.gsearchPreview);
  const gsColw = useGsColWidths();
  const gsPvW = useSettings((s) => s.gsearchPreviewWidth);
  const iconMap = useIcons((s) => s.icons);
  const extMap = useIcons((s) => s.exts);
  // 索引状态（chip 展示 + 防抖自适应）：对话框打开期间 2s 轮询
  const indexStatus = useIndexStatus(open);
  const indexReady = Boolean(indexStatus?.enabled && indexStatus?.daemonAlive);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 当前活跃请求号：流式批次与终态响应都按它守卫 */
  const activeReq = useRef<number | null>(null);

  // 流式批次监听（挂载一次；过期请求的批次直接丢弃）
  useEffect(() => {
    const un = listen<SearchBatchEvent>("search-batch", (ev) => {
      setStream((prev) => applyBatch(prev, ev.payload, activeReq.current));
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 打开时重置（2026-10-16 七次定案：磁盘范围选择移除，恒全库检索）
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setStream(EMPTY_STREAM);
    setRes(null);
    setLoading(false);
    setSel(0);
    setRowFilter("");
    setChecked(new Set());
    anchorRef.current = 0;
    // 横向残留归零：列表 scrollLeft 复位会触发 scroll 事件同步表头；
    // 已在原点时事件不触发，表头 transform 需手动还原
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    if (headRef.current) headRef.current.style.transform = "";
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // 关闭时取消在途搜索
  useEffect(() => {
    if (open) return;
    const req = activeReq.current;
    if (req !== null) api.cancelSearch(req).catch(() => undefined);
    activeReq.current = null;
  }, [open]);

  // 搜索：防抖（索引就绪 120ms 秒搜体感 / 遍历 300ms）；发起前显式取消上一轮
  //（流式批次按 reqId 守卫，旧批次自动丢弃）。类型选择器二态：files/dirs 直发
  // typeFilter，常用类型键组合成 ext: 词随查询下发（仅类型选择无输入词也允许，
  // 如空输入选"文档" = 列出全部文档）
  useEffect(() => {
    if (!open) return;
    const composed = composeTypeFilterQuery(query, typeSel);
    const tf: SearchTypeFilter =
      typeSel === "files" || typeSel === "dirs" ? typeSel : "all";
    if (!composed) {
      const req = activeReq.current;
      if (req !== null) api.cancelSearch(req).catch(() => undefined);
      activeReq.current = null;
      setStream(EMPTY_STREAM);
      setRes(null);
      setLoading(false);
      setPvIndex(null);
      setChecked(new Set());
      return;
    }
    setLoading(true);
    let stale = false;
    const t = window.setTimeout(() => {
      const prev = activeReq.current;
      if (prev !== null) api.cancelSearch(prev).catch(() => undefined);
      const reqId = nextGlobalSearchReq();
      activeReq.current = reqId;
      setStream(EMPTY_STREAM);
      // 上轮终态必须同时清掉：liveEntries 优先取 res，不清会把上一轮的
      // 结果整套展示在本轮扫描期间（流式批次全部被遮蔽，列表与状态栏自相矛盾）
      setRes(null);
      setPvIndex(null); // 新一轮搜索：预览回到"未选中"，等用户单击
      setChecked(new Set());
      api
        .searchAll({
          query: composed,
          maxResults,
          // roots 省略 = 服务端默认全部固定盘（磁盘范围选择已移除，恒全库）
          roots: undefined,
          typeFilter: tf,
          reqId,
        })
        .then((r) => {
          if (stale || activeReq.current !== reqId) return;
          setRes(r);
          setSel(0);
          setLoading(false);
          if (query.trim()) {
            const s = useSettings.getState();
            s.update({ recentSearches: pushSearchHistory(s.recentSearches, query) });
          }
        })
        .catch((e) => {
          if (stale || activeReq.current !== reqId) return;
          setRes(EMPTY_RES);
          setLoading(false);
          useUi.getState().toast(`全盘搜索失败：${String(e)}`, "error");
        });
    }, indexReady ? 120 : 300);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, maxResults, typeSel, indexReady]);

  const liveEntries = res?.entries ?? stream.entries;
  const entries = useMemo(() => {
    const sorted = sortResults(liveEntries, sortKey, sortDir);
    const q = rowFilter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (e) => e.name.toLowerCase().includes(q) || (e.py?.includes(q) ?? false),
    );
  }, [liveEntries, sortKey, sortDir, rowFilter]);

  // 预览条目防抖跟随显式选中（pvIndex）；无选中即清空
  useEffect(() => {
    if (pvIndex === null) {
      setPvEntry(null);
      return;
    }
    const e = entries[pvIndex] ?? null;
    const t = window.setTimeout(() => setPvEntry(e), 160);
    return () => window.clearTimeout(t);
  }, [pvIndex, entries]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DENSITY.rowH,
    overscan: DENSITY.overscan,
  });

  function navigateTo(path: string) {
    const pane = useLayout.getState().activePane();
    const tabId = pane?.tabs[pane.activeTab]?.id;
    if (tabId) usePanes.getState().navigate(tabId, path);
  }

  /** 激活结果：文件夹 = 活动标签导航进去；文件 = 系统打开 */
  function activate(e: FileEntry) {
    if (e.isDir) {
      navigateTo(e.path);
    } else {
      api.openItem(e.path).catch((err) => useUi.getState().toast(String(err), "error"));
    }
    close();
  }

  /** 在活动标签中打开所在文件夹 */
  function reveal(e: FileEntry) {
    navigateTo(parentPath(e.path) ?? e.path);
    close();
  }

  /** 多选批量删除到回收站：确认后走任务引擎（灵动岛进度 + 回执） */
  async function deleteBatch(selEntries: FileEntry[]) {
    const ok = await confirmDialog({
      title: "删除到回收站",
      message: `将把选中的 ${selEntries.length} 项移入回收站？`,
      kind: "warn",
      okText: "删除",
    });
    if (!ok) return;
    api
      .deleteItems(
        selEntries.map((e) => e.path),
        false,
      )
      .then(() => setChecked(new Set()))
      .catch((err) => useUi.getState().toast(String(err), "error"));
  }

  /** 复制/移动到窗格 ▸（同 FileList 菜单：点选子菜单即记忆目标窗格） */
  function paneMenuItems(paths: string[], mode: "copy" | "move"): MenuItem[] {
    const layout = useLayout.getState();
    const others = layout.tree
      ? dfsPanes(layout.tree)
          .filter((p) => p.id !== layout.activePaneId)
          .map((p) => ({
            paneId: p.id,
            label:
              p.tabs[p.activeTab]?.path === THIS_PC
                ? "此电脑"
                : (p.tabs[p.activeTab]?.path ?? ""),
            path: p.tabs[p.activeTab]?.path ?? THIS_PC,
          }))
      : [];
    if (!others.length) return [{ label: "（无其他窗格）", disabled: true }];
    return others.map((o) => ({
      label: o.label,
      action: () => {
        if (layout.activePaneId) {
          useLayout.getState().setPaneTarget(layout.activePaneId, o.paneId);
        }
        void transfer(paths, o.path, mode);
      },
    }));
  }

  /** 右键菜单：右键行在多选集内 = 对整个选集批量操作，否则单选该行 */
  function rowMenu(e: FileEntry): MenuItem[] {
    const batch = checked.has(e.path) && checked.size > 1;
    const selEntries = batch
      ? entries.filter((x) => checked.has(x.path))
      : [e];
    const paths = selEntries.map((x) => x.path);
    const one = selEntries.length === 1 ? selEntries[0] : null;
    const copyPaths = () => {
      navigator.clipboard
        .writeText(paths.join("\n"))
        .then(() =>
          useUi.getState().toast(paths.length > 1 ? `已复制 ${paths.length} 条路径` : "路径已复制"),
        )
        .catch(() => undefined);
    };
    return [
      ...(one
        ? [
            { label: one.isDir ? "打开文件夹" : "打开", action: () => activate(one) },
            { label: "打开所在文件夹", action: () => reveal(one) },
          ]
        : [{ label: `打开所在文件夹（首项）`, action: () => reveal(selEntries[0]) }]),
      { sep: true },
      {
        label: one ? "复制完整路径" : `复制完整路径（${paths.length} 项）`,
        action: copyPaths,
      },
      { label: "复制到窗格 ▸", sub: paneMenuItems(paths, "copy") },
      { label: "移动到窗格 ▸", sub: paneMenuItems(paths, "move") },
      { sep: true },
      {
        label: one ? "删除" : `删除到回收站（${paths.length} 项）`,
        danger: true,
        action: () => void deleteBatch(selEntries),
      },
    ];
  }

  /** 行点击选择模型：普通 = 单选清多选；Ctrl = 翻选；Shift = 锚点范围 */
  function focusRow(idx: number, ev: ReactMouseEvent) {
    const clamped = Math.min(idx, entries.length - 1);
    if (ev.shiftKey) {
      const a = Math.min(anchorRef.current, clamped);
      const b = Math.max(anchorRef.current, clamped);
      setChecked(new Set(entries.slice(a, b + 1).map((x) => x.path)));
    } else if (ev.ctrlKey || ev.metaKey) {
      setChecked((prev) => {
        const next = new Set(prev);
        const p = entries[clamped]?.path;
        if (p === undefined) return prev;
        if (next.has(p)) {
          next.delete(p);
        } else {
          next.add(p);
        }
        return next;
      });
    } else {
      setChecked(new Set());
    }
    anchorRef.current = clamped;
    setSel(clamped);
    setPvIndex(clamped);
  }

  const onInputKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (!entries.length) {
      if (ev.key === "Escape") close();
      return;
    }
    // 二次过滤可能收窄结果集：越界选中按末项处理
    const focus = Math.min(sel, entries.length - 1);
    // Ctrl+A（输入框为空时）：全选结果
    if (ev.ctrlKey && ev.key.toLowerCase() === "a" && !query.trim()) {
      ev.preventDefault();
      setChecked(new Set(entries.map((x) => x.path)));
      return;
    }
    if (ev.key === "Escape" && checked.size > 0) {
      // Esc 先清多选，再按关闭处理
      ev.preventDefault();
      ev.stopPropagation();
      setChecked(new Set());
      anchorRef.current = focus;
      return;
    }
    if (ev.key === "Escape") {
      // 整页模式：输入框内 Esc 直接关闭（阻止全局键盘分支重复处理）
      ev.stopPropagation();
      close();
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const step = ev.key === "ArrowDown" ? 1 : -1;
      const n = Math.max(0, Math.min(entries.length - 1, focus + step));
      if (ev.shiftKey) {
        // Shift+方向键：自锚点扩展范围选
        const a = Math.min(anchorRef.current, n);
        const b = Math.max(anchorRef.current, n);
        setChecked(new Set(entries.slice(a, b + 1).map((x) => x.path)));
      } else {
        setChecked(new Set());
        anchorRef.current = n;
      }
      setSel(n);
      setPvIndex(n);
      virtualizer.scrollToIndex(n, { align: "auto" });
    } else if (ev.key === "Enter") {
      const cur = entries[focus];
      if (!cur) return;
      if (ev.ctrlKey) {
        // Ctrl+Enter（Everything 同款）：在活动标签打开所在文件夹
        ev.preventDefault();
        reveal(cur);
      } else {
        activate(cur);
      }
    }
  };

  /** 列头排序：同列点击反向，异列回升序 */
  function toggleSort(key: ResultSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  /** 列头单元格：可点排序的带箭头指示，不可点的纯文本 */
  function headLabel(key: ResultSortKey | null, text: string) {
    if (key === null) return <>{text}</>;
    const active = sortKey === key;
    return (
      <button
        className={`np-gsearch-sort${active ? " is-active" : ""}`}
        title={`按${text}排序${active ? `（${sortDir === "asc" ? "升序" : "降序"}，点击反向）` : ""}`}
        onClick={toggleSort.bind(null, key)}
      >
        {text}
        {active && (
          <AppIcon icon={sortDir === "asc" ? ChevronUp : ChevronDown} size={DENSITY.iconXs} />
        )}
      </button>
    );
  }

  const wan = (n: number) => (n >= 10000 ? `${Math.round(n / 10000)} 万` : `${n}`);
  const statusText = loading
    ? stream.scanned > 0
      ? `正在扫描… 已扫描 ${stream.scanned.toLocaleString()} 项`
      : "正在扫描磁盘…"
    : res
      ? `${res.engine === "index" ? "索引" : "遍历"} · ${entries.length} 项结果${rowFilter.trim() ? `（过滤自 ${res.entries.length}）` : ""} · ${res.engine === "index" ? `全库 ${wan(res.scanned)} 条` : `已扫描 ${res.scanned.toLocaleString()} 项`} · ${res.elapsedMs} ms${res.truncated ? " · 已截断" : ""}${res.fallbackReason ? ` · 索引不可用：${res.fallbackReason}` : ""}`
      : "Enter 打开 · Ctrl+Enter 定位 · Shift 多选 · Ctrl+A 全选";
  const statusSuffix = checked.size > 1 ? ` · 已选 ${checked.size} 项` : "";

  const rows = virtualizer.getVirtualItems();
  const pvSpec = pvEntry ? fileIcon(pvEntry.name, pvEntry.isDir, false) : null;
  // 文件夹不按扩展名路由：isDir 直取 folder（目录名可能带点）
  const pvKind: PreviewKind = pvEntry
    ? pvEntry.isDir
      ? "folder"
      : previewKind(pvEntry.name)
    : "fallback";

  // 面板宽度测量 → 详情列自然宽（Explorer 口径，同 FileList .np-rows）：列宽总和
  // 超出面板即 .np-gsearch-list 横向滚动，表头经 clip + onScroll 平移与行同步
  const [panelW, setPanelW] = useState(0);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPanelW(el.clientWidth));
    ro.observe(el);
    setPanelW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const contentW = detailsContentWidth(panelW, gsColw, "gsearch");
  const innerMinW = Math.max(panelW, contentW);

  // 表头横滚同步：列表横向滚动时平移表头（transform 不触发回流）
  function syncHeadX() {
    const el = scrollRef.current;
    const head = headRef.current;
    if (el && head) head.style.transform = `translateX(${-el.scrollLeft}px)`;
  }

  // 可见窗真实图标请求（铁律 3：只取可见行；批量去重/防抖/负缓存交给 stores/icons）
  const firstIdx = rows.length ? rows[0].index : 0;
  const lastIdx = rows.length ? rows[rows.length - 1].index : -1;
  const visiblePaths = useMemo(() => {
    const out: string[] = [];
    for (let i = firstIdx; i <= lastIdx && i < entries.length; i++) {
      out.push(entries[i].path);
    }
    return out;
  }, [firstIdx, lastIdx, entries]);
  useEffect(() => {
    if (!realIcons || !visiblePaths.length) return;
    useIcons.getState().requestIcons(visiblePaths.slice(0, 60));
  }, [visiblePaths, realIcons]);

  return (
    <section className="np-gsearchpage">
      <header className="np-gsearchpage-head">
        <button
          className="np-menupage-back"
          title="返回主界面（Esc）"
          onClick={close}
        >
          <AppIcon icon={ArrowLeft} size={DENSITY.iconSm} />
          <span>返回主界面</span>
        </button>
        <span className="np-menupage-title">全盘搜索</span>
        {/* 空 query 时的最近搜索 chips：收纳在头部右侧（不占独立行，出现/消失不推挤布局） */}
        {!query.trim() && history.length > 0 && (
          <div className="np-gsearch-history">
            <span className="np-gsearch-hist-label">最近</span>
            {history.slice(0, 8).map((h) => (
              <button key={h} className="np-gsearch-chip" onClick={() => setQuery(h)}>
                {h}
              </button>
            ))}
          </div>
        )}
      </header>
        <div className="np-gsearch-filters">
          <InputGroup
          inputRef={inputRef}
          className="np-gsearch-input"
          leftElement={ic(Search)}
          rightElement={
            <PopoverNext
              placement="bottom-end"
              arrow={false}
              content={
                <div className="np-gsearch-help">
                  <div className="np-gsearch-help-title">查询语法速查</div>
                  {[
                    ["词1 词2", "多词 = 且（全部命中）"],
                    ['"报表 2026"', '双引号短语 = 含空格字面'],
                    ["!旧", "! 排除（名称/路径/ext: 均可）"],
                    ["*.xlsx ?", "通配符：* 任意串、? 单字符"],
                    ["ext:jpg;png", "扩展名（; 取或，可 ! 取反）"],
                    ["size:>100mb", "体积：> >= < <= 精确 A..B 区间"],
                    ["dm:today", "时间：today/yesterday/thisweek/last7days/2025-06"],
                    ["点击列头", "排序（再点反向）· Shift/Ctrl 多选"],
                  ].map(([k, v]) => (
                    <div key={k} className="np-gsearch-help-row">
                      <span className="np-kbd">{k}</span>
                      <span className="np-gsearch-help-desc">{v}</span>
                    </div>
                  ))}
                </div>
              }
            >
              <Button
                minimal
                size="small"
                icon={ic(CircleHelp)}
                title="查询语法速查"
                className="np-gsearch-help-btn"
              />
            </PopoverNext>
          }
          value={query}
          placeholder={'搜索所有磁盘 · ext: size: dm: 过滤 · !排除 · "短语" · 拼音首字母'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          spellCheck={false}
          size="small"
        />
          <NpSelect<string>
            value={typeSel}
            title="类型（文件/文件夹或常用类型预设，对应 ext: 过滤词）"
            options={SEARCH_TYPE_OPTIONS}
            onChange={setTypeSel}
          />
          <InputGroup
            className="np-gsearch-rowfilter"
            size="small"
            leftElement={ic(Filter)}
            value={rowFilter}
            placeholder="结果过滤…"
            title="对当前结果就地二次过滤（名称 / 拼音首字母，不重新搜索）"
            onChange={(e) => setRowFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (rowFilter) setRowFilter("");
                else close();
              }
            }}
            spellCheck={false}
          />
          <NpSelect<number>
            value={maxResults}
            title="结果上限"
            options={MAX_OPTIONS.map((m) => ({ value: m, label: `上限 ${m}` }))}
            onChange={setMaxResults}
          />
          <span className="np-gsearch-filter-spacer" />
          <Button
            minimal
            size="small"
            className="np-gsearch-pv-toggle"
            icon={ic(PanelRight)}
            active={previewOpen}
            title="预览面板"
            onClick={() => useSettings.getState().update({ gsearchPreview: !previewOpen })}
          />
        </div>
        <div className="np-gsearch-main">
          <div
            ref={panelRef}
            className="np-gsearch-panel"
            style={
              {
                "--np-colw-name": `${gsColw.name}px`,
                "--np-colw-loc": `${gsColw.loc}px`,
                "--np-colw-size": `${gsColw.size}px`,
                "--np-colw-type": `${gsColw.type}px`,
                "--np-colw-mtime": `${gsColw.mtime}px`,
              } as CSSProperties
            }
          >
            {/* 表头：clip 裁掉横向超出卡片的部分，ref + onScroll 平移同步（与行同滚不
                漂移）；对齐算术同 .np-head（padding4+margin2+padding8=14，右缘补滚动条槽）。
                列头点击排序（名称/位置/大小/时间；类型不可排），箭头 = 当前方向 */}
            <div className="np-head-clip">
              <div className="np-gsearch-head" ref={headRef} style={{ minWidth: innerMinW }}>
                <span className="np-gsearch-hc np-col-name">
                  {headLabel("name", "名称")}
                  <ColGrip col="name" ctl={gsColCtl} />
                </span>
                <span className="np-gsearch-hc np-col-loc">
                  {headLabel("path", "位置")}
                  <ColGrip col="loc" ctl={gsColCtl} />
                </span>
                <span className="np-gsearch-hc np-col-size">
                  {headLabel("size", "大小")}
                  <ColGrip col="size" ctl={gsColCtl} />
                </span>
                <span className="np-gsearch-hc np-col-type">类型</span>
                {gsMtimeVisible(panelW) && (
                  <span className="np-gsearch-hc np-col-mtime">
                    {headLabel("mtime", "修改时间")}
                    <ColGrip col="mtime" ctl={gsColCtl} />
                  </span>
                )}
              </div>
            </div>
            <div
              ref={scrollRef}
              className={`np-gsearch-list ${contentW > panelW ? "np-scroll-x" : ""}`}
              onScroll={syncHeadX}
            >
              {entries.length === 0 ? (
                <div className="np-list-empty np-gsearch-empty">
                  {loading ? (
                    <span className="np-spin">
                      <AppIcon icon={LoaderCircle} size={DENSITY.iconLg} />
                    </span>
                  ) : (
                    <AppIcon
                      icon={query.trim() ? SearchX : Search}
                      size={DENSITY.iconLg}
                    />
                  )}
                  <span>
                    {loading
                      ? "正在扫描磁盘…"
                      : query.trim()
                        ? "没有匹配的结果"
                        : "输入关键词开始搜索（文件名 / 通配符 / 拼音首字母）"}
                  </span>
                </div>
              ) : (
                <div
                  className="relative"
                  style={{ height: virtualizer.getTotalSize(), minWidth: innerMinW }}
                >
                  {rows.map((row) => {
                    const e = entries[row.index];
                    const isSelected = row.index === sel || checked.has(e.path);
                    return (
                      <div
                        key={row.key}
                        className={`np-row ${isSelected ? "is-sel" : ""}`}
                        style={{
                          position: "absolute",
                          insetInline: 0,
                          height: row.size,
                          transform: `translateY(${row.start}px)`,
                        }}
                        // 不抢焦点：保持输入框持有焦点，Space/方向键不落到全局快捷键
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={(ev) => focusRow(row.index, ev)}
                        onDoubleClick={() => activate(e)}
                        onContextMenu={(ev) => {
                          ev.preventDefault();
                          // 右键未选行 = 先改为单选该行，再出菜单（Windows 惯例）
                          if (!checked.has(e.path) && row.index !== sel) {
                            setChecked(new Set());
                            anchorRef.current = row.index;
                            setSel(row.index);
                          }
                          useUi.getState().openMenu(rowMenu(e), ev.clientX, ev.clientY);
                        }}
                      >
                        <SearchRowIcon entry={e} realIcons={realIcons} iconMap={iconMap} extMap={extMap} />
                        <span className="np-name">
                          <span className="np-ellipsis" title={e.name}>
                            {highlightParts(e.name, query, e.py).map((p, i) =>
                              p.hit ? (
                                <mark key={i} className="np-hl">
                                  {p.text}
                                </mark>
                              ) : (
                                <span key={i}>{p.text}</span>
                              ),
                            )}
                          </span>
                        </span>
                        <span
                          className="np-cell-muted np-col-loc np-ellipsis"
                          title={e.path}
                        >
                          {parentPath(e.path) ?? e.path}
                        </span>
                        <span className="np-cell-muted np-col-size">{formatSize(e)}</span>
                        <span className="np-cell-muted np-col-type np-ellipsis">
                          {typeName(e.name, e.isDir)}
                        </span>
                        {gsMtimeVisible(panelW) && (
                          <span className="np-cell-muted np-col-mtime">
                            {formatTime(e.mtimeMs)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          {/* 分隔条：隐形沟槽，悬停/拖拽以强调色轻染（§4.1） */}
          {previewOpen && (
            <span
              className="np-gsearch-split"
              title="拖动调整预览面板宽度"
              onMouseDown={startPreviewResize}
            />
          )}
          {previewOpen && (
            <aside className="np-gsearch-pv" style={{ width: gsPvW }}>
              <header className="np-gsearch-pv-head">
                {pvSpec && (
                  <AppIcon icon={pvSpec.icon} size={DENSITY.iconMd} colorVar={pvSpec.colorVar} />
                )}
                <span className="np-gsearch-pv-name np-ellipsis">
                  {pvEntry ? pvEntry.name : "未选中结果"}
                </span>
                {pvEntry && <span className="np-pv-badge">{PREVIEW_LABELS[pvKind]}</span>}
                <span className="np-gsearch-pv-spacer" />
                <Button
                  minimal
                  size="small"
                  icon={ic(SquareArrowOutUpRight)}
                  title="用默认程序打开 (Enter)"
                  disabled={!pvEntry}
                  onClick={() => pvEntry && activate(pvEntry)}
                />
                <Button
                  minimal
                  size="small"
                  icon={ic(FolderOpen)}
                  title="打开所在文件夹"
                  disabled={!pvEntry}
                  onClick={() => pvEntry && reveal(pvEntry)}
                />
              </header>
              <PreviewBody
                entry={pvEntry}
                onOpen={activate}
                onReveal={reveal}
                emptyHint="选择结果以预览"
              />
            </aside>
          )}
        </div>
        {/* 状态条：左端索引模式控制组（开关常驻 + 状态 chip）+ 右侧引擎/计数回执 */}
        <div className="np-gsearch-status">
          <IndexModeBar status={indexStatus} />
          <span className="np-gsearch-status-text np-ellipsis">
            {statusText}
            {statusSuffix}
          </span>
        </div>
    </section>
  );
}
