// 右键菜单功能库（内置功能注册表）+ 条件判定纯函数 + 预设菜单/工具栏布局。
// 菜单布局 = settings.menuEntries（有序 MenuEntry），渲染方（FileList）按
// entryVisible 过滤后交给各功能的执行器；本模块只描述"有什么功能、默认条件"，
// 不持有执行逻辑（执行器闭包在 FileList 组件内，避免把列表状态提升进全局）。
import {
  Archive,
  ArchiveRestore,
  ArrowLeftRight,
  ArrowRightToLine,
  ArrowUp,
  Bookmark,
  BookmarkPlus,
  Bomb,
  CheckCheck,
  ClipboardList,
  ClipboardPaste,
  Columns2,
  Command,
  Copy,
  CopyPlus,
  Ellipsis,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  Files,
  FileCheck,
  FileClock,
  FileMinus2,
  FileOutput,
  FilePlus,
  FilePlus2,
  FileStack,
  FileText,
  Fingerprint,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  FolderTree,
  Folders,
  GitCompare,
  Grid3x3,
  HardDrive,
  Heading,
  Image,
  Info,
  Languages,
  Library,
  Link,
  Link2,
  List,
  Lock,
  LockOpen,
  Merge,
  Minimize2,
  PanelTop,
  Palette,
  PenLine,
  Plus,
  Presentation,
  PackageOpen,
  RefreshCw,
  Repeat,
  Replace,
  RotateCw,
  Rows2,
  Scaling,
  Scissors,
  Search,
  ShieldCheck,
  Shrink,
  Split,
  SquareDashedMousePointer,
  Stamp,
  Table,
  Table2,
  Terminal,
  Text,
  Trash2,
  Type,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import type { MenuCond, MenuEntry } from "./ipc";
import { IMG_EXTS, MONTAGE_MAX, MONTAGE_MIN } from "./imgOps";
import { t } from "./i18n";

export type MenuArea = "sel" | "blank" | "both";

export interface BuiltinFn {
  /** 稳定 key（MenuEntry.id = "builtin:" + key） */
  key: string;
  label: string;
  /** 一句话说明（功能库胶囊悬停提示，2026-11-09 增；参考 DOpus/TC 定制页
   *  的按钮描述——74 个功能名不都能望文生义） */
  desc: string;
  /** 功能库分组标题 */
  group: string;
  /** 功能图标（Lucide，2026-11-11 快速命令面板随功能库入库补齐；仅元数据，
   *  渲染一律经 AppIcon/ic——iconRule 审计同 fileIcons 口径） */
  icon: LucideIcon;
  /** 默认出现区域 */
  area: MenuArea;
  /** 能否用于右键选中条目 / 空白处（编辑器据此约束"出现位置"可选项）。
   *  工具栏不设能力位——全部内置功能都可入工具栏（2026-10-14 定案）：
   *  窗格工具（supportsSel/Blank 双 false）仅工具栏可用，其余功能两面共享 */
  supportsSel: boolean;
  supportsBlank: boolean;
  /** 默认出现条件 */
  cond: MenuCond;
}

const C = (cond: Partial<MenuCond>): MenuCond => ({
  target: "all",
  minCount: 1,
  maxCount: 0,
  exts: "",
  ...cond,
});

/** 内置功能库（顺序 = 功能库展示顺序；2026-11-09 分组合并精简：12 组 → 8 组——
 *  剪贴板并入「文件」，视图并入「新建与选择」复名「新建与视图」，窗格协作 +
 *  窗格工具合并为「窗格」（仅工具栏能力位仍由 supportsSel/Blank 表达，组名
 *  不再区分两面），「表格与文本」并入「办公」复名「办公与表格」，「图片合并
 *  转 PDF」自办公移入 PDF 组；组序按使用频率与逻辑流排列，同组条目在表内连续。
 *  2026-11-09 二次扩充：对标 TC/DOpus/XYplorer/FreeCommander 新增「工具」组
 *  （校验值/校验核对/时间属性/NTFS 链接/分割合并）+ 路径变体 + 行尾转换） */
export const BUILTIN_FNS: BuiltinFn[] = [
  // ── 文件（含剪贴板操作）：打开/互传 → 重命名 → 删除 → 属性 ──
  { key: "open", label: "打开", desc: "用系统默认程序打开", group: "文件", icon: ExternalLink, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ maxCount: 1 }) },
  { key: "openTab", label: "在新标签打开", desc: "在当前窗格新标签页打开此文件夹", group: "文件", icon: FolderOpen, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", maxCount: 1 }) },
  { key: "cut", label: "剪切", desc: "剪切选中项到剪贴板", group: "文件", icon: Scissors, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "copy", label: "复制", desc: "复制选中项到剪贴板", group: "文件", icon: Copy, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "paste", label: "粘贴", desc: "粘贴剪贴板中的文件", group: "文件", icon: ClipboardPaste, area: "both", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "copyPath", label: "复制路径", desc: "复制完整路径（多选多行）", group: "文件", icon: Link, area: "sel", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "copyPathVariants", label: "复制路径 ▸", desc: "正斜杠/带引号/相对路径等格式", group: "文件", icon: Link2, area: "sel", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "copyName", label: "复制名称", desc: "复制文件名（多选多行）", group: "文件", icon: Type, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "copyNameStem", label: "复制名称（无扩展名）", desc: "复制不含扩展名的主名", group: "文件", icon: Heading, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "rename", label: "重命名", desc: "行内改名", group: "文件", icon: PenLine, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ maxCount: 1 }) },
  { key: "batchRename", label: "批量重命名", desc: "查找替换/序号/日期等规则批量改名", group: "文件", icon: WandSparkles, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ minCount: 2 }) },
  { key: "delete", label: "删除", desc: "移入回收站", group: "文件", icon: Trash2, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "deletePerm", label: "永久删除", desc: "不经回收站直接删除", group: "文件", icon: Bomb, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "properties", label: "属性", desc: "查看名称/大小/时间/属性位", group: "文件", icon: Info, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ maxCount: 1 }) },
  // ── 新建与视图 ──
  { key: "newFolder", label: "新建文件夹", desc: "新建空文件夹", group: "新建与视图", icon: FolderPlus, area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "newFile", label: "新建文本文件", desc: "新建 0 字节文本文件", group: "新建与视图", icon: FilePlus2, area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "newFolders", label: "批量新建文件夹", desc: "名单/序号模板一次建多个", group: "新建与视图", icon: Folders, area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  // 新建 = 子菜单聚合（文件夹 / 文本 / 常用办公格式），子项执行器在 FileList
  { key: "new", label: "新建", desc: "文件夹与常用格式一键新建", group: "新建与视图", icon: Plus, area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "selectAll", label: "全选", desc: "选中当前列表全部条目", group: "新建与视图", icon: SquareDashedMousePointer, area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "reverseSelect", label: "反向选择", desc: "反转当前选中状态", group: "新建与视图", icon: CheckCheck, area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "preview", label: "预览", desc: "快速预览浮层（Space 同效）", group: "新建与视图", icon: Eye, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "refresh", label: "刷新", desc: "重新读取当前目录", group: "新建与视图", icon: RefreshCw, area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "toggleHidden", label: "切换隐藏文件", desc: "显示或隐藏隐藏文件", group: "新建与视图", icon: EyeOff, area: "blank", supportsSel: false, supportsBlank: true, cond: C({}) },
  // ── 窗格：互传（菜单/工具栏两面共享）+ 窗格工具 ──
  { key: "copyToPane", label: "复制到窗格", desc: "复制选中项到对侧窗格", group: "窗格", icon: CopyPlus, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "moveToPane", label: "移动到窗格", desc: "移动选中项到对侧窗格", group: "窗格", icon: ArrowRightToLine, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  // 窗格工具（2026-10-15 并入功能库，与右键菜单共享）：仅工具栏可用——
  // 无选中语义，supportsSel/Blank 双 false 使其不可拖入右键菜单；
  // 工具栏条目默认「当前文件夹」恒可用（见 builtinToolbarEntry 的作用域区分）
  { key: "up", label: "上一级", desc: "回到上一级目录", group: "窗格", icon: ArrowUp, area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "view", label: "视图类型", desc: "切换详细信息/列表/图标视图", group: "窗格", icon: List, area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "addr", label: "地址框", desc: "显示地址栏（固定条目）", group: "窗格", icon: PanelTop, area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "search", label: "搜索当前文件夹", desc: "在当前文件夹范围内搜索", group: "窗格", icon: Search, area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "splitH", label: "横向分裂", desc: "横向分裂出新窗格", group: "窗格", icon: Columns2, area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "splitV", label: "纵向分裂", desc: "纵向分裂出新窗格", group: "窗格", icon: Rows2, area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "swap", label: "交换窗格", desc: "交换两窗格位置", group: "窗格", icon: ArrowLeftRight, area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  // ── 标记与系统 ──
  { key: "colorTag", label: "颜色标记", desc: "用颜色给文件做标记", group: "标记与系统", icon: Palette, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "addFavorite", label: "添加到收藏夹", desc: "收藏此文件夹", group: "标记与系统", icon: BookmarkPlus, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir" }) },
  { key: "shelfAdd", label: "添加到暂存区", desc: "加入暂存架稍后统一处理", group: "标记与系统", icon: Bookmark, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "sysMenu", label: "更多系统选项", desc: "系统级右键菜单（打开方式等）", group: "标记与系统", icon: Ellipsis, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "openTerminal", label: "在终端打开", desc: "在此目录打开终端", group: "标记与系统", icon: Terminal, area: "sel", supportsSel: true, supportsBlank: true, cond: C({}) },
  // ── 整理 ──
  { key: "zipHere", label: "压缩…", desc: "压缩为 zip/7z/tar.gz", group: "整理", icon: Archive, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "extract", label: "解压到此处", desc: "解压到压缩包同名子文件夹", group: "整理", icon: PackageOpen, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "zip,7z,rar,tar,tgz,gz,xz,bz2" }) },
  { key: "extractTo", label: "解压到…", desc: "选择目标路径解压", group: "整理", icon: ArchiveRestore, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "zip,7z,rar,tar,tgz,gz,xz,bz2" }) },
  { key: "organizeBy", label: "按规则归类", desc: "按扩展名或修改年月归组移动", group: "整理", icon: FolderTree, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2 }) },
  { key: "findDuplicates", label: "查找重复文件", desc: "按内容指纹找出重复文件", group: "整理", icon: Files, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", maxCount: 1 }) },
  { key: "findEmpty", label: "清理空文件/空文件夹", desc: "扫描空文件与空文件夹后勾删", group: "整理", icon: Eraser, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", maxCount: 1 }) },
  { key: "dirSizes", label: "空间分析", desc: "矩形树图逐层分析目录体积", group: "整理", icon: HardDrive, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", maxCount: 1 }) },
  { key: "compareFolders", label: "文件夹比较", desc: "对比两个文件夹的差异", group: "整理", icon: GitCompare, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", minCount: 2 }) },
  // ── 工具（2026-11-09 新增，对标 TC Create/Verify Checksums、DOpus
  //    Set Attributes、XYplorer/TC Split & Combine、NTLinks 插件）──
  { key: "hashCalc", label: "计算校验值", desc: "计算 MD5/SHA-1/SHA-256/SHA-512", group: "工具", icon: Fingerprint, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file" }) },
  { key: "hashVerify", label: "校验核对", desc: "核对 .md5/.sha256 等校验文件", group: "工具", icon: FileCheck, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1, exts: "md5,sha1,sha256,sha512,md5sums,sha1sums,sha256sums,sha512sums" }) },
  { key: "fileTouch", label: "修改时间与属性", desc: "批量改修改时间/只读/隐藏位", group: "工具", icon: FileClock, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "createLink", label: "创建链接 ▸", desc: "硬链接（同卷）/符号链接", group: "工具", icon: FolderSymlink, area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "fileSplit", label: "文件分割", desc: "按大小切块并生成 .crc 清单", group: "工具", icon: Scissors, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1 }) },
  { key: "fileCombine", label: "文件合并", desc: "合并 .part 部件还原原文件", group: "工具", icon: Merge, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2 }) },
  // 功能库入口入库（2026-11-12 用户定案）：快捷命令面板不再是右键菜单固定
  // 尾项，入库为普通功能——可拖入右键菜单/窗格工具栏、可改条件可移除；
  // 两面可用（选中/空白右键均唤起）。快速命令面板清单内不自列（palette.ts）
  { key: "palette", label: "功能库…", desc: "搜索并直接执行全部功能", group: "工具", icon: Command, area: "both", supportsSel: true, supportsBlank: true, cond: C({}) },
  // ── PDF（2026-11-11 二批扩至十二键：插入空白页/转图片/加密/解密；
  //    「图片合并转 PDF」同日下线——能力由「合并为 PDF」单选覆盖）──
  { key: "pdfMerge", label: "合并为 PDF", desc: "按选中顺序合成一份 PDF（PDF/图片混选均可，单张即可）", group: "PDF", icon: FileStack, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "pdf,jpg,jpeg,png" }) },
  { key: "pdfMergeFolders", label: "按文件夹合并 PDF", desc: "每个文件夹各合成一份", group: "PDF", icon: Library, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", minCount: 1 }) },
  { key: "pdfSplit", label: "PDF 拆分", desc: "按页数或书签拆分为多个 PDF（命名规则/子文件夹可选）", group: "PDF", icon: Split, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1, exts: "pdf" }) },
  { key: "pdfExtract", label: "PDF 提取页", desc: "抽取指定页另存新文件", group: "PDF", icon: FileOutput, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1, exts: "pdf" }) },
  { key: "pdfRemove", label: "PDF 删除页", desc: "删除指定页另存新文件", group: "PDF", icon: FileMinus2, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1, exts: "pdf" }) },
  { key: "pdfRotate", label: "PDF 旋转", desc: "全部页旋转（可逆向还原）", group: "PDF", icon: RotateCw, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1, exts: "pdf" }) },
  { key: "pdfCompress", label: "PDF 轻压缩", desc: "无损瘦身：同内容流去重（合并同字体）+ L9 重压缩", group: "PDF", icon: Minimize2, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "pdf" }) },
  { key: "pdfWatermark", label: "PDF 加水印", desc: "文字水印平铺/角标", group: "PDF", icon: Stamp, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "pdf" }) },
  { key: "pdfInsertBlank", label: "PDF 插入空白页", desc: "12 种模式插补 A4 空白页（凑偶数/凑倍数/指定页码）", group: "PDF", icon: FilePlus, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "pdf" }) },
  { key: "pdfToPng", label: "PDF 转图片", desc: "逐页转 PNG（页范围/分辨率/加密口令）", group: "PDF", icon: Image, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "pdf" }) },
  { key: "pdfEncrypt", label: "PDF 加密", desc: "AES-128 加密 + 打印/复制/编辑权限控制", group: "PDF", icon: Lock, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "pdf" }) },
  { key: "pdfDecrypt", label: "PDF 解密", desc: "输入权限密码解除加密与限制", group: "PDF", icon: LockOpen, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "pdf" }) },
  // ── 图片处理（2026-10-15，Rust src/img/mod.rs；扩展名口径 lib/imgOps.ts）──
  { key: "imgCompress", label: "图片压缩", desc: "Auto/JPEG/PNG8/无损优化", group: "图片处理", icon: Shrink, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: IMG_EXTS }) },
  { key: "imgWatermark", label: "图片加水印", desc: "文字/贴图平铺或角标水印", group: "图片处理", icon: Stamp, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: IMG_EXTS }) },
  { key: "imgConvert", label: "图片格式转换", desc: "PNG/JPEG/BMP/TIFF/WebP 互转", group: "图片处理", icon: Repeat, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: IMG_EXTS }) },
  { key: "imgResize", label: "图片尺寸调整", desc: "按百分比或指定宽高缩放", group: "图片处理", icon: Scaling, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: IMG_EXTS }) },
  { key: "imgMontage", label: "宫格拼图", desc: "多图拼成网格画布", group: "图片处理", icon: Grid3x3, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: MONTAGE_MIN, maxCount: MONTAGE_MAX, exts: IMG_EXTS }) },
  // ── 办公与表格 ──
  { key: "officeToPdf", label: "转为 PDF", desc: "Word/Excel/PPT 转 PDF", group: "办公与表格", icon: Presentation, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "doc,docx,docm,xls,xlsx,xlsm,xlsb,ppt,pptx,pptm,rtf" }) },
  { key: "officeClean", label: "清理隐私属性", desc: "抹除作者/时间等文档属性", group: "办公与表格", icon: ShieldCheck, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "docx,docm,xlsx,xlsm,xlsb,pptx,pptm" }) },
  { key: "officeToTxt", label: "导出文本 TXT", desc: "抽取文档纯文本", group: "办公与表格", icon: FileText, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "docx,docm,pptx,pptm,xlsx,xlsm,xlsb,xls,ods,epub" }) },
  { key: "csvConvert", label: "编码转换 ▸", desc: "UTF-8/GBK 编码互转", group: "办公与表格", icon: Languages, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "csv,tsv,txt,md,log" }) },
  { key: "eolConvert", label: "行尾转换 ▸", desc: "CRLF 与 LF 行尾互转", group: "办公与表格", icon: Replace, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "txt,md,csv,tsv,log,json,xml,yaml,yml,ini,sql,html,css,js,mjs,cjs,ts,tsx,jsx,py,java,cs,c,cpp,h,hpp,rs,go,sh,bat,ps1" }) },
  { key: "csvMerge", label: "CSV 合并", desc: "多 CSV 合并自动去重表头", group: "办公与表格", icon: Table, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2, exts: "csv,tsv" }) },
  { key: "xlsxMerge", label: "Excel 合并", desc: "多工作簿合并为一份", group: "办公与表格", icon: Table2, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2, exts: "xlsx,xlsm,xls,xlsb,ods" }) },
  { key: "textMerge", label: "文本合并", desc: "文本按选中顺序拼接", group: "办公与表格", icon: Text, area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2, exts: "txt,md,log" }) },
  { key: "exportList", label: "导出文件清单", desc: "导出 CSV 清单，直存当前文件夹", group: "办公与表格", icon: ClipboardList, area: "both", supportsSel: true, supportsBlank: true, cond: C({}) },
];

