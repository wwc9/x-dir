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
    opts?: { dwellMs?: number; action?: IslandReceipt["action"] },
  ): void;
  dismissReceipt(id: string): void;
  /** 固定/取消固定（2026-11-17 展笺方案 A）：固定后不自动过期，仅手动消去 */
  pinReceipt(id: string, pinned: boolean): void;
  /** 过期剪枝；holdId = 用户悬停中的回执（展笺方案 A：悬停续期，移开恢复倒计时） */
  prune(now: number, holdId?: string): void;
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
        receipts: [
          ...rest,
          { id: `rcpt-${now}-${++receiptSeq}`, tone, text, until, action: opts?.action },
        ],
      };
    });
  },

  dismissReceipt(id) {
    set((s) => ({ receipts: s.receipts.filter((r) => r.id !== id) }));
  },

  pinReceipt(id, pinned) {
    set((s) => ({
      receipts: s.receipts.map((r) => (r.id === id ? { ...r, pinned } : r)),
    }));
  },

  prune(now, holdId) {
    const { receipts } = get();
    if (!receipts.length) return;
    let changed = false;
    const kept = receipts
      .map((r) => {
        if (r.pinned) return r; // 固定回执不自动过期
        if (r.id === holdId) {
          // 悬停续期：到期线推到 600ms 后（心跳 1s 周期内保持存活），
          // 移开后从推高的到期线继续走完剩余驻留
          const next = Math.max(r.until, now + 600);
          if (next !== r.until) {
            changed = true;
            return { ...r, until: next };
          }
          return r;
        }
        if (r.until > now) return r;
        changed = true;
        return null;
      })
      .filter((r): r is IslandReceipt => r !== null);
    if (changed) set({ receipts: kept });
  },

  setGsearch(matched) {
    set({ gsearch: matched });
  },
}));
