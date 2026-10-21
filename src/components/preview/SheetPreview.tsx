// 表格预览（V2 快速预览）：虚拟化网格——TanStack Virtual 行虚拟化（铁律：DOM 只有可见行），
// 单一 CSS grid 容器 + 格子显式行列定位（支持合并单元格：锚点格跨行跨列
// 展开、被覆盖格不渲染；跨行合并跟随锚点行显隐——锚点行不在可见区间时合并区不展示，
// 预览场景可接受）。多 sheet 走底部切换条（chips）。
// 2026-10-18：首行表头样式（加粗 + 冻结）、数值列右对齐（采样启发）、预览内查找
// （命中格高亮 + 滚动定位）。

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { OfficeSection } from "../../lib/ipc";
import {
  buildMergeMap,
  parseSheetRows,
  sheetColumnCount,
  sheetColumnWidths,
  sheetMatches,
  sheetNumericCols,
} from "../../lib/sheetGrid";
import { DENSITY } from "../../lib/tokens";
import type { PreviewSearchCtl } from "../../lib/previewSearch";

export function SheetPreview({
  sections,
  search,
}: {
  sections: OfficeSection[];
  search?: PreviewSearchCtl;
}) {
  const [active, setActive] = useState(0);
  const sec = sections[Math.min(active, sections.length - 1)];
  const rows = useMemo(() => parseSheetRows(sec.text), [sec.text]);
  const colCount = useMemo(() => sheetColumnCount(rows), [rows]);
  const colWidths = useMemo(() => sheetColumnWidths(rows, colCount), [rows, colCount]);
  const totalWidth = useMemo(() => colWidths.reduce((a, b) => a + b, 0), [colWidths]);
  const numericCols = useMemo(
    () => sheetNumericCols(rows, colCount),
    [rows, colCount],
  );
  const merges = useMemo(
    () => buildMergeMap(sec.merges ?? [], rows.length, colCount),
    [sec.merges, rows.length, colCount],
  );

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
    estimateSize: () => DENSITY.rowH,
    overscan: DENSITY.overscan,
  });

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
      const isHead = r === 0 && rows.length > 1;
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
      <div ref={scrollRef} className="np-pv-sheet-scroll">
        {rows.length === 0 ? (
          <div className="np-pv-empty">{t("（空工作表）")}</div>
        ) : (
          <div
            className="np-pv-sheet-inner"
            style={{
              height: virtualizer.getTotalSize(),
              width: Math.max(totalWidth, 0),
              gridTemplateColumns: colWidths.map((w) => `${w}px`).join(" "),
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