export function builtinByKey(key: string): BuiltinFn | undefined {
  return BUILTIN_FNS.find((f) => f.key === key);
}

/** PDF 功能族（2026-11-11 定案：整组入驻右键菜单）：注册表 PDF 组全部键，
 *  出厂布局整组带入 + 存量档一次性补种（seedPdfEntries）；自注册表按组派生，
 *  组内增删成员时默认布局/补种自动跟进，无需另改两处 */
export const PDF_MENU_KEYS: string[] = BUILTIN_FNS.filter((f) => f.group === "PDF").map(
  (f) => f.key,
);

/** PDF 功能族补种版本：v1 = 九件入驻（2026-11-11 上午），v2 = 插入空白页/
 *  转图片/加密/解密四件扩充（2026-11-11）。仅对「已有自定义布局的存量档」
 *  补种（settings.load 以 saved.menuEntries 是否存在区分——2026-11-12 出厂
 *  默认改收编用户现用方案后，出厂布局不再自带 PDF 组，新装档不补种） */
export const PDF_MENU_SEED_VERSION = 2;

/** 菜单补种总版本：v3 = 功能库入口（builtin:palette）入库默认菜单，存量档
 *  一次性补种到末尾（2026-11-12）。此后菜单级新功能入库 = 版本 +1 */
