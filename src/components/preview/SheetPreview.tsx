// 表格预览（V2 快速预览）：虚拟化网格——TanStack Virtual 行虚拟化（铁律：DOM 只有可见行），
// 单一 CSS grid 容器 + 格子显式行列定位（支持合并单元格：锚点格跨行跨列
// 展开、被覆盖格不渲染；跨行合并跟随锚点行显隐——锚点行不在可见区间时合并区不展示，
// 预览场景可接受）。多 sheet 走底部切换条（chips）。
// 2026-10-18：首行表头样式（加粗 + 冻结）、数值列右对齐（采样启发）、预览内查找
// （命中格高亮 + 滚动定位）。
// 2026-11-03：行高三档（单行省略 / 换行自适应 / 宽松留白）——多行档行高由
// lib/sheetGrid.sheetRowHeights 按列宽折行估算，经 gridTemplateRows 显式轨道
// 下发（合并区跨行高度 = 各行轨道之和仍正确），virtualizer 按同一数组估高。

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { OfficeSection } from "../../lib/ipc";
import {
  buildMergeMap,
  parseSheetRows,
  sheetColumnCount,
  sheetColumnWidths,
  sheetHeaderRow,
  sheetMatches,
  sheetNumericCols,
  sheetRowHeights,
  trimSheetEdges,
  type SheetRowMode,
} from "../../lib/sheetGrid";
import { Seg } from "../ImgDialogs";
import { DENSITY } from "../../lib/tokens";
import type { PreviewSearchCtl } from "../../lib/previewSearch";

const ROW_MODE_OPTS: { value: SheetRowMode; label: string; title: string }[] = [
  { value: "single", label: "单行", title: "行高固定，超长文本省略号（悬停看全文）" },
  { value: "wrap", label: "换行", title: "按内容自动调整行高，长文本完整展示（上限 6 行）" },
  { value: "relaxed", label: "宽松", title: "换行 + 更大留白，适合逐行细读" },
];

