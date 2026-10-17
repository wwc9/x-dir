// 扩展名 → Lucide 图标映射（AGENTS.md §4.5：图标选型唯一来源，禁止散落硬编码）。
// 2026-10-15 扩充：覆盖市面常见格式（代码/配置/办公/图片/RAW/音频/视频/字幕/
// 压缩/镜像/安装包/字体/数据库/证书/备份），常见格式各配专属图标（同类同色、
// 图标按语义细分），分类常量 + 分组类型名，配单测；
// 预览页由 tools/gen-file-icon-preview.mjs 从本文件生成（单一数据源）。
import {
  ALargeSmall,
  AppWindow,
  Box,
  Camera,
  Captions,
  Coffee,
  Cog,
  CodeXml,
  Container,
  Database,
  Disc3,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileClock,
  FileVideo,
  Folder,
  GitBranch,
  Hammer,
  HardDrive,
  ListMusic,
  Mail,
  Magnet,
  Music,
  NotebookPen,
  NotebookText,
  Package,
  Palette,
  PenTool,
  Piano,
  Presentation,
  Scale,
  ScrollText,
  SquareTerminal,
  Timer,
  type LucideIcon,
} from "lucide-react";

export interface FileIconSpec {
  icon: LucideIcon;
  /** 值为 index.css 的 --np-icon-* 变量名（不含 var() 包装） */
  colorVar: string;
}

const FOLDER: FileIconSpec = { icon: Folder, colorVar: "--np-icon-folder" };
const DRIVE: FileIconSpec = { icon: HardDrive, colorVar: "--np-icon-drive" };
const GENERIC: FileIconSpec = { icon: File, colorVar: "--np-icon-generic" };

// ── 分类常量（同类同色；常见格式按语义各配专属图标）──────────────────
// 代码（青）
const CODE = { icon: FileCode, colorVar: "--np-icon-code" };
const CODE_JSON = { icon: FileJson, colorVar: "--np-icon-code" };
const CODE_COG = { icon: FileCog, colorVar: "--np-icon-code" };
const CODE_STYLE = { icon: Palette, colorVar: "--np-icon-code" };
const CODE_SHELL = { icon: SquareTerminal, colorVar: "--np-icon-code" };
const CODE_MARKUP = { icon: CodeXml, colorVar: "--np-icon-code" };
const CODE_DB = { icon: Database, colorVar: "--np-icon-code" };
const CODE_NOTEBOOK = { icon: NotebookPen, colorVar: "--np-icon-code" };
const CODE_BUILD = { icon: Hammer, colorVar: "--np-icon-code" };
const CODE_GIT = { icon: GitBranch, colorVar: "--np-icon-code" };
// 文本（灰）
const TEXT = { icon: FileText, colorVar: "--np-icon-text" };
const TEXT_MD = { icon: NotebookText, colorVar: "--np-icon-text" };
const TEXT_LOG = { icon: ScrollText, colorVar: "--np-icon-text" };
const TEXT_MAIL = { icon: Mail, colorVar: "--np-icon-text" };
const TEXT_SCALE = { icon: Scale, colorVar: "--np-icon-text" };
const TEXT_BACKUP = { icon: FileClock, colorVar: "--np-icon-generic" };
const TEXT_TIMER = { icon: Timer, colorVar: "--np-icon-generic" };
// PDF / 办公 / 表格
const PDF = { icon: FileText, colorVar: "--np-icon-pdf" };
const DOC = { icon: FileText, colorVar: "--np-icon-doc" };
const SLIDE = { icon: Presentation, colorVar: "--np-icon-slide" };
const SHEET = { icon: FileSpreadsheet, colorVar: "--np-icon-table" };
// 图片（蓝）
const IMAGE = { icon: FileImage, colorVar: "--np-icon-image" };
const IMAGE_RAW = { icon: Camera, colorVar: "--np-icon-image" };
const IMAGE_DESIGN = { icon: PenTool, colorVar: "--np-icon-image" };
const IMAGE_3D = { icon: Box, colorVar: "--np-icon-image" };
// 音频（紫）
const AUDIO = { icon: Music, colorVar: "--np-icon-audio" };
const AUDIO_PIANO = { icon: Piano, colorVar: "--np-icon-audio" };
const AUDIO_LIST = { icon: ListMusic, colorVar: "--np-icon-audio" };
// 视频（红）
const VIDEO = { icon: FileVideo, colorVar: "--np-icon-video" };
const VIDEO_SUB = { icon: Captions, colorVar: "--np-icon-video" };
// 压缩（橙）
const ARCHIVE = { icon: FileArchive, colorVar: "--np-icon-archive" };
const ARCHIVE_DISC = { icon: Disc3, colorVar: "--np-icon-archive" };
const ARCHIVE_VDISK = { icon: HardDrive, colorVar: "--np-icon-archive" };
const ARCHIVE_TORRENT = { icon: Magnet, colorVar: "--np-icon-archive" };
// 可执行（紫罗兰）
const EXE = { icon: AppWindow, colorVar: "--np-icon-exe" };
const EXE_PKG = { icon: Package, colorVar: "--np-icon-exe" };
const EXE_JAVA = { icon: Coffee, colorVar: "--np-icon-exe" };
const EXE_SYS = { icon: Cog, colorVar: "--np-icon-exe" };
const EXE_TERM = { icon: FileTerminal, colorVar: "--np-icon-exe" };
const EXE_CONTAINER = { icon: Container, colorVar: "--np-icon-exe" };
const EXE_BUILD = { icon: Hammer, colorVar: "--np-icon-exe" };
const CERT = { icon: FileKey, colorVar: "--np-icon-exe" };
const FONT = { icon: ALargeSmall, colorVar: "--np-icon-font" };
// 数据库（青，与代码同族）
const EXE_DB = { icon: Database, colorVar: "--np-icon-code" };

