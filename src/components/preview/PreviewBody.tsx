// 预览主体（容器无关渲染核心）：QuickPreview 大浮层与全盘搜索内嵌面板共用。
// 持有取数状态与 kind 路由（text/office/TIFF 经 Rust，其余 asset protocol 直读）；
// 外壳（header 动作条 / footer / 键盘 / 选中同步）由宿主负责。
// 单条目生命周期：切换即弃用上一条目数据（reqId 竞态守卫 + FontFace/media 自清理）。

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Spinner } from "@blueprintjs/core";

import {
  api,
  type FileEntry,
  type OfficeTextResult,
  type PreviewTextResult,
} from "../../lib/ipc";
import { extOf } from "../../lib/fileIcons";
import { previewKind } from "../../lib/previewKind";
import { DENSITY } from "../../lib/tokens";
import type { PreviewSearchCtl } from "../../lib/previewSearch";
import { ArchivePreview } from "./ArchivePreview";
import { DocPreview } from "./DocPreview";
import { FallbackPreview } from "./FallbackPreview";
import { FolderPreview } from "./FolderPreview";
import { FontPreview } from "./FontPreview";
import { ImagePreview } from "./ImagePreview";
import { MediaPreview } from "./MediaPreview";
import { SheetPreview } from "./SheetPreview";

// PDF 渲染器懒加载：pdf.js（~1.5MB）独立分包，只在首次预览 PDF 时下载解析
const PdfPreview = lazy(() => import("./PdfPreview"));

export type PreviewLoad =
  | { stage: "loading" }
  | { stage: "error"; message: string }
  | { stage: "text"; data: PreviewTextResult }
  | { stage: "office"; data: OfficeTextResult };

/** 取数状态回传（宿主页脚 / 元信息展示用） */
export interface PreviewMeta {
  load: PreviewLoad;
  pdfPages: number | null;
  infoText: string | null;
}

/** 需要 Rust 取数据的类型；其余走 asset protocol 直读
 *  （email 复用 office 抽取管线；officeBinary 走专用转换通道不计入） */
export function needsPreviewLoad(kind: string): boolean {
  return (
    kind === "text" ||
    kind === "markdown" ||
    kind === "officeDoc" ||
    kind === "officeSheet" ||
    kind === "officeSlides" ||
    kind === "email" ||
    kind === "epub"
  );
}