export const MENU_SEED_VERSION = 3;

/** 功能库分组（2026-10-15 A+B 改版）：展示顺序 = 注册表首现顺序（同组连续，
 *  vitest 固定断言）；目录跳转与胶囊墙按此渲染 */
export function fnGroups(): string[] {
  return [...new Set(BUILTIN_FNS.map((f) => f.group))];
}

/** 功能库 scrollspy：以「滚动容器视口顶部（scrollTop + threshold）触及的最新簇」
 *  为当前组；scrollTop 高于首簇时返回 null，调用方保持原高亮 */
export function spyGroup(
  clusters: { group: string; top: number }[],
  scrollTop: number,
  threshold: number,
): string | null {
  let cur: string | null = null;
  for (const c of clusters) if (c.top <= scrollTop + threshold) cur = c.group;
  return cur;
}

/** 工具栏默认布局（2026-11-12 用户定版 = 现用方案收编为出厂默认；addr =
 *  地址框固定条目。2026-10-15 初版 10 键含 addFavorite/openTerminal，用户
 *  实际使用中移除，收编后 8 键） */
export const TOOLBAR_DEFAULT_KEYS = [
  "up",
  "newFolder",
  "refresh",
  "addr",
  "copyPath",
  "search",
  "splitH",
  "splitV",
] as const;

