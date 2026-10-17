// 快速预览类型路由（纯函数，模式同 fileIcons.ts）：扩展名 → 预览类型。
// M1 支持：图片/媒体/文本/Markdown/字体/office 文本抽取 + 兜底卡；
// pdf 归入 fallback（M2 接 pdf.js 时改此处映射即可）。

export type PreviewKind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "markdown"
  | "officeDoc"
  | "officeSheet"
  | "officeSlides"
  | "epub"
  | "archive"
  | "font"
  | "fallback";

const MAP: Record<string, PreviewKind> = {
  // 图片（WebView2 内置解码）
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  ico: "image",
  avif: "image",
  // TIFF：Rust 端 tiff crate 解码转 PNG data URL（WebView2 不内置 TIFF 解码）
  tif: "image",
  tiff: "image",
  // 视频 / 音频（HTML5 media；冷门编码由 onError 回落兜底卡）
  mp4: "video",
  webm: "video",
  mkv: "video",
  mov: "video",
  m4v: "video",
  avi: "video", // 容器试探：Chromium 部分编码可解，失败走 onError 兜底
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  flac: "audio",
  m4a: "audio",
  aac: "audio",
  // PDF（M2：pdf.js）
  pdf: "pdf",
  // 文本 / 代码（HTML 一律按文本显示，不渲染不可信内容）
  txt: "text",
  log: "text",
  text: "text",
  json: "text",
  xml: "text",
  ini: "text",
  cfg: "text",
  conf: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  csv: "text",
  tsv: "text",
  html: "text",
  htm: "text",
  ts: "text",
  tsx: "text",
  js: "text",
  jsx: "text",
  rs: "text",
  py: "text",
  c: "text",
  h: "text",
  cpp: "text",
  hpp: "text",
  java: "text",
  go: "text",
  rb: "text",
  php: "text",
  sh: "text",
  bat: "text",
  ps1: "text",
  css: "text",
  sql: "text",
  // Markdown
  md: "markdown",
  markdown: "markdown",
  // 电子书：Rust 端 epub 章节抽取（复用 zip + XML 基建）
  epub: "epub",
  // office 文本抽取（Rust 端 preview_extract_office）
  docx: "officeDoc",
  docm: "officeDoc",
  xlsx: "officeSheet",
  xlsm: "officeSheet",
  xlsb: "officeSheet",
  xls: "officeSheet",
  ods: "officeSheet",
  pptx: "officeSlides",
  pptm: "officeSlides",
  // 压缩包清单（Rust 端 preview_list_archive；rar 许可证不合 §8 不支持）
  zip: "archive",
  tar: "archive",
  tgz: "archive",
  "7z": "archive",
  // 单文件压缩：清单卡显示内层文件名 + 解压后大小（bz2 格式不存大小）
  gz: "archive",
  xz: "archive",
  bz2: "archive",
  // 字体（FontFace API 字样预览）
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  ttc: "font",
};

/** 扩展名 → 预览类型；无扩展名 / 点开头文件 / 未知扩展名 → fallback 兜底卡 */
export function previewKind(name: string): PreviewKind {
  if (name.toLowerCase().endsWith(".tar.gz")) return "archive";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "fallback";
  return MAP[name.slice(dot + 1).toLowerCase()] ?? "fallback";
}

/** 预览类型徽标文案（footer/头部展示）。folder 不经 previewKind(name) 判定
 *  （那是按扩展名的纯函数），由调用方按 entry.isDir 直取 */
export const PREVIEW_LABELS: Record<PreviewKind, string> = {
  folder: "文件夹",
  image: "图片",
  video: "视频",
  audio: "音频",
  pdf: "PDF",
  text: "文本",
  markdown: "Markdown",
  officeDoc: "Word 文档",
  officeSheet: "电子表格",
  officeSlides: "演示文稿",
  epub: "电子书",
  archive: "压缩包",
  font: "字体",
  fallback: "文件",
};
