// 与 Rust 结构体一一对应的 IPC 类型与封装（serde rename_all = "camelCase"）
import { invoke } from "@tauri-apps/api/core";

export const THIS_PC = "::{ThisPC}";

export type SortKey = "name" | "size" | "mtime" | "type";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}
export type ViewMode = "list" | "details";
export type Policy = "overwrite" | "skip" | "rename";
/** V2 颜色标记键（与 index.css --np-tag-* token 一一对应） */
export type TagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export interface FileAttrs {
  hidden: boolean;
  system: boolean;
  readonly: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  /** 创建时间（§7.3 属性对话框）；文件系统不支持时为 0 */
  ctimeMs: number;
  attrs: FileAttrs;
  /** 拼音首字母匹配串（首字母跳转用；不含汉字为 null，前端回落名称前缀匹配） */
  py: string | null;
}

export interface DirPage {
  total: number;
  entries: FileEntry[];
}

export interface SearchResult {
  entries: FileEntry[];
  truncated: boolean;
  /** 实际遍历的条目数（状态条"已扫描"展示；索引通道无此语义恒 0） */
  scanned: number;
  /** 搜索耗时（毫秒，窗格状态条展示） */
  elapsedMs: number;
  /** 服务引擎："index"（NTFS 索引）| "scan"（实时遍历） */
  engine: "index" | "scan";
}

/** 全盘搜索结果（index = NTFS 索引通道；scan = 实时遍历兜底） */
export interface GlobalSearchResult {
  entries: FileEntry[];
  truncated: boolean;
  /** 实际扫描的条目数 */
  scanned: number;
  elapsedMs: number;
  engine: "index" | "scan";
  /** engine = "scan" 且索引模式已开启时的回退原因（守护未运行/索引过期等） */
  fallbackReason: string | null;
}

/** search-batch 事件载荷：遍历命中的流式批次（前端按 reqId 累积渲染） */
export interface SearchBatchEvent {
  reqId: number;
  entries: FileEntry[];
  scanned: number;
}

/** 快速预览：文本直读结果（Rust 端 BOM→UTF-8→GB18030 探测） */
export interface PreviewTextResult {
  content: string;
  truncated: boolean;
  /** "UTF-8" | "UTF-16LE" | "UTF-16BE" | "GB18030" | "binary" */
  encoding: string;
  /** 前 8KB 含 NUL，按二进制处理（回落元信息卡） */
  binary: boolean;
}

/** 快速预览：office 文本抽取的一节（docx=正文；pptx=幻灯片 N；表格=工作表名） */
export interface OfficeSection {
  title: string;
  text: string;
  truncated: boolean;
}

export interface OfficeTextResult {
  kind: "docx" | "slides" | "sheet" | "epub";
  sections: OfficeSection[];
  truncated: boolean;
}

/** 快速预览：压缩包内条目（不解压，仅清单） */
export interface ArchiveEntry {
  name: string;
  size: number;
  isDir: boolean;
}

export interface ArchiveListing {
  total: number;
  entries: ArchiveEntry[];
  /** 条目数超 500 截断，total 仍为真实总数 */
  truncated: boolean;
}

/** 搜索结果类型过滤 */
export type SearchTypeFilter = "all" | "files" | "dirs";

/** 索引模式状态回执（index_status）：daemon.json 配置的卷 + 各卷建索引回执 */
export interface IndexStatus {
  daemonAlive: boolean;
  enabled: boolean;
  /** daemon.json 启用的卷清单——建索引期间 volumes 尚无该卷条目，据此判定"初建中" */
  configured: string[];
  volumes: Record<string, IndexVolumeStatus>;
}

export interface IndexVolumeStatus {
  entries: number;
  fresh: boolean;
  error: string | null;
}

/** 重复文件组（同 SHA-256 指纹，>1 份） */
export interface DupGroup {
  hash: string;
  size: number;
  paths: string[];
}

/** 目录体积条目（文件夹 = 递归合计） */
export interface DirSizeEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  files: number;
}

