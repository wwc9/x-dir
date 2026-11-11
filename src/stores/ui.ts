import { create } from "zustand";

import type { FileEntry } from "../lib/ipc";
import type { SettingsTabId } from "../components/SettingsPanel";
import type { UpdateCheck } from "../lib/update";
import { useLayout } from "./layout";
import { useIsland } from "./island";

export type DialogSpec =
  | {
      type: "confirm";
      title?: string;
      message: string;
      /** 语义级别：决定标题图标与确认按钮 intent（默认 info） */
      kind?: DialogKind;
      okText?: string;
      cancelText?: string;
      /** 可选「记住选择」勾选（2026-11-05）：勾选并按确定时触发——
       *  删除确认用它落盘关闭「删除前确认」，替代用户进设置手动关 */
      rememberLabel?: string;
      onRemember?: () => void;
    }
  | {
      type: "alert";
      title?: string;
      message: string;
      kind?: DialogKind;
      okText?: string;
    }
  | {
      type: "input";
      title: string;
      label?: string;
      initial?: string;
      okText?: string;
      /** 掩码显示（压缩包密码输入等） */
      mask?: boolean;
      validate?(v: string): string | null;
    }
  | { type: "conflict"; items: string[] }
  | { type: "properties"; entry: FileEntry; freeBytes?: number }
  /** 批量重命名（右键"批量重命名"）：带选中项入场，解析出可执行改名清单 */
  | { type: "batchRename"; entries: FileEntry[] }
  /** 重复文件查找（右键"查找重复文件"）：对选中目录扫描 */
  | { type: "duplicates"; dir: string }
  /** 空间分析（右键"空间分析"）：目录体积树，可逐层钻取 */
  | { type: "dirsizes"; dir: string }
  /** 文件夹比较（右键"文件夹比较"）：选中恰好 2 个目录 */
  | { type: "compare"; a: string; b: string }
  /** 图片处理五件套（右键「图片处理」组，2026-10-15）：带选中图片入场 */
  | { type: "imgCompress"; entries: FileEntry[] }
  | { type: "imgWatermark"; entries: FileEntry[] }
  | { type: "imgConvert"; entries: FileEntry[] }
  | { type: "imgResize"; entries: FileEntry[] }
  | { type: "imgMontage"; entries: FileEntry[] }
  /** 空文件/空文件夹清理（右键"清理空文件/空文件夹"，2026-10-17）：扫描后勾删 */
  | { type: "emptyScan"; dir: string }
  /** 批量新建文件夹（右键"批量新建文件夹"，2026-10-17）：名单/序号模板预演后创建 */
  | { type: "newFolders"; dir: string; existing: string[] }
  /** Excel 合并（右键"Excel 合并"，2026-10-17；2026-11-03 §4.9 清单化）：
   *  清单拖动定序 + 模式 + 输出名一次成形 */
  | { type: "xlsxMerge"; entries: FileEntry[] }
  /** PDF 合并扩展（2026-10-22）：混列 PDF/图片 + 按文件夹分组 + 空白页凑偶数 */
  | { type: "pdfMerge"; variant: "files" | "folders"; entries: FileEntry[] }
  /** PDF 加水印（右键"PDF 加水印"，2026-10-22 参数化）：带选中 PDF 入场 */
  | { type: "pdfWatermark"; entries: FileEntry[] }
  /** 通用文件合并（2026-11-03 §4.9 对齐，取代裸输入框）：图片转 PDF / CSV / 文本 / zip 打包 */
  | { type: "filesMerge"; flavor: "images" | "csv" | "text" | "zip"; entries: FileEntry[] }
  /** PDF 提取页/删除页（2026-11-03 §4.9 对齐）：页数回显 + 范围解析预演 */
  | { type: "pdfPages"; mode: "extract" | "remove"; entry: FileEntry }
  /** 解除占用（2026-11-01）：删除撞上占用失败的路径入场，可关句柄后按原语义重删 */
  | { type: "unlock"; items: string[]; permanent: boolean }
  /** 计算校验值（2026-11-09 功能库「工具」组）：带选中文件入场，算法可切换 */
  | { type: "hashCalc"; entries: FileEntry[] }
  /** 校验核对（选中一个 .md5/.sha256 等校验文件，逐项哈希比对） */
  | { type: "hashVerify"; path: string }
  /** 修改时间与属性（批量改修改/访问时间、只读/隐藏位） */
  | { type: "fileTouch"; entries: FileEntry[] }
  /** 文件分割（按大小切块 + .crc 清单） */
  | { type: "fileSplit"; entry: FileEntry }
  /** 导出文件清单参数面板（2026-11-10）：entries 空 = 空白处语境（导出整个
   *  文件夹），否则导出选中项；回执 ExportListingOptions 给 runExportListing */
  | { type: "exportListing"; entries: FileEntry[]; dir: string }
  /** PDF 拆分参数面板（2026-11-10 参数化）：按页数 N / 按书签层级 + 命名
   *  规则 + 子文件夹选项，回执 PdfSplitOptions 给 runPdfSplit */
  | { type: "pdfSplit"; entry: FileEntry; dir: string }
  /** PDF 插入空白页（2026-11-11）：12 种模式参数面板，回执给 insertBlankPages */
  | { type: "pdfInsertBlank"; entries: FileEntry[] }
  /** PDF 转图片（2026-11-11）：页范围/分辨率/口令/子文件夹，回执给 pdfToPngs */
  | { type: "pdfToPng"; entries: FileEntry[] }
  /** PDF AES-128 加密（2026-11-11）：口令 + 三权限位，回执给 encryptPdfs */
  | { type: "pdfEncrypt"; entries: FileEntry[] }
  /** PDF 解密（2026-11-11）：权限密码输入，回执给 decryptPdfs */
  | { type: "pdfDecrypt"; entries: FileEntry[] };

