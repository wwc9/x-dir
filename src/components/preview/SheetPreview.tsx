// 表格预览（V2 快速预览）：虚拟化网格——TanStack Virtual 行虚拟化（铁律：DOM 只有可见行），
// CSS grid 列对齐 + 自适应列宽，多 sheet 走顶部切换条（chips）。

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { OfficeSection } from "../../lib/ipc";
import {
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DENSITY.rowH,
    overscan: DENSITY.overscan,
  });

  return (
    <div className="np-pv-sheet">
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
      <div ref={scrollRef} className="np-pv-sheet-scroll">
        {rows.length === 0 ? (
          <div className="np-pv-empty">（空工作表）</div>
        ) : (
          <div
            className="np-pv-sheet-inner"
            style={{ height: virtualizer.getTotalSize(), width: Math.max(totalWidth, 0) }}
          >
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                className="np-pv-sheet-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  height: row.size,
                  transform: `translateY(${row.start}px)`,
                  gridTemplateColumns: colWidths.map((w) => `${w}px`).join(" "),
                }}
              >
                {rows[row.index].map((cell, c) => (
                  <div key={c} className="np-pv-sheet-cell" title={cell}>
                    {cell}
                  </div>
                ))}
                {/* 参差行补齐空单元格，保持网格线连续 */}
                {Array.from({ length: colCount - rows[row.index].length }, (_, c) => (
                  <div key={`e${c}`} className="np-pv-sheet-cell" />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