/** 工具栏「当前文件夹」作用域键：窗格工具（含不在默认表的 view/swap）+
 *  功能库入口 + 天生作用于当前文件夹的功能，工具栏条目默认恒可用；其余
 *  功能默认「依赖选中项」并沿用注册表默认条件。与默认表解耦——不在默认
 *  布局的功能拖入工具栏时作用域判定不变 */
const TOOLBAR_FOLDER_KEYS = new Set<string>([
  "up",
  "view",
  "addr",
  "search",
  "splitH",
  "splitV",
  "swap",
  "newFolder",
  "refresh",
  "copyPath",
  "addFavorite",
  "openTerminal",
  "palette",
]);

/** 工具栏条目构造：作用域默认值按上表区分；菜单功能的数量/类型条件原样带入，
 *  未满足时窗格按钮置灰（toolReady） */
export function builtinToolbarEntry(key: string): MenuEntry {
  const fn = builtinByKey(key);
  return {
    id: `builtin:${key}`,
    kind: "builtin",
    area: fn && TOOLBAR_FOLDER_KEYS.has(key) ? "blank" : "sel",
    cond: fn ? { ...fn.cond } : C({}),
  };
}

export function defaultToolbarEntries(): MenuEntry[] {
  return TOOLBAR_DEFAULT_KEYS.map(builtinToolbarEntry);
}

