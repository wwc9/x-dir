// 文件列表能力注册表：全局快捷键通过它调用"活动窗格列表"的操作，
// 避免把条目数据提升进全局 store（§4.3 铁律 3）。
import type { FileEntry } from "./ipc";
import type { MenuItem } from "../stores/ui";

export interface ListHandlers {
  onArrow(dir: "up" | "down" | "left" | "right", extend: boolean): void;
  /** 翻页/首尾移动（§7.2 PgUp/PgDn/Home/End） */
  onNav(key: "pageup" | "pagedown" | "home" | "end", extend: boolean): void;
  onEnter(): void;
  onBackspace(): void;
  /** permanent = Shift+Del 永久删除（绕过回收站，前端强制确认） */
  onDelete(permanent: boolean): void;
  onRename(): void;
  /** Alt+Enter / 右键菜单"属性" */
  onProperties(): void;
  /** Shift+F10 / ContextMenu 键：键盘呼出选中项右键菜单 */
  onContextMenu(): void;
  onSelectAll(): void;
  onCopy(cut: boolean): void;
  onPaste(): void;
  /** Ctrl+Shift+C / X：复制/移动选中项到"目标窗格"（每窗格记忆上次对侧） */
  onTransferToPane(move: boolean): void;
  onRefresh(force: boolean): void;
  onNewFolder(): void;
  /** 快速预览：按需取当前列表快照（条目 = 当前视图顺序，selected = 选中名），
   *  数据仍留在列表组件内，仅读取时拉取（铁律 3 口径不变） */
  getSnapshot(): { entries: FileEntry[]; selected: string[] };
  /** 定位到指定条目：设为选中并滚动到可见（预览"打开所在文件夹"用） */
  revealEntry(name: string): void;
  /** 定制工具栏：按内置功能 key 解析执行项（sel = 当前窗格选中条目）。
   *  仅菜单功能需要——窗格工具由 Pane 原生执行，不走此回调 */
  builtinMenuItem?(key: string, sel: FileEntry[]): MenuItem | null;
}

const registry = new Map<string, ListHandlers>();

export function registerList(tabId: string, h: ListHandlers): () => void {
  registry.set(tabId, h);
  return () => {
    if (registry.get(tabId) === h) registry.delete(tabId);
  };
}

export function getList(tabId: string | null | undefined): ListHandlers | null {
  return tabId ? (registry.get(tabId) ?? null) : null;
}
