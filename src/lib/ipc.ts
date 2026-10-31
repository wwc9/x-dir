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

/** 内容搜索命中行（行号 1 起，text = 原始行内容） */
export interface ContentLine {
  line: number;
  text: string;
}

/** 内容搜索命中文件：附至多 3 条命中行片段 */
export interface ContentMatch {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  lines: ContentLine[];
}

/** 内容搜索结果（限定目录范围，无索引；scanned = 实际扫描文件数） */
export interface ContentSearchResult {
  matches: ContentMatch[];
  scanned: number;
  skippedBinary: number;
  truncated: boolean;
  elapsedMs: number;
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

/** 表格合并单元格：0 基锚点 + 跨度（xlsx/xlsm/ods 解析，其余格式为空数组） */
export interface SheetMerge {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/** 结构化文档块（2026-10-18）：docx/pptx/odt/odp/rtf/eml/msg 富预览单元 */
export interface OfficeBlock {
  /** "heading" | "para" | "list" | "table" | "kv" | "note" */
  kind: string;
  /** 标题级别(1-6) / 列表缩进层级 */
  level: number;
  text: string;
  /** 仅 kv：标签（主题/发件人/附件…） */
  label: string;
  /** 仅 table：行×格 */
  rows: string[][];
}

/** 快速预览：office 文本抽取的一节（docx=正文/第 N 页；pptx=幻灯片 N；表格=工作表名） */
export interface OfficeSection {
  title: string;
  text: string;
  truncated: boolean;
  merges: SheetMerge[];
  /** 结构化块（非空时前端按块渲染，空则回退纯文本 pre） */
  blocks?: OfficeBlock[];
}

export interface OfficeTextResult {
  kind: "docx" | "slides" | "sheet" | "epub" | "email";
  sections: OfficeSection[];
  truncated: boolean;
  /** epub 封面（PNG data URL）；其余类型为 null */
  cover?: string | null;
}

/** doc/ppt COM 转 PDF 预览回执（pdfPath 经 asset protocol 直读） */
export interface DocPdfPreview {
  pdfPath: string;
  cached: boolean;
}

/** 仓库版本清单（update.json；Rust 侧 PowerShell 双源直取，见 commands/update.rs） */
export interface UpdateManifestDto {
  version: string;
  pubDate: string | null;
  notes: string[];
  /** 命中的拉取源："Gitee" | "GitHub" */
  source: string;
}

/** fetch_update_manifest 回执：manifest 为 null 时 errors 为逐源失败原因 */
export interface UpdateFetchResult {
  manifest: UpdateManifestDto | null;
  errors: string[];
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
  /** 界面语言（2026-10-21）：zh=中文 / en=English，暂只此两种 */
  lang: "zh" | "en";
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
  /** 边栏「布局方案 / 暂存区」两卡的上下分割比例（布局方案占比，0.2–0.8；拖中间把手调整） */
  sideSplitRatio: number;
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
  /** 暂存区拖出语义（暂存区标题切换钮）：move = 落窗格即移动并移出暂存；
   *  copy = 复制到目标窗格、条目保留 */
  stagingMode: "move" | "copy";
  /** 全盘搜索索引模式（NTFS MFT/USN，需提权守护进程；默认关闭） */
  nameIndex: { enabled: boolean };
  /** 截图（§3.6）：系统级热键开关（X-Dir 运行时任意界面生效）与键位 */
  shotEnabled: boolean;
  /** 截图热键键位（tauri-plugin-global-shortcut 字符串，如 "Ctrl+Alt+A"） */
  shotHotkey: string;
  /** 截图标注：阴影宽度（CSS px，0=关；滑块记忆） */
  shotShadowW: number;
  /** 截图标注：边框宽度（CSS px，0=关；滑块记忆） */
  shotBorderW: number;
  /** 截图标注：边框颜色（默认黑） */
  shotBorderColor: string;
  /** 截图标注「滚轮记忆」（2026-10-30）：线形线宽 1~30（新图形默认值） */
  shotStrokeW?: number;
  /** 滚轮记忆：文字字号 10~80 */
  shotTextFont?: number;
  /** 滚轮记忆：序号圈尺寸档 1~20（直径 = 16+w×2.6 css） */
  shotStepW?: number;
  /** 滚轮记忆：马赛克格宽档 2~20（格 = max(4,w×3) css） */
  shotMosaicW?: number;
  /** 滚轮记忆：模糊不透明度 0.15~1（缺省 1） */
  shotBlurAlpha?: number;
  /** ── 剪贴板历史（§3.7，2026-10-30 定案，Ditto 式）── */
  /** 剪贴板监听开关（系统级热键呼出浮窗） */
  cliphistEnabled: boolean;
  /** 呼出热键（tauri-plugin-global-shortcut 字符串，可自定义录制） */
  cliphistHotkey: string;
  /** 选中条目后直接粘贴到目标窗口（恢复焦点 + 模拟 Ctrl+V；失败降级仅复制） */
  cliphistDirectPaste: boolean;
  /** 历史容量上限（条，后端钳制 50–10000，超限删最旧非置顶） */
  cliphistCapacity: number;
  /** 保留天数（0 = 永不按时清理；置顶条目豁免清理） */
  cliphistKeepDays: number;
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
  lang: "zh",
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
  sideSplitRatio: 0.5,
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
  stagingMode: "move",
  nameIndex: { enabled: false },
  shotEnabled: true,
  shotHotkey: "Ctrl+Alt+A",
  shotShadowW: 0,
  shotBorderW: 0,
  shotBorderColor: "#000000",
  cliphistEnabled: true,
  cliphistHotkey: "Ctrl+Shift+V",
  cliphistDirectPaste: true,
  cliphistCapacity: 500,
  cliphistKeepDays: 30,
};
export const PAGE_SIZE = 500;

/** 剪贴板历史条目（分页元数据；thumb = 缩略图 dataURL 或 null） */
export interface ClipHistItem {
  id: number;
  kind: "text" | "image" | "files";
  preview: string;
  size: number;
  pinned: boolean;
  createdAt: number;
  lastUsedAt: number;
  thumb: string | null;
}

export interface ClipHistPage {
  items: ClipHistItem[];
  total: number;
}

/** 全局热键注册项（hotkeysSync 全量重建，回调按 id 分发） */
export interface HotkeySpec {
  id: string;
  hotkey: string;
}

function cmd<T>(
  name: string,
  args?: Record<string, unknown> | Uint8Array,
): Promise<T> {
  // Uint8Array 请求体 = tauri 原始通道（InvokeBody::Raw），运行时直传字节
  return invoke<T>(name, args as Record<string, unknown>);
}

/** 原始直传帧体：[w u32 LE][h u32 LE][x i32 LE][y i32 LE][RGBA...]。invoke
 *  请求体整体传 Uint8Array 时 tauri 自动走 application/octet-stream 原始
 *  通道（InvokeBody::Raw），免 base64/JSON 序列化 */
function frameBody(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): Uint8Array {
  const body = new Uint8Array(16 + rgba.byteLength);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, width, true);
  dv.setUint32(4, height, true);
  dv.setInt32(8, x, true);
  dv.setInt32(12, y, true);
  body.set(rgba, 16);
  return body;
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
  /** 内容搜索（2026-10-22）：限定目录范围内做文件内容关键词匹配（无索引，有界范围）。
   *  多词 AND、大小写不敏感；单文件 2MB 上限 + 二进制嗅探 + 命中数封顶（语义见 fs::content） */
  searchContent: (o: {
    root: string;
    query: string;
    exts?: string;
    reqId?: number;
  }) =>
    cmd<ContentSearchResult>("search_content", {
      root: o.root,
      query: o.query,
      exts: o.exts,
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
  /** PDF 合并（2026-10-22 扩展）：mergeByFolder = 按文件夹分组合并（各组输出
   *  合并结果-<文件夹名>-<时间戳>.pdf，output 忽略）；autoInsertBlankPage =
   *  空白 A4 页凑偶数（blankPagePosition = 第1页之前 | 最后1页之后）；
   *  PDF/图片混列均可（jpg/jpeg/png），缺失/不可读源自动跳过 */
  pdfMerge: (
    paths: string[],
    output: string,
    mergeByFolder?: boolean,
    autoInsertBlankPage?: boolean,
    blankPagePosition?: "第1页之前" | "最后1页之后",
  ) =>
    cmd<{ jobId: number }>("pdf_merge", {
      paths,
      output,
      mergeByFolder,
      autoInsertBlankPage,
      blankPagePosition,
    }),
  pdfSplit: (path: string, outDir: string) =>
    cmd<{ jobId: number }>("pdf_split", { path, outDir }),
  /** PDF 加水印参数（2026-10-22 参数化）：文字支持占位符 [原文件名]
   *  [原文件夹名] [页码] [页面标签] [日期时间]；字体 4 种（嵌入渲染）、
   *  8 色、11 位置（九宫格 + 对角线）、透明度 0–10、页范围、页码/日期格式 */
  pdfWatermark: (o: {
    paths: string[];
    text: string;
    /** 输出名模板：[原文件名]/[原文件夹名]/[日期时间] 可组合，默认 [原文件名]-水印 */
    outName?: string;
    fontName?: string;
    fontSize?: number;
    fontColor?: string;
    position?: string;
    transparency?: number;
    margin?: number;
    pageRange?: string;
    pageNumberFormat?: string;
    datetimeFormat?: string;
  }) =>
    cmd<{ jobId: number }>("pdf_watermark", {
      paths: o.paths,
      text: o.text,
      outName: o.outName,
      fontName: o.fontName,
      fontSize: o.fontSize,
      fontColor: o.fontColor,
      position: o.position,
      transparency: o.transparency,
      margin: o.margin,
      pageRange: o.pageRange,
      pageNumberFormat: o.pageNumberFormat,
      datetimeFormat: o.datetimeFormat,
    }),
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
  /** 关于浮窗更新检查：Rust 侧双源直取 update.json（绕开 WebView CORS/代理态不稳） */
  fetchUpdateManifest: () => cmd<UpdateFetchResult>("fetch_update_manifest"),
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
  /** 主题切换时同步无边框窗口顶部 1px 非客户区颜色（COLORREF 0x00BBGGRR），
   *  填成画布色融入背景，防系统强调色/窗口背景亮条浮出（实测 2026-10-17） */
  setBorderColor: (color: number) => cmd<void>("set_border_color", { color }),
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
  /** 快速预览：OOXML/ODF/RTF/邮件文本抽取（docx/pptx/xlsx/xls/xlsb/ods/odt/odp/rtf/eml/msg/et/wps/dps） */
  previewExtractOffice: (path: string) =>
    cmd<OfficeTextResult>("preview_extract_office", { path }),
  /** 快速预览：doc/ppt/pps COM 转 PDF（缓存 %TEMP%/xdir_preview；需已装 Office/WPS） */
  previewDocPdf: (path: string) =>
    cmd<DocPdfPreview>("preview_doc_pdf", { path }),
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
  /** 截图（§3.6）：开始一次会话（定格光标所在显示器 + 打开覆盖窗） */
  shotBegin: () => cmd<void>("shot_begin"),
  /** 关闭截图覆盖窗（完成 / 取消收尾） */
  shotClose: () => cmd<void>("shot_close"),
  /** 截图窗族内容首帧就绪：Rust 此时才 show（提前 show 会闪黑屏） */
  shotReady: () => cmd<void>("shot_ready"),
  /** 常驻截图覆盖窗页面就绪（事件监听已注册）：Rust 放行会话事件下发 */
  shotPageReady: () => cmd<void>("shot_page_ready"),
  /** 会话定格帧二进制直传（RGBA 原始字节，显示器整幅）：前端 putImageData
   *  直绘，无 BMP 落盘/asset 读回/解码三跳；空 ArrayBuffer = 无进行中的会话 */
  shotFrame: () => cmd<ArrayBuffer>("shot_frame"),
  /** 截图准星键盘微调（WASD/方向键）：移动真实光标（物理像素相对位移），
   *  生成的鼠标移动由覆盖窗 pointermove 正常接管 */
  shotNudgeCursor: (dx: number, dy: number) => cmd<void>("shot_nudge_cursor", { dx, dy }),
  /** 贴图拖动会话：Rust 线程 125Hz 轮询系统光标直接驱动窗口（零逐帧 IPC）；
   *  松开左键自动结束 */
  shotPinDragStart: () => cmd<void>("shot_pin_drag_start"),
  /** 贴图拖动冗余收场（正常由松键检测结束） */
  shotPinDragStop: () => cmd<void>("shot_pin_drag_stop"),
  /** 复制图像 PNG（dataURL）到系统剪贴板（回落路径：含 PNG 编码/解码） */
  shotCopy: (dataUrl: string) => cmd<void>("shot_copy", { dataUrl }),
  /** 复制选区到剪贴板（感知优先路径）：RGBA 原始字节整体作为 invoke 请求体
   *  （Uint8Array → tauri 自动走 application/octet-stream 原始通道
   *  InvokeBody::Raw），免 PNG 编码/base64/JSON/PNG 解码四道工序；
   *  请求体 = [w u32 LE][h u32 LE][RGBA...]；报错时调用方回落 shotCopy */
  shotCopyRaw: (
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<void> => cmd<void>("shot_copy_raw", frameBody(rgba, width, height, 0, 0)),
  /** 复制快路（零 IPC）：无标注时只传选区整数矩形（显示器相对物理坐标），
   *  Rust 进程内裁剪定格帧后直写剪贴板——免 getImageData 与 RGBA 跨进程拷贝；
   *  Err（无会话/矩形不合法）时前端回落 shotCopyRaw */
  shotCopyCrop: (x: number, y: number, w: number, h: number): Promise<void> =>
    cmd<void>("shot_copy_crop", { x, y, w, h }),
  /** 贴图：PNG dataURL 钉成置顶窗（x/y/w/h = 虚拟桌面物理坐标） */
  shotPin: (dataUrl: string, x: number, y: number, w: number, h: number) =>
    cmd<void>("shot_pin", { dataUrl, x, y, w, h }),
  /** 保存 PNG dataURL 为文件（原生保存对话框；用户取消 = null；回落路径） */
  shotSaveData: (dataUrl: string) =>
    cmd<string | null>("shot_save_data", { dataUrl }),
  /** 暂存选区帧（RGBA 原始字节直传）：后续 shotSaveRaw 开对话框 */
  shotStageRaw: (
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<void> => cmd<void>("shot_stage_raw", frameBody(rgba, width, height, 0, 0)),
  /** 快存暂存（零 IPC）：无标注时只传选区整数矩形（显示器相对物理坐标），
   *  Rust 进程内从会话定格帧裁剪暂存——免 getImageData 与 RGBA 跨进程拷贝；
   *  Err（无会话/矩形不合法）时前端回落 shotStageRaw */
  shotStageCrop: (x: number, y: number, w: number, h: number): Promise<void> =>
    cmd<void>("shot_stage_crop", { x, y, w, h }),
  /** 保存暂存帧：对话框即时打开，PNG 原生 Fast 编码在对话框期间并行完成，
   *  选完路径即刻写盘（用户取消 = null） */
  shotSaveRaw: (): Promise<string | null> => cmd<string | null>("shot_save_raw"),
  /** 贴图暂存帧直传落位（BMP 临时文件 memcpy 级编码；回落路径 shotPin） */
  shotPinRaw: (
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    x: number,
    y: number,
  ): Promise<void> => cmd<void>("shot_pin_raw", frameBody(rgba, width, height, x, y)),
  /** 贴图快存落位（零 IPC）：选区整数矩形（显示器相对）+ 屏幕落位物理坐标，
   *  Rust 进程内裁剪定格帧后直接建贴图窗；Err 时前端回落 shotPinRaw */
  shotPinCrop: (x: number, y: number, w: number, h: number, sx: number, sy: number) =>
    cmd<void>("shot_pin_crop", { x, y, w, h, sx, sy }),
  /** 全局热键全量重建（§3.7，2026-10-30）：全部系统级热键单点注册（截图
   *  shot-open / 剪贴板 cliphist-toggle），取代旧 shotRegisterHotkey——
   *  其 unregister_all 全清语义无法与第二个热键并存 */
  hotkeysSync: (hotkeys: HotkeySpec[]) => cmd<void>("hotkeys_sync", { hotkeys }),
  /** 剪贴板历史（§3.7）：启停监听 + 推送容量/天数护栏（启动与设置变更时调用） */
  cliphistConfigure: (enabled: boolean, capacity: number, keepDays: number) =>
    cmd<void>("cliphist_configure", { enabled, capacity, keepDays }),
  /** 剪贴板历史：分页查询（query 空串=全部；kind 空串=全部类型） */
  cliphistList: (query: string, kind: string, offset: number, limit: number) =>
    cmd<ClipHistPage>("cliphist_list", { query, kind, offset, limit }),
  /** 剪贴板历史：写回系统剪贴板；paste=true 直接粘贴（返回 pasted，失败
   *  由前端降级提示「已复制」） */
  cliphistWriteBack: (id: number, paste: boolean) =>
    cmd<boolean>("cliphist_write_back", { id, paste }),
  /** 剪贴板历史：置顶 / 取消置顶（置顶豁免容量与天数清理） */
  cliphistSetPin: (id: number, pinned: boolean) =>
    cmd<void>("cliphist_set_pin", { id, pinned }),
  /** 剪贴板历史：删除单条 */
  cliphistDelete: (id: number) => cmd<void>("cliphist_delete", { id }),
  /** 剪贴板历史：清空全部未置顶条目 */
  cliphistClear: () => cmd<void>("cliphist_clear"),
  /** 剪贴板历史：收浮窗（Esc / 选中条目后；失焦自动收由 Rust 窗口事件处理） */
  cliphistHide: () => cmd<void>("cliphist_hide"),
  /** 剪贴板历史：浮窗置顶常驻开关（true = 失焦不自动收窗，Esc/热键仍收） */
  cliphistSetPinned: (pinned: boolean) => cmd<void>("cliphist_set_pinned", { pinned }),
  /** 剪贴板历史：浮窗最大化/还原（撑满所在显示器工作区，Rust 侧手动尺寸方案） */
  cliphistSetMaximized: (maximized: boolean) =>
    cmd<void>("cliphist_set_maximized", { maximized }),
  /** 截图标注偏好补丁写：Rust 侧白名单键合并（装饰三键 + 滚轮记忆五键
   *  shotStrokeW/shotTextFont/shotStepW/shotMosaicW/shotBlurAlpha），
   *  避免轻量截图页整对象回写覆盖主窗设置 */
  shotSavePrefs: (prefs: Record<string, unknown>) => cmd<void>("shot_save_prefs", { prefs }),
  /** 滚动长截图（§3.6 二期）：以选区（显示器相对物理坐标）开滚动会话。
   *  两段式（贴图 finish 流同款）：begin 校验+装钩+收覆盖窗后返回，主循环把
   *  停靠消息处理完，前端随即调 launch 建浮条窗起循环——蒙层未离屏即建窗
   *  实测永久卡死（WebView2 build() 泵消息坑） */
  shotScrollBegin: (rx: number, ry: number, rw: number, rh: number, mx: number, my: number) =>
    cmd<void>("shot_scroll_begin", { rx, ry, rw, rh, mx, my }),
  shotScrollLaunch: () => cmd<void>("shot_scroll_launch", {}),
  /** 滚动预览窗增量拉取已拼行 [fromY..h)：原始 RGBA 行主序二进制直传；
   *  空响应 = 无新内容或会话已收尾 */
  shotScrollChunk: (fromY: number) => cmd<ArrayBuffer>("shot_scroll_chunk", { fromY }),
  /** 滚动预览窗操作：finish = 用已拼内容出结果；cancel = 丢弃 */
  shotScrollControl: (action: "finish" | "cancel") =>
    cmd<void>("shot_scroll_control", { action }),
  /** 滚动结果窗：长图（临时 PNG 路径）写入剪贴板 */
  shotResultCopy: (file: string) => cmd<void>("shot_result_copy", { file }),
  /** 滚动结果窗：长图另存（原生对话框；用户取消 = null） */
  shotResultSave: (file: string) =>
    cmd<string | null>("shot_result_save", { file }),
  /** 长图贴图：以临时 PNG 路径钉成置顶窗（cx/cy = 窗中心全局物理坐标） */
  shotPinFile: (file: string, cx: number, cy: number) =>
    cmd<void>("shot_pin_file", { file, cx, cy }),
};

// M0 内存对比用假数据命令保留
export function listFakeDir(
  path: string,
  offset: number,
  limit: number,
): Promise<DirPage> {
  return invoke("fake_list_dir", { path, offset, limit });
}