/** 工具栏地址框归一化：addr 固定常驻（不可移除、可排序）——缺失时插入第 3 位
 *  （与默认布局位置一致，钳制到表长），意外重复去重。加载/导入后必须过一遍。 */
export function ensureToolbarAddr(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  let seen = false;
  for (const en of entries) {
    if (en.id === "builtin:addr") {
      if (seen) continue;
      seen = true;
    }
    out.push(en);
  }
  if (!seen) {
    const at = Math.min(3, out.length);
    out.splice(at, 0, builtinToolbarEntry("addr"));
  }
  return out;
}

/** 基础固定功能（2026-10-15 定案）：这七项常驻右键菜单——不可移除/清空，
 *  但可拖动排序、可改出现条件。按 id 判定保护，不改存储结构。 */
export const FIXED_KEYS = [
  "open",
  "cut",
  "copy",
  "paste",
  "rename",
  "delete",
  "properties",
] as const;

export function isFixedEntryId(id: string): boolean {
  return (
    id.startsWith("builtin:") &&
    (FIXED_KEYS as readonly string[]).includes(id.slice("builtin:".length))
  );
}

export function isFixedEntry(en: MenuEntry): boolean {
  return en.kind === "builtin" && isFixedEntryId(en.id);
}

/** 归一化：去掉意外重复的固定项，并按 FIXED_KEYS 顺序把缺失的固定功能
 *  （用注册表默认区域/条件）追加到末尾。预设应用、配置导入、旧档迁移后必须过一遍。 */
