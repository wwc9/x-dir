// PDF 预览（M2）：pdf.js 渲染，TanStack Virtual 只画可见页（铁律：DOM 只有可见行）。
// 本组件经 React.lazy 动态加载 —— pdf.js（~1.5MB）独立分包，不影响冷启动；
// 文件经 asset protocol 直读，文档销毁随组件生命周期（切换/关闭即 destroy）。

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Spinner } from "@blueprintjs/core";

import { DENSITY } from "../../lib/tokens";

// pdf.js 主线程兜底极慢，必须显式指定 worker；?url 由构建器落成独立资源
let workerSrc: string | null = null;
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  if (!workerSrc) {
    workerSrc = worker.default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  return pdfjs;
}

export default function PdfPreview({
  url,
  onDocInfo,
  onError,
}: {
  url: string;
  /** 文档就绪后回报总页数（footer 展示） */
  onDocInfo(pages: number): void;
  onError(message: string): void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.414); // 首页宽高比估算（A4 竖版），measureElement 修正
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // 文档加载：asset protocol URL 直读；destroy 随生命周期
  useEffect(() => {
    let alive = true;
    let task: { destroy(): void } | null = null;
    setDoc(null);
    (async () => {
      const pdfjs = await loadPdfjs();
      if (!alive) return;
      const loading = pdfjs.getDocument({ url });
      task = loading;
      const d = await loading.promise;
      if (!alive) return; // 已卸载：cleanup 里的 loading.destroy() 会连带销毁文档
      const p1 = await d.getPage(1);
      const vp = p1.getViewport({ scale: 1 });
      setRatio(vp.height / vp.width);
      setDoc(d);
      onDocInfo(d.numPages);
    })().catch((err) => {
      if (alive) onError(String(err));
    });
    return () => {
      alive = false;
      task?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // 宽度测量：页面渲染宽 = 内容列宽
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  const virtualizer = useVirtualizer({
    count: doc?.numPages ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (width || 760) * ratio + PAGE_GAP,
    overscan: 2,
    getItemKey: (i) => i + 1,
  });

  return (
    <div ref={scrollRef} className="np-pv-pdf">
      {!doc ? (
        <div className="np-pv-loading">
          <Spinner size={DENSITY.iconMd} />
        </div>
      ) : (
        <div ref={innerRef} className="np-pv-pdf-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="np-pv-pdf-page"
              style={{ position: "absolute", insetInline: 0, transform: `translateY(${row.start}px)` }}
            >
              <PdfCanvas doc={doc} pageNum={row.index + 1} width={width || 760} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const PAGE_GAP = 10;

function PdfCanvas({
  doc,
  pageNum,
  width,
}: {
  doc: PDFDocumentProxy;
  pageNum: number;
  width: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let task: RenderTask | null = null;
    let alive = true;
    (async () => {
      const page = await doc.getPage(pageNum);
      const canvas = canvasRef.current;
      if (!alive || !canvas) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      // 画布按 devicePixelRatio 放大保证清晰，CSS 尺寸 = 逻辑宽
      const viewport = page.getViewport({ scale: scale * window.devicePixelRatio });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${Math.floor(base.height * scale)}px`;
      task = page.render({ canvas, viewport });
      await task.promise;
    })().catch(() => {
      /* 取消（滚动离屏/卸载）或单页损坏：保持现状即可 */
    });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [doc, pageNum, width]);

  return <canvas ref={canvasRef} />;
}
