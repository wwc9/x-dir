import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";

import {
  api,
  PAGE_SIZE,
  THIS_PC,
  type CmdError,
  type DriveInfo,
  type FileEntry,
  type SearchBatchEvent,
  type SearchResult,
  type SortKey,
  type TagColor,
} from "../lib/ipc";
import { applyBatch, EMPTY_STREAM, nextPaneSearchReq } from "../lib/searchStream";
import { formatElapsed, formatSize, formatTime } from "../lib/format";
import { formatShortTime, selStats } from "../lib/selStats";
import { extOf, fileIcon, typeName } from "../lib/fileIcons";
import { DENSITY } from "../lib/tokens";
import { isValidName, joinPath, parentPath, samePathList, relativeTo, stemOf, toExtendedLength, toForwardSlash, toQuoted } from "../lib/path";
import { useUndo } from "../lib/undo";
import { rectsIntersect, rowDropDest } from "../lib/hitTest";
import { registerList } from "../lib/listRegistry";
import { useDnd } from "../stores/dnd";
import {
  applyRenames,
  cleanOfficeMeta,
  combineParts,
  compressPdfs,
  convertEncoding,
  convertEol,
  createEntry,
  createFolders,
  createLinks,
  decryptPdfs,
  deletePaths,
  encryptPdfs,
  insertBlankPages,
  pdfToPngs,
  runExportListing,
  runPdfSplit,
  exportOfficeText,
  extractPdfPages,
  imagesToPdf,
  imgCompress,
  imgConvert,
  imgMontage,
  imgResize,
  imgWatermark,
  mergeCsvs,
  mergePdfs,
  mergeTexts,
  mergeXlsx,
  officeToPdf,
  extractArchives,
  extractArchivesTo,
  pickExtractDestDir,
  organizeEntries,
  removePdfPages,
  rotatePdf,
  transfer,
  watermarkPdfs,
  zipEntries,
} from "../lib/operations";
import type { ExportListingOptions } from "../lib/listing";
import type { PdfSplitOptions } from "../lib/pdfOps";
import { builtinByKey, entryVisible, type MenuArea } from "../lib/menuCommands";
import { dfsPanes } from "../lib/layoutTree";
import { useClipboard } from "../stores/clipboard";
import { useIcons } from "../stores/icons";
import { useLayout } from "../stores/layout";
import { useNavTree } from "../stores/navtree";
import { usePanes } from "../stores/panes";
import { pickStartIndex, usePreview } from "../stores/preview";
import { composeTypeFilterQuery } from "../lib/searchStream";
import { t } from "../lib/i18n";
import { useSettings } from "../stores/settings";
import { useUi, type MenuItem, type TypeAheadState } from "../stores/ui";
import { matchRangeOf } from "../lib/typeAhead";
import {
  COL_DEFAULTS,
  clampColWidth,
  detailsContentWidth,
  sanitizeColWidths,
  type ColGroup,
  type ColKey,
  type ColWidths,
} from "../lib/columns";
import { AppIcon } from "./AppIcon";
import { HardDrive, Monitor } from "lucide-react";
import { ColGrip, colDragClickGuard, type ColResizeCtl } from "./ColGrip";

const DND_MIME = "application/x-xdir";
const freeCache = new Map<string, number>();
/** 磁盘可用空间缓存上限：长会话不无界增长（LRU 淘汰，Map 保持插入序） */
const FREE_CACHE_MAX = 200;
/** 颜色标记选项（键 = index.css --np-tag-* token） */
const TAG_COLORS: { key: TagColor; label: string }[] = [
  { key: "red", label: t("红") },
  { key: "orange", label: t("橙") },
  { key: "yellow", label: t("黄") },
  { key: "green", label: t("绿") },
  { key: "blue", label: t("蓝") },
  { key: "purple", label: t("紫") },
];

function driveName(d: DriveInfo): string {
  return d.label ? `${d.label} (${d.letter})` : d.letter;
}

/** 文本入剪贴板（复制路径/名称共用），toast 反馈 */
function copyText(text: string, okMsg: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => useUi.getState().toast(okMsg))
    .catch(() => useUi.getState().toast("复制失败", "error"));
}

function driveEntries(drives: DriveInfo[]): FileEntry[] {
  return drives.map((d) => ({
    name: driveName(d),
    path: `${d.letter}\\`,
    isDir: true,
    size: d.totalBytes,
    mtimeMs: 0,
    ctimeMs: 0,
    attrs: { hidden: false, system: false, readonly: false },
    py: null,
  }));
}

/** 着色规则匹配：*.ext 通配或名称子串（大小写不敏感），手动标记优先 */
/** 首字母定位行内命中高亮（2026-11-05）：matchRangeOf 的字符区间把名称分三段，
 *  匹配段包 np-ta-hit；未激活 / 未命中 / 对齐失败（罕见字符）原样渲染。
 *  isDir 透传：主名定位规则（文件夹整名不剥扩展名分隔）与匹配侧一致 */
function TaName({
  name,
  py,
  isDir,
  ta,
}: {
  name: string;
  py?: string[] | null;
  isDir?: boolean;
  ta: TypeAheadState | null;
}) {
  if (!ta?.needle || !ta.mode) return <>{name}</>;
  const range = matchRangeOf(name, py, ta.needle, ta.mode, isDir);
  if (!range) return <>{name}</>;
  const [start, len] = range;
  const chars = Array.from(name);
  return (
    <>
      {chars.slice(0, start).join("")}
      <span className="np-ta-hit">{chars.slice(start, start + len).join("")}</span>
      {chars.slice(start + len).join("")}
    </>
  );
}

function tagColorOf(entry: FileEntry): TagColor | null {
  const s = useSettings.getState();
  const manual = s.colorTags[entry.path];
  if (manual) return manual;
  const lower = entry.name.toLowerCase();
  for (const r of s.colorRules) {
    const p = r.pattern.trim().toLowerCase();
    if (!p) continue;
    if (p.startsWith("*.")) {
      if (!entry.isDir && extOf(entry.name) === p.slice(2)) return r.color;
    } else if (lower.includes(p)) {
      return r.color;
    }
  }
  return null;
}

/** 真实图标淡入（共享：文件列表行 + 暂存区行）：img 挂载后下一帧淡入（150ms）。
 *  必须停留在模块层：若定义在组件体内，父组件每次重渲染（如点击选中）都会
 *  产生新的函数身份，React 卸载重建整棵行子树，淡入状态被重置而反复重放 */
export function FadeInIcon({ src }: { src: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, [src]);
  return (
    <span className="np-icon-slot">
      <img
        className="np-realicon"
        src={src}
        alt=""
        draggable={false}
        style={{ opacity: on ? 1 : 0 }}
      />
    </span>
  );
}

/** 行内文件图标：真实图标（路径表或扩展名共享表）→ 空位。
 *  realIcons 开启时 Lucide 不再参与（用户预期"全部用真实图标"）：
 *  已知图标同步直渲染（零切换），未知路径渲染 16px 预留空位，图标到位后淡入 */
function RowFileIcon({
  entry,
  isThisPc,
  realIcons,
  iconMap,
  exts,
}: {
  entry: FileEntry;
  isThisPc: boolean;
  realIcons: boolean;
  iconMap: Record<string, string>;
  exts: Record<string, string>;
}) {
  if (!isThisPc) {
    if (realIcons) {
      const u =
        iconMap[entry.path] ?? exts[extOf(entry.name)] ?? undefined;
      if (u) return <FadeInIcon src={u} />;
      return <span className="np-icon-slot" />;
    }
    const spec = fileIcon(entry.name, entry.isDir, isThisPc && entry.isDir);
    return <AppIcon icon={spec.icon} size={DENSITY.iconMd} colorVar={spec.colorVar} />;
  }
  // 此电脑页盘符只查路径表：盘符根在 Rust 端有专属真实提取（icons.rs icon_key），
  // 扩展名共享表对 "(C:)" 这类名称无意义
  if (realIcons) {
    const u = iconMap[entry.path];
    if (u) return <FadeInIcon src={u} />;
    return <span className="np-icon-slot" />;
  }
  const spec = fileIcon(entry.name, entry.isDir, true);
  return <AppIcon icon={spec.icon} size={DENSITY.iconMd} colorVar={spec.colorVar} />;
}