export function PreviewBody({
  entry,
  rotateSignal = 0,
  onOpen,
  onReveal,
  onMeta,
  search,
  textWrap = true,
  emptyHint = "选择文件以预览",
}: {
  entry: FileEntry | null;
  rotateSignal?: number;
  onOpen(en: FileEntry): void;
  onReveal(en: FileEntry): void;
  onMeta?: (m: PreviewMeta) => void;
  /** 预览内查找控制通道（宿主搜索条；不传 = 无查找 UI） */
  search?: PreviewSearchCtl;
  /** 文本自动换行开关（宿主按钮切换） */
  textWrap?: boolean;
  emptyHint?: string;
}) {
  // 文件夹不按扩展名路由（previewKind 是名称纯函数）：isDir 直取 folder 卡
  const kind = entry ? (entry.isDir ? "folder" : previewKind(entry.name)) : "fallback";

  const [load, setLoad] = useState<PreviewLoad>({ stage: "loading" });
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [pdfPages, setPdfPages] = useState<number | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [tiffSrc, setTiffSrc] = useState<{ loading: boolean; url: string | null }>({
    loading: false,
    url: null,
  });
  // officeBinary（doc/ppt/pps）→ COM 转 PDF 通道
  const [binPdf, setBinPdf] = useState<{ loading: boolean; path: string | null }>({
    loading: false,
    path: null,
  });
  const reqRef = useRef(0);
  const tiffReq = useRef(0);

  // onMeta 经 ref 中转：宿主回传 setState 会导致回调身份每渲染必变，进 deps 死循环
  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;
  useEffect(() => {
    metaRef.current?.({ load, pdfPages, infoText });
  }, [load, pdfPages, infoText]);

  // 数据加载：文本/markdown → preview_read_text；office/email → preview_extract_office。
  // reqId 守卫：切换条目后旧响应直接丢弃
  useEffect(() => {
    setMediaError(null);
    setPdfPages(null);
    setInfoText(null);
    setTiffSrc({ loading: false, url: null });
    setBinPdf({ loading: false, path: null });
    setLoad({ stage: "loading" });
    if (!entry || !needsPreviewLoad(kind)) return;
    const req = ++reqRef.current;
    const p =
      kind === "text" || kind === "markdown"
        ? api
            .previewReadText(entry.path, DENSITY.previewTextMaxBytes)
            .then((data): PreviewLoad => {
              if (data.binary) throw new Error("二进制文件不支持按文本预览");
              return { stage: "text", data };
            })
        : api
            .previewExtractOffice(entry.path)
            .then((data): PreviewLoad => ({ stage: "office", data }));
    p.then((r) => {
      if (reqRef.current === req) setLoad(r);
    }).catch((err) => {
      if (reqRef.current === req) setLoad({ stage: "error", message: String(err) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.path, entry?.mtimeMs, kind]);

  // doc/ppt/pps → COM 转 PDF（缓存 %TEMP%/xdir_preview；需已装 Office/WPS）
  useEffect(() => {
    if (!entry || kind !== "officeBinary") return;
    const req = ++reqRef.current;
    setBinPdf({ loading: true, path: null });
    api
      .previewDocPdf(entry.path)
      .then((r) => {
        if (reqRef.current === req) setBinPdf({ loading: false, path: r.pdfPath });
      })
      .catch((err) => {
        if (reqRef.current === req) {
          setBinPdf({ loading: false, path: null });
          setMediaError(String(err));
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.path, entry?.mtimeMs, kind]);

  // TIFF：WebView2 无内置解码，Rust 解码转 PNG data URL
  useEffect(() => {
    if (!entry || kind !== "image") return;
    const ext = extOf(entry.name);
    if (ext !== "tif" && ext !== "tiff") return;
    const req = ++tiffReq.current;
    setTiffSrc({ loading: true, url: null });
    api
      .previewTiffDataUrl(entry.path)
      .then((url) => {
        if (tiffReq.current === req) setTiffSrc({ loading: false, url });
      })
      .catch((err) => {
        if (tiffReq.current === req) {
          setTiffSrc({ loading: false, url: null });
          setMediaError(String(err));
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.path, kind]);

  const body = () => {
    if (!entry) {
      return <div className="np-pv-none">{emptyHint}</div>;
    }
    // 错误兜底只认本条目的状态（load 在条目切换时已重置，无陈旧泄漏）
    const errNote =
      mediaError ??
      (load.stage === "error" ? load.message || "无法预览此文件" : undefined);
    if (errNote) {
      return (
        <FallbackPreview
          entry={entry}
          note={errNote}
          onOpen={() => onOpen(entry)}
          onReveal={() => onReveal(entry)}
        />
      );
    }
    switch (kind) {
      case "folder":
        return (
          <FolderPreview
            key={entry.path}
            entry={entry}
            onOpen={() => onOpen(entry)}
            onReveal={() => onReveal(entry)}
            onInfo={setInfoText}
          />
        );
      case "image": {
        const ext = extOf(entry.name);
        if (ext === "tif" || ext === "tiff") {
          if (tiffSrc.loading)
            return (
              <div className="np-pv-loading">
                <Spinner size={DENSITY.iconMd} />
              </div>
            );
          if (!tiffSrc.url) return null; // 解码失败已置 mediaError → 兜底卡
          return (
            <ImagePreview
              key={entry.path}
              src={tiffSrc.url}
              alt={entry.name}
              rotateSignal={rotateSignal}
              onError={() => setMediaError("TIFF 渲染失败")}
            />
          );
        }
        return (
          <ImagePreview
            key={entry.path}
            src={convertFileSrc(entry.path)}
            alt={entry.name}
            rotateSignal={rotateSignal}
            onError={() => setMediaError("图片解码失败，可能是不支持的格式")}
          />
        );
      }
      case "video":
      case "audio":
        return (
          <MediaPreview
            src={convertFileSrc(entry.path)}
            isAudio={kind === "audio"}
            onError={() => setMediaError("媒体解码失败，可能缺少对应解码器")}
          />
        );
      case "archive":
        return (
          <ArchivePreview
            key={entry.path}
            path={entry.path}
            onInfo={setInfoText}
            onError={(m) => setMediaError(m || "压缩包解析失败（格式不支持或文件损坏）")}
          />
        );
      case "font":
        return (
          <FontPreview
            src={convertFileSrc(entry.path)}
            onError={() => setMediaError("字体加载失败")}
          />
        );
      case "text":
      case "markdown":
      case "officeDoc":
      case "officeSheet":
      case "officeSlides":
      case "email":
      case "epub": {
        if (load.stage === "loading")
          return (
            <div className="np-pv-loading">
              <Spinner size={DENSITY.iconMd} />
            </div>
          );
        // 表格走专用虚拟网格（整幅铺满，多 sheet 切换条）
        if (kind === "officeSheet" && load.stage === "office")
          return (
            <SheetPreview key={entry.path} sections={load.data.sections} search={search} />
          );
        return (
          <DocPreview
            kind={kind}
            text={load.stage === "text" ? load.data : undefined}
            office={load.stage === "office" ? load.data : undefined}
            fileName={entry.name}
            search={search}
            textWrap={textWrap}
          />
        );
      }
      case "officeBinary": {
        // doc/ppt/pps → COM 转 PDF 通道（需已装 Office/WPS；结果缓存秒开）
        if (binPdf.loading)
          return (
            <div className="np-pv-none np-pv-converting">
              <Spinner size={DENSITY.iconMd} />
              <div>{t("正在转换为 PDF 预览…（首次转换需数秒，需已装 Office 或 WPS）")}</div>
            </div>
          );
        if (!binPdf.path) return null; // 失败已置 mediaError → 兜底卡
        return (
          <Suspense
            fallback={
              <div className="np-pv-loading">
                <Spinner size={DENSITY.iconMd} />
              </div>
            }
          >
            <PdfPreview
              url={convertFileSrc(binPdf.path)}
              onDocInfo={setPdfPages}
              onError={(m) => setMediaError(m || "转换后的 PDF 加载失败")}
              search={search}
            />
          </Suspense>
        );
      }
      case "pdf":
        return (
          <Suspense
            fallback={
              <div className="np-pv-loading">
                <Spinner size={DENSITY.iconMd} />
              </div>
            }
          >
            <PdfPreview
              // mtime 作查询参数缓存击穿：水印/压缩等旁写覆盖同名文件后，
              // 路径不变若 URL 也不变，pdf.js 会拿旧字节（改色不生效的假象）
              url={`${convertFileSrc(entry.path)}?v=${entry.mtimeMs}`}
              onDocInfo={setPdfPages}
              onError={(m) => setMediaError(m || "PDF 加载失败（加密或损坏的文件不支持预览）")}
              search={search}
            />
          </Suspense>
        );
      default:
        return (
          <FallbackPreview
            entry={entry}
            onOpen={() => onOpen(entry)}
            onReveal={() => onReveal(entry)}
          />
        );
    }
  };

  return <div className="np-pv-body">{body()}</div>;
}