export function ensureFixedEntries(entries: MenuEntry[]): MenuEntry[] {
  const seen = new Set<string>();
  const kept = entries.filter((en) => {
    if (!isFixedEntry(en)) return true;
    if (seen.has(en.id)) return false;
    seen.add(en.id);
    return true;
  });
  for (const key of FIXED_KEYS) {
    const id = `builtin:${key}`;
    if (seen.has(id)) continue;
    const fn = builtinByKey(key);
    if (!fn) continue;
    kept.push({
      id,
      kind: "builtin",
      area: fn.area,
      cond: { ...fn.cond },
    });
    seen.add(id);
  }
  return kept;
}

/** 启用时机标签（总是 / 选中时 / 未选中时）：菜单 = 条目出现的右键语境
 *  （未选中 = 空白处右键），工具栏 = 按钮是否依赖选中项判定 */
export function areaLabel(area: MenuEntry["area"]): string {
  return area === "sel" ? t("选中时") : area === "blank" ? t("未选中时") : t("总是");
}

/** 出现位置按能力位收窄：返回实际生效区域；null = 当前设置下该条目永不显示。
 *  「不限」的语义 = 在支持的区域都出现（AGENTS §4.3：both 仍受能力位约束）——
 *  仅支持选中的功能（如「打开」）选「不限」等效「选中」。 */