export function FileList({
  tabId,
  paneId,
  path,
  active,
}: {
  tabId: string;
  paneId: string;
  path: string;
  active: boolean;
}) {
  const showHidden = useSettings((s) => s.showHidden);
  const confirmDelete = useSettings((s) => s.confirmDelete);
  const realIcons = useSettings((s) => s.realIcons);
  const iconMap = useIcons((s) => s.icons);
  const extMap = useIcons((s) => s.exts);
  const ui = usePanes((s) => s.tabs[tabId]);
  const typeAhead = useUi((s) => s.typeAhead);
  // 每窗格独立列宽：PaneNode.colWidths 覆盖全局默认（settings.colWidths 为回落，
  // 兼容旧档），随工作区树持久化（「上次会话」/「默认方案」）
  const paneNode = useLayout((s) =>
    s.tree ? dfsPanes(s.tree).find((p) => p.id === paneId) : undefined,
  );
  const colw = useMemo<ColWidths>(
    () => sanitizeColWidths({ ...useSettings.getState().colWidths, ...paneNode?.colWidths }),
    [paneNode],
  );
  // 读当前有效列宽（store 实时取，避免拖拽长会话中的闭包过期）
  const paneColsNow = (): ColWidths => {
    const t = useLayout.getState().tree;
    const p = t ? dfsPanes(t).find((x) => x.id === paneId) : undefined;
    return sanitizeColWidths({ ...useSettings.getState().colWidths, ...p?.colWidths });
  };
  const paneCtl: ColResizeCtl<ColKey> = {
    getW: (k) => paneColsNow()[k],
    setLive: (k, w) => {
      const cols = paneColsNow();
      cols[k] = clampColWidth(w, k);
      useLayout.getState().setPaneColWidths(paneId, cols);
    },
    // 拖拽中的写树已由「上次会话」1s 防抖自动保存，松手无需再落盘
    commit: () => undefined,
    reset: (k) => {
      const cols = paneColsNow();
      cols[k] = COL_DEFAULTS[k];
      useLayout.getState().setPaneColWidths(paneId, cols);
    },
  };
  const viewMode = ui?.viewMode ?? "details";
  const sort = ui?.sort ?? { key: "name", dir: "asc" as const };
  const selected = ui?.selected ?? [];
  const refreshTick = ui?.refreshTick ?? 0;
  const editing = ui?.editing ?? null;
  const search = ui?.search ?? null;
  // 视图内过滤（Ctrl+E）：null = 关闭；非空词经 Rust 端 nameFilter 就地收窄
  const filter = ui?.filter ?? null;
  const filterActive = filter !== null && !!filter.trim();

  const isThisPc = path === THIS_PC;
  // 窗格序号（状态条左端标志）：本窗格在布局树 DFS 序中的位次（1 起），
  // 分裂/关闭窗格后按新树重排
  const paneNo = useLayout((s) =>
    s.tree ? dfsPanes(s.tree).findIndex((p) => p.id === paneId) + 1 : 0,
  );
  const searching = search !== null;
  // 空查询 = 搜索框开着但列表照常展示目录内容，键入非空才切搜索视图
  const searchActive = searching && !!search?.trim();
  const [pages, setPages] = useState(new Map<number, FileEntry[]>());
  const [drives, setDrives] = useState<DriveInfo[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<CmdError | null>(null);
  const [free, setFree] = useState<number | null>(null);
  const [width, setWidth] = useState(600);
  const dndPoint = useDnd((s) => s.point);
  const [searchRes, setSearchRes] = useState<SearchResult | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 框选（rubber band）：内容坐标（相对虚拟内容原点）的锚点 + 渲染矩形
  const innerRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<{
    base: string[]; // 起拖时的选中基准（Ctrl 拖 = 累加模式）
    additive: boolean;
    anchor: string | null; // 保留既有 shift 范围锚点
    x1: number;
    y1: number;
  } | null>(null);
  const [band, setBand] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  // V3 OLE 拖拽落点高亮：Rust DragOver 推送的 CSS 点落在本列表矩形内。
  // 点压在本列表的文件夹行上 = 投放目标改为该文件夹（§7.4）：行级 is-drop
  // 高亮取代整表高亮；rowDropDest 判定见 lib/hitTest（单测锁定）
  const dropRowPath = (() => {
    if (!dndPoint) return null;
    const row = document
      .elementFromPoint(dndPoint.x, dndPoint.y)
      ?.closest<HTMLElement>(".np-row[data-dir]");
    if (!row || !scrollRef.current?.contains(row)) return null;
    return rowDropDest(row.dataset);
  })();
  const dropHover =
    !!dndPoint &&
    !dropRowPath &&
    (() => {
      const r = scrollRef.current?.getBoundingClientRect();
      return !!r && dndPoint.x >= r.left && dndPoint.x < r.right && dndPoint.y >= r.top && dndPoint.y < r.bottom;
    })();
  const fetched = useRef(new Set<number>());
  const forceRef = useRef(false);

  /** 数据到达时刻的图标预热：跳过防抖直发 IPC（首批 48 个 ≈ 可见窗口），
   *  让真实图标赶在首帧绘制前后到位，把"内置 → 真实"的切换压到不可感知 */
  const prefetchIcons = (entries: FileEntry[]) => {
    if (!realIcons) return;
    useIcons
      .getState()
      .requestIcons(entries.slice(0, 48).map((e) => e.path), true);
  };

  const entries: FileEntry[] = useMemo(() => {
    if (searchActive) return searchRes?.entries ?? [];
    if (isThisPc) return driveEntries(drives ?? []);
    const flat: FileEntry[] = [];
    for (const es of pages.values()) flat.push(...es);
    return flat;
  }, [pages, drives, isThisPc, searchActive, searchRes]);

  const count = isThisPc ? (drives?.length ?? 0) : searchActive ? entries.length : total;

  const drivesFree = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of drives ?? []) m.set(`${d.letter}\\`, d.freeBytes);
    return m;
  }, [drives]);

  const entryAt = (i: number): FileEntry | undefined => {
    if (searchActive) return entries[i];
    if (isThisPc) return entries[i];
    return pages.get(Math.floor(i / PAGE_SIZE))?.[i % PAGE_SIZE];
  };

  // 选中/定位用：路径 → 当前视图位置（搜索结果跨目录同名时名字会撞，必须按路径）
  const pathIndex = useMemo(() => {
    const m = new Map<string, number>();
    entries.forEach((e, i) => m.set(e.path, i));
    return m;
  }, [entries]);

  // 数据加载：路径/排序/隐藏开关/刷新信号变化时取第一页（§6.4）。
  // 上下文未变（仅 refreshTick 变化）= 软刷新：不清旧数据、不重置滚动，
  // 新首页到达后就地替换——目录监控/拖放引发的自动刷新不再整表闪烁。
  // 上下文变了（换目录/排序/视图开关）= 硬切换：清空重来、滚动归零
  const loadCtxRef = useRef<string | null>(null);
  // 竞态守卫：每次上下文变化自增；在途响应到达时核对代数，旧代结果直接丢弃。
  // 没有它，快速切换目录时旧目录的首页/补页会写进新目录的视图（可致误操作）
  const loadGenRef = useRef(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const ctx = [path, sort.key, sort.dir, showHidden, searchActive, filterActive, filter].join("\u0000");
    const soft = loadCtxRef.current === ctx;
    loadCtxRef.current = ctx;
    const gen = ++loadGenRef.current;
    if (!soft) {
      setPages(new Map());
      setTotal(0);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
    setLoaded(false);
    setError(null);
    usePanes.getState().setError(tabId, null);
    fetched.current = new Set();
    if (isThisPc) {
      api
        .getDrives()
        .then((ds) => {
          if (loadGenRef.current !== gen) return;
          setDrives(ds);
          setLoaded(true);
          prefetchIcons(driveEntries(ds));
        })
        .catch((e) => {
          if (loadGenRef.current !== gen) return;
          setError(e);
          setLoaded(true);
        });
      return;
    }
    if (searchActive) return; // 搜索模式（非空查询）由下方专用 effect 取数
    const force = forceRef.current;
    forceRef.current = false;
    fetched.current.add(0);
    api
      .listDir({
        path,
        sort,
        showHidden,
        offset: 0,
        limit: PAGE_SIZE,
        force,
        nameFilter: filterActive ? filter.trim() : undefined,
      })
      .then((r) => {
        if (loadGenRef.current !== gen) return;
        setTotal(r.total);
        setLoaded(true);
        // 只换第 0 页（可视窗必在其中）；其余页丢弃并同步重置 fetched，
        // 滚动补页 effect 会按需重拉——软刷取数期间旧页继续展示，已浏览内容不闪空
        setPages(new Map([[0, r.entries]]));
        fetched.current = new Set([0]);
        prefetchIcons(r.entries);
      })
      .catch((e) => {
        if (loadGenRef.current !== gen) return;
        setError(e);
        setLoaded(true);
        usePanes.getState().setError(tabId, String(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, sort, showHidden, refreshTick, searchActive, filter]);

  // V2 递归搜索：防抖 250ms；reqId 竞态守卫 + search-batch 流式累积（边扫边出），
  // 输入变化/退出搜索显式取消在途扫描
  const searchReqRef = useRef<number | null>(null);
  useEffect(() => {
    const un = listen<SearchBatchEvent>("search-batch", (ev) => {
      setSearchRes((prev) => {
        const base = prev ?? EMPTY_STREAM;
        const next = applyBatch(base, ev.payload, searchReqRef.current);
        // reqId 不匹配（别的窗格在搜索）时 applyBatch 原样返回——必须保持
        // 引用不变返回 prev（null 同理保持 null），否则非搜索窗格逐批次
        // 全列表重拍平（2026-11-01 审查修复：无条件包新对象破坏了 reqId 短路）
        if (next === base) return prev;
        return {
          entries: next.entries,
          truncated: next.truncated,
          scanned: next.scanned,
          elapsedMs: 0, // 流式期间未知耗时，终态响应带回
          engine: "scan", // 流式批次仅来自遍历通道
        };
      });
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const cancelSearchReq = () => {
    const prev = searchReqRef.current;
    if (prev !== null) api.cancelSearch(prev).catch(() => undefined);
    searchReqRef.current = null;
  };

  // 搜索类型（搜索浮层的类型选择；all/files/dirs 直发 typeFilter，预设组合 ext: 词）
  const searchType = usePanes((s) => s.tabs[tabId]?.searchType ?? "all");
  // 穿透子文件夹（2026-11-01）：默认关 = 仅当前目录；跨导航粘性
  const searchDeep = usePanes((s) => s.tabs[tabId]?.searchDeep === true);

  useEffect(() => {
    if (!searching || isThisPc) {
      cancelSearchReq();
      setSearchRes(null);
      return;
    }
    const typeFilter =
      searchType === "files" || searchType === "dirs" ? searchType : undefined;
    const composed = composeTypeFilterQuery(search ?? "", searchType);
    if (!composed.trim() && !typeFilter) {
      // 无关键词且未选类型（all）：不触发递归搜索
      cancelSearchReq();
      setSearchRes(null);
      return;
    }
    let stale = false;
    const seq = window.setTimeout(() => {
      cancelSearchReq();
      const reqId = nextPaneSearchReq(paneId);
      searchReqRef.current = reqId;
      setSearchRes({ entries: [], truncated: false, scanned: 0, elapsedMs: 0, engine: "scan" });
      api
        .searchDir({ path, query: composed, typeFilter, reqId, deep: searchDeep })
        .then((r) => {
          if (stale || searchReqRef.current !== reqId) return;
          searchReqRef.current = null;
          setSearchRes(r);
          prefetchIcons(r.entries);
        })
        .catch((e) => {
          if (stale || searchReqRef.current !== reqId) return;
          searchReqRef.current = null;
          setError(e);
          setSearchRes({ entries: [], truncated: false, scanned: 0, elapsedMs: 0, engine: "scan" });
        });
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(seq);
      // 卸载/依赖变化即取消在途扫描：切标签后后端遍历不再白耗 IO；
      // reqId 守卫保证新旧请求互不串扰
      cancelSearchReq();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, search, searching, isThisPc, refreshTick, searchType, searchDeep]);

  // 可用空间（窗格状态条）。闭包捕获请求时的 path，响应到达时与当前路径
  // 比对——快速导航下旧盘的慢响应不得覆盖新盘读数（2026-11-01 审查修复：
  // 列表/搜索主链路都有 loadGen 守卫，唯这里漏了）
  useEffect(() => {
    if (isThisPc) {
      setFree(null);
      return;
    }
    const c = freeCache.get(path);
    if (c !== undefined) {
      setFree(c);
      return;
    }
    const want = path;
    api
      .getVolume(want)
      .then((v) => {
        if (freeCache.size >= FREE_CACHE_MAX) {
          const oldest = freeCache.keys().next().value;
          if (oldest !== undefined) freeCache.delete(oldest);
        }
        freeCache.set(want, v.freeBytes);
        if (want === usePanes.getState().currentPathOf(tabId)) setFree(v.freeBytes);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, isThisPc, tabId]);

  // 目录监控：仅可见窗格挂 watcher，生命周期随路径（§6.8，铁律 3）
  useEffect(() => {
    if (isThisPc) return;
    api.watchDir(path).catch(() => undefined);
    return () => {
      api.unwatchDir(path).catch(() => undefined);
    };
  }, [path, isThisPc]);

  useEffect(() => {
    usePanes.getState().setTotal(tabId, count);
  }, [tabId, count]);

  // 宽度测量 → 每行单元格数
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // 表头横滚同步：.np-rows 横向滚动时平移表头（transform 不触发回流；
  // resize 收窄使 scrollLeft 被浏览器钳回时也会触发 scroll，无需额外监听）
  function syncHeadX() {
    const el = scrollRef.current;
    const head = headRef.current;
    if (el && head) head.style.transform = `translateX(${-el.scrollLeft}px)`;
  }

  const cellW = DENSITY.cellWList;
  const rowH = DENSITY.rowH;
  const perRow = viewMode === "details" ? 1 : Math.max(1, Math.floor((width - 8) / cellW));
  const rowCount = Math.ceil(count / perRow);

  // 详情视图自然宽（lib/columns 纯函数）：各列定宽互不影响，超出容器即横向滚动。
  // 内容层与表头共用该 minWidth；仅当真正放不下时 .np-rows 才开横向滚动。
  // 浅搜结果全部在当前目录（位置列恒 "."，无意义）→ 用常规列组（2026-11-01）
  const searchCols = searchActive && searchDeep;
  const colGroup: ColGroup = isThisPc ? "thispc" : searchCols ? "search" : "normal";
  const contentW = viewMode === "details" ? detailsContentWidth(width, colw, colGroup) : 0;
  const innerMinW = viewMode === "details" ? Math.max(width, contentW) : undefined;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: DENSITY.overscan,
  });

  const rows = virtualizer.getVirtualItems();

  // 滚动分页：按需补齐可见页（铁律 1/3）。依赖含 pages：软刷新会先丢弃
  // 第 0 页以外的旧页，可视窗落在被丢弃页时靠本 effect 重新拉取
  const firstIdx = rows.length ? rows[0].index * perRow : 0;
  const lastIdx = rows.length
    ? (rows[rows.length - 1].index + 1) * perRow - 1
    : 0;
  useEffect(() => {
    if (isThisPc || searchActive) return;
    const gen = loadGenRef.current; // 补页归属当前加载代；换目录后的旧响应直接丢弃
    const fp = Math.floor(firstIdx / PAGE_SIZE);
    const lp = Math.floor(lastIdx / PAGE_SIZE);
    for (let p = fp; p <= lp; p++) {
      if (fetched.current.has(p)) continue;
      fetched.current.add(p);
      api
        .listDir({
          path,
          sort,
          showHidden,
          offset: p * PAGE_SIZE,
          limit: PAGE_SIZE,
          nameFilter: filterActive ? filter.trim() : undefined,
        })
        .then((r) => {
          if (loadGenRef.current !== gen) return;
          setTotal(r.total);
          setPages((prev) => new Map(prev).set(p, r.entries));
        })
        .catch((e) => {
          fetched.current.delete(p); // 允许下次滚动重试
          if (loadGenRef.current !== gen) return;
          // 与首页加载同语义：状态条与地址栏都要感知错误
          setError(e);
          usePanes.getState().setError(tabId, String(e));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstIdx, lastIdx, isThisPc, searchActive, path, sort, showHidden, refreshTick, pages, filter]);

  // 真实图标 / 缩略图：只对可见窗口请求（铁律 3），批量去重交给 stores/icons
  const visibleEntries = useMemo(() => {
    const out: FileEntry[] = [];
    for (let i = firstIdx; i <= lastIdx; i++) {
      const e = entryAt(i);
      if (e) out.push(e);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstIdx, lastIdx, entries]);

  useEffect(() => {
    if (!realIcons || searchActive) return;
    useIcons
      .getState()
      .requestIcons(visibleEntries.slice(0, 60).map((e) => e.path));
  }, [visibleEntries, realIcons, searchActive]);

  const selectedEntries = (): FileEntry[] => {
    // listRegistry 处理器（Ctrl+C/V/X、Enter、F2、Delete、Alt+Enter）走本组件
    // 闭包，而 registerList 依赖数组不含 selected——此处必须实时读 store，否则
    // 鼠标/键盘改选后这些操作仍作用于上次注册时的旧选中（典型症状：Ctrl+C 无效果）
    const sel = usePanes.getState().tabs[tabId]?.selected ?? [];
    if (!sel.length) return [];
    // 选中标识 = 路径（搜索结果跨目录同名时按名匹配会误伤同名文件）
    const set_ = new Set(sel);
    return entries.filter((e) => set_.has(e.path));
  };
  const selectedPaths = (): string[] => selectedEntries().map((e) => e.path);

  function openEntry(entry: FileEntry) {
    if (entry.isDir) {
      usePanes.getState().navigate(tabId, entry.path);
    } else {
      api.openItem(entry.path).catch((e) => useUi.getState().toast(String(e), "error"));
    }
  }

  function clickSelect(e: React.MouseEvent, entry: FileEntry) {
    const idx = pathIndex.get(entry.path) ?? 0;
    const uiNow = usePanes.getState().tabs[tabId];
    if (!uiNow) return;
    if (e.ctrlKey) {
      const next = uiNow.selected.includes(entry.path)
        ? uiNow.selected.filter((n) => n !== entry.path)
        : [...uiNow.selected, entry.path];
      usePanes.getState().setSelected(tabId, next, entry.path);
    } else if (e.shiftKey && uiNow.anchor) {
      selectRange(uiNow.anchor, idx);
    } else {
      usePanes.getState().setSelected(tabId, [entry.path], entry.path);
    }
    // 导航树联动定位：点文件夹 → 定位该文件夹；点文件 → 定位其所在文件夹
    const target = entry.isDir ? entry.path : parentPath(entry.path) ?? path;
    useNavTree.getState().locate(target);
  }

  function selectRange(anchorPath: string, toIdx: number) {
    const a = pathIndex.get(anchorPath) ?? toIdx;
    const [lo, hi] = [Math.min(a, toIdx), Math.max(a, toIdx)];
    const paths: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const en = entryAt(i);
      if (en) paths.push(en.path);
    }
    usePanes.getState().setSelected(tabId, paths, anchorPath);
  }

  /** 行按下（详情/图标视图共用）：中键 = 文件夹新标签打开；右键 = 已选中保持
   *  多选、未选中先单选；左键 = 未选项/带 Ctrl·Shift 立即改选，已选项裸按不动
   *  选中（多选整体可拖），收敛与否交给 armRowDrag 的「待定单击」裁决 */
  function rowMouseDown(e: React.MouseEvent, entry: FileEntry) {
    // 重命名输入框内按下：完全交给浏览器原生 caret 定位/拖选——改选与 armRowDrag
    // 都不适用（armed 拖拽会把框内拖选文字劫持成 OLE 文件拖动）
    if ((e.target as HTMLElement).closest(".np-rename")) return;
    if (e.button === 1) {
      // 中键 = 文件夹在新标签打开（浏览器/Explorer 惯例；preventDefault 顺带
      // 拦掉中键自动滚动）
      e.preventDefault();
      if (entry.isDir) useLayout.getState().newTab(paneId, entry.path);
      return;
    }
    if (e.button === 2) {
      // 右键（2026-10-22 修复）：已选中项保持多选不动（此前走 clickSelect，
      // 多选被替换成单项）
      const uiNow = usePanes.getState().tabs[tabId];
      if (uiNow && !uiNow.selected.includes(entry.path)) clickSelect(e, entry);
      return;
    }
    const uiNow = usePanes.getState().tabs[tabId];
    const inSel = !!uiNow?.selected.includes(entry.path);
    if (!inSel || e.ctrlKey || e.shiftKey) clickSelect(e, entry);
    armRowDrag(e, entry);
  }

  /** V3 原生拖拽：左键按下位移 ≥5px 触发 OLE DoDragDrop（拖出窗口/窗格间同管线）。
   *  路径在触发时刻解析：拖已选集合或该行。Explorer 惯例（2026-11-01 修复多选
   *  拖动丢选中）：裸按在已选项上 = 「待定单击」——mousedown 不改选中，成拖则
   *  整组带走，原地松开（未成拖）才收敛为单选。 */
  function armRowDrag(e: React.MouseEvent, entry: FileEntry) {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const pendingClick =
      !e.ctrlKey &&
      !e.shiftKey &&
      !!usePanes.getState().tabs[tabId]?.selected.includes(entry.path);
    let started = false;
    const onMove = (ev: MouseEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      started = true;
      cleanup();
      const now = usePanes.getState().tabs[tabId];
      const sel = now?.selected ?? [];
      const paths = sel.includes(entry.path) ? selectedPaths() : [entry.path];
      api
        .startDrag(paths)
        .then((effect) => {
          if (effect !== "none") usePanes.getState().bumpRefresh(tabId);
        })
        .catch((err) => useUi.getState().toast(String(err), "error"));
    };
    const onUp = () => {
      cleanup();
      if (!started && pendingClick) clickSelect(e, entry);
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** 框选多选（rubber band）：列表空白处按住左键拖拽，带内可见行实时选中。
   *  命中判定取可见行真实矩形（对 CSS 间距零假设）；Ctrl 拖 = 在原选中上累加；
   *  指针贴近上下缘自动滚动（内容坐标锚定，带随内容滚动不漂移）。 */
  function startMarquee(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const sc = e.currentTarget;
    if ((e.target as HTMLElement).closest(".np-row")) return; // 行内按下 = 点选/拖出
    const scRect = sc.getBoundingClientRect();
    if (e.clientX - scRect.left >= sc.clientWidth) return; // 竖向滚动条
    // 空白按下时若重命名进行中：先主动失焦提交——下方 preventDefault 会拦掉
    // 浏览器默认的焦点转移，onBlur 不触发，重命名模式就退不出去
    sc.querySelector<HTMLInputElement>(".np-rename")?.blur();
    e.preventDefault();
    const inner = innerRef.current?.getBoundingClientRect();
    if (!inner) return;
    const uiNow = usePanes.getState().tabs[tabId];
    const additive = e.ctrlKey;
    bandRef.current = {
      base: additive ? (uiNow?.selected ?? []) : [],
      additive,
      anchor: additive ? (uiNow?.anchor ?? null) : null,
      x1: e.clientX - inner.left,
      y1: e.clientY - inner.top,
    };
    if (!additive) usePanes.getState().setSelected(tabId, [], null);

    const onMove = (ev: MouseEvent) => {
      const b = bandRef.current;
      const innerNow = innerRef.current?.getBoundingClientRect();
      const scNow = scrollRef.current;
      if (!b || !innerNow || !scNow) return;
      // 指针贴近上下缘：自动滚动（先滚再取坐标，带与命中同步滚动后的内容）
      const scb = scNow.getBoundingClientRect();
      if (ev.clientY < scb.top + 28) scNow.scrollTop -= 14;
      else if (ev.clientY > scb.bottom - 28) scNow.scrollTop += 14;
      const x2 = ev.clientX - innerNow.left;
      const y2 = ev.clientY - innerNow.top;
      setBand({
        left: Math.min(b.x1, x2),
        top: Math.min(b.y1, y2),
        width: Math.abs(x2 - b.x1),
        height: Math.abs(y2 - b.y1),
      });
      // 带矩形（视口坐标）与可见行矩形求交
      const bandView = {
        left: Math.min(b.x1, x2) + innerNow.left,
        right: Math.max(b.x1, x2) + innerNow.left,
        top: Math.min(b.y1, y2) + innerNow.top,
        bottom: Math.max(b.y1, y2) + innerNow.top,
      };
      const paths: string[] = [];
      scNow.querySelectorAll<HTMLElement>(".np-row[data-idx]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!rectsIntersect(r, bandView)) return;
        const en = entryAt(Number(el.dataset.idx));
        if (en) paths.push(en.path);
      });
      const merged = b.additive
        ? [...new Set([...b.base, ...paths])]
        : paths;
      usePanes
        .getState()
        .setSelected(tabId, merged, b.additive ? b.anchor : (paths[0] ?? null));
    };
    const onUp = () => {
      bandRef.current = null;
      setBand(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** 双轨右键菜单：Shift+右键 = 系统原生 IContextMenu（§3.3），否则自绘 */
  function openRowMenu(e: React.MouseEvent, entry: FileEntry) {
    // 重命名框内右键 = 浏览器原生文本编辑菜单（剪切/复制/粘贴），不出文件菜单
    if ((e.target as HTMLElement).closest(".np-rename")) return;
    e.preventDefault();
    const now = usePanes.getState().tabs[tabId];
    const sel = now?.selected ?? [];
    const multi = sel.includes(entry.path);
    const paths = multi ? selectedPaths() : [entry.path];
    if (e.shiftKey) {
      api.showContextMenu(paths).catch((err) => useUi.getState().toast(String(err), "error"));
      return;
    }
    if (!multi) usePanes.getState().setSelected(tabId, [entry.path], entry.path);
    useUi.getState().openMenu(rowMenuItems(entry), e.clientX, e.clientY);
  }

  function toggleSort(key: SortKey) {
    if (colDragClickGuard()) return; // 列宽拖拽结束的误触 click 不切换排序
    usePanes
      .getState()
      .setSort(tabId, {
        key,
        dir: sort.key === key && sort.dir === "asc" ? "desc" : "asc",
      });
  }

  const forceBump = () => {
    forceRef.current = true;
    usePanes.getState().bumpRefresh(tabId);
  };

  /** Ctrl+Shift+C / X 与右键"复制/移动到窗格"共用：传输到目标窗格当前目录。
   *  目标 = 每窗格记忆的上次对侧（未记忆回落 DFS 序首个其他窗格），成功发起
   *  后写入记忆，下一次快捷键直达同一目标 */
  function transferToPane(move: boolean) {
    const layout = useLayout.getState();
    const targetId = layout.paneTargetOf(paneId);
    if (!targetId) {
      useUi.getState().toast("没有其他窗格可作目标", "error");
      return;
    }
    const target = layout.tree
      ? dfsPanes(layout.tree).find((p) => p.id === targetId)
      : undefined;
    const dest = target?.tabs[target.activeTab]?.path;
    if (!dest || dest === THIS_PC) {
      useUi.getState().toast("目标窗格在「此电脑」页，请先进入一个文件夹", "error");
      return;
    }
    const paths = selectedPaths();
    if (!paths.length) {
      useUi.getState().toast("未选中任何项", "error");
      return;
    }
    layout.setPaneTarget(paneId, targetId);
    void transfer(paths, dest, move ? "move" : "copy");
  }

  /** 内置功能执行器：key → 菜单项（闭包持有当前列表上下文；注册表在 lib/menuCommands） */
  function builtinMenuItem(key: string, sel: FileEntry[]): MenuItem | null {
    const entry0 = sel[0];
    const layout = useLayout.getState();
    switch (key) {
      case "open":
        return { label: t("打开"), action: () => openEntry(entry0) };
      case "openTab":
        return {
          label: t("在新标签打开"),
          action: () => {
            const paneId = layout.activePaneId;
            if (paneId) useLayout.getState().newTab(paneId, entry0.path);
          },
        };
      case "rename":
        return { label: t("重命名"), action: () => usePanes.getState().setEditing(tabId, entry0.path) };
      case "delete":
        return {
          label: t("删除"),
          danger: true,
          action: () => deletePaths(selectedPaths(), confirmDelete),
        };
      case "deletePerm":
        return {
          label: t("永久删除"),
          danger: true,
          action: () => void deletePaths(selectedPaths(), true, true),
        };
      case "properties":
        return {
          label: t("属性"),
          action: () =>
            useUi
              .getState()
              .openDialog({ type: "properties", entry: entry0, freeBytes: free ?? undefined }),
        };
      case "cut":
        return { label: t("剪切"), action: () => useClipboard.getState().set("cut", selectedPaths()) };
      case "copy":
        return { label: t("复制"), action: () => useClipboard.getState().set("copy", selectedPaths()) };
      case "paste":
        return { label: t("粘贴"), action: () => void doPaste() };
      case "copyPath": {
        // 空白处右键 = 复制当前目录路径
        const text = sel.length ? selectedPaths().join("\n") : path;
        return {
          label: sel.length ? t("复制路径") : t("复制当前目录路径"),
          action: () => copyText(text, t(t("路径已复制"))),
        };
      }
      case "copyName":
        return {
          label: t("复制名称"),
          action: () => copyText(sel.map((e2) => e2.name).join("\n"), t("名称已复制")),
        };
      case "copyNameStem":
        return {
          label: t("复制名称（无扩展名）"),
          action: () =>
            copyText(sel.map((e2) => stemOf(e2.name)).join("\n"), t("名称已复制")),
        };
      // 复制路径变体（2026-11-09，对标 XYplorer/TC 多格式复制）：
      // 空白处右键 = 当前目录路径的各格式变体
      case "copyPathVariants": {
        const items = sel.length ? selectedPaths() : [path];
        return {
          label: sel.length ? t("复制路径 ▸") : t("复制当前目录路径 ▸"),
          sub: [
            {
              label: t("复制为正斜杠路径"),
              action: () =>
                copyText(items.map(toForwardSlash).join("\n"), t("路径已复制")),
            },
            {
              label: t("复制为带引号路径"),
              action: () => copyText(items.map(toQuoted).join("\n"), t("路径已复制")),
            },
            {
              label: t("复制为扩展长路径（\\\\?\\）"),
              action: () =>
                copyText(items.map(toExtendedLength).join("\n"), t("路径已复制")),
            },
            {
              label: t("复制相对路径（相对当前目录）"),
              action: () => {
                const texts = items.map((p2) => relativeTo(p2, path) ?? p2);
                copyText(texts.join("\n"), t("路径已复制"));
              },
            },
            {
              label: t("复制所在文件夹路径"),
              action: () => {
                const texts = sel.length
                  ? [...new Set(sel.map((e2) => parentPath(e2.path) ?? path))]
                  : [path];
                copyText(texts.join("\n"), t("路径已复制"));
              },
            },
          ],
        };
      }
      case "copyToPane":
      case "moveToPane": {
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
        const label = key === "copyToPane" ? "复制到窗格 ▸" : "移动到窗格 ▸";
        if (!others.length) return { label, disabled: true };
        return {
          label,
          sub: others.map((o) => ({
            label: o.label,
            action: () => {
              // 子菜单点选即记忆为目标窗格：Ctrl+Shift+C/X 下次直达此处
              if (layout.activePaneId) {
                useLayout.getState().setPaneTarget(layout.activePaneId, o.paneId);
              }
              void transfer(selectedPaths(), o.path, key === "copyToPane" ? "copy" : "move");
            },
          })),
        };
      }
      case "colorTag":
        return {
          label: t("颜色标记 ▸"),
          sub: [
            ...TAG_COLORS.map((c) => ({
              label: c.label,
              action: () => useSettings.getState().setTagged(entry0.path, c.key),
            })),
            { sep: true },
            {
              label: t("清除标记"),
              action: () => useSettings.getState().setTagged(entry0.path, null),
            },
          ],
        };
      case "addFavorite": {
        const paths = selectedPaths();
        return {
          label: t("添加到收藏夹"),
          action: () => {
            const st = useSettings.getState();
            for (const p of paths) st.addFavorite(p);
            useUi.getState().toast("已加入收藏");
          },
        };
      }
      case "shelfAdd": {
        const paths = selectedPaths();
        return {
          label: t("添加到暂存区"),
          action: () => {
            const added = useSettings.getState().addShelf(paths);
            useUi.getState().toast(
              added ? `已暂存 ${added} 项` : "这些项已在暂存区（或暂存区已满）",
            );
          },
        };
      }
      case "sysMenu":
        return {
          label: t("更多系统选项（Shift+右键）"),
          action: () => {
            api
              .showContextMenu(selectedPaths())
              .catch((err) => useUi.getState().toast(String(err), "error"));
          },
        };
      case "openTerminal": {
        // 选中条目 = 其所在目录；空白处 = 当前目录；"此电脑"伪路径无终端可开
        const dir = sel.length ? (parentPath(entry0.path) ?? path) : path;
        return {
          label: t("在终端打开"),
          disabled: dir === THIS_PC,
          action: () =>
            api
              .openTerminal(dir, useSettings.getState().terminal)
              .catch((err) => useUi.getState().toast(String(err), "error")),
        };
      }
      case "pdfMerge":
        return { label: t("合并为 PDF…"), action: () => void mergePdfs(sel, path, "files") };
      case "pdfMergeFolders":
        return {
          label: t("按文件夹合并 PDF…"),
          action: () => void mergePdfs(sel, path, "folders"),
        };
      case "pdfSplit":
        // 参数面板（2026-11-10 参数化）：拆分方式/页数或书签层级/命名规则/子文件夹
        return {
          label: t("PDF 拆分"),
          action: () => {
            void useUi
              .getState()
              .openDialog<PdfSplitOptions & { outDir: string } | null>({
                type: "pdfSplit",
                entry: entry0,
                dir: path,
              })
              .then((opts) => {
                if (opts) void runPdfSplit(entry0, path, opts);
              });
          },
        };
      case "pdfWatermark":
        return { label: t("PDF 加水印…"), action: () => void watermarkPdfs(sel, path) };
      case "pdfExtract":
        return { label: t("PDF 提取页…"), action: () => void extractPdfPages(entry0, path) };
      case "pdfRemove":
        return { label: t("PDF 删除页…"), action: () => void removePdfPages(entry0, path) };
      case "pdfRotate":
        // 三项口径（2026-11-09 P1：原 4 项中「逆时针 90°」与「270°」数学等效
        // 重复）；统一发顺时针等效度数，Rust 旁写 _旋转<度数>.pdf 与菜单一致
        return {
          label: t("PDF 旋转 ▸"),
          sub: [
            { deg: 90, label: t("顺时针 {d}°", { d: 90 }) },
            { deg: 180, label: t("旋转 {d}°", { d: 180 }) },
            { deg: 270, label: t("逆时针 {d}°", { d: 90 }) },
          ].map(({ deg, label }) => ({
            label,
            action: () => void rotatePdf(entry0, deg),
          })),
        };
      case "pdfCompress":
        return { label: t("PDF 轻压缩"), action: () => void compressPdfs(sel, path) };
      case "pdfInsertBlank":
        // 参数面板（2026-11-11）：12 种插入模式 + 指定页码 + 间隔 N
        return { label: t("PDF 插入空白页…"), action: () => void insertBlankPages(sel, path) };
      case "pdfToPng":
        // 前端 pdf.js 渲染（本地任务通道推进度），独立子文件夹/直存两态
        return { label: t("PDF 转图片…"), action: () => void pdfToPngs(sel, path) };
      case "pdfEncrypt":
        // AES-128 + 三权限位（默认全禁止）
        return { label: t("PDF 加密…"), action: () => void encryptPdfs(sel, path) };
      case "pdfDecrypt":
        // 权限密码输入，旁写 _解密.pdf
        return { label: t("PDF 解密…"), action: () => void decryptPdfs(sel, path) };
      case "imgToPdf":
        return { label: t("图片合并为 PDF…"), action: () => void imagesToPdf(sel, path) };
      case "imgCompress":
        return { label: t("图片压缩…"), action: () => void imgCompress(sel, path) };
      case "imgWatermark":
        return { label: t("图片加水印…"), action: () => void imgWatermark(sel, path) };
      case "imgConvert":
        return { label: t("图片格式转换…"), action: () => void imgConvert(sel, path) };
      case "imgResize":
        return { label: t("图片尺寸调整…"), action: () => void imgResize(sel, path) };
      case "imgMontage":
        return { label: t("宫格拼图…"), action: () => void imgMontage(sel, path) };
      case "officeToPdf":
        return { label: t("转为 PDF…"), action: () => void officeToPdf(sel, path) };
      case "officeClean":
        return { label: t("清理隐私属性"), action: () => void cleanOfficeMeta(sel, path) };
      case "officeToTxt":
        return { label: t("导出文本 TXT"), action: () => void exportOfficeText(sel, path) };
      case "csvConvert":
        return {
          label: t("编码转换 ▸"),
          sub: [
            { label: t("转为 UTF-8 BOM（Excel 友好）"), action: () => void convertEncoding(sel, "utf8bom") },
            { label: t("转为 UTF-8"), action: () => void convertEncoding(sel, "utf8") },
            { label: t("转为 GBK"), action: () => void convertEncoding(sel, "gbk") },
          ],
        };
      // 行尾转换（2026-11-09）：字节级重写不改编码，旁写 *_crlf/_lf.ext
      case "eolConvert":
        return {
          label: t("行尾转换 ▸"),
          sub: [
            { label: t("转为 CRLF（Windows）"), action: () => void convertEol(sel, "crlf") },
            { label: t("转为 LF（Unix）"), action: () => void convertEol(sel, "lf") },
          ],
        };
      case "csvMerge":
        return { label: t("CSV 合并…"), action: () => void mergeCsvs(sel, path) };
      case "xlsxMerge":
        return { label: t("Excel 合并…"), action: () => void mergeXlsx(sel, path) };
      case "textMerge":
        return { label: t("文本合并…"), action: () => void mergeTexts(sel, path) };
      case "exportList":
        // 参数面板（2026-11-10 五次定案）：穿透/内容筛选/格式/文件名确认后
        // 导出。空白处 = 整个文件夹语境（默认穿透）（「此电脑」页禁用）
        return {
          label: t("导出文件清单"),
          disabled: sel.length === 0 && isThisPc,
          action: () => {
            void useUi
              .getState()
              .openDialog<ExportListingOptions | null>({
                type: "exportListing",
                entries: sel,
                dir: path,
              })
              .then((opts) => {
                if (opts) void runExportListing(sel, path, opts);
              });
          },
        };
      case "batchRename":
        return {
          label: t("批量重命名…"),
          action: () => {
            void useUi
              .getState()
              .openDialog<{ path: string; newName: string }[] | null>({
                type: "batchRename",
                entries: sel,
              })
              .then((plan) => {
                if (plan?.length) void applyRenames(plan, forceBump);
              });
          },
        };
      case "zipHere":
        return { label: t("压缩…"), action: () => void zipEntries(sel, path) };
      case "extractTo":
        return {
          label: t("解压到…"),
          action: () =>
            void (async () => {
              const dest = await pickExtractDestDir();
              if (dest) extractArchivesTo(selectedPaths(), dest);
            })(),
        };
      case "extract":
        return {
          label: t("解压到此处"),
          action: () => void extractArchives(selectedPaths()),
        };
      case "findDuplicates":
        return {
          label: t("查找重复文件"),
          action: () =>
            void useUi
              .getState()
              .openDialog({ type: "duplicates", dir: entry0.path }),
        };
      case "findEmpty":
        return {
          label: t("清理空文件/空文件夹"),
          action: () =>
            void useUi.getState().openDialog({ type: "emptyScan", dir: entry0.path }),
        };
      case "dirSizes":
        return {
          label: t("空间分析"),
          action: () =>
            void useUi.getState().openDialog({ type: "dirsizes", dir: entry0.path }),
        };
      case "compareFolders":
        return {
          label: t("文件夹比较"),
          action: () => {
            const [x, y] = selectedPaths();
            if (x && y) void useUi.getState().openDialog({ type: "compare", a: x, b: y });
          },
        };
      case "organizeBy":
        return {
          label: t("按规则归类 ▸"),
          sub: [
            { label: t("按扩展名分组"), action: () => void organizeEntries(sel, path, "ext") },
            { label: t("按修改年月分组"), action: () => void organizeEntries(sel, path, "month") },
          ],
        };
      // ── 工具（2026-11-09 功能库「工具」组）──
      case "hashCalc":
        return {
          label: t("计算校验值…"),
          action: () =>
            void useUi.getState().openDialog({ type: "hashCalc", entries: sel }),
        };
      case "hashVerify":
        return {
          label: t("校验核对"),
          action: () =>
            void useUi.getState().openDialog({ type: "hashVerify", path: entry0.path }),
        };
      case "fileTouch":
        return {
          label: t("修改时间与属性…"),
          action: () =>
            void useUi.getState().openDialog({ type: "fileTouch", entries: sel }),
        };
      case "createLink":
        return {
          label: t("创建链接 ▸"),
          sub: [
            {
              label: t("创建硬链接（同卷文件）"),
              action: () => void createLinks(sel, true, forceBump),
            },
            {
              label: t("创建符号链接（需管理员或开发者模式）"),
              action: () => void createLinks(sel, false, forceBump),
            },
          ],
        };
      case "fileSplit":
        return {
          label: t("文件分割…"),
          action: () =>
            void useUi.getState().openDialog({ type: "fileSplit", entry: entry0 }),
        };
      case "fileCombine":
        return { label: t("文件合并"), action: () => void combineParts(selectedPaths()) };
      case "newFolder":
        return { label: t("新建文件夹"), action: () => createEntry(path, "dir", forceBump) };
      case "newFile":
        return { label: t("新建文本文件"), action: () => createEntry(path, "file", forceBump) };
      case "newFolders":
        return {
          label: t("批量新建文件夹…"),
          action: () =>
            void createFolders(
              path,
              entries.map((e2) => e2.name),
              forceBump,
            ),
        };
      // 「新建」子菜单：文件夹 + 常用格式（txt/md 为合法空文件 0 字节；docx/
      // xlsx/pptx 由 Rust create_file 落盘最小合法 OOXML 模板——方案 A，
      // 2026-11-05 定案，Office/WPS 干净打开不报修复）
      case "new":
        return {
          label: t("新建"),
          sub: (
            [
              ["文件夹", "新建文件夹", "新建文件夹", "dir"],
              ["文本文档", "新建文本文档", "新建文本文档.txt", "file"],
              ["Word 文档", "新建 Word 文档", "新建 Word 文档.docx", "file"],
              ["Excel 工作表", "新建 Excel 工作表", "新建 Excel 工作表.xlsx", "file"],
              ["PowerPoint 演示文稿", "新建 PowerPoint 演示文稿", "新建 PowerPoint 演示文稿.pptx", "file"],
              ["Markdown 文档", "新建 Markdown 文档", "新建 Markdown 文档.md", "file"],
            ] as const
          ).map(([label, title, initial, kind]) => ({
            label,
            action: () =>
              createEntry(path, kind, forceBump, { title, initial }),
          })),
        };
      // 预览：与 Space 同语义——当前视图全部条目（含文件夹元信息卡）入队，定位到选中项
      case "preview":
        return {
          label: t("预览"),
          action: () => {
            if (entries.length)
              usePreview
                .getState()
                .openPreview(
                  entries,
                  pickStartIndex(entries, usePanes.getState().tabs[tabId]?.selected ?? []),
                );
          },
        };
      case "refresh":
        return {
          label: t("刷新"),
          action: () => {
            forceRef.current = true;
            usePanes.getState().bumpRefresh(tabId);
          },
        };
      case "selectAll":
        return { label: t("全选"), action: () => selectAll() };
      case "reverseSelect":
        return {
          label: t("反向选择"),
          action: () => {
            const cur = new Set(selectedPaths());
            const inv = entries.filter((e2) => !cur.has(e2.path)).map((e2) => e2.path);
            usePanes.getState().setSelected(tabId, inv, inv[0] ?? null);
          },
        };
      case "toggleHidden": {
        const on = useSettings.getState().showHidden;
        return {
          label: on ? "隐藏隐藏文件" : "显示隐藏文件",
          action: () => {
            const s = useSettings.getState();
            s.update({ showHidden: !s.showHidden });
          },
        };
      }
      default:
        return null;
    }
  }

  /** 规范驱动菜单（settings.menuEntries）：按区域 + 条件过滤，分割线整形 */
  function specMenuItems(area: MenuArea, sel: FileEntry[]): MenuItem[] {
    const items: MenuItem[] = [];
    const s = useSettings.getState();
    for (const en of s.menuEntries) {
      // "both" = 不限位置（仍受功能能力位 supportsSel/supportsBlank 约束）
      if (en.area !== area && en.area !== "both") continue;
      if (en.kind === "sep") {
        if (items.length && !items[items.length - 1].sep) items.push({ sep: true });
        continue;
      }
      if (en.kind !== "builtin") continue; // custom 条目已随命令模板下线剔除（防御性跳过）
      const fn = builtinByKey(en.id.slice("builtin:".length));
      if (!fn) continue;
      if (area === "blank" && !fn.supportsBlank) continue;
      if (area === "sel" && !fn.supportsSel) continue;
      if (!entryVisible(en.cond, area, area === "sel" ? sel : null)) continue;
      const mi = builtinMenuItem(fn.key, sel);
      if (mi) items.push(mi);
    }
    while (items.length && items[0].sep) items.shift();
    while (items.length && items[items.length - 1].sep) items.pop();
    // 固定尾项（2026-10-15 定案）：「编辑菜单…」不属 menuEntries 存储、不可配置，
    // 任何配置/条件下恒在且排最后，直达右键菜单编辑页
    if (items.length && !items[items.length - 1].sep) items.push({ sep: true });
    items.push({
      label: t("编辑菜单…"),
      action: () => useUi.getState().openMenuPage(),
    });
    return items;
  }

  function rowMenuItems(entry: FileEntry): MenuItem[] {
    const nowSel = usePanes.getState().tabs[tabId]?.selected ?? [];
    const sel = nowSel.includes(entry.path) ? selectedEntries() : [entry];
    return specMenuItems("sel", sel);
  }

  function blankMenuItems(): MenuItem[] {
    return specMenuItems("blank", []);
  }

  async function doPaste() {
    // 系统剪贴板为准（2026-11-06 修复）：旧逻辑「缓存有值就直接用」导致
    // 外部（Explorer）复制的新内容被应用内旧缓存压过——桌面复制 A、窗格
    // 粘贴出的却是之前在窗格复制的 B。粘贴前读系统 CF_HDROP 比对：
    // 与缓存同一集合 → 用缓存（cut/copy 语义准确 + cut 后清缓存）；
    // 不一致 → 外部已换内容，以系统为准（cut 判定走 Preferred DropEffect）；
    // 系统读不到（剪贴板被占用等）→ 回落缓存
    const cur = useClipboard.getState().clip;
    const sys = await api.getClipboardFiles().catch(() => null);
    let mode: "copy" | "cut";
    let paths: string[];
    if (sys?.paths.length) {
      if (cur && samePathList(sys.paths, cur.paths)) {
        mode = cur.mode;
        paths = cur.paths;
      } else {
        mode = sys.cut ? "cut" : "copy";
        paths = sys.paths;
        useClipboard.getState().setInternal({ mode, paths, fromSystem: true });
      }
    } else if (cur) {
      mode = cur.mode;
      paths = cur.paths;
    } else {
      useUi.getState().toast("剪贴板里没有文件", "error");
      return;
    }
    await transfer(paths, path, mode === "copy" ? "copy" : "move");
    if (mode === "cut") useClipboard.getState().clear();
  }

  function selectAll() {
    usePanes
      .getState()
      .setSelected(tabId, entries.map((e) => e.path), entries[0]?.path ?? null);
  }

  async function commitRename(entry: FileEntry, newName: string) {
    usePanes.getState().setEditing(tabId, null);
    if (!newName || newName === entry.name) return;
    if (!isValidName(newName)) {
      useUi.getState().toast("名称含非法字符或为 Windows 保留名", "error");
      return;
    }
    try {
      await api.renameItem(entry.path, newName);
      // 重命名可逆：撤销 = 改回原名（Ctrl+Z；单条也走批量结构）
      const parent = parentPath(entry.path);
      if (parent) {
        useUndo.getState().push({
          kind: "rename",
          ops: [{ from: entry.path, to: joinPath(parent, newName) }],
        });
      }
      forceBump();
      // 同目录他窗格零防抖同步：仅本窗格刷新会让他窗格等 watcher 全链路
      // （防抖 + 合并窗 + 重扫），主动 bump 250ms 合并窗直达
      const dir = parentPath(entry.path);
      if (dir) usePanes.getState().bumpAffected([dir]);
    } catch (e) {
      useUi.getState().toast(`重命名失败：${String(e)}`, "error");
    }
  }

  // 全局快捷键接入（lib/listRegistry）
  useEffect(
    () =>
      registerList(tabId, {
        onArrow: (dir, extend) => {
          if (!count) return;
          const uiNow = usePanes.getState().tabs[tabId];
          if (!uiNow) return;
          const last = uiNow.selected[uiNow.selected.length - 1];
          const cur = last ? (pathIndex.get(last) ?? -1) : -1;
          const delta =
            dir === "up" ? -perRow : dir === "down" ? perRow : dir === "left" ? -1 : 1;
          const next = Math.min(count - 1, Math.max(0, Math.max(cur, 0) + delta));
          if (extend && uiNow.anchor !== null) {
            selectRange(uiNow.anchor, next);
          } else {
            const en = entryAt(next);
            if (en) usePanes.getState().setSelected(tabId, [en.path], en.path);
          }
          virtualizer.scrollToIndex(Math.floor(next / perRow), { align: "auto" });
        },
        onNav: (key, extend) => {
          if (!count) return;
          const uiNow = usePanes.getState().tabs[tabId];
          if (!uiNow) return;
          const last = uiNow.selected[uiNow.selected.length - 1];
          const cur = last ? (pathIndex.get(last) ?? -1) : -1;
          const viewport = scrollRef.current?.clientHeight ?? 0;
          const page = Math.max(1, Math.floor(viewport / rowH) - 1);
          const base = cur < 0 ? 0 : cur;
          const next =
            key === "home"
              ? 0
              : key === "end"
                ? count - 1
                : key === "pageup"
                  ? Math.max(0, base - page)
                  : Math.min(count - 1, base + page);
          if (extend && uiNow.anchor !== null) {
            selectRange(uiNow.anchor, next);
          } else {
            const en = entryAt(next);
            if (en) usePanes.getState().setSelected(tabId, [en.path], en.path);
          }
          virtualizer.scrollToIndex(Math.floor(next / perRow), { align: "auto" });
        },
        onEnter: () => {
          // 多选全开（2026-11-06 用户定案，Explorer 同款）：文件逐个调默认
          // 程序打开；文件夹逐个导航（多夹连续导航到最后一项，与 Explorer
          // 连开多窗的可达性等价——窗格内导航语义只有「一个当前目录」）
          for (const entry of selectedEntries()) openEntry(entry);
        },
        onBackspace: () => usePanes.getState().up(tabId),
        onDelete: (permanent) => deletePaths(selectedPaths(), confirmDelete, permanent),
        onRename: () => {
          const es = selectedEntries();
          if (es.length === 1) usePanes.getState().setEditing(tabId, es[0].path);
        },
        onProperties: () => {
          const es = selectedEntries();
          if (es.length !== 1) return;
          useUi.getState().openDialog({
            type: "properties",
            entry: es[0],
            freeBytes: freeCache.get(path) ?? undefined,
          });
        },
        onContextMenu: () => {
          // 键盘呼出（Shift+F10 / ContextMenu 键）：菜单定位到选中行下方
          const p = usePanes.getState().tabs[tabId]?.selected[0];
          const i = p !== undefined ? pathIndex.get(p) : undefined;
          const en = i !== undefined ? entryAt(i) : undefined;
          if (!en) return;
          const row = scrollRef.current?.querySelector<HTMLElement>(
            `.np-row[data-idx="${i}"]`,
          );
          const rr = row?.getBoundingClientRect();
          const paneR = scrollRef.current?.getBoundingClientRect();
          useUi
            .getState()
            .openMenu(
              rowMenuItems(en),
              rr ? rr.left : (paneR?.left ?? 0) + 80,
              rr ? rr.bottom + 4 : (paneR?.top ?? 0) + 80,
            );
        },
        onSelectAll: selectAll,
        onCopy: (cut) =>
          useClipboard.getState().set(cut ? "cut" : "copy", selectedPaths()),
        onPaste: () => void doPaste(),
        onTransferToPane: (move) => transferToPane(move),
        onRefresh: (force) => {
          if (force) forceRef.current = true;
          usePanes.getState().bumpRefresh(tabId);
        },
        onNewFolder: () => createEntry(path, "dir", forceBump),
        // selected 实时读 store（依赖数组不含 selected，闭包值会在鼠标改选后过期）
        getSnapshot: () => ({
          entries,
          selected: usePanes.getState().tabs[tabId]?.selected ?? [],
        }),
        revealEntry: (p) => {
          const i = pathIndex.get(p);
          if (i === undefined) return;
          usePanes.getState().setSelected(tabId, [p], p);
          virtualizer.scrollToIndex(Math.floor(i / perRow), { align: "auto" });
        },
        // 定制工具栏：任意内置功能按当前选中上下文解析执行项
        builtinMenuItem: (key, sel) => builtinMenuItem(key, sel),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabId, count, perRow, entries, pages, drives, confirmDelete, path],
  );

  // 选中统计（2026-11-03 方案 B）：多选 = 数量+大小+类型 Top2；单选 = 行内属性条
  const stats = useMemo(() => selStats(selected, entries), [selected, entries]);

  const sortArrow = (key: SortKey) =>
    sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : "";

  /** 搜索结果"位置"列：搜索根以下的相对父目录 */
  const relDirOf = (entry: FileEntry): string => {
    const parent = parentPath(entry.path);
    if (!parent) return entry.path;
    if (parent.toLowerCase() === path.toLowerCase()) return ".";
    return parent.toLowerCase().startsWith(path.toLowerCase())
      ? parent.slice(path.length + 1)
      : parent;
  };

  // 错误态逃生口（2026-11-06 用户需求）：目录打不开时给两条一键去处——
  // 桌面路径经 getKnownFolder 取真实位置（OneDrive 重定向也正确）
  const goDesktop = () => {
    api
      .getKnownFolder("desktop")
      .then((p) => usePanes.getState().navigate(tabId, p))
      .catch((e) => useUi.getState().toast(String(e), "error"));
  };
  const goThisPc = () => usePanes.getState().navigate(tabId, THIS_PC);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      ref={wrapRef}
      style={
        {
          "--np-colw-name": `${colw.name}px`,
          "--np-colw-mtime": `${colw.mtime}px`,
          "--np-colw-type": `${colw.type}px`,
          "--np-colw-size": `${colw.size}px`,
          "--np-colw-loc": `${colw.loc}px`,
        } as CSSProperties
      }
    >
      {/* 列表头（详细信息 / 此电脑列组，§7.5；搜索模式第二列为"位置"）。
          clip 裁掉横向超出卡片的部分；ref + onScroll 同步平移（与行同滚不漂移） */}
      {viewMode === "details" && (
        <div className="np-head-clip">
          <div
            className="np-head"
            ref={headRef}
            style={innerMinW ? { minWidth: innerMinW } : undefined}
          >
          {isThisPc ? (
            <>
              <span className="np-col-name">
                {t("名称")}<ColGrip col="name" ctl={paneCtl} />
              </span>
              <span className="np-col-type">
                {t("类型")}<ColGrip col="type" ctl={paneCtl} />
              </span>
              <span className="np-col-size">
                {t("总大小")}<ColGrip col="size" ctl={paneCtl} />
              </span>
              <span className="np-col-size">
                {t("可用空间")}<ColGrip col="size" ctl={paneCtl} />
              </span>
            </>
          ) : searchCols ? (
            <>
              <span className="np-col-name">
                {t("名称")}<ColGrip col="name" ctl={paneCtl} />
              </span>
              <span className="np-col-loc">
                {t("位置")}<ColGrip col="loc" ctl={paneCtl} />
              </span>
              <span className="np-col-type">
                {t("类型")}<ColGrip col="type" ctl={paneCtl} />
              </span>
              <span className="np-col-size">
                {t("大小")}<ColGrip col="size" ctl={paneCtl} />
              </span>
            </>
          ) : (
            <>
              <button className="np-head-c np-col-name" onClick={() => toggleSort("name")}>
                {t("名称")}{sortArrow("name")}
                <ColGrip col="name" ctl={paneCtl} />
              </button>
              <button className="np-head-c np-col-mtime" onClick={() => toggleSort("mtime")}>
                {t("修改时间")}{sortArrow("mtime")}
                <ColGrip col="mtime" ctl={paneCtl} />
              </button>
              <button className="np-head-c np-col-type" onClick={() => toggleSort("type")}>
                {t("类型")}{sortArrow("type")}
                <ColGrip col="type" ctl={paneCtl} />
              </button>
              <button className="np-head-c np-col-size" onClick={() => toggleSort("size")}>
                {t("大小")}{sortArrow("size")}
                <ColGrip col="size" ctl={paneCtl} />
              </button>
            </>
          )}
          </div>
        </div>
      )}

      {/* 列表体（虚拟滚动） */}
      <div
        ref={scrollRef}
        className={`np-rows ${viewMode === "details" && contentW > width ? "np-scroll-x" : ""} ${dropHover ? "np-drop-hover" : ""}`}
        onScroll={syncHeadX}
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
              // 标签跨窗格拖动：落到列表区 = 移入该窗格（文件拖放已走 OLE 管线）
              useLayout
                .getState()
                .moveTab(d.tabMove.fromPaneId, d.tabMove.tabIndex, paneId);
            }
          } catch {
            /* 忽略 */
          }
        }}
        onMouseDown={startMarquee}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest(".np-row")) return;
          e.preventDefault();
          // Explorer 惯例：右键空白处清空选择（空白菜单针对目录本身）
          usePanes.getState().setSelected(tabId, [], null);
          if (isThisPc) {
            useUi
              .getState()
              .openMenu(
                [
                  {
                    label: t("刷新 F5"),
                    action: () => usePanes.getState().bumpRefresh(tabId),
                  },
                  { sep: true },
                  {
                    label: t("编辑菜单…"),
                    action: () => useUi.getState().openMenuPage(),
                  },
                ],
                e.clientX,
                e.clientY,
              );
          } else {
            useUi.getState().openMenu(blankMenuItems(), e.clientX, e.clientY);
          }
        }}
      >
        {error ? (
          <div className="np-list-error">
            <div className="np-list-error-title">
              {error.code === "E_NOT_FOUND" ? "文件夹不存在" : "无法打开此位置"}
            </div>
            <div className="np-list-error-path" title={path}>
              {path}
            </div>
            <div className="np-list-error-msg">
              {error.code === "E_NOT_FOUND"
                ? "可能已被移动、重命名或删除，也可能路径输入有误。"
                : error.code === "E_PERM"
                  ? "没有访问此位置的权限。"
                  : error.message}
            </div>
            <div className="np-list-error-actions">
              <button
                className="np-list-error-btn"
                data-tip="跳转到桌面文件夹"
                onClick={goDesktop}
              >
                <AppIcon icon={Monitor} size={DENSITY.iconSm} />
                打开桌面
              </button>
              <button
                className="np-list-error-btn"
                data-tip="跳转到驱动器列表"
                onClick={goThisPc}
              >
                <AppIcon icon={HardDrive} size={DENSITY.iconSm} />
                打开此电脑
              </button>
            </div>
          </div>
        ) : count === 0 ? (
          <div className="np-list-empty">
            {isThisPc
              ? "正在读取驱动器…"
              : searchActive
                ? "没有匹配的结果"
                : filterActive
                  ? "没有匹配过滤词的条目"
                  : loaded
                    ? "此文件夹为空"
                    : "正在加载…"}
          </div>
        ) : (
          <div
            key={viewMode}
            ref={innerRef}
            className="relative"
            style={{
              height: virtualizer.getTotalSize(),
              // 自然宽撑开：各列定宽不互压，超出容器由 .np-rows 横向滚动
              minWidth: innerMinW,
            }}
          >
            {band && (
              <div
                className="np-marquee"
                style={{
                  left: band.left,
                  top: band.top,
                  width: band.width,
                  height: band.height,
                }}
              />
            )}
            {rows.map((row) => (
              <div
                key={row.key}
                className="absolute inset-x-0 flex"
                style={{ height: row.size, transform: `translateY(${row.start}px)` }}
              >
                {Array.from({ length: perRow }, (_, col) => {
                  const idx = row.index * perRow + col;
                  const entry = entryAt(idx);
                  if (!entry) return <div key={col} className="flex-1" />;
                  const sel = selected.includes(entry.path);
                  const editingThis = editing === entry.path;
                  const tag = tagColorOf(entry);
                  const nameEl = editingThis ? (
                    <input
                      autoFocus
                      defaultValue={entry.name}
                      className="np-rename"
                      spellCheck={false}
                      onFocus={(e) => {
                        const dot = entry.name.lastIndexOf(".");
                        e.target.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
                      }}
                      onBlur={(e) => commitRename(entry, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          commitRename(entry, (e.target as HTMLInputElement).value);
                        if (e.key === "Escape")
                          usePanes.getState().setEditing(tabId, null);
                      }}
                    />
                  ) : (
                    <span
                      className="np-ellipsis"
                      style={tag ? { color: `var(--np-tag-${tag})` } : undefined}
                    >
                      {tag && <span className="np-tagdot" style={{ background: `var(--np-tag-${tag})` }} />}
                      <TaName
                        name={entry.name}
                        py={entry.py}
                        isDir={entry.isDir}
                        ta={active && !searching ? typeAhead : null}
                      />
                    </span>
                  );

                  if (viewMode === "details") {
                    return (
                      <div
                        key={col}
                        data-idx={idx}
                        data-path={entry.path}
                        data-dir={entry.isDir ? "1" : undefined}
                        className={`np-row ${sel ? "is-sel" : ""} ${
                          entry.path === dropRowPath ? "is-drop" : ""
                        }`}
                        style={{ width: "100%" }}
                        onMouseDown={(e) => rowMouseDown(e, entry)}
                        onDoubleClick={(e) => {
                          // 框内双击 = 选词，不冒泡成「打开该项」
                          if (!(e.target as HTMLElement).closest(".np-rename")) openEntry(entry);
                        }}
                        onContextMenu={(e) => openRowMenu(e, entry)}
                      >
                        <RowFileIcon
                          entry={entry}
                          isThisPc={isThisPc}
                          realIcons={realIcons}
                          iconMap={iconMap}
                          exts={extMap}
                        />
                        <span className="np-name">{nameEl}</span>
                        {searchCols ? (
                          <>
                            <span className="np-cell-muted np-col-loc">
                              {relDirOf(entry)}
                            </span>
                            <span className="np-cell-muted np-col-type">
                              {t(typeName(entry.name, entry.isDir))}
                            </span>
                            <span className="np-cell-muted np-col-size">
                              {formatSize(entry)}
                            </span>
                          </>
                        ) : !isThisPc ? (
                          <>
                            <span className="np-cell-muted np-col-mtime">
                              {formatTime(entry.mtimeMs)}
                            </span>
                            <span className="np-cell-muted np-col-type">
                              {t(typeName(entry.name, entry.isDir))}
                            </span>
                            <span className="np-cell-muted np-col-size">
                              {formatSize(entry)}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="np-cell-muted np-col-type">{t("本地磁盘")}</span>
                            <span className="np-cell-muted np-col-size">
                              {formatSize(entry)}
                            </span>
                            <span className="np-cell-muted np-col-size">
                              {formatSize({
                                isDir: false,
                                size: drivesFree.get(entry.path) ?? 0,
                              })}
                            </span>
                          </>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={col}
                      data-idx={idx}
                      data-path={entry.path}
                      data-dir={entry.isDir ? "1" : undefined}
                      className={`np-row ${sel ? "is-sel" : ""} ${
                        entry.path === dropRowPath ? "is-drop" : ""
                      }`}
                      style={{ width: cellW, flex: "0 0 auto" }}
                      onMouseDown={(e) => rowMouseDown(e, entry)}
                      onDoubleClick={(e) => {
                        // 框内双击 = 选词，不冒泡成「打开该项」
                        if (!(e.target as HTMLElement).closest(".np-rename")) openEntry(entry);
                      }}
                      onContextMenu={(e) => openRowMenu(e, entry)}
                    >
                      <RowFileIcon
                        entry={entry}
                        isThisPc={isThisPc}
                        realIcons={realIcons}
                        iconMap={iconMap}
                        exts={extMap}
                      />
                      {nameEl}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 首字母跳转回显（type-ahead）：输入缓冲 + 序位/总数 + 命中条目，悬于状态
          条右上角；Esc/停顿超时即消失（lib/keyboard 维护 useUi.typeAhead）。匹配集
          唯一时省略 x/y 免噪 */}
      {active && !searching && typeAhead && (
        <div className="np-typeahead">
          <span className="np-typeahead-buf">{typeAhead.buf}</span>
          {typeAhead.hit && (typeAhead.total ?? 0) > 1 && (
            <span className="np-typeahead-buf">
              {typeAhead.pos}/{typeAhead.total}
            </span>
          )}
          {typeAhead.hit && <span className="np-ellipsis">{typeAhead.hit}</span>}
        </div>
      )}

      {/* 窗格状态条（§7.1） */}
      <div className="np-pstatus">
        <span className="np-ellipsis">
          <span className="np-pane-no" title={`窗格 ${paneNo}`}>
            <span className="np-pane-hash">#</span>
            {paneNo}
          </span>
          <span className="np-pane-dot" aria-hidden>
            ·
          </span>
          {searchActive
            ? `搜索 “${search}” · ${count.toLocaleString()} 项${
                searchDeep ? "" : t(" · 当前目录")
              }${
                searchRes?.elapsedMs ? ` · ${formatElapsed(searchRes.elapsedMs)}` : ""
              }${
                searchRes?.engine === "index"
                  ? " · 索引"
                  : searchRes?.scanned
                    ? t(" · 已扫描 {n}", { n: searchRes.scanned.toLocaleString() })
                    : ""
              }${searchRes?.truncated ? t("（已截断）") : ""}`
            : filterActive
              ? t("过滤 “{q}” · {n} 项（Ctrl+E 编辑 · Esc 退出）", { q: filter?.trim(), n: count.toLocaleString() })
              : t("Σ {n} 个对象", { n: count.toLocaleString() })}
          {!searchActive &&
            selected.length > 0 &&
            (stats.single
              ? stats.single.isDir
                ? t(" · {name} · 文件夹", { name: stats.single.name })
                : t(" · {name} · {size} · 修改于 {time}", {
                    name: stats.single.name,
                    size: formatSize({ isDir: false, size: stats.single.size }),
                    time: formatShortTime(stats.single.mtimeMs),
                  })
              : t(" · 选中 {n} 项", { n: selected.length }) +
                // 含文件夹 = 仅数量（合计不展示——文件夹大小未知，部分和误导）
                (!stats.hasDir && stats.size > 0
                  ? ` (${formatSize({ isDir: false, size: stats.size })})`
                  : ""))}
        </span>
        <span className="np-ellipsis">
          {free !== null && !searchActive && t("可用 {s}", { s: formatSize({ isDir: false, size: free }) })}
          {dropHover && t(" · 释放以放入")}
        </span>
      </div>
    </div>
  );
}
