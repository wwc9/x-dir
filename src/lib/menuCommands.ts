// 右键菜单功能库（内置功能注册表）+ 条件判定纯函数 + 预设菜单/工具栏布局。
// 菜单布局 = settings.menuEntries（有序 MenuEntry），渲染方（FileList）按
// entryVisible 过滤后交给各功能的执行器；本模块只描述"有什么功能、默认条件"，
// 不持有执行逻辑（执行器闭包在 FileList 组件内，避免把列表状态提升进全局）。
import type { MenuCond, MenuEntry } from "./ipc";
import { IMG_EXTS, MONTAGE_MAX, MONTAGE_MIN } from "./imgOps";

export type MenuArea = "sel" | "blank" | "both";

export interface BuiltinFn {
  /** 稳定 key（MenuEntry.id = "builtin:" + key） */
  key: string;
  label: string;
  /** 功能库分组标题 */
  group: string;
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

/** 内置功能库（顺序 = 功能库展示顺序；2026-10-15 分组重整：
 *  「窗格」拆为窗格协作（两面共享的互传）与窗格工具（仅工具栏），「新建与视图」
 *  拆为新建与选择 / 视图；组序按使用频率与逻辑流排列，同组条目在表内连续） */
export const BUILTIN_FNS: BuiltinFn[] = [
  // ── 文件 ──
  { key: "open", label: "打开", group: "文件", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ maxCount: 1 }) },
  { key: "openTab", label: "在新标签打开", group: "文件", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", maxCount: 1 }) },
  { key: "rename", label: "重命名", group: "文件", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ maxCount: 1 }) },
  { key: "batchRename", label: "批量重命名", group: "文件", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ minCount: 2 }) },
  { key: "delete", label: "删除", group: "文件", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "deletePerm", label: "永久删除", group: "文件", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "properties", label: "属性", group: "文件", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ maxCount: 1 }) },
  // ── 剪贴板 ──
  { key: "cut", label: "剪切", group: "剪贴板", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "copy", label: "复制", group: "剪贴板", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "paste", label: "粘贴", group: "剪贴板", area: "both", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "copyPath", label: "复制路径", group: "剪贴板", area: "sel", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "copyName", label: "复制名称", group: "剪贴板", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  // ── 新建与选择 ──
  { key: "newFolder", label: "新建文件夹", group: "新建与选择", area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "newFile", label: "新建文本文件", group: "新建与选择", area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "newFolders", label: "批量新建文件夹", group: "新建与选择", area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  // 新建 = 子菜单聚合（文件夹 / 文本 / 常用办公格式），子项执行器在 FileList
  { key: "new", label: "新建", group: "新建与选择", area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "selectAll", label: "全选", group: "新建与选择", area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "reverseSelect", label: "反向选择", group: "新建与选择", area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  // ── 视图 ──
  { key: "preview", label: "预览", group: "视图", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "refresh", label: "刷新", group: "视图", area: "blank", supportsSel: true, supportsBlank: true, cond: C({}) },
  { key: "toggleHidden", label: "切换隐藏文件", group: "视图", area: "blank", supportsSel: false, supportsBlank: true, cond: C({}) },
  // ── 窗格协作（作用于选中项，菜单/工具栏两面共享）──
  { key: "copyToPane", label: "复制到窗格", group: "窗格协作", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "moveToPane", label: "移动到窗格", group: "窗格协作", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  // ── 窗格工具（2026-10-15 并入功能库，与右键菜单共享）：仅工具栏可用——
  //    无选中语义，supportsSel/Blank 双 false 使其不可拖入右键菜单；
  //    工具栏条目默认「当前文件夹」恒可用（见 builtinToolbarEntry 的作用域区分）
  { key: "up", label: "上一级", group: "窗格工具", area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "view", label: "视图类型", group: "窗格工具", area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "addr", label: "地址框", group: "窗格工具", area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "search", label: "搜索当前文件夹", group: "窗格工具", area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "splitH", label: "横向分裂", group: "窗格工具", area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "splitV", label: "纵向分裂", group: "窗格工具", area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  { key: "swap", label: "交换窗格", group: "窗格工具", area: "blank", supportsSel: false, supportsBlank: false, cond: C({}) },
  // ── 标记与系统 ──
  { key: "colorTag", label: "颜色标记", group: "标记与系统", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "addFavorite", label: "添加到收藏夹", group: "标记与系统", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir" }) },
  { key: "shelfAdd", label: "添加到暂存区", group: "标记与系统", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "sysMenu", label: "更多系统选项", group: "标记与系统", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "openTerminal", label: "在终端打开", group: "标记与系统", area: "sel", supportsSel: true, supportsBlank: true, cond: C({}) },
  // ── 整理 ──
  { key: "zipHere", label: "压缩为 zip", group: "整理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
  { key: "extract", label: "解压到此处", group: "整理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "zip,7z" }) },
  { key: "organizeBy", label: "按规则归类", group: "整理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2 }) },
  { key: "findDuplicates", label: "查找重复文件", group: "整理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", maxCount: 1 }) },
  { key: "findEmpty", label: "清理空文件/空文件夹", group: "整理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", maxCount: 1 }) },
  { key: "dirSizes", label: "空间分析", group: "整理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", maxCount: 1 }) },
  { key: "compareFolders", label: "文件夹比较", group: "整理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "dir", minCount: 2 }) },
  // ── PDF ──
  { key: "pdfMerge", label: "PDF 合并", group: "PDF", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2, exts: "pdf" }) },
  { key: "pdfSplit", label: "PDF 拆分为单页", group: "PDF", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1, exts: "pdf" }) },
  { key: "pdfExtract", label: "PDF 提取页", group: "PDF", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1, exts: "pdf" }) },
  { key: "pdfRemove", label: "PDF 删除页", group: "PDF", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1, exts: "pdf" }) },
  { key: "pdfRotate", label: "PDF 旋转", group: "PDF", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", maxCount: 1, exts: "pdf" }) },
  { key: "pdfCompress", label: "PDF 轻压缩", group: "PDF", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "pdf" }) },
  { key: "pdfWatermark", label: "PDF 加水印", group: "PDF", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "pdf" }) },
  // ── 图片处理（2026-10-15，Rust src/img/mod.rs；扩展名口径 lib/imgOps.ts）──
  { key: "imgCompress", label: "图片压缩", group: "图片处理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: IMG_EXTS }) },
  { key: "imgWatermark", label: "图片加水印", group: "图片处理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: IMG_EXTS }) },
  { key: "imgConvert", label: "图片格式转换", group: "图片处理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: IMG_EXTS }) },
  { key: "imgResize", label: "图片尺寸调整", group: "图片处理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: IMG_EXTS }) },
  { key: "imgMontage", label: "宫格拼图", group: "图片处理", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: MONTAGE_MIN, maxCount: MONTAGE_MAX, exts: IMG_EXTS }) },
  // ── 办公 ──
  { key: "imgToPdf", label: "图片合并转 PDF", group: "办公", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "png,jpg,jpeg" }) },
  { key: "officeToPdf", label: "转为 PDF", group: "办公", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "doc,docx,docm,xls,xlsx,xlsm,xlsb,ppt,pptx,pptm,rtf" }) },
  { key: "officeClean", label: "清理隐私属性", group: "办公", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "docx,docm,xlsx,xlsm,xlsb,pptx,pptm" }) },
  { key: "officeToTxt", label: "导出文本 TXT", group: "办公", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "docx,docm,pptx,pptm,xlsx,xlsm,xlsb,xls,ods,epub" }) },
  // ── 表格与文本 ──
  { key: "csvConvert", label: "编码转换", group: "表格与文本", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", exts: "csv,tsv,txt,md,log" }) },
  { key: "csvMerge", label: "CSV 合并", group: "表格与文本", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2, exts: "csv,tsv" }) },
  { key: "xlsxMerge", label: "Excel 合并", group: "表格与文本", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2, exts: "xlsx,xlsm,xls,xlsb,ods" }) },
  { key: "textMerge", label: "文本合并", group: "表格与文本", area: "sel", supportsSel: true, supportsBlank: false, cond: C({ target: "file", minCount: 2, exts: "txt,md,log" }) },
  { key: "exportList", label: "导出文件清单", group: "表格与文本", area: "sel", supportsSel: true, supportsBlank: false, cond: C({}) },
];