/** 双文件夹比较：相对路径条目 */
export interface CompareRelItem {
  rel: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface CompareResult {
  aOnly: CompareRelItem[];
  bOnly: CompareRelItem[];
  differ: CompareRelItem[];
  same: number;
}

/** 空文件/空文件夹扫描结果（0 字节文件 + 无子项目录） */
export interface EmptyScan {
  emptyFiles: string[];
  emptyDirs: string[];
  scanned: number;
}

/** 批量新建文件夹回执（created = 实际路径，与磁盘重名时自动 "(2)" 递增） */
export interface CreateDirsResult {
  created: string[];
  failed: { name: string; message: string }[];
}

export interface DriveInfo {
  letter: string;
  label: string;
  driveType: "fixed" | "removable" | "cdrom";
  totalBytes: number;
  freeBytes: number;
}

export interface ConflictInfo {
  sourceName: string;
  existingIsDir: boolean;
  existingSize: number;
}

/** Rust AppError 镜像（src-tauri/src/commands/files.rs）：全部命令的错误通道。
 *  invoke reject 时 Tauri 抛出的就是该对象（不再是字符串），展示时请自行格式化 */
export interface AppError {
  code: "E_NOT_FOUND" | "E_PERM" | "E_EXISTS" | "E_INVALID_NAME" | "E_IO" | "E_UNKNOWN" | "E_UNSUPPORTED";
  message: string;
}

export interface ColorRule {
  pattern: string;
  color: TagColor;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  /** "在终端打开"用的 shell：wt 存在时按它追加命令行，回退经典控制台同规则 */
  terminal: "powershell" | "cmd";
  showHidden: boolean;
  defaultView: ViewMode;
  defaultSort: Sort;
  confirmDelete: boolean;
  restoreLastSession: boolean;
  favorites: { name: string; path: string }[];
  /** 自定义右键命令模板（设置 → 右键菜单 → 命令模板；由菜单条目引用） */
  customCommands: CustomCommand[];
  /** 右键菜单布局（有序条目：内置功能/自定义命令/分割线，含出现条件） */
  menuEntries: MenuEntry[];
  /** 右键菜单编辑器左栏（启用菜单）宽（px，两栏间可拖，钳制 240–480） */
  menuedLeftWidth: number;
  /** V2：真实文件图标（SHGetFileInfo） */
  realIcons: boolean;
  /** V2：复制/移动走 IFileOperation 原生引擎（系统进度与冲突对话框） */
  nativeFileOps: boolean;
  /** V2：手动颜色标记（路径 → 色） */
  colorTags: Record<string, TagColor>;
  /** 窗格工具栏布局（定制页共享功能库：有序 MenuEntry，条件按窗格选中项判定） */
  toolbarEntries: MenuEntry[];
  /** V2：着色规则（*.ext 或名称子串 → 色），列表顺序即优先级 */
  colorRules: ColorRule[];
  /** 界面缩放（Ctrl +/-/0、Ctrl+滚轮；WebView2 ZoomFactor，1 = 100%） */
  uiZoom: number;
  /** ── UI 偏好（2026-10-12 集中化：原散落 localStorage，随 settings.json 保存/导出）── */
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  colWidths: { name: number; mtime: number; type: number; size: number; loc: number };
  /** 全盘搜索结果列宽（独立于文件列表：弹窗宽固定，两侧比例偏好互不干扰） */
  gsearchColWidths: { name: number; loc: number; size: number; type: number; mtime: number };
  /** 全盘搜索内嵌预览面板（Spotlight 式右栏）开关，默认开启 */
  gsearchPreview: boolean;
  /** 全盘搜索预览面板宽（px，分隔条可拖，钳制 280–640） */
  gsearchPreviewWidth: number;
  navTreeWidth: number;
  navTreeVisible: boolean;
  navTreeExpanded: string[];
  /** 浏览历史（全局，跨窗格去重置顶，上限 50 条） */
  recentFolders: string[];
  /** 全盘搜索历史（去重置顶，上限 20 条） */
  recentSearches: string[];
  /** 导航后按路径记忆选中集（回到该目录自动恢复；Ctrl+A/Esc 等显式操作不受影响） */
  rememberSelection: boolean;
  /** 暂存区（侧边栏下半）：临时拖放的文件/文件夹路径，跨会话保留；去重与上限见 lib/shelf.ts */
  staging: string[];
  /** 全盘搜索索引模式（NTFS MFT/USN，需提权守护进程；默认关闭） */
  nameIndex: { enabled: boolean };
}

/** 自定义右键命令：占位符 %f=全部选中路径（逐个引号包裹） %n=首项文件名 %d=所在目录；
 *  模板不含占位符时自动在末尾追加 %f。出现条件由菜单条目（MenuEntry.cond）承载 */
export interface CustomCommand {
  /** 稳定标识（菜单条目引用）；旧档由 settings.load 补发 */
  id: string;
  name: string;
  command: string;
  /** 最少选中数（默认 1）——仅作新建菜单条目时的默认条件 */
  minCount: number;
  /** 最大选中数（0 = 不限） */
  maxCount: number;
  /** 作用对象：全部 / 仅文件 / 仅文件夹 */
  target: "all" | "file" | "dir";
  /** 扩展名白名单（逗号/空格分隔如 "txt,md"；空 = 不限） */
  exts: string;
}

/** 右键菜单条目条件：对象类型 + 数量上下限 + 扩展名白名单（area=blank 时忽略） */
export interface MenuCond {
  /** 选中对象类型：全部 / 仅文件 / 仅文件夹 */
  target: "all" | "file" | "dir";
  /** 最少选中数（默认 1） */
  minCount: number;
  /** 最大选中数（0 = 不限） */
  maxCount: number;
  /** 扩展名白名单（空 = 不限；非空时选中须为匹配扩展名的文件，文件夹不适用） */
  exts: string;
}

/** 右键菜单条目：有序存 settings.menuEntries，渲染时按条件过滤 */
export interface MenuEntry {
  /** builtin:<功能 key> | custom:<命令 id> | sep:<随机串> */
  id: string;
  kind: "builtin" | "custom" | "sep";
  /** 出现区域：sel=右键选中条目 / blank=右键空白处 / both=不限（两处都出现，
   *  仍受功能自身能力位 supportsSel/supportsBlank 约束） */
  area: "sel" | "blank" | "both";
  cond: MenuCond;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  terminal: "powershell",
  showHidden: false,
  defaultView: "details",
  defaultSort: { key: "name", dir: "asc" },
  confirmDelete: true,
  toolbarEntries: [],
  restoreLastSession: true,
  favorites: [],
  customCommands: [],
  // 出厂布局由 settings.load 的迁移填充（defaultMenuEntries，含旧命令条目化）
  menuEntries: [],
  menuedLeftWidth: 300,
  realIcons: true,
  // 2026-10-15 定案：默认走内置引擎（灵动岛字节级进度 + 应用内冲突框）；
  // 原生 IFileOperation 的进度/冲突交系统 UI 且快操作不弹窗，改为可选开启
  nativeFileOps: false,
  colorTags: {},
  colorRules: [],
  uiZoom: 1,
  sidebarWidth: 136,
  sidebarCollapsed: false,
  colWidths: { name: 240, mtime: 130, type: 110, size: 80, loc: 160 },
  gsearchColWidths: { name: 168, loc: 134, size: 72, type: 72, mtime: 132 },
  gsearchPreview: true,
  gsearchPreviewWidth: 400,
  navTreeWidth: 200,
  navTreeVisible: true,
  navTreeExpanded: [THIS_PC],
  recentFolders: [],
  recentSearches: [],
  rememberSelection: true,
  staging: [],
  nameIndex: { enabled: false },
};

export const PAGE_SIZE = 500;

function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args);
}

