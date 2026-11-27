// 盘符清单共享 store（2026-11-27 审查修复）：此前导航树 / 顶栏收藏 / 窗格
// 面包屑各自挂载时拉一次 getDrives，U 盘插拔后重启前盘符列表冻结（树的
// 「刷新」钮只清子目录缓存救不了盘符）。后端 drive_watch 以 message-only
// 窗收 WM_DEVICECHANGE → "drives-changed" 事件，此处统一重拉并广播订阅方。

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { api, type DriveInfo } from "../lib/ipc";

interface DrivesStore {
  drives: DriveInfo[];
  ready: boolean;
  refresh(): void;
  init(): Promise<() => void>;
}

export const useDrives = create<DrivesStore>()((set, get) => ({
  drives: [],
  ready: false,

  refresh() {
    api
      .getDrives()
      .then((drives) => set({ drives, ready: true }))
      .catch(() => undefined);
  },

  async init() {
    get().refresh();
    const un = await listen("drives-changed", () => get().refresh());
    return un;
  },
}));
