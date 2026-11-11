// 待处理清单共享组件（§4.9 三段式之①，2026-11-03 抽出共用）：
// 参数对话框（PDF 合并/加水印/图片五件套/Excel 合并/通用合并等）的置顶
// 文件清单——默认按名称自然序，行可拖动调整处理顺序（Pointer 事件实现：
// 应用窗口注册了 OLE 拖放，HTML5 DnD 事件被拦截不可用）。
// 原实现驻 ToolsDialogs（2026-10-22），图片对话框对齐 §4.9 时抽出避免循环依赖。
import { useRef } from "react";
import { GripVertical } from "lucide-react";

import type { FileEntry } from "../lib/ipc";
import { useT } from "../lib/i18n";
import { AppIcon } from "./AppIcon";
import { DENSITY } from "../lib/tokens";

/** 文件名（去路径）与名称自然序比较器（数字感知，1 → 2 → 10）——
 *  合并与加水印等对话框的待处理清单共用 */
export const nameOf = (p: string) => p.slice(p.lastIndexOf("\\") + 1);
const NAME_COLLATOR = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base",
});

/** 按名称自然序初始化待处理清单（§4.9 置顶清单的默认顺序） */
export function pathsByNames(entries: FileEntry[]): string[] {
  return entries
    .map((e) => e.path)
    .sort((a, b) => NAME_COLLATOR.compare(nameOf(a), nameOf(b)));
}

/** 可拖动排序的待处理文件清单：把手指针拖拽实时换行，
 *  行 = 把手 + 文件名省略 + 右侧序号；容器 np-pdfmlist surface-2 限高滚动 */
export function DragFileList({
  items,
  onChange,
}: {
  items: string[];
  onChange(update: (items: string[]) => string[]): void;
}) {
  const t2 = useT();
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<number | null>(null);

  /** 指针拖拽：按下把手捕获指针，移动时按行中点实时换位（矩形每次现查，
   *  换位后行序即新序），松手收尾 */
  function beginRowDrag(e: React.PointerEvent, idx: number) {
    if (e.button !== 0 || !listRef.current) return;
    e.preventDefault();
    dragFrom.current = idx;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (dragFrom.current === null || !listRef.current) return;
      const rows = Array.from(
        listRef.current.querySelectorAll<HTMLElement>("[data-row]"),
      );
      let target = rows.length - 1;
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          target = i;
          break;
        }
      }
      if (target !== dragFrom.current) {
        const from = dragFrom.current;
        onChange((arr) => {
          const next = [...arr];
          const [it] = next.splice(from, 1);
          next.splice(target, 0, it);
          return next;
        });
        dragFrom.current = target;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragFrom.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div className="np-pdfmlist" ref={listRef}>
      {items.map((p, i) => (
        <div key={p} data-row={i} className="np-pdfmlist-item" title={p}>
          <span
            className="np-pdfmlist-grip"
            data-tip={t2("拖动调整顺序")}
            onPointerDown={(e) => beginRowDrag(e, i)}
          >
            <AppIcon icon={GripVertical} size={DENSITY.iconXs} />
          </span>
          <span className="np-ellipsis np-pdfmlist-name">{nameOf(p)}</span>
          <span className="np-pdfmlist-pos">{i + 1}</span>
        </div>
      ))}
    </div>
  );
}

/** §4.9 三段式之①的完整分区：标题行（标题 + 排序说明）+ 可拖动清单 */
export function QueueSection({
  title,
  items,
  onChange,
}: {
  /** 分区标题（处理顺序 / 合并顺序 / 拼合顺序 …） */
  title: string;
  items: string[];
  onChange(update: (items: string[]) => string[]): void;
}) {
  const t2 = useT();
  return (
    <>
      <div className="np-pdfmsec">
        <span className="np-bren-k">{title}</span>
        <span className="np-dialog-muted">
          {t2("默认按名称排序（数字感知），拖动行可调整顺序")}
        </span>
      </div>
      <DragFileList items={items} onChange={onChange} />
    </>
  );
}
