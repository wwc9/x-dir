// 表格预览（V2 快速预览）：虚拟化网格——行虚拟化（TanStack Virtual，铁律：DOM
// 只有可见行）+ 列虚拟化（2026-11-26：显式轨道不产生 DOM，只渲染视窗列，宽表
// 不再全量铺格子）。单一 CSS grid 容器 + 格子显式行列定位（支持合并单元格：
// 锚点格跨行跨列展开、被覆盖格不渲染；2026-11-26 起锚点矩形与可见行列窗口相
// 交即渲染——修复「锚点滚出窗口合并区消失成空洞」）。多 sheet 走底部切换条。
// 2026-10-18：首行表头样式（加粗 + 冻结）、数值列右对齐（采样启发）、预览内查
// 找（命中格高亮 + 滚动定位）。
// 2026-11-03：行高三档（单行省略 / 换行自适应 / 宽松留白）——多行档行高由
// lib/sheetGrid.sheetRowHeights 按列宽折行估算，经 gridTemplateRows 显式轨道
// 下发（合并区跨行高度 = 各行轨道之和仍正确），virtualizer 按同一数组估高。
// 2026-11-25：行高切换 Seg 迁 QuickPreview footer 中央槽（portal，同 PDF 页码
// 跳转槽位复用）——原右上悬浮药丸必挡表格右上格内容，退役；无槽宿主（全盘
// 搜索内嵌预览）回退表头上方文档流工具行。三档选择随 settings.json
// pvSheetRowMode 持久化（原会话级）。
// 2026-11-26 表格预览八项增强：① 列虚拟化（见上）；② 搜索命中横向跟随（让出
// 冻结首列宽度后把命中列滚进视口）；③ 多行档截断格角标（sheetTruncatedCells
// 与行高同源启发，标出被 6 行上限静默裁切的格）；④ 表头行数手动纠正（自动/无/
// 1 行/2 行 Seg，footer 控件行第三档）；⑤ 合并区视窗可见（mergesInView）；
// ⑥ 单元格选中态集群——单击选中（is-sel 描边 + footer 坐标条 A1·内容），
// 方向键移动（落进合并区吸附锚点；焦点在网格容器本地拦截，无选中时全部透传
// 给预览级键位），Enter/双击弹强霜详情浮层看全文，Ctrl+C 复制格内容（toast
// 回执），Esc 逐级退出：浮层 → 选中 → 关预览；⑦ 冻结首列（总宽超视口时左缘
// 钉住标识列，随纵向滚动 transform 平移，行窗口与主网格同源）；⑧ 列宽手拖
// （列边界拖拽热区，会话级覆写合入启发式列宽，双击复位）。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@blueprintjs/core";
import { t } from "../../lib/i18n";
import { useSettings } from "../../stores/settings";
import { useUi } from "../../stores/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, X } from "lucide-react";

import type { OfficeSection } from "../../lib/ipc";
import {
  buildMergeMap,
  clampSheetColWidth,
  mergesInView,
  parseSheetRows,
  sheetA1,
  sheetColPrefix,
  sheetColumnCount,
  sheetColumnWindow,
  sheetColumnWidths,
  sheetHeaderRow,
  sheetMatches,
  sheetNumericCols,
  sheetRowHeights,
  sheetTruncatedCells,
  trimSheetEdges,
  type SheetRowMode,
} from "../../lib/sheetGrid";
import { Seg } from "../ImgDialogs";
import { ic } from "../AppIcon";
import { DENSITY } from "../../lib/tokens";
import type { PreviewSearchCtl } from "../../lib/previewSearch";

const ROW_MODE_OPTS: { value: SheetRowMode; label: string; title: string }[] = [
  { value: "single", label: "单行", title: "行高固定，超长文本省略号（悬停看全文）" },
  { value: "wrap", label: "换行", title: "按内容自动调整行高，长文本完整展示（上限 6 行）" },
  { value: "relaxed", label: "宽松", title: "换行 + 更大留白，适合逐行细读" },
];