export const api = {
  listDir: (o: {
    path: string;
    sort: Sort;
    showHidden: boolean;
    offset: number;
    limit: number;
    force?: boolean;
    /** 视图内名称过滤（空格分隔多词 = AND；ASCII 词追加拼音首字母匹配）；
     *  传 undefined = 不过滤 */
    nameFilter?: string;
    /** 后端已支持（ext_filter），前端暂未接线；传 undefined 即不过滤 */
    extFilter?: string[];
  }) =>
    cmd<DirPage>("list_dir", {
      path: o.path,
      sort: o.sort,
      showHidden: o.showHidden,
      offset: o.offset,
      limit: o.limit,
      force: o.force ?? false,
      nameFilter: o.nameFilter,
    }),
  listDirs: (path: string, showHidden = false) =>
    cmd<string[]>("list_dirs", { path, showHidden }),
  exportConfig: (path: string) =>
    cmd<{ workspaces: number; sourceSettingsPath: string }>("export_config", { path }),
  importConfig: (path: string) =>
    cmd<{ workspaces: number; importedSettings: boolean }>("import_config", { path }),
  searchDir: (o: {
    path: string;
    query: string;
    maxResults?: number;
    typeFilter?: SearchTypeFilter;
    reqId?: number;
  }) =>
    cmd<SearchResult>("search_dir", {
      path: o.path,
      query: o.query,
      maxResults: o.maxResults,
      typeFilter: o.typeFilter,
      reqId: o.reqId,
    }),
  /** roots 省略 = 全部固定盘；索引模式可用时自动走索引通道（毫秒级） */
  searchAll: (o: {
    query: string;
    maxResults?: number;
    roots?: string[];
    typeFilter?: SearchTypeFilter;
    reqId?: number;
  }) =>
    cmd<GlobalSearchResult>("search_all", {
      query: o.query,
      maxResults: o.maxResults,
      roots: o.roots,
      typeFilter: o.typeFilter,
      reqId: o.reqId,
    }),
  /** 取消指定槽位（reqId）正在进行的搜索 */
  cancelSearch: (reqId: number) => cmd<void>("cancel_search", { reqId }),
  indexStatus: () =>
    cmd<IndexStatus>("index_status"),
  enableIndexMode: () => cmd<void>("enable_index_mode"),
  disableIndexMode: () => cmd<void>("disable_index_mode"),
  suggestPaths: (input: string, limit = 8) =>
    cmd<string[]>("suggest_paths", { input, limit }),
  checkConflicts: (sources: string[], destDir: string) =>
    cmd<ConflictInfo[]>("check_conflicts", { sources, destDir }),
  copyItems: (sources: string[], destDir: string, policy: Policy, native: boolean) =>
    cmd<{ jobId: number }>("copy_items", { sources, destDir, policy, native }),
  moveItems: (sources: string[], destDir: string, policy: Policy, native: boolean) =>
    cmd<{ jobId: number }>("move_items", { sources, destDir, policy, native }),
  deleteItems: (paths: string[], permanent = false) =>
    cmd<{ jobId: number }>("delete_items", { paths, permanent }),
  restoreFromTrash: (paths: string[]) =>
    cmd<{ restored: number; missing: number }>("restore_trash", { paths }),
  pdfPageCount: (path: string) => cmd<number>("pdf_page_count", { path }),
  pdfMerge: (paths: string[], output: string) =>
    cmd<{ jobId: number }>("pdf_merge", { paths, output }),
  pdfSplit: (path: string, outDir: string) =>
    cmd<{ jobId: number }>("pdf_split", { path, outDir }),
  pdfWatermark: (paths: string[], text: string) =>
    cmd<{ jobId: number }>("pdf_watermark", { paths, text }),
  /** 图片压缩：target 0=Auto 1=JPEG 2=PNG8 3=无损优化；quality = JPEG 质量 1–100 */
  imgCompress: (paths: string[], target: 0 | 1 | 2 | 3, quality: number) =>
    cmd<{ jobId: number }>("img_compress", { paths, target, quality }),
  /** 图片水印：imagePath 空串 = 文字水印；tile = 平铺/角标；opacity 10–100；
   *  scaleDiv = 水印尺寸 = 图像短边 / scaleDiv（4–64） */
  imgWatermark: (
    paths: string[],
    opts: {
      imagePath: string;
      text: string;
      tile: boolean;
      opacity: number;
      scaleDiv: number;
    },
  ) => cmd<{ jobId: number }>("img_watermark", { paths, ...opts }),
  /** 图片格式转换：target 0=png 1=jpg 2=bmp 3=tiff 4=ico 5=webp（无损） */
  imgConvert: (
    paths: string[],
    target: 0 | 1 | 2 | 3 | 4 | 5,
    quality: number,
    bakeExif: boolean,
  ) => cmd<{ jobId: number }>("img_convert", { paths, target, quality, bakeExif }),
  /** 图片尺寸调整：mode 0=百分比(1–800) 1=指定宽 2=指定高(1–20000) */
  imgResize: (
    paths: string[],
    mode: 0 | 1 | 2,
    value: number,
    lanczos: boolean,
    onlyDown: boolean,
  ) => cmd<{ jobId: number }>("img_resize", { paths, mode, value, lanczos, onlyDown }),
  /** 宫格拼图：cols 2–6 / cell 128–2048 / gap 0–64；bg 0=白 1=黑 2=透明；
   *  output = 完整输出路径（重名自动 (2)） */
  imgMontage: (
    paths: string[],
    opts: {
      cols: number;
      cell: number;
      gap: number;
      cover: boolean;
      bg: 0 | 1 | 2;
      output: string;
      png: boolean;
    },
  ) => cmd<{ jobId: number }>("img_montage", { paths, ...opts }),
  cancelJob: (jobId: number) => cmd<void>("cancel_job", { jobId }),
  pauseJob: (jobId: number) => cmd<void>("pause_job", { jobId }),
  resumeJob: (jobId: number) => cmd<void>("resume_job", { jobId }),
  renameItem: (path: string, newName: string) =>
    cmd<void>("rename_item", { path, newName }),
  createDir: (parentDir: string, name: string) =>
    cmd<string>("create_dir", { parentDir, name }),
  createFile: (parentDir: string, name: string) =>
    cmd<string>("create_file", { parentDir, name }),
  openItem: (path: string) => cmd<void>("open_item", { path }),
  openTerminal: (path: string, shell: "powershell" | "cmd") =>
    cmd<void>("open_terminal", { path, shell }),
  getDrives: () => cmd<DriveInfo[]>("get_drives"),
  getVolume: (path: string) =>
    cmd<{ freeBytes: number; totalBytes: number }>("get_volume", { path }),
  getKnownFolder: (id: string) => cmd<string>("get_known_folder", { id }),
  getLaunchArgs: () => cmd<string[]>("get_launch_args"),
  watchDir: (path: string) => cmd<void>("watch_dir", { path }),
  unwatchDir: (path: string) => cmd<void>("unwatch_dir", { path }),
  setClipboardFiles: (paths: string[], cut: boolean) =>
    cmd<void>("set_clipboard_files", { paths, cut }),
  getClipboardFiles: () =>
    cmd<{ paths: string[]; cut: boolean } | null>("get_clipboard_files"),
  clearClipboard: () => cmd<void>("clear_clipboard"),
  getFileIcons: (paths: string[]) =>
    cmd<Record<string, string>>("get_file_icons", { paths }),
  showContextMenu: (paths: string[]) =>
    cmd<void>("show_context_menu", { paths }),
  /** 返回落点效果："copy"/"move"；"drop" = 已放置但落点未回写 effect（WebView2 网页落点）；
   *  "none" = 未放置（拖拽取消/落在无效目标） */
  startDrag: (paths: string[]) =>
    cmd<"copy" | "move" | "drop" | "none">("start_drag", { paths }),
  /** settings.json 缺失/解析失败时后端返回 null（stores/settings 以 DEFAULT_SETTINGS 兜底） */
  getSettings: () => cmd<Partial<Settings> | null>("get_settings"),
  saveSettings: (s: Settings) => cmd<void>("save_settings", { json: s }),
  listWorkspaces: () => cmd<string[]>("list_workspaces"),
  loadWorkspace: (name: string) =>
    cmd<{ name: string; tree: unknown }>("load_workspace", { name }),
  saveWorkspace: (name: string, tree: unknown) =>
    cmd<void>("save_workspace", { name, tree }),
  deleteWorkspace: (name: string) => cmd<void>("delete_workspace", { name }),
  /** 快速预览：按编码探测读文本（上限 8MB = 后端 TEXT_READ_CAP；maxBytes 为 u32 勿传更大值） */
  previewReadText: (path: string, maxBytes: number) =>
    cmd<PreviewTextResult>("preview_read_text", { path, maxBytes }),
  /** 快速预览：OOXML/ODF 文本抽取（docx/pptx/xlsx/xls/xlsb/ods） */
  previewExtractOffice: (path: string) =>
    cmd<OfficeTextResult>("preview_extract_office", { path }),
  /** 快速预览：压缩包清单（zip/tar/tar.gz/7z，不解压） */
  listArchive: (path: string) =>
    cmd<ArchiveListing>("preview_list_archive", { path }),
  /** 快速预览：TIFF 解码为 PNG data URL（WebView2 不内置 TIFF 解码） */
  previewTiffDataUrl: (path: string) =>
    cmd<string>("preview_tiff_data_url", { path }),

  // ── 办公批处理（2026-10-14，全部入任务引擎）──
  /** PDF 提取页（spec 如 "1-3,5,8-"）→ output 新文件 */
  pdfExtractPages: (path: string, spec: string, output: string) =>
    cmd<{ jobId: number }>("pdf_extract_pages", { path, spec, output }),
  /** PDF 删除页（spec 指定要删的页，保留其余）→ output 新文件 */
  pdfRemovePages: (path: string, spec: string, output: string) =>
    cmd<{ jobId: number }>("pdf_remove_pages", { path, spec, output }),
  /** PDF 全部页相对旋转（原地，±90/±180/±270） */
  pdfRotate: (path: string, degrees: number) =>
    cmd<{ jobId: number }>("pdf_rotate", { path, degrees }),
  /** PDF 轻压缩（旁写 *_压缩.pdf） */
  pdfCompress: (paths: string[]) =>
    cmd<{ jobId: number }>("pdf_compress", { paths }),
  /** 图片（PNG/JPEG）合并转 PDF，每图一页 */
  imagesToPdf: (paths: string[], output: string) =>
    cmd<{ jobId: number }>("images_to_pdf", { paths, output }),
  /** Office/WPS COM 转 PDF（旁写 <stem>.pdf；需已装 Office 或 WPS） */
  officeToPdf: (paths: string[]) =>
    cmd<{ jobId: number }>("office_to_pdf", { paths }),
  /** OOXML 隐私属性清理（旁写 *_清洁.ext） */
  cleanOfficeMeta: (paths: string[]) =>
    cmd<{ jobId: number }>("clean_office_meta", { paths }),
  /** Office 文档导出文本 TXT（旁写 <stem>.txt） */
  officeToText: (paths: string[]) =>
    cmd<{ jobId: number }>("office_to_text", { paths }),
  /** 文本/表格编码转换（旁写 <stem><后缀>.ext；target ∈ utf8bom/utf8/gbk） */
  convertEncoding: (paths: string[], target: "utf8bom" | "utf8" | "gbk") =>
    cmd<{ jobId: number }>("convert_encoding", { paths, target }),
  /** CSV/TSV 合并（去重复表头）→ output（UTF-8 BOM） */
  mergeCsv: (paths: string[], output: string) =>
    cmd<{ jobId: number }>("merge_csv", { paths, output }),
  /** 文本合并（空行分隔）→ output（UTF-8 BOM） */
  mergeTexts: (paths: string[], output: string) =>
    cmd<{ jobId: number }>("merge_texts", { paths, output }),
  /** Excel 工作簿合并（calamine 读 → rust_xlsxwriter 写 .xlsx）；
   *  mode ∈ "sheets"（每源表一张目标表）| "rows"（纵向拼接去重复表头） */
  mergeXlsx: (paths: string[], output: string, mode: "sheets" | "rows") =>
    cmd<{ jobId: number }>("merge_xlsx", { paths, output, mode }),
  /** 压缩为 zip（文件平铺、文件夹递归含顶层目录） */
  zipFiles: (paths: string[], output: string) =>
    cmd<{ jobId: number }>("zip_files", { paths, output }),
  /** 解压 zip/7z：每包解到 dest_dir 下 <包名>/ 子目录 */
  extractArchives: (sources: string[], destDir: string) =>
    cmd<{ jobId: number }>("extract_archives", { sources, destDir }),
  /** 重复文件查找（SHA-256 指纹） */
  findDuplicates: (dir: string) => cmd<DupGroup[]>("find_duplicates", { dir }),
  /** 空文件/空文件夹扫描（0 字节文件 + 字面空目录） */
  scanEmpty: (dir: string) => cmd<EmptyScan>("scan_empty", { dir }),
  /** 批量新建文件夹（与磁盘重名自动 "(2)"；名单内重名/非法名逐条报错不中断） */
  createDirs: (parentDir: string, names: string[]) =>
    cmd<CreateDirsResult>("create_dirs", { parentDir, names }),
  /** 目录体积分析（直接子项） */
  dirSizes: (dir: string) => cmd<DirSizeEntry[]>("dir_sizes", { dir }),
  /** 双文件夹比较（相对路径对齐） */
  compareDirs: (a: string, b: string) => cmd<CompareResult>("compare_dirs", { a, b }),
  /** 保存文本文件（UTF-8 BOM；导出文件清单用） */
  saveTextFile: (path: string, content: string) =>
    cmd<void>("save_text_file", { path, content }),
};

// M0 内存对比用假数据命令保留
export function listFakeDir(
  path: string,
  offset: number,
  limit: number,
): Promise<DirPage> {
  return invoke("fake_list_dir", { path, offset, limit });
}
