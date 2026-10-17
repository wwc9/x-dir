// 表格预览（V2 快速预览）：虚拟化网格——TanStack Virtual 行虚拟化（铁律：DOM 只有可见行），
// 单一 CSS grid 容器 + 格子显式行列定位（2026-10-17 起支持合并单元格：锚点格跨行跨列
// 展开、被覆盖格不渲染；跨行合并跟随锚点行显隐——锚点行不在可见区间时合并区不展示，
// 预览场景可接受）。多 sheet 走底部切换条（chips，2026-10-17 自顶部移入）。

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { OfficeSection } from "../../lib/ipc";
import {
  buildMergeMap,
  parseSheetRows,
  sheetColumnCount,
  sheetColumnWidths,
} from "../../lib/sheetGrid";
import { DENSITY } from "../../lib/tokens";

export function SheetPreview({ sections }: { sections: OfficeSection[] }) {
  const [active, setActive] = useState(0);
  const sec = sections[Math.min(active, sections.length - 1)];
  const rows = useMemo(() => parseSheetRows(sec.text), [sec.text]);
  const colCount = useMemo(() => sheetColumnCount(rows), [rows]);
  const colWidths = useMemo(() => sheetColumnWidths(rows, colCount), [rows, colCount]);
  const totalWidth = useMemo(() => colWidths.reduce((a, b) => a + b, 0), [colWidths]);
  const merges = useMemo(
    () => buildMergeMap(sec.merges ?? [], rows.length, colCount),
    [sec.merges, rows.length, colCount],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DENSITY.rowH,
    overscan: DENSITY.overscan,
  });

  const cells: React.ReactNode[] = [];
  for (const vi of virtualizer.getVirtualItems()) {
    const r = vi.index;
    for (let c = 0; c < colCount; c++) {
      const k = `${r}:${c}`;
      if (merges.covered.has(k)) continue; // 被合并区覆盖：不渲染
      const anchor = merges.anchors.get(k);
      const text = rows[r][c] ?? "";
      cells.push(
        <div
          key={k}
          className={`np-pv-sheet-cell${r % 2 === 1 ? " is-even" : ""}${
            anchor ? " is-anchor" : ""
          }`}
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
          <div className="np-pv-empty">（空工作表）</div>
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
