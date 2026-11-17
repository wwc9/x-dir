// 文件夹体积缓存（2026-11-17「是否展示文件夹的大小」定案）：开关开启时窗格
// 列表按父目录拉取直接子项的递归体积（复用 analyze::dir_sizes——spawn_blocking
// + 20 万文件上限 = best-effort 口径），LRU 上限防无界增长（图标缓存同款护栏）；
// normKey 归一与快照缓存同语义（大小写/尾反斜杠）。
import { create } from "zustand";

import { api } from "../lib/ipc";
import { normKey } from "../lib/path";

/** LRU 上限：目录体积条目数（超限丢最旧） */
const MAX_ENTRIES = 500;
/** 单父目录在飞保护：连发导航/watcher 回声不重复拉 */
const inFlight = new Set<string>();
/** LRU 触达序（normKey，最旧在前） */
let touchOrder: string[] = [];

interface DirSizesStore {
  /** normKey(path) → 递归字节数；未收录 = 未计算（展示层留空待补） */
  sizes: Record<string, number>;
  /** 拉取 parent 的直接子项体积（子文件夹递归合计）；在飞去重 */
  request(parent: string): void;
}

export const useDirSizes = create<DirSizesStore>()((set) => ({
  sizes: {},

  request(parent) {
    const pkey = normKey(parent);
    if (inFlight.has(pkey)) return;
    inFlight.add(pkey);
    api
      .dirSizes(parent)
      .then((rows) => {
        set((s) => {
          const sizes = { ...s.sizes };
          for (const r of rows) {
            if (!r.isDir) continue;
            const k = normKey(r.path);
            sizes[k] = r.size;
            touchOrder = touchOrder.filter((x) => x !== k);
            touchOrder.push(k);
          }
          while (touchOrder.length > MAX_ENTRIES) {
            const evict = touchOrder.shift();
            if (evict !== undefined) delete sizes[evict];
          }
          return { sizes };
        });
      })
      .catch(() => undefined)
      .finally(() => inFlight.delete(pkey));
  },
}));
