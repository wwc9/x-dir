import { create } from "zustand";

import { api } from "../lib/ipc";

export interface Clip {
  mode: "copy" | "cut";
  paths: string[];
  /** 内容来自系统剪贴板（Explorer 复制后可直接 Ctrl+V） */
  fromSystem?: boolean;
}

interface ClipboardStore {
  clip: Clip | null;
  set(mode: "copy" | "cut", paths: string[]): void;
  setInternal(clip: Clip | null): void;
  clear(): void;
  /** V2：内部无内容时从系统剪贴板同步（CF_HDROP，§3.2） */
  syncFromSystem(): Promise<void>;
}

export const useClipboard = create<ClipboardStore>()((set, get) => ({
  clip: null,

  set(mode, paths) {
    const clip = paths.length ? { mode, paths } : null;
    set({ clip });
    // 同步写系统剪贴板（CF_HDROP + Preferred DropEffect），失败不阻塞应用内使用
    if (clip) {
      api.setClipboardFiles(clip.paths, mode === "cut").catch(() => undefined);
    } else {
      api.clearClipboard().catch(() => undefined);
    }
  },

  setInternal(clip) {
    set({ clip });
  },

  clear() {
    set({ clip: null });
    api.clearClipboard().catch(() => undefined);
  },

  async syncFromSystem() {
    if (get().clip) return;
    try {
      const sys = await api.getClipboardFiles();
      if (sys && sys.paths.length && !get().clip) {
        set({
          clip: {
            mode: sys.cut ? "cut" : "copy",
            paths: sys.paths,
            fromSystem: true,
          },
        });
      }
    } catch {
      // 系统剪贴板不可用（如被占用）：保持无内容
    }
  },
}));