/** 提示弹窗语义级别：info=主操作、warn=警示、danger=不可逆/错误 */
export type DialogKind = "info" | "warn" | "danger";

/** 标准确认弹窗（取消/确定，Esc 或点遮罩 = 取消）；rememberLabel/onRemember
 *  = 可选「以后不再确认」勾选（勾选并确定时触发，见 DialogSpec confirm） */
export function confirmDialog(opts: {
  title?: string;
  message: string;
  kind?: DialogKind;
  okText?: string;
  cancelText?: string;
  rememberLabel?: string;
  onRemember?: () => void;
}): Promise<boolean | null> {
  return useUi.getState().openDialog<boolean | null>({ type: "confirm", ...opts });
}

/** 标准提醒弹窗（仅一个确定按钮，用于阻断式提示） */
export function alertDialog(opts: {
  title?: string;
  message: string;
  kind?: DialogKind;
  okText?: string;
}): Promise<null> {
  return useUi.getState().openDialog<null>({ type: "alert", ...opts });
}

/** 关闭窗格确认（窗格关闭按钮与 Ctrl+Shift+W 共用）：确认后关闭指定窗格 */
export function closePaneConfirmed(paneId: string): void {
  void confirmDialog({
    title: "关闭窗格",
    message: "确定关闭此窗格吗？其中的所有标签页将一并关闭。",
    kind: "warn",
    okText: "关闭",
  }).then((ok) => {
    if (ok) useLayout.getState().close(paneId);
  });
}

export interface MenuItem {
  label?: string;
  sep?: boolean;
  disabled?: boolean;
  danger?: boolean;
  action?: () => void;
  sub?: MenuItem[];
}

/** 首字母跳转（type-ahead）回显：活动窗格列表角落的定位 pill */
export interface TypeAheadState {
  buf: string;
  /** 当前命中条目名（无命中为 null） */
  hit: string | null;
  /** 命中在匹配集中的序位（1 起，重复首字母循环时回显 "x/y"） */
  pos?: number;
  /** 匹配集总数 */
  total?: number;
  /** 生效匹配针与档位（2026-11-05）：行内命中高亮随 pill 存续（lib/typeAhead
   *  matchRangeOf 消费；Tab 循环 / Backspace 回删也在 pill 激活期生效） */
  needle?: string;
  mode?: "prefix" | "contains" | "pymid";
}