export function effectiveArea(
  supportsSel: boolean,
  supportsBlank: boolean,
  area: MenuEntry["area"],
): MenuEntry["area"] | null {
  if (area === "sel") return supportsSel ? "sel" : null;
  if (area === "blank") return supportsBlank ? "blank" : null;
  if (supportsSel && supportsBlank) return "both";
  return supportsSel ? "sel" : supportsBlank ? "blank" : null;
}

/** 条件的人话预览（编辑器浮层底部实时回显，增强可理解性）：
 *  「选中条目时显示 · 仅文件 · 至少 2 项 · 类型 pdf（不区分大小写）」 */
export function condSentence(cond: MenuCond, area: MenuEntry["area"]): string {
  const pos =
    area === "both"
      ? t("总是显示")
      : area === "sel"
        ? t("选中条目时显示")
        : t("未选中时显示（空白处）");
  const obj =
    cond.target === "all"
      ? t("对象不限")
      : cond.target === "file"
        ? t("仅文件")
        : t("仅文件夹");
  const min = cond.minCount ?? 1;
  const max = cond.maxCount;
  const cnt =
    min > 1 && max > 0
      ? t("第 {a}–{b} 项", { a: min, b: max })
      : min > 1
        ? t("至少 {n} 项", { n: min })
        : max > 0
          ? t("至多 {n} 项", { n: max })
          : t("数量不限");
  const exts = cond.exts
    .split(/[,，;；\s]+/)
    .filter(Boolean)
    .join(" / ");
  const ext = exts ? ` · ${t("类型")} ${exts}${t("（不区分大小写）")}` : "";
  return `${pos} · ${obj} · ${cnt}${ext}`;
}

/** 条件判定：blank 恒可见（能力开关在渲染端约束）；sel 按对象/数量/扩展名过滤。
 *  exts 非空时所有选中须为匹配扩展名的文件（文件夹不适用）。 */
export function entryVisible(
  cond: MenuCond,
  area: MenuArea,
  items: { name: string; isDir: boolean }[] | null,
): boolean {
  if (area === "blank") return true;
  if (!items || !items.length) return false;
  const min = Math.max(cond.minCount ?? 1, 1);
  if (items.length < min) return false;
  if (cond.maxCount > 0 && items.length > cond.maxCount) return false;
  if (cond.target === "file" && items.some((i) => i.isDir)) return false;
  if (cond.target === "dir" && items.some((i) => !i.isDir)) return false;
  const allow = parseExts(cond.exts ?? "");
  if (allow.length && !items.every((i) => !i.isDir && allow.includes(extOfName(i.name)))) {
    return false;
  }
  return true;
}

// 局部扩展名提取（避免依赖 fileIcons 的 BY_EXT 大表）
function extOfName(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 && i + 1 < name.length ? name.slice(i + 1).toLowerCase() : "";
}

/// "txt, md；ZIP" → ["txt","md","zip"]（中英文逗号/顿号/空格/分号混排均可，点号归一）
export function parseExts(exts: string): string[] {
  return exts
    .split(/[,，;；\s]+/)
    .map((s) => s.replace(/^\./, "").toLowerCase())
    .filter(Boolean);
}