/** 表头行数（2026-11-26 手动纠正）：auto = 智能判定；0/1/2 = 手动指定行数 */
type SheetHeaderMode = "auto" | 0 | 1 | 2;
const HEADER_MODE_OPTS: { value: SheetHeaderMode; label: string; title: string }[] = [
  { value: "auto", label: "自动", title: "自动判定表头行（前 5 行内非空占比 ≥60% 的首行）" },
  { value: 0, label: "无", title: "无表头：首行即数据，不冻结表头条" },
  { value: 1, label: "1 行", title: "首行为表头" },
  { value: 2, label: "2 行", title: "前两行为表头（带装饰标题的表）" },
];

/** 列虚拟化两侧外扩列数（横向斜读预渲染，滚动不出白） */
const COL_OVERSCAN = 3;

export function SheetPreview({
  sections,
  search,
  jumpSlot,
}: {
  sections: OfficeSection[];
  search?: PreviewSearchCtl;
  /** QuickPreview footer 中央槽（np-pv-foot-jumpslot）：行高/表头控件经 portal
   *  注入，与 PDF 页码跳转同槽复用；无槽宿主回退文档流工具行（不悬浮遮挡） */
  jumpSlot?: HTMLElement | null;
}) {
  const [active, setActive] = useState(0);
  // 行高模式（2026-11-25 持久化进 settings.json，原会话级）：默认换行
  // （2026-11-03 用户定案——长文本格完整可读优先于紧凑恒高），记住上次选择
  const rowMode = useSettings((s) => s.pvSheetRowMode);
  const updateSettings = useSettings((s) => s.update);
  const sec = sections[Math.min(active, sections.length - 1)];
  const baseRows = useMemo(() => parseSheetRows(sec.text), [sec.text]);
  const baseCols = useMemo(() => sheetColumnCount(baseRows), [baseRows]);
  // 边缘空行/空列裁剪（2026-11-24 表格预览增强）：样式化 used range 的装饰性
  // 空行空列会挤掉表头判定（is-head 指向空行）并占首屏视野；合并区随裁剪平移；
  // rowOffset/colOffset = 真实 A1 坐标还原用
  const trimmed = useMemo(
    () => trimSheetEdges(baseRows, baseCols, sec.merges ?? []),
    [baseRows, baseCols, sec.merges],
  );
  const rows = trimmed.rows;
  const colCount = trimmed.colCount;

  // 表头行（2026-11-26 手动纠正）：默认自动判定，猜错可切 0/1/2 行
  const [headerMode, setHeaderMode] = useState<SheetHeaderMode>("auto");
  const headRow = useMemo(
    () =>
      headerMode === "auto"
        ? sheetHeaderRow(rows, colCount)
        : headerMode === 0
          ? -1
          : headerMode - 1,
    [headerMode, rows, colCount],
  );
  const colWidths = useMemo(() => sheetColumnWidths(rows, colCount), [rows, colCount]);
  // 手拖列宽覆写（2026-11-26，会话级，切 sheet 重置）合入启发式列宽
  const [colOverride, setColOverride] = useState<Record<number, number>>({});
  const effWidths = useMemo(
    () => colWidths.map((w, c) => colOverride[c] ?? w),
    [colWidths, colOverride],
  );
  const colPrefix = useMemo(() => sheetColPrefix(effWidths), [effWidths]);
  const totalWidth = colPrefix[colPrefix.length - 1] ?? 0;
  const numericCols = useMemo(
    () => sheetNumericCols(rows, colCount, headRow >= 0 ? headRow + 1 : 0),
    [rows, colCount, headRow],
  );
  const merges = useMemo(
    () => buildMergeMap(trimmed.merges, rows.length, colCount),
    [trimmed.merges, rows.length, colCount],
  );
  const rowHeights = useMemo(
    () => (rowMode === "single" ? null : sheetRowHeights(rows, effWidths, rowMode)),
    [rowMode, rows, effWidths],
  );
  // 截断格集合（2026-11-26）：多行档被 6 行上限静默裁切的格 → 角标提示
  const truncSet = useMemo(
    () => (rowMode === "single" ? null : sheetTruncatedCells(rows, effWidths, rowMode)),
    [rowMode, rows, effWidths],
  );

  // 冻结首列（2026-11-26）：总宽超出视口才启用（不超时首列本来可见）；
  // viewW > 0 = 已完成视口测量（SSR/首帧前不渲染，输出确定性）
  const [viewW, setViewW] = useState(0);
  const frozenW =
    viewW > 0 && colCount > 1 && totalWidth > viewW + 1 && rows.length > 0 ? effWidths[0] : 0;
  const frozenRef = useRef<HTMLDivElement>(null);
  const frozenWRef = useRef(0);
  frozenWRef.current = frozenW;
  const totalWidthRef = useRef(0);
  totalWidthRef.current = totalWidth;
  const colPrefixRef = useRef(colPrefix);
  colPrefixRef.current = colPrefix;

  // 冻结表头条（2026-11-24 表格预览增强）：行 0..表头行 在长表下滚后移出虚拟
  // 窗口，滚动越过表头底缘时显示独立的表头条（横向随滚动条平移），越回头部
  // 自动隐藏（此时网格内自带表头，避免重复）
  const headStripRef = useRef<HTMLDivElement>(null);
  const headBottom = useMemo(() => {
    if (headRow < 0) return 0;
    return rowHeights
      ? rowHeights.slice(0, headRow + 1).reduce((a, b) => a + b, 0)
      : (headRow + 1) * DENSITY.rowH;
  }, [headRow, rowHeights]);

  // 预览内查找：命中格集合 + 活动格；活动命中变化滚动定位
  const matches = useMemo(() => sheetMatches(rows, search?.term ?? ""), [rows, search?.term]);
  useEffect(() => {
    search?.onTotal(matches.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);
  const hitSet = useMemo(() => {
    const s = new Set<string>();
    for (const m of matches) s.add(`${m.r}:${m.c}`);
    return s;
  }, [matches]);
  const activeKey =
    matches.length > 0 ? `${matches[Math.min(search!.active, matches.length - 1)].r}:${matches[Math.min(search!.active, matches.length - 1)].c}` : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowHeights?.[i] ?? DENSITY.rowH,
    overscan: DENSITY.overscan,
  });
  // 行高模式切换 → 逐行高度数组变了，显式触发重测（estimateSize 换了身份但
  // virtualizer 缓存不自动失效）；列宽手拖同理（折行估算随列宽变）
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeights]);

  // ── 列窗口（2026-11-26 列虚拟化）：rAF 节流的滚动同步（表头条平移 + 冻结列
  //    纵向跟随 + 列窗口重算 + 详情浮层随滚关闭），挂载/重渲染后 layout 同步 ──
  const [colWin, setColWin] = useState({ start: 0, end: -1 });
  const rafRef = useRef(0);
  const [popover, setPopover] = useState<{ r: number; c: number; left: number; top: number } | null>(null);
  const popoverRef = useRef(false);
  popoverRef.current = popover !== null;
  const syncGrid = (fromScroll = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const strip = headStripRef.current;
    if (strip && headRow >= 0) {
      strip.style.display = el.scrollTop > headBottom + 2 ? "block" : "none";
      strip.style.transform = `translateX(${-el.scrollLeft}px)`;
    }
    if (frozenRef.current) {
      frozenRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    }
    const win = sheetColumnWindow(colPrefixRef.current, el.scrollLeft, el.clientWidth, COL_OVERSCAN);
    setColWin((prev) => (prev.start === win.start && prev.end === win.end ? prev : win));
    // 详情浮层随滚收起：只挂在真实滚动路径（layout 同步是每渲染后跑的，
    // 不能挂这里——否则浮层刚 setPopover 就被下一次渲染关掉，永远不可见）
    if (fromScroll && popoverRef.current) setPopover(null);
  };
  const onSheetScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      syncGrid(true);
    });
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  useLayoutEffect(syncGrid);
  // 视口宽：ResizeObserver 跟随（预览面板拖宽/窗口缩放）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewW(el.clientWidth);
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 活动命中 → 滚动到所在行（居中）+ 横向跟随（让出冻结首列宽度后把命中列
  // 滚进视口——命中在第 80 列时不再「知道有、看不见」）
  useEffect(() => {
    if (!matches.length || !search || search.active >= matches.length) return;
    const m = matches[search.active];
    virtualizer.scrollToIndex(m.r, { align: "center" });
    const el = scrollRef.current;
    if (!el) return;
    const L = colPrefixRef.current[m.c];
    const R = colPrefixRef.current[m.c + 1] ?? L + 80;
    const fw = frozenWRef.current;
    if (L - fw < el.scrollLeft) {
      el.scrollLeft = Math.max(0, L - fw - 8);
    } else if (R > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, Math.min(totalWidthRef.current - el.clientWidth, R - el.clientWidth + 8));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search?.active, matches]);

  // 切 sheet：选中/浮层/列宽覆写随 sheet 上下文失效，滚动归零
  useEffect(() => {
    setSel(null);
    setPopover(null);
    setColOverride({});
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ── 单元格选中态（2026-11-26）：单击选中 + 方向键移动 + Enter/双击详情 +
  //    Ctrl+C 复制；焦点在滚动容器本地拦截，无选中时按键透传预览级语义 ──
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const openPopover = (r: number, c: number) => {
    const cell = gridRef.current?.querySelector(`[data-k="${r}:${c}"]`);
    const root = rootRef.current;
    if (!cell || !root) return;
    const cr = cell.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const width = Math.min(440, rr.width - 16);
    const maxH = Math.round(rr.height * 0.5);
    let left = cr.left - rr.left;
    let top = cr.bottom - rr.top + 4;
    // 下方放不下 → 弹到格子上方
    if (top + 160 > rr.height) top = Math.max(8, cr.top - rr.top - maxH - 8);
    left = Math.max(8, Math.min(left, rr.width - width - 8));
    setPopover({ r, c, left, top });
  };
  const copySel = () => {
    if (!sel) return;
    const text = rows[sel.r]?.[sel.c] ?? "";
    navigator.clipboard
      .writeText(text)
      .then(() => {
        useUi.getState().toast(t("已复制"));
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => useUi.getState().toast(t("复制失败"), "error"));
  };
  const moveSel = (e: React.KeyboardEvent, nr: number, nc: number) => {
    const r = Math.min(rows.length - 1, Math.max(0, nr));
    const c = Math.min(colCount - 1, Math.max(0, nc));
    // 移进合并区 → 吸附到锚点（与视觉块一致）
    const a = merges.anchorOf.get(`${r}:${c}`);
    const tgt = a ? { r: a.row, c: a.col } : { r, c };
    setSel(tgt);
    requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector(`[data-k="${tgt.r}:${tgt.c}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (popover) {
      // 浮层开启：Esc/Enter 关闭，其余透传（滚动等）
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        setPopover(null);
      }
      return;
    }
    if (!sel) return; // 无选中：全部透传（Space/Esc/↑↓ = 预览级键位不动）
    switch (e.key) {
      case "ArrowUp":
        return moveSel(e, sel.r - 1, sel.c);
      case "ArrowDown":
        return moveSel(e, sel.r + 1, sel.c);
      case "ArrowLeft":
        return moveSel(e, sel.r, sel.c - 1);
      case "ArrowRight":
        return moveSel(e, sel.r, sel.c + 1);
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        openPopover(sel.r, sel.c);
        return;
      case "Escape":
        // 第一层 Esc 退出选中，不关预览（window 级 Esc 才是关预览）
        e.preventDefault();
        e.stopPropagation();
        setSel(null);
        return;
      default:
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "c") {
          e.preventDefault();
          e.stopPropagation();
          copySel();
        }
    }
  };
  const onCellClick = (r: number, c: number) => {
    setSel({ r, c });
    setPopover(null); // 点其他格收旧浮层（双击会在其后重开新格浮层）
    scrollRef.current?.focus();
  };
  const onCellDoubleClick = (r: number, c: number) => {
    setSel({ r, c });
    scrollRef.current?.focus();
    openPopover(r, c);
  };

  // ── 列宽手拖（2026-11-26）：列边界 7px 热区，会话级覆写；双击复位 ──
  const dragRef = useRef<{ c: number; startX: number; baseW: number } | null>(null);
  const onColDragMove = (e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const w = clampSheetColWidth(d.baseW + e.clientX - d.startX);
    setColOverride((prev) => (prev[d.c] === w ? prev : { ...prev, [d.c]: w }));
  };
  const onColDragEnd = () => {
    dragRef.current = null;
    window.removeEventListener("mousemove", onColDragMove);
    window.removeEventListener("mouseup", onColDragEnd);
  };
  const onColDragStart = (c: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { c, startX: e.clientX, baseW: effWidths[c] };
    window.addEventListener("mousemove", onColDragMove);
    window.addEventListener("mouseup", onColDragEnd);
  };

  // ── 渲染：格子（列窗口内）──
  const items = virtualizer.getVirtualItems();
  const rFirst = items[0]?.index ?? 0;
  const rLast = items.length ? items[items.length - 1].index : -1;
  const cellCls = (r: number, c: number, anchor?: { colSpan: number }) => {
    const k = `${r}:${c}`;
    const isHead = headRow >= 0 && r <= headRow;
    return [
      "np-pv-sheet-cell",
      r % 2 === 1 ? "is-even" : "",
      anchor ? "is-anchor" : "",
      isHead ? "is-head" : "",
      !isHead && numericCols[c] ? "is-num" : "",
      k === activeKey ? "is-hit-active" : hitSet.has(k) ? "is-hit" : "",
      sel && sel.r === r && sel.c === c ? "is-sel" : "",
      truncSet?.has(k) && !anchor ? "is-trunc" : "",
    ]
      .filter(Boolean)
      .join(" ");
  };
  const cells: React.ReactNode[] = [];
  for (const vi of items) {
    const r = vi.index;
    for (let c = colWin.start; c <= colWin.end && c < colCount; c++) {
      const k = `${r}:${c}`;
      if (merges.covered.has(k)) continue; // 被合并区覆盖：不渲染
      const anchor = merges.anchors.get(k);
      const text = rows[r][c] ?? "";
      cells.push(
        <div
          key={k}
          data-k={k}
          className={cellCls(r, c, anchor)}
          style={{
            gridColumn: `${c + 1} / span ${anchor?.colSpan ?? 1}`,
            gridRow: `${r + 1} / span ${anchor?.rowSpan ?? 1}`,
          }}
          title={text}
          onClick={() => onCellClick(r, c)}
          onDoubleClick={() => onCellDoubleClick(r, c)}
        >
          {text}
        </div>,
      );
    }
  }
  // 视窗外但与可见窗口相交的合并锚点（#5）：显式渲染，按原跨度放置（轨道
  // 全量存在，放置不依赖窗口）；窗口内已由循环渲染的不重复
  for (const [k, m] of mergesInView(merges.anchors, rFirst, rLast, colWin.start, colWin.end)) {
    if (m.row >= rFirst && m.row <= rLast && m.col >= colWin.start && m.col <= colWin.end) continue;
    const text = rows[m.row]?.[m.col] ?? "";
    cells.push(
      <div
        key={k}
        data-k={k}
        className={cellCls(m.row, m.col, m)}
        style={{
          gridColumn: `${m.col + 1} / span ${m.colSpan}`,
          gridRow: `${m.row + 1} / span ${m.rowSpan}`,
        }}
        title={text}
        onClick={() => onCellClick(m.row, m.col)}
        onDoubleClick={() => onCellDoubleClick(m.row, m.col)}
      >
        {text}
      </div>,
    );
  }
  // 列宽拖拽热区（列窗口内每列右缘）
  const handles: React.ReactNode[] = [];
  for (let c = colWin.start; c <= colWin.end && c < colCount; c++) {
    handles.push(
      <div
        key={`h${c}`}
        className="np-pv-sheet-colhandle"
        style={{ left: (colPrefix[c + 1] ?? 0) - 4 }}
        data-tip={t("拖动调列宽 · 双击复位")}
        onMouseDown={(e) => onColDragStart(c, e)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setColOverride((prev) => {
            const next = { ...prev };
            delete next[c];
            return next;
          });
        }}
        onClick={(e) => e.stopPropagation()}
      />,
    );
  }

  // 冻结首列格（列 0 切片，行窗口与主网格同源；合并区锚点在列 0 且与行窗口
  // 相交的按原行跨度绘制，被右方合并覆盖的格留白）
  const frozenCells: React.ReactNode[] = [];
  if (frozenW > 0) {
    for (const [k, m] of mergesInView(merges.anchors, rFirst, rLast, 0, 0)) {
      if (m.col !== 0) continue;
      const text = rows[m.row]?.[m.col] ?? "";
      frozenCells.push(
        <div
          key={k}
          className={cellCls(m.row, 0, { colSpan: 1 })}
          style={{ gridColumn: "1 / span 1", gridRow: `${m.row + 1} / span ${m.rowSpan}` }}
          title={text}
        >
          {text}
        </div>,
      );
    }
    for (const vi of items) {
      const r = vi.index;
      const k = `${r}:0`;
      if (merges.covered.has(k) || merges.anchors.has(k)) continue;
      const text = rows[r][0] ?? "";
      frozenCells.push(
        <div
          key={k}
          className={cellCls(r, 0)}
          style={{ gridColumn: "1 / span 1", gridRow: `${r + 1} / span 1` }}
          title={text}
          onClick={() => onCellClick(r, 0)}
          onDoubleClick={() => onCellDoubleClick(r, 0)}
        >
          {text}
        </div>,
      );
    }
  }

  // 表头条（仅列窗口内表头格）
  const headStripCells: React.ReactNode[] = [];
  if (headRow >= 0 && rows.length > headRow + 1) {
    for (let r = 0; r <= headRow; r++) {
      for (let c = colWin.start; c <= colWin.end && c < colCount; c++) {
        const k = `${r}:${c}`;
        if (merges.covered.has(k)) continue;
        const anchor = merges.anchors.get(k);
        headStripCells.push(
          <div
            key={k}
            className="np-pv-sheet-cell is-head"
            style={{
              gridColumn: `${c + 1} / span ${anchor?.colSpan ?? 1}`,
              gridRow: `${r + 1} / span ${anchor?.rowSpan ?? 1}`,
            }}
          >
            {rows[r][c] ?? ""}
          </div>,
        );
      }
    }
  }

  // footer 中央槽控件：坐标条（选中态）+ 行高三档 + 表头行数
  const coordText = sel
    ? `${sheetA1(sel.r + trimmed.rowOffset, sel.c + trimmed.colOffset)} · ${rows[sel.r]?.[sel.c] ?? ""}`
    : "";
  const footCtl = (
    <div className="np-pv-sheet-footctl">
      {sel && (
        <span
          className="np-pv-sheet-coord np-ellipsis"
          data-tip={copied ? t("已复制") : t("双击查看全文 · Ctrl+C 复制")}
        >
          {copied ? t("已复制") : coordText}
        </span>
      )}
      <Seg
        value={rowMode}
        onChange={(m) => updateSettings({ pvSheetRowMode: m })}
        options={ROW_MODE_OPTS.map((o) => ({ ...o, label: t(o.label), title: t(o.title) }))}
      />
      <Seg
        value={headerMode}
        onChange={setHeaderMode}
        options={HEADER_MODE_OPTS.map((o) => ({ ...o, label: t(o.label), title: t(o.title) }))}
      />
    </div>
  );

  return (
    <div ref={rootRef} className="np-pv-sheet">
      {jumpSlot
        ? createPortal(footCtl, jumpSlot, "np-pv-sheet-footctl")
        : <div className="np-pv-sheet-moderow">{footCtl}</div>}
      {/* 冻结表头条：默认隐藏，滚动越过表头底缘后出现，横向随滚动条平移 */}
      {headRow >= 0 && rows.length > headRow + 1 && (
        <div
          ref={headStripRef}
          className="np-pv-sheet-headstrip"
          style={{ height: headBottom, display: "none" }}
          aria-hidden
        >
          <div
            className="np-pv-sheet-inner"
            style={{
              width: Math.max(totalWidth, 0),
              gridTemplateColumns: effWidths.map((w) => `${w}px`).join(" "),
              gridTemplateRows: rowHeights
                ? rowHeights.slice(0, headRow + 1).map((h) => `${h}px`).join(" ")
                : Array.from({ length: headRow + 1 })
                    .map(() => `${DENSITY.rowH}px`)
                    .join(" "),
            }}
          >
            {headStripCells}
          </div>
        </div>
      )}
      <div className="np-pv-sheet-vp">
        <div
          ref={scrollRef}
          className="np-pv-sheet-scroll"
          tabIndex={0}
          onScroll={onSheetScroll}
          onKeyDown={onKeyDown}
        >
          {rows.length === 0 ? (
            <div className="np-pv-empty">{t("（空工作表）")}</div>
          ) : (
            <div
              ref={gridRef}
              className={`np-pv-sheet-inner${rowMode !== "single" ? " is-wrap" : ""}`}
              style={{
                height: virtualizer.getTotalSize(),
                width: Math.max(totalWidth, 0),
                gridTemplateColumns: effWidths.map((w) => `${w}px`).join(" "),
                // 多行档：显式行轨道（虚拟行不渲染但轨道占位，合并区跨行高度正确）
                gridTemplateRows: rowHeights
                  ? rowHeights.map((h) => `${h}px`).join(" ")
                  : undefined,
              }}
            >
              {cells}
              {handles}
            </div>
          )}
        </div>
        {/* 冻结首列：左缘钉住标识列（总宽超视口才挂载），纵向随滚动 transform 平移 */}
        {frozenW > 0 && (
          <div className="np-pv-sheet-frozen" style={{ width: frozenW }} aria-hidden>
            <div
              ref={frozenRef}
              className={`np-pv-sheet-inner${rowMode !== "single" ? " is-wrap" : ""}`}
              style={{
                width: frozenW,
                gridTemplateColumns: `${frozenW}px`,
                gridTemplateRows: rowHeights
                  ? rowHeights.map((h) => `${h}px`).join(" ")
                  : undefined,
              }}
            >
              {frozenCells}
            </div>
          </div>
        )}
        {/* 单元格详情浮层（强霜家族）：Enter/双击开启，Esc 关闭，滚动即收 */}
        {popover && (
          <div
            className="np-pv-sheet-detail"
            role="dialog"
            aria-label={t("单元格内容详情")}
            style={{ left: popover.left, top: popover.top }}
          >
            <div className="np-pv-sheet-detail-head">
              <span className="np-pv-sheet-detail-a1">
                {sheetA1(popover.r + trimmed.rowOffset, popover.c + trimmed.colOffset)}
              </span>
              <Button
                minimal
                small
                icon={ic(Copy)}
                text={copied ? t("已复制") : t("复制")}
                onClick={copySel}
              />
              <Button
                minimal
                small
                icon={ic(X)}
                aria-label={t("关闭")}
                onClick={() => setPopover(null)}
              />
            </div>
            <div className="np-pv-sheet-detail-body">{rows[popover.r]?.[popover.c] ?? ""}</div>
          </div>
        )}
      </div>
      {sections.length > 1 && (
        <div className="np-pv-sheet-tabs">
          {sections.map((s, i) => (
            <button
              key={s.title + i}
              className={`np-pv-sheet-chip ${i === active ? "is-active" : ""}`}
              onClick={() => setActive(i)}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