interface UiStore {
  dialog: DialogSpec | null;
  dialogResolve: ((v: unknown) => void) | null;
  menu: { items: MenuItem[]; x: number; y: number } | null;
  /** 全盘搜索面板（Everything 式，Ctrl+Shift+F / 顶栏按钮唤起） */
  globalSearch: boolean;
  /** 设置浮窗（Dialog，2026-10-14 回归浮窗样式）：null = 关闭；非空 = 当前分类 id */
  settingsTab: SettingsTabId | null;
  /** 右键菜单独立页（占满顶栏以下内容区，顶栏指针钮唤起，Esc 返回） */
  menuPage: boolean;
  /** 关于浮窗（Dialog）：工具简介/开源地址/作者 + 更新检查（顶栏信息钮与启动检查共用） */
  aboutOpen: boolean;
  /** 更新检查结果：null = 尚未检查过；manifest 为 null = 双源都拉取失败 */
  updateCheck: UpdateCheck | null;
  /** 窗格交换选择模式：非空 = 该窗格已按下"交换"，等待点选目标窗格 */
  swapFrom: string | null;
  /** type-ahead 输入回显（lib/keyboard 维护；null = 无输入中缓冲） */
  typeAhead: TypeAheadState | null;
  setTypeAhead(t: TypeAheadState | null): void;
  openDialog<T>(spec: DialogSpec): Promise<T | null>;
  resolveDialog(v: unknown): void;
  openMenu(items: MenuItem[], x: number, y: number): void;
  closeMenu(): void;
  openGlobalSearch(): void;
  closeGlobalSearch(): void;
  /** 退出全部整页（全盘搜索/定制互斥）：顶栏主界面类按钮先回主界面再执行动作 */
  exitPages(): void;
  openSettings(tab: SettingsTabId): void;
  closeSettings(): void;
  openMenuPage(): void;
  closeMenuPage(): void;
  openAbout(): void;
  closeAbout(): void;
  setUpdateCheck(c: UpdateCheck): void;
  beginSwap(paneId: string): void;
  cancelSwap(): void;
  /** 提示播报（2026-10-15 并入灵动岛回执，独立 toast 窗口已移除）：
   *  error → fail 徽标驻留 6s（错误值得多看两眼），其余 → ok 徽标驻留 4s */
  toast(text: string, kind?: "info" | "error"): void;
}

export const useUi = create<UiStore>()((set, get) => ({
  dialog: null,
  dialogResolve: null,
  menu: null,
  globalSearch: false,
  settingsTab: null,
  menuPage: false,
  aboutOpen: false,
  updateCheck: null,
  swapFrom: null,
  typeAhead: null,

  setTypeAhead(t) {
    set({ typeAhead: t });
  },

  openDialog<T>(spec: DialogSpec): Promise<T | null> {
    return new Promise((resolve) => {
      // 已有弹窗在开：旧 Promise 立即以"取消"收场（Esc 语义）——
      // 直接覆盖会让上一个 await 永久悬挂，第一次操作静默丢失
      const prev = get().dialogResolve;
      set({ dialog: spec, dialogResolve: resolve as (v: unknown) => void });
      prev?.(null);
    });
  },

  resolveDialog(v: unknown) {
    const r = get().dialogResolve;
    set({ dialog: null, dialogResolve: null });
    r?.(v);
  },

  openMenu(items, x, y) {
    // 全部条目被能力位/条件过滤后为空：不开菜单（否则会弹一个空浮层）
    if (!items.length) return;
    set({ menu: { items, x, y } });
  },

  closeMenu() {
    set({ menu: null });
  },

  openGlobalSearch() {
    // 整页互斥（2026-10-16 定案）：打开全盘搜索即退出定制页
    set({ globalSearch: true, menuPage: false });
  },

  closeGlobalSearch() {
    set({ globalSearch: false });
  },

  /** 退出全部整页（全盘搜索/定制互斥）：顶栏主界面类按钮先回主界面再执行动作 */
  exitPages() {
    set({ menuPage: false, globalSearch: false });
  },

  openSettings(tab) {
    set({ settingsTab: tab });
  },

  closeSettings() {
    set({ settingsTab: null });
  },

  openMenuPage() {
    // 整页互斥：打开定制即退出全盘搜索
    set({ menuPage: true, globalSearch: false });
  },

  closeMenuPage() {
    set({ menuPage: false });
  },

  openAbout() {
    set({ aboutOpen: true });
  },

  closeAbout() {
    set({ aboutOpen: false });
  },

  setUpdateCheck(c) {
    set({ updateCheck: c });
  },

  beginSwap(paneId) {
    set({ swapFrom: paneId });
    // 提示由灵动岛「交换窗格」模式通道承担（优先级高于回执，无需再播报）
  },

  cancelSwap() {
    set({ swapFrom: null });
  },

  toast(text, kind = "info") {
    if (kind === "error") {
      useIsland.getState().pushReceipt("fail", text, { dwellMs: 6_000 });
    } else {
      useIsland.getState().pushReceipt("ok", text);
    }
  },
}));