let seq = 0;
/** 稳定随机 id（sep 条目） */
export function newMenuId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${++seq}`;
  return `${prefix}:${rand}`;
}

/** 默认菜单构建器：e = 内置功能条目（默认条件 + 补丁），sep = 分割线（全新 id，
 *  重复重置不产生重复 key） */
function presetBuilder() {
  const e = (
    key: string,
    area: MenuArea,
    condPatch?: Partial<MenuCond>,
  ): MenuEntry => {
    const fn = builtinByKey(key);
    if (!fn) throw new Error(`unknown builtin: ${key}`);
    return {
      id: `builtin:${key}`,
      kind: "builtin",
      area,
      cond: C({ ...fn.cond, ...condPatch }),
    };
  };
  const sep = (area: MenuArea): MenuEntry => ({
    id: newMenuId("sep"),
    kind: "sep",
    area,
    cond: C({}),
  });
  return { e, sep };
}

/** 出厂菜单布局（2026-11-12 用户定版 = 现用方案收编：常见基础功能 +
 *  「功能库…」尾段；资源管理器惯例排序。2026-10-15 初版与 2026-11-11 的
 *  PDF 组/copyPath/copyName 块随本次收编退出出厂布局——仍可从功能库拖入；
 *  互传/标记等进阶功能同样留功能库自行拖入。
 *  粘贴一条两用（area=both）：选中语境排在复制旁，空白语境排在新建前；
 *  功能库两用（both）尾段：选中/空白右键均可唤起 */
export function defaultMenuEntries(): MenuEntry[] {
  const { e, sep } = presetBuilder();
  return [
    e("open", "sel"),
    e("preview", "sel"),
    e("cut", "sel"),
    e("copy", "sel"),
    e("paste", "both"),
    sep("both"),
    e("delete", "sel"),
    e("rename", "sel"),
    e("new", "blank"),
    e("properties", "sel"),
    sep("both"),
    e("palette", "both"),
  ];
}

/** 功能库入口补种（2026-11-12 定案）：builtin:palette 入库默认菜单后，
 *  已保存布局一次性在末尾追加（分割线 + 条目，注册表默认区域/条件，可在
 *  编辑器拖动/移除；末尾已是分割线时不重复加）。由 settings.load 的
 *  MENU_SEED_VERSION 门闸保证只跑一次，已有该条目（含手动拖入过）幂等跳过 */
export function seedPaletteEntry(entries: MenuEntry[]): MenuEntry[] {
  if (entries.some((en) => en.id === "builtin:palette")) return entries;
  const fn = builtinByKey("palette");
  if (!fn) return entries;
  const needSep = entries.length > 0 && entries[entries.length - 1].kind !== "sep";
  return [
    ...entries,
    ...(needSep ? [{ id: newMenuId("sep"), kind: "sep" as const, area: "both" as const, cond: C({}) }] : []),
    { id: "builtin:palette", kind: "builtin", area: fn.area, cond: { ...fn.cond } },
  ];
}

/** 存量档补种（2026-11-11 定案）：PDF 功能族入驻出厂菜单后，已保存布局
 *  一次性追加缺失的 PDF 组条目（注册表默认区域/条件，追加在末尾，可在
 *  编辑器拖动排序）。由 settings.load 的 pdfMenuSeeded 标记保证只跑一次——
 *  此后用户在编辑器里删减的 PDF 条目重启不回填（尊重自定义，区别于固定项） */
export function seedPdfEntries(entries: MenuEntry[]): MenuEntry[] {
  const out = [...entries];
  const seen = new Set(entries.map((en) => en.id));
  for (const key of PDF_MENU_KEYS) {
    const id = `builtin:${key}`;
    if (seen.has(id)) continue;
    const fn = builtinByKey(key);
    if (!fn) continue;
    out.push({ id, kind: "builtin", area: fn.area, cond: { ...fn.cond } });
    seen.add(id);
  }
  return out;
}

/** 旧档清理（2026-10-14 定案：命令模板功能下线）：剔除引用自定义命令的菜单条目。
 *  渲染端反查不到命令本就会跳过，加载时统一清掉，防编辑器残留「未命名命令」死行；
 *  模板数据本身（settings.customCommands）留档不删，仅功能面移除。 */
export function stripCustomEntries(entries: MenuEntry[]): MenuEntry[] {
  return entries.filter((en) => en.kind !== "custom");
}
