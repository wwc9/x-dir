// PDF 预览（M2 → 2026-10-18 增强）：pdf.js 渲染，TanStack Virtual 只画可见页
// （铁律：DOM 只有可见行）。本组件经 React.lazy 动态加载——pdf.js（~1.5MB）独立
// 分包，不影响冷启动；文件经 asset protocol 直读，文档销毁随组件生命周期。
// 增强：文本层（textLayer，页面文字可选中复制）、页码跳转输入、预览内查找
// （整册文本抽取 → 命中列表 → 滚动定位 + 页内 CSS Highlight 高亮）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import { Spinner } from "@blueprintjs/core";

import { DENSITY } from "../../lib/tokens";
import {
  collectTextNodes,
  findMatches,
  mapRanges,
  setGroupHighlights,
  clearGroupHighlights,
  type PreviewSearchCtl,
} from "../../lib/previewSearch";

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

/** 查找文本抽取页数上限（更大文档仅搜索前 N 页） */
const SEARCH_PAGE_CAP = 400;

export default function PdfPreview({
  url,
  onDocInfo,
  onError,
  search,
}: {
  url: string;
  /** 文档就绪后回报总页数（footer 展示） */
  onDocInfo(pages: number): void;
  onError(message: string): void;
  search?: PreviewSearchCtl;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.414); // 首页宽高比估算（A4 竖版），measureElement 修正
  const [width, setWidth] = useState(0);
  const [jump, setJump] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  /** 每页拍平文本（搜索用；null = 尚未抽取完成） */
  const pageTextsRef = useRef<string[] | null>(null);
  const [searchReady, setSearchReady] = useState(0);
  const term = search?.term ?? "";

  // 文档加载：asset protocol URL 直读；destroy 随生命周期
  useEffect(() => {
    let alive = true;
    let task: { destroy(): void } | null = null;
    setDoc(null);
    pageTextsRef.current = null;
    setSearchReady(0);
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
      // 后台抽取每页文本（查找用）：超长文档截到 SEARCH_PAGE_CAP
      const cap = Math.min(d.numPages, SEARCH_PAGE_CAP);
      const texts: string[] = [];
      for (let i = 1; i <= cap; i++) {
        if (!alive) return;
        const page = await d.getPage(i);
        const tc = await page.getTextContent();
        texts.push(
          tc.items
            .map((it) =>
              "str" in it ? it.str + ("hasEOL" in it && it.hasEOL ? "\n" : "") : "",
            )
            .join(""),
        );
      }
      if (!alive) return;
      pageTextsRef.current = texts;
      setSearchReady((n) => n + 1);
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

  // 命中列表：每页文本匹配 + 页前缀累计（全局活动序号 → 页 + 页内序号）
  const matches = useMemo(() => {
    void searchReady; // 文本抽取完成后重算
    const texts = pageTextsRef.current;
    if (!term || !texts) return [] as { page: number; occ: number }[];
    const out: { page: number; occ: number }[] = [];
    for (let p = 0; p < texts.length && out.length < 2000; p++) {
      for (const _ of findMatches(texts[p], term, 2000 - out.length)) {
        out.push({ page: p + 1, occ: out.length });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, searchReady]);

  useEffect(() => {
    search?.onTotal(matches.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches.length]);

  const virtualizer = useVirtualizer({
    count: doc?.numPages ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (width || 760) * ratio + PAGE_GAP,
    overscan: 2,
    getItemKey: (i) => i + 1,
  });

  // 活动命中 → 跳页
  const activeMatch =
    search && matches.length ? matches[Math.min(search.active, matches.length - 1)] : null;
  useEffect(() => {
    if (!activeMatch) return;
    virtualizer.scrollToIndex(activeMatch.page - 1, { align: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMatch?.page, search?.active]);

  function jumpTo() {
    const n = Number.parseInt(jump, 10);
    if (!Number.isFinite(n) || !doc) return;
    const target = Math.min(Math.max(n, 1), doc.numPages);
    virtualizer.scrollToIndex(target - 1, { align: "start" });
    setJump("");
  }

  // 命中的页前缀（页 → 该页之前累计命中数），页内高亮判定活动命中用
  const pageOffsets = useMemo(() => {
    const offsets = new Map<number, number>();
    let prev = -1;
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].page !== prev) {
        offsets.set(matches[i].page, i);
        prev = matches[i].page;
      }
    }
    return offsets;
  }, [matches]);

  return (
    <div ref={scrollRef} className="np-pv-pdf">
      {!doc ? (
        <div className="np-pv-loading">
          <Spinner size={DENSITY.iconMd} />
        </div>
      ) : (
        <>
          <div
            ref={innerRef}
            className="np-pv-pdf-inner"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="np-pv-pdf-page"
                style={{ position: "absolute", insetInline: 0, transform: `translateY(${row.start}px)` }}
              >
                <PdfCanvas
                  doc={doc}
                  pageNum={row.index + 1}
                  width={width || 760}
                  term={term}
                  globalOffset={pageOffsets.get(row.index + 1) ?? -1}
                  activeGlobal={search && matches.length ? Math.min(search.active, matches.length - 1) : -1}
                />
                {/* 页码隔断（2026-10-17 定稿放页尾）：第 N 页，共 M 页 */}
                <div className="np-pv-pdf-pagemark">
                  <span className="np-pv-pdf-pagemark-line" />
                  第 {row.index + 1} 页，共 {doc.numPages} 页
                  <span className="np-pv-pdf-pagemark-line" />
                </div>
              </div>
            ))}
          </div>
          <div className="np-pv-pdf-jump">
            <input
              className="np-pv-pdf-jump-input"
              value={jump}
              placeholder={`1-${doc.numPages}`}
              onChange={(e) => setJump(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") jumpTo();
                e.stopPropagation();
              }}
            />
            <span>/ {doc.numPages}</span>
          </div>
        </>
      )}
    </div>
  );
}

const PAGE_GAP = 10;

function PdfCanvas({
  doc,
  pageNum,
  width,
  term,
  globalOffset,
  activeGlobal,
}: {
  doc: PDFDocumentProxy;
  pageNum: number;
  width: number;
  term: string;
  /** 本页首个命中的全局序号（-1 = 本页无命中） */
  globalOffset: number;
  activeGlobal: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [layerReady, setLayerReady] = useState(0);

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

  // 文本层：页面文字可选中复制；滚动离屏随组件销毁
  useEffect(() => {
    let alive = true;
    let tl: TextLayer | null = null;
    setLayerReady(0);
    (async () => {
      const pdfjs = await loadPdfjs();
      const page = await doc.getPage(pageNum);
      const layer = layerRef.current;
      if (!alive || !layer) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      layer.textContent = "";
      tl = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport,
      });
      await tl.render();
      if (!alive) return;
      setLayerReady((n) => n + 1);
    })().catch(() => {
      /* 文本层失败不影响画面渲染 */
    });
    return () => {
      alive = false;
      tl?.cancel();
    };
  }, [doc, pageNum, width]);

  // 页内查找高亮：文本层节点扫描 + CSS Highlight API（按页分组，页间不互覆盖）；
  // 活动命中单独色
  useEffect(() => {
    const layer = layerRef.current;
    const group = `pdf-${pageNum}`;
    if (!layer) return;
    if (!term || globalOffset < 0) {
      clearGroupHighlights(group);
      return;
    }
    const nodes = collectTextNodes(layer);
    const nodeTexts = nodes.map((n) => n.nodeValue ?? "");
    const hits = findMatches(nodeTexts.join(""), term);
    const ranges = mapRanges(nodeTexts, hits, term);
    const normal: Range[] = [];
    const active: Range[] = [];
    for (const r of ranges) {
      const range = document.createRange();
      range.setStart(nodes[r.node], r.start);
      range.setEnd(nodes[r.node], r.end);
      (globalOffset + r.match === activeGlobal ? active : normal).push(range);
    }
    setGroupHighlights(group, normal, active);
    return () => clearGroupHighlights(group);
  }, [term, globalOffset, activeGlobal, layerReady, width, pageNum]);

  return (
    <div className="np-pv-pdf-viewport">
      <canvas ref={canvasRef} />
      <div ref={layerRef} className="textLayer" />
    </div>
  );
}
