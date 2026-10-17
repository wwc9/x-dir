import { create } from "zustand";

import { useSettings } from "./settings";

// 浏览历史：全局一份、跨窗格去重、最新在前，集中存 settings.recentFolders。
// 记录点是 panes.navigate()（地址栏/导航树/收藏夹/上级等一切导航的汇合处）。

const MAX = 50;

interface HistoryStore {
  record(path: string): void;
  clear(): void;
}

export const useHistory = create<HistoryStore>()(() => ({
  record(path) {
    const cur = useSettings.getState().recentFolders ?? [];
    if (cur[0] === path) return; // 连续重复不落盘
    const next = [path, ...cur.filter((p) => p !== path)].slice(0, MAX);
    useSettings.getState().update({ recentFolders: next });
  },

  clear() {
    useSettings.getState().update({ recentFolders: [] });
  },
}));