/** 扩展名 → 图标（键 = 小写扩展名，不含点；插入顺序即预览分组顺序） */
export const BY_EXT: Record<string, FileIconSpec> = {
  // ── 源码（FileCode）──
  rs: CODE, py: CODE, pyw: CODE, js: CODE, mjs: CODE, cjs: CODE,
  jsx: CODE, ts: CODE, mts: CODE, cts: CODE, tsx: CODE,
  c: CODE, h: CODE, cpp: CODE, cc: CODE, cxx: CODE, hpp: CODE, hh: CODE,
  cs: CODE, go: CODE, java: CODE, kt: CODE, kts: CODE, scala: CODE,
  rb: CODE, php: CODE, phtml: CODE, pl: CODE, pm: CODE, lua: CODE,
  dart: CODE, swift: CODE, zig: CODE, v: CODE, nim: CODE,
  ex: CODE, exs: CODE, erl: CODE, hrl: CODE, hs: CODE, lhs: CODE,
  ml: CODE, mli: CODE, fs: CODE, fsx: CODE, fsi: CODE,
  elm: CODE, clj: CODE, cljs: CODE, cljc: CODE, edn: CODE,
  jl: CODE, r: CODE, vb: CODE, pas: CODE, d: CODE,
  asm: CODE, nasm: CODE, s: CODE, coffee: CODE, cof: CODE,
  graphql: CODE, gql: CODE, proto: CODE,
  // ── 标记语言（CodeXml）──
  html: CODE_MARKUP, htm: CODE_MARKUP, xhtml: CODE_MARKUP,
  vue: CODE_MARKUP, svelte: CODE_MARKUP, astro: CODE_MARKUP,
  // ── 样式（Palette）──
  css: CODE_STYLE, scss: CODE_STYLE, sass: CODE_STYLE, less: CODE_STYLE,
  styl: CODE_STYLE, pcss: CODE_STYLE,
  // ── 数据库查询（Database）──
  sql: CODE_DB,
  // ── 构建脚本（Hammer）──
  gradle: CODE_BUILD, cmake: CODE_BUILD, mk: CODE_BUILD,
  // ── 笔记本（NotebookPen）──
  ipynb: CODE_NOTEBOOK, rmd: CODE_NOTEBOOK,
  // ── 配置（FileCog）──
  json: CODE_JSON, jsonc: CODE_JSON, json5: CODE_JSON,
  toml: CODE_COG, yaml: CODE_COG, yml: CODE_COG, ini: CODE_COG,
  cfg: CODE_COG, conf: CODE_COG, env: CODE_COG, properties: CODE_COG,
  lock: CODE_COG, plist: CODE_COG,
  // ── 版本控制（GitBranch）──
  gitignore: CODE_GIT, gitattributes: CODE_GIT,
  gitmodules: CODE_GIT,
  // ── Shell（SquareTerminal，开发侧）──
  sh: CODE_SHELL, bash: CODE_SHELL, zsh: CODE_SHELL, fish: CODE_SHELL,
  ksh: CODE_SHELL,
  // ── 文本 / 标记 / 邮件 ──
  txt: TEXT, nfo: TEXT, rst: TEXT, adoc: TEXT, org: TEXT, man: TEXT,
  md: TEXT_MD, markdown: TEXT_MD, mdx: TEXT_MD,
  log: TEXT_LOG, bib: TEXT_LOG,
  eml: TEXT_MAIL,
  // ── PDF ──
  pdf: PDF,
  // ── 办公文档（Word 族）──
  doc: DOC, docx: DOC, docm: DOC, dot: DOC, dotx: DOC, dotm: DOC,
  odt: DOC, ott: DOC, fodt: DOC, rtf: DOC, pages: DOC, wps: DOC,
  wpd: DOC, abw: DOC, msg: DOC,
  // ── 演示文稿 ──
  ppt: SLIDE, pptx: SLIDE, pptm: SLIDE, pot: SLIDE, potx: SLIDE, potm: SLIDE,
  pps: SLIDE, ppsx: SLIDE, ppsm: SLIDE, odp: SLIDE, fodp: SLIDE, otp: SLIDE,
  thmx: SLIDE,
  // ── 表格 ──
  xls: SHEET, xlsx: SHEET, xlsm: SHEET, xlsb: SHEET, xlt: SHEET,
  xltx: SHEET, xltm: SHEET, xlam: SHEET, ods: SHEET, fods: SHEET, ots: SHEET,
  csv: SHEET, tsv: SHEET, numbers: SHEET, et: SHEET, dbf: SHEET,
  // ── 图片 ──
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, jfif: IMAGE, jif: IMAGE,
  gif: IMAGE, webp: IMAGE, bmp: IMAGE, dib: IMAGE, svg: IMAGE, svgz: IMAGE,
  ico: IMAGE, icns: IMAGE, cur: IMAGE,
  tif: IMAGE, tiff: IMAGE, heic: IMAGE, heif: IMAGE, hif: IMAGE,
  avif: IMAGE, jp2: IMAGE, jpx: IMAGE, j2k: IMAGE, jxl: IMAGE,
  pnm: IMAGE, ppm: IMAGE, pgm: IMAGE, pbm: IMAGE, pfm: IMAGE,
  tga: IMAGE, pcx: IMAGE, exr: IMAGE, hdr: IMAGE,
  // ── 相机 RAW（Camera）──
  dng: IMAGE_RAW, cr2: IMAGE_RAW, cr3: IMAGE_RAW, nef: IMAGE_RAW,
  arw: IMAGE_RAW, orf: IMAGE_RAW, rw2: IMAGE_RAW, raf: IMAGE_RAW,
  srw: IMAGE_RAW, pef: IMAGE_RAW,
  // ── 设计源文件（PenTool）──
  psd: IMAGE_DESIGN, psb: IMAGE_DESIGN, ai: IMAGE_DESIGN, eps: IMAGE_DESIGN,
  sketch: IMAGE_DESIGN, fig: IMAGE_DESIGN, xcf: IMAGE_DESIGN,
  cdr: IMAGE_DESIGN, drawio: IMAGE_DESIGN,
  // ── 3D 模型（Box）──
  obj: IMAGE_3D, stl: IMAGE_3D, "3ds": IMAGE_3D, fbx: IMAGE_3D,
  dae: IMAGE_3D, blend: IMAGE_3D, blend1: IMAGE_3D, glb: IMAGE_3D,
  gltf: IMAGE_3D, usdz: IMAGE_3D, ply: IMAGE_3D, abc: IMAGE_3D,
  // ── 音频（Music）/ 乐器专属 / 播放列表 ──
  mp3: AUDIO, wav: AUDIO, flac: AUDIO, m4a: AUDIO, aac: AUDIO,
  ogg: AUDIO, oga: AUDIO, opus: AUDIO, wma: AUDIO, aiff: AUDIO, aif: AUDIO,
  alac: AUDIO, ape: AUDIO, mka: AUDIO, wv: AUDIO, dsf: AUDIO,
  mod: AUDIO, xm: AUDIO, it: AUDIO, s3m: AUDIO,
  mid: AUDIO_PIANO, midi: AUDIO_PIANO,
  m3u: AUDIO_LIST, m3u8: AUDIO_LIST, pls: AUDIO_LIST, asx: AUDIO_LIST,
  xspf: AUDIO_LIST, wpl: AUDIO_LIST,
  // ── 视频 ──
  mp4: VIDEO, m4v: VIDEO, mkv: VIDEO, avi: VIDEO, mov: VIDEO,
  wmv: VIDEO, flv: VIDEO, webm: VIDEO, mpg: VIDEO, mpeg: VIDEO,
  mpe: VIDEO, m2v: VIDEO, vob: VIDEO, ogv: VIDEO, "3gp": VIDEO,
  "3g2": VIDEO, asf: VIDEO, rm: VIDEO, rmvb: VIDEO, f4v: VIDEO,
  divx: VIDEO, m2ts: VIDEO,
  // ── 字幕（Captions）──
  srt: VIDEO_SUB, ass: VIDEO_SUB, ssa: VIDEO_SUB, sub: VIDEO_SUB,
  vtt: VIDEO_SUB, sbv: VIDEO_SUB,
  // ── 压缩包 ──
  zip: ARCHIVE, zipx: ARCHIVE, rar: ARCHIVE, "7z": ARCHIVE, tar: ARCHIVE,
  gz: ARCHIVE, bz2: ARCHIVE, xz: ARCHIVE, zst: ARCHIVE, lz4: ARCHIVE,
  lzma: ARCHIVE, tgz: ARCHIVE, tbz2: ARCHIVE, txz: ARCHIVE, cab: ARCHIVE,
  lzh: ARCHIVE, arj: ARCHIVE,
  // ── 光盘镜像（Disc3）──
  iso: ARCHIVE_DISC, img: ARCHIVE_DISC, bin: ARCHIVE_DISC, cue: ARCHIVE_DISC,
  mds: ARCHIVE_DISC, nrg: ARCHIVE_DISC, dmg: ARCHIVE_DISC,
  // ── 虚拟磁盘（HardDrive）──
  vhd: ARCHIVE_VDISK, vhdx: ARCHIVE_VDISK, vdi: ARCHIVE_VDISK,
  vmdk: ARCHIVE_VDISK, qcow2: ARCHIVE_VDISK, wim: ARCHIVE_VDISK,
  esd: ARCHIVE_VDISK, swm: ARCHIVE_VDISK,
  // ── 种子（Magnet）──
  torrent: ARCHIVE_TORRENT,
  // ── 可执行 / 快捷方式（AppWindow）──
  exe: EXE, com: EXE, pif: EXE, scr: EXE, lnk: EXE,
  // ── 安装包（Package）──
  msi: EXE_PKG, msp: EXE_PKG, mst: EXE_PKG,
  apk: EXE_PKG, ipa: EXE_PKG, appx: EXE_PKG, msix: EXE_PKG,
  appxbundle: EXE_PKG, msixbundle: EXE_PKG, deb: EXE_PKG, rpm: EXE_PKG,
  pkg: EXE_PKG,
  // ── Java（Coffee）──
  jar: EXE_JAVA, war: EXE_JAVA, ear: EXE_JAVA,
  // ── 系统组件（Cog）──
  dll: EXE_SYS, sys: EXE_SYS, drv: EXE_SYS, ocx: EXE_SYS, cpl: EXE_SYS,
  mui: EXE_SYS, reg: EXE_SYS, inf: EXE_SYS,
  // ── Windows 脚本（FileTerminal）──
  bat: EXE_TERM, cmd: EXE_TERM, ps1: EXE_TERM, psm1: EXE_TERM,
  // ── 字体（ALargeSmall）──
  ttf: FONT, otf: FONT, ttc: FONT, woff: FONT, woff2: FONT, eot: FONT,
  fon: FONT,
  // ── 数据库（Database）──
  db: EXE_DB, sqlite: EXE_DB, sqlite3: EXE_DB, db3: EXE_DB,
  s3db: EXE_DB, mdb: EXE_DB, accdb: EXE_DB, mdf: EXE_DB,
  // ── 证书 / 密钥（FileKey）──
  cer: CERT, crt: CERT, pem: CERT, key: CERT, p12: CERT, pfx: CERT,
  p7b: CERT, csr: CERT, jks: CERT,
  // ── 备份 / 临时（FileClock / Timer）──
  bak: TEXT_BACKUP, backup: TEXT_BACKUP, old: TEXT_BACKUP,
  sav: TEXT_BACKUP, version: TEXT_BACKUP,
  tmp: TEXT_TIMER,
};

