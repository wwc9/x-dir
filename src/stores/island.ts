// 灵动岛回执/活动栈：zustand 只持有易变状态（回执、最近活动时间、全盘搜索进度），
// 仲裁逻辑在 lib/island（纯函数配单测）——本店不决定"显示什么"，只供料。
import { create } from "zustand";

import { DENSITY } from "../lib/tokens";
import type { IslandReceipt } from "../lib/island";

let receiptSeq = 0;

interface IslandStore {
  receipts: IslandReceipt[];
  /** 全盘搜索流进行中的命中数；null = 无搜索 */
  gsearch: number | null;
  /** 播报回执：同文本去重（覆盖刷新驻留期），默认驻留 DENSITY.islandReceiptMs */
  pushReceipt(
    tone: IslandReceipt["tone"],
    text: string,
    opts?: { dwellMs?: number },
  ): void;
  dismissReceipt(id: string): void;
  prune(now: number): void;
  setGsearch(matched: number | null): void;
}

export const useIsland = create<IslandStore>()((set, get) => ({
  receipts: [],
  gsearch: null,

  pushReceipt(tone, text, opts) {
    const now = Date.now();
    const until = now + (opts?.dwellMs ?? DENSITY.islandReceiptMs);
    set((s) => {
      // 同文本覆盖（如连续两个「复制 完成」刷新驻留期而非堆叠两条）
      const rest = s.receipts.filter((r) => r.text !== text);
      return {
        receipts: [...rest, { id: `rcpt-${now}-${++receiptSeq}`, tone, text, until }],
      };
    });
  },

  dismissReceipt(id) {
    set((s) => ({ receipts: s.receipts.filter((r) => r.id !== id) }));
  },

  prune(now) {
    const { receipts } = get();
    if (!receipts.length) return;
    const kept = receipts.filter((r) => r.until > now);
    if (kept.length !== receipts.length) set({ receipts: kept });
  },

  setGsearch(matched) {
    set({ gsearch: matched });
  },
}));
