import { create } from "zustand";

import { api, THIS_PC } from "../lib/ipc";
import { useSettings } from "./settings";

// 导航树：children 缓存留在本 store（内存态）；
// 宽度/可见性/展开节点为用户偏好，集中寄存 settings（2026-10-12 配置集中化）。

interface NavTreeStore {
  /** 子目录名缓存（键 = 父路径；THIS_PC = 盘符列表） */
  children: Record<string, string[]>;
  /** 最近一次定位的节点（窗格点击行 → 树高亮滚动；会话态不持久化） */
  located: string | null;
  locate(path: string): void;
  toggleDir(path: string): void;
  loadDir(path: string): Promise<void>;
  refresh(): void;
}

export const TREE_W_MIN = 160;
export const TREE_W_MAX = 360;

/** 折叠节点时连同其整棵已展开子树一并收起 */
function withSubtreeRemoved(expanded: string[], path: string): string[] {
  const prefix = path.endsWith("\\") ? path : path + "\\";
  return expanded.filter((k) => k !== path && !k.startsWith(prefix));
}

export const useNavTree = create<NavTreeStore>()((set, get) => ({
  children: {},
  located: null,

  /** 定位：展开状态替换为目标的祖先链（虚拟根/盘符根/逐级父目录，不含目标本身）——
   *  其他已展开分支自动折叠，避免树无限变长；补载子目录、标记定位节点。
   *  链与当前展开状态一致时零开销（不写 settings）。中间段需去尾反斜杠——
   *  树节点路径由 treeChildPath 生成，不带尾反斜杠 */
  locate(path) {
    const s = useSettings.getState();
    const chain: string[] = [THIS_PC];
    if (path !== THIS_PC) {
      let i = path.indexOf("\\");
      while (i >= 0) {
        const seg = path.slice(0, i + 1);
        const clean = seg.length > 3 ? seg.replace(/\\+$/, "") : seg;
        if (clean !== path) chain.push(clean);
        i = path.indexOf("\\", i + 1);
      }
    }
    const cur = s.navTreeExpanded;
    const same =
      cur.length === chain.length && chain.every((c, i) => cur[i] === c);
    if (!same) s.update({ navTreeExpanded: chain });
    for (const c of chain) void get().loadDir(c);
    set({ located: path });
  },

  toggleDir(path) {
    const s = useSettings.getState();
    const isOpen = s.navTreeExpanded.includes(path);
    const expanded = isOpen
      ? withSubtreeRemoved(s.navTreeExpanded, path)
      : [...s.navTreeExpanded, path];
    s.update({ navTreeExpanded: expanded });
    if (!isOpen) void get().loadDir(path);
  },

  async loadDir(path) {
    if (get().children[path]) return;
    try {
      if (path === THIS_PC) {
        const drives = await api.getDrives();
        set({ children: { ...get().children, [path]: drives.map((d) => d.letter) } });
        return;
      }
      const names = await api.listDirs(path, useSettings.getState().showHidden);
      set({ children: { ...get().children, [path]: names } });
    } catch {
      // 读取失败（无权限等）按空目录处理，节点仍可折叠
      set({ children: { ...get().children, [path]: [] } });
    }
  },

  refresh() {
    set({ children: {} });
    for (const p of useSettings.getState().navTreeExpanded) void get().loadDir(p);
  },
}));

/** 树内父子路径拼接：盘符根（C:\）直接连名，其余补分隔符 */
export function treeChildPath(parent: string, name: string): string {
  return parent.endsWith("\\") ? parent + name : parent + "\\" + name;
}