/** 无扩展名的常见开发文件（Dockerfile / Makefile / LICENSE 等，按文件名小写匹配） */
export const BY_NAME: Record<string, FileIconSpec> = {
  dockerfile: EXE_CONTAINER,
  makefile: EXE_BUILD,
  procfile: EXE_BUILD,
  license: TEXT_SCALE,
  copying: TEXT_SCALE,
  notice: TEXT,
  authors: TEXT,
  contributors: TEXT,
  changelog: TEXT_LOG,
  install: TEXT,
  news: TEXT,
  todo: TEXT,
  version: TEXT_BACKUP,
};

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 && i + 1 < name.length ? name.slice(i + 1).toLowerCase() : "";
}

export function fileIcon(name: string, isDir: boolean, isDrive = false): FileIconSpec {
  if (isDrive) return DRIVE;
  if (isDir) return FOLDER;
  const ext = extOf(name);
  return (
    BY_EXT[ext] ??
    (ext === "" ? BY_NAME[name.toLowerCase()] : undefined) ??
    GENERIC
  );
}

/** 分组类型名（2026-10-15 扩充）：组 → 扩展名列表，铺平生成 TYPE_NAMES */
const TYPE_GROUPS: Record<string, string[]> = {
  "PDF 文档": ["pdf"],
  "Word 文档": ["doc", "docx", "docm", "dot", "dotx", "dotm", "odt", "ott", "fodt", "rtf", "pages", "wps", "wpd", "abw", "msg"],
  演示文稿: ["ppt", "pptx", "pptm", "pot", "potx", "potm", "pps", "ppsx", "ppsm", "odp", "fodp", "otp", "thmx"],
  "Excel 表格": ["xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "xlam", "ods", "fods", "ots", "numbers", "et"],
  "CSV 表格": ["csv", "tsv"],
  "数据库表": ["dbf"],
  数据库文件: ["db", "sqlite", "sqlite3", "db3", "s3db", "mdb", "accdb", "mdf"],
  图片文件: [
    "png", "jpg", "jpeg", "jfif", "jif", "gif", "webp", "bmp", "dib", "svg",
    "svgz", "ico", "icns", "cur", "tif", "tiff", "heic", "heif", "hif",
    "avif", "jp2", "jpx", "j2k", "jxl", "pnm", "ppm", "pgm", "pbm", "pfm",
    "tga", "pcx", "exr", "hdr",
  ],
  "相机 RAW": ["dng", "cr2", "cr3", "nef", "arw", "orf", "rw2", "raf", "srw", "pef"],
  "设计源文件": ["psd", "psb", "ai", "eps", "sketch", "fig", "xcf", "cdr", "drawio"],
  "3D 模型": ["obj", "stl", "3ds", "fbx", "dae", "blend", "blend1", "glb", "gltf", "usdz", "ply", "abc"],
  音频文件: [
    "mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "wma", "aiff",
    "aif", "alac", "ape", "mka", "wv", "dsf", "mod", "xm", "it", "s3m",
  ],
  "MIDI 音频": ["mid", "midi"],
  播放列表: ["m3u", "m3u8", "pls", "asx", "xspf", "wpl"],
  视频文件: [
    "mp4", "m4v", "mkv", "avi", "mov", "wmv", "flv", "webm", "mpg", "mpeg",
    "mpe", "m2v", "vob", "ogv", "3gp", "3g2", "asf", "rm", "rmvb", "f4v",
    "divx", "m2ts",
  ],
  字幕文件: ["srt", "ass", "ssa", "sub", "vtt", "sbv"],
  压缩包: [
    "zip", "zipx", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "lz4",
    "lzma", "tgz", "tbz2", "txz", "cab", "lzh", "arj",
  ],
  光盘镜像: ["iso", "img", "bin", "cue", "mds", "nrg", "dmg"],
  虚拟磁盘: ["vhd", "vhdx", "vdi", "vmdk", "qcow2", "wim", "esd", "swm"],
  种子文件: ["torrent"],
  应用程序: ["exe", "com", "pif", "scr"],
  快捷方式: ["lnk"],
  安装程序: ["msi", "msp", "mst", "apk", "ipa", "appx", "msix", "appxbundle", "msixbundle", "deb", "rpm", "pkg"],
  "Java 包": ["jar", "war", "ear"],
  系统组件: ["dll", "sys", "drv", "ocx", "cpl", "mui", "reg", "inf"],
  脚本文件: ["bat", "cmd", "ps1", "psm1"],
  字体文件: ["ttf", "otf", "ttc", "woff", "woff2", "eot", "fon"],
  证书文件: ["cer", "crt", "pem", "key", "p12", "pfx", "p7b", "csr", "jks"],
  备份文件: ["bak", "backup", "old", "sav", "version"],
  临时文件: ["tmp"],
  文本文件: ["txt", "nfo", "rst", "adoc", "org", "man", "authors", "notice", "install", "news", "todo"],
  "Markdown 文档": ["md", "markdown", "mdx"],
  日志文件: ["log", "bib", "changelog"],
  "LaTeX 文档": ["tex"],
  邮件文件: ["eml"],
  许可证文件: ["license", "copying"],
};

/** 无扩展名文件的类型名（与 BY_NAME 同键） */
const BY_NAME_TYPES: Record<string, string> = {
  dockerfile: "Docker 定义",
  makefile: "Make 构建脚本",
  procfile: "Procfile 定义",
  license: "许可证文件",
  copying: "许可证文件",
  notice: "说明文件",
  authors: "作者列表",
  contributors: "贡献者列表",
  changelog: "更新日志",
  install: "安装说明",
  news: "更新记录",
  todo: "待办事项",
  version: "版本文件",
};

/** 扩展名 → 类型中文名（详细信息列），由 TYPE_GROUPS 铺平 + BY_NAME_TYPES 合并 */
export const TYPE_NAMES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(TYPE_GROUPS).flatMap(([t, exts]) => exts.map((e) => [e, t])),
  ),
  ...BY_NAME_TYPES,
};

export function typeName(name: string, isDir: boolean): string {
  if (isDir) return "文件夹";
  const ext = extOf(name);
  if (ext) return TYPE_NAMES[ext] ?? `${ext.toUpperCase()} 文件`;
  return TYPE_NAMES[name.toLowerCase()] ?? "文件";
}

/** 预览/测试用：分类标题（按 colorVar 分组展示） */
export const ICON_CATEGORY_NAMES: Record<string, string> = {
  "--np-icon-code": "代码 · 配置 · 脚本 · 数据库",
  "--np-icon-text": "文本 · 标记 · 邮件",
  "--np-icon-pdf": "PDF",
  "--np-icon-doc": "办公文档（Word 族）",
  "--np-icon-slide": "演示文稿",
  "--np-icon-table": "表格",
  "--np-icon-image": "图片 · 设计 · RAW · 3D",
  "--np-icon-audio": "音频 · 播放列表",
  "--np-icon-video": "视频 · 字幕",
  "--np-icon-archive": "压缩包 · 镜像 · 种子",
  "--np-icon-exe": "可执行 · 安装包 · 系统组件 · 证书",
  "--np-icon-font": "字体",
  "--np-icon-generic": "备份 · 临时",
};
