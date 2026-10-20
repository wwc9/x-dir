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
  /** Excel 合并（右键"Excel 合并"，2026-10-17）：模式 + 输出名一次成形 */
  | { type: "xlsxMerge"; count: number };;

/** 提示弹窗语义级别：info=主操作、warn=警示、danger=不可逆/错误 */
export type DialogKind = "info" | "warn" | "danger";

/** 标准确认弹窗（取消/确定，Esc 或点遮罩 = 取消） */
export function confirmDialog(opts: {
  title?: string;
  message: string;
  kind?: DialogKind;
  okText?: string;
  cancelText?: string;
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