export function builtinByKey(key: string): BuiltinFn | undefined {
  return BUILTIN_FNS.find((f) => f.key === key);
}

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

/** 工具栏默认布局（2026-10-15 定案 = 用户定稿排列；addr = 地址框固定条目） */
export const TOOLBAR_DEFAULT_KEYS = [
  "up",
  "newFolder",
  "refresh",
  "addr",
  "copyPath",
  "addFavorite",
  "search",
  "openTerminal",
  "splitH",
  "splitV",
] as const;

/** 工具栏「当前文件夹」作用域键：窗格工具（含不在默认表的 view/swap）+
 *  天生作用于当前文件夹的功能，工具栏条目默认恒可用；其余功能默认
 *  「依赖选中项」并沿用注册表默认条件。与默认表解耦——不在默认布局的
 *  功能拖入工具栏时作用域判定不变 */
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
  return area === "sel" ? "选中时" : area === "blank" ? "未选中时" : "总是";
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
      ? "总是显示"
      : area === "sel"
        ? "选中条目时显示"
        : "未选中时显示（空白处）";
  const obj =
    cond.target === "all"
      ? "对象不限"
      : cond.target === "file"
        ? "仅文件"
        : "仅文件夹";
  const min = cond.minCount ?? 1;
  const max = cond.maxCount;
  const cnt =
    min > 1 && max > 0
      ? `第 ${min}–${max} 项`
      : min > 1
        ? `至少 ${min} 项`
        : max > 0
          ? `至多 ${max} 项`
          : "数量不限";
  const exts = cond.exts
    .split(/[,，;；\s]+/)
    .filter(Boolean)
    .join(" / ");
  const ext = exts ? ` · 类型 ${exts}（不区分大小写）` : "";
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

/** 出厂菜单布局（2026-10-15 用户定版：常见基础功能，资源管理器惯例排序；
 *  PDF/互传/标记等进阶功能留在功能库自行拖入）。
 *  粘贴一条两用（area=both）：选中语境排在复制旁，空白语境排在新建前 */
export function defaultMenuEntries(): MenuEntry[] {
  const { e, sep } = presetBuilder();
  return [
    e("open", "sel"),
    e("preview", "sel"),
    e("cut", "sel"),
    e("copy", "sel"),
    e("paste", "both"),
    sep("both"),
    e("copyPath", "sel"),
    e("copyName", "sel"),
    sep("both"),
    e("delete", "sel"),
    e("rename", "sel"),
    e("new", "blank"),
    e("properties", "sel"),
  ];
}

/** 旧档清理（2026-10-14 定案：命令模板功能下线）：剔除引用自定义命令的菜单条目。
 *  渲染端反查不到命令本就会跳过，加载时统一清掉，防编辑器残留「未命名命令」死行；
 *  模板数据本身（settings.customCommands）留档不删，仅功能面移除。 */
export function stripCustomEntries(entries: MenuEntry[]): MenuEntry[] {
  return entries.filter((en) => en.kind !== "custom");
}