export function SheetPreview({
  sections,
  search,
}: {
  sections: OfficeSection[];
  search?: PreviewSearchCtl;
}) {
  const [active, setActive] = useState(0);
  // 行高模式（会话级，不持久化）：默认换行自适应（2026-11-03 用户定案——
  // 长文本格完整可读优先于紧凑恒高；单行省略/宽松仍可一键切换）
  const [rowMode, setRowMode] = useState<SheetRowMode>("wrap");
  const sec = sections[Math.min(active, sections.length - 1)];
  const baseRows = useMemo(() => parseSheetRows(sec.text), [sec.text]);
  const baseCols = useMemo(() => sheetColumnCount(baseRows), [baseRows]);
  // 边缘空行/空列裁剪（2026-11-24 表格预览增强）：样式化 used range 的装饰性
  // 空行空列会挤掉表头判定（is-head 指向空行）并占首屏视野；合并区随裁剪平移
  const trimmed = useMemo(
    () => trimSheetEdges(baseRows, baseCols, sec.merges ?? []),
    [baseRows, baseCols, sec.merges],
  );
  const rows = trimmed.rows;
  const colCount = trimmed.colCount;
  const headRow = useMemo(() => sheetHeaderRow(rows, colCount), [rows, colCount]);
  const colWidths = useMemo(() => sheetColumnWidths(rows, colCount), [rows, colCount]);
  const totalWidth = useMemo(() => colWidths.reduce((a, b) => a + b, 0), [colWidths]);
  const numericCols = useMemo(
    () => sheetNumericCols(rows, colCount, headRow >= 0 ? headRow + 1 : 0),
    [rows, colCount, headRow],
  );
  const merges = useMemo(
    () => buildMergeMap(trimmed.merges, rows.length, colCount),
    [trimmed.merges, rows.length, colCount],
  );
  const rowHeights = useMemo(
    () => (rowMode === "single" ? null : sheetRowHeights(rows, colWidths, rowMode)),
    [rowMode, rows, colWidths],
  );
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
  const onSheetScroll = () => {
    const el = scrollRef.current;
    const strip = headStripRef.current;
    if (!el || !strip || headRow < 0) return;
    strip.style.display = el.scrollTop > headBottom + 2 ? "block" : "none";
    strip.style.transform = `translateX(${-el.scrollLeft}px)`;
  };

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
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowHeights?.[i] ?? DENSITY.rowH,
    overscan: DENSITY.overscan,
  });
  // 行高模式切换 → 逐行高度数组变了，显式触发重测（estimateSize 换了身份但
  // virtualizer 缓存不自动失效）
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeights]);

  // 活动命中 → 滚动到所在行（居中）
  useEffect(() => {
    if (!matches.length || !search || search.active >= matches.length) return;
    virtualizer.scrollToIndex(matches[search.active].r, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search?.active, matches]);

  const cells: React.ReactNode[] = [];
  for (const vi of virtualizer.getVirtualItems()) {
    const r = vi.index;
    for (let c = 0; c < colCount; c++) {
      const k = `${r}:${c}`;
      if (merges.covered.has(k)) continue; // 被合并区覆盖：不渲染
      const anchor = merges.anchors.get(k);
      const text = rows[r][c] ?? "";
      // 表头 = 判定行及其上方（裁剪后行 0 通常即表头；带装饰标题的表带标题+列头两行）
      const isHead = headRow >= 0 && r <= headRow;
      const cls = [
        "np-pv-sheet-cell",
        r % 2 === 1 ? "is-even" : "",
        anchor ? "is-anchor" : "",
        isHead ? "is-head" : "",
        !isHead && numericCols[c] ? "is-num" : "",
        k === activeKey ? "is-hit-active" : hitSet.has(k) ? "is-hit" : "",
      ]
        .filter(Boolean)
        .join(" ");
      cells.push(
        <div
          key={k}
          className={cls}
          style={{
            gridColumn: `${c + 1} / span ${anchor?.colSpan ?? 1}`,
            gridRow: `${r + 1} / span ${anchor?.rowSpan ?? 1}`,
          }}
          title={text}
        >
          {text}
        </div>,
      );
    }
  }

  return (
    <div className="np-pv-sheet">
      <div className="np-pv-sheet-bar">
        <Seg
          value={rowMode}
          onChange={setRowMode}
          options={ROW_MODE_OPTS.map((o) => ({
            ...o,
            label: t(o.label),
            title: t(o.title),
          }))}
        />
      </div>
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
              gridTemplateColumns: colWidths.map((w) => `${w}px`).join(" "),
              gridTemplateRows: rowHeights
                ? rowHeights.slice(0, headRow + 1).map((h) => `${h}px`).join(" ")
                : Array.from({ length: headRow + 1 })
                    .map(() => `${DENSITY.rowH}px`)
                    .join(" "),
            }}
          >
            {Array.from({ length: headRow + 1 }).flatMap((_, r) =>
              Array.from({ length: colCount }).flatMap((_, c) => {
                const k = `${r}:${c}`;
                if (merges.covered.has(k)) return [];
                const anchor = merges.anchors.get(k);
                const text = rows[r][c] ?? "";
                return [
                  <div
                    key={k}
                    className="np-pv-sheet-cell is-head"
                    style={{
                      gridColumn: `${c + 1} / span ${anchor?.colSpan ?? 1}`,
                      gridRow: `${r + 1} / span ${anchor?.rowSpan ?? 1}`,
                    }}
                  >
                    {text}
                  </div>,
                ];
              }),
            )}
          </div>
        </div>
      )}
      <div ref={scrollRef} className="np-pv-sheet-scroll" onScroll={onSheetScroll}>
        {rows.length === 0 ? (
          <div className="np-pv-empty">{t("（空工作表）")}</div>
        ) : (
          <div
            className={`np-pv-sheet-inner${rowMode !== "single" ? " is-wrap" : ""}`}
            style={{
              height: virtualizer.getTotalSize(),
              width: Math.max(totalWidth, 0),
              gridTemplateColumns: colWidths.map((w) => `${w}px`).join(" "),
              // 多行档：显式行轨道（虚拟行不渲染但轨道占位，合并区跨行高度正确）
              gridTemplateRows: rowHeights
                ? rowHeights.map((h) => `${h}px`).join(" ")
                : undefined,
            }}
          >
            {cells}
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
