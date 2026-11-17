import { describe, expect, it } from "vitest";

import type { JobInfo } from "../../stores/jobs";
import { useIsland } from "../../stores/island";
import {
  ISLAND_SHEET_MIN,
  resolveIsland,
  shouldExpandReceipt,
  summarizeJobs,
  type IslandInput,
} from "../island";

const base: IslandInput = {
  now: 1_000_000,
  job: null,
  swap: false,
  gsearch: null,
  receipts: [],
  clip: null,
  path: "C:\\work",
  selected: 0,
};

const view = (patch: Partial<IslandInput>) => resolveIsland({ ...base, ...patch });

function job(patch: Partial<JobInfo>): JobInfo {
  return {
    jobId: 1,
    mode: "copy",
    phase: "running",
    totalFiles: 0,
    doneFiles: 0,
    totalBytes: 0,
    doneBytes: 0,
    currentPath: "",
    destDir: null,
    sourceParents: [],
    deletePermanent: false,
    ...patch,
  };
}

describe("灵动岛仲裁（resolveIsland）", () => {
  it("默认回落路径，活动窗格有选中时带后缀计数", () => {
    expect(view({})).toEqual({ kind: "path", path: "C:\\work", selected: 0 });
    expect(view({ selected: 3 })).toEqual({
      kind: "path",
      path: "C:\\work",
      selected: 3,
    });
  });

  it("优先级链：任务 > 交换模式 > 全盘搜索 > 回执 > 剪贴板", () => {
    const full = {
      job: summarizeJobs({ 1: job({}) }, [1])!,
      swap: true,
      gsearch: 7,
      receipts: [{ id: "r1", tone: "ok" as const, text: "复制完成", until: base.now + 1000 }],
      clip: { count: 2, cut: false },
    };
    expect(view(full).kind).toBe("job");
    expect(view({ ...full, job: null }).kind).toBe("swap");
    expect(view({ ...full, job: null, swap: false }).kind).toBe("gsearch");
    expect(view({ ...full, job: null, swap: false, gsearch: null }).kind).toBe("receipt");
    expect(
      view({ ...full, job: null, swap: false, gsearch: null, receipts: [] }).kind,
    ).toBe("clipboard");
  });

  it("回执取最新未过期；过期剪枝后落到下个通道", () => {
    const receipts = [
      { id: "old", tone: "ok" as const, text: "旧", until: base.now + 5000 },
      { id: "new", tone: "fail" as const, text: "新", until: base.now + 9000 },
    ];
    const v = view({ receipts });
    expect(v).toEqual({
      kind: "receipt",
      receipt: { id: "new", tone: "fail", text: "新", until: base.now + 9000 },
    });
    // 全部过期：视同无回执
    const expired = view({
      receipts: [{ id: "e", tone: "ok", text: "过期", until: base.now - 1 }],
      clip: { count: 1, cut: false },
    });
    expect(expired.kind).toBe("clipboard");
  });

  it("固定（pinned）回执永不过期，仍占用回执通道（展笺方案 A）", () => {
    const v = view({
      receipts: [{ id: "p", tone: "fail", text: "已固定", until: base.now - 1, pinned: true }],
      clip: { count: 1, cut: false },
    });
    expect(v).toEqual({
      kind: "receipt",
      receipt: { id: "p", tone: "fail", text: "已固定", until: base.now - 1, pinned: true },
    });
  });
});

describe("展笺阈值（shouldExpandReceipt，方案 A）", () => {
  it("超过 ISLAND_SHEET_MIN 字符才展开；阈值内不展开", () => {
    expect(shouldExpandReceipt("中".repeat(ISLAND_SHEET_MIN))).toBe(false);
    expect(shouldExpandReceipt("中".repeat(ISLAND_SHEET_MIN + 1))).toBe(true);
    expect(shouldExpandReceipt("")).toBe(false);
  });
});

describe("回执剪枝（store.prune 的 hold/pinned 语义）", () => {
  it("悬停中的回执续期不剪枝；移开恢复倒计时；固定回执永不剪", () => {
    useIsland.setState({ receipts: [
      { id: "held", tone: "fail", text: "悬停中", until: 1000 },
      { id: "pinned", tone: "info", text: "固定", until: 1000, pinned: true },
      { id: "gone", tone: "ok", text: "过期", until: 1000 },
    ] });
    // now=2000：held 在悬停（holdId）→ 续期存活；pinned 固定存活；gone 剪除
    useIsland.getState().prune(2000, "held");
    const kept = useIsland.getState().receipts;
    expect(kept.map((r) => r.id)).toEqual(["held", "pinned"]);
    expect(kept[0].until).toBeGreaterThan(2000); // 续期推高到期线
    // 无 hold 继续剪：held 走自然过期，pinned 仍在
    useIsland.getState().prune(kept[0].until + 1);
    expect(useIsland.getState().receipts.map((r) => r.id)).toEqual(["pinned"]);
    // 取消固定后恢复过期语义
    useIsland.getState().pinReceipt("pinned", false);
    useIsland.getState().prune(9999);
    expect(useIsland.getState().receipts).toEqual([]);
  });
});

describe("任务摘要（summarizeJobs）", () => {
  it("无任务返回 null；head 取 order 末位（最新）", () => {
    expect(summarizeJobs({}, [])).toBeNull();
    const s = summarizeJobs(
      {
        1: job({ jobId: 1, mode: "copy", totalBytes: 100, doneBytes: 25 }),
        2: job({ jobId: 2, mode: "extract", totalFiles: 10, doneFiles: 5, currentPath: "C:\\x\\y.zip" }),
      },
      [1, 2],
    )!;
    expect(s.count).toBe(2);
    expect(s.label).toBe("解压");
    expect(s.percent).toBe(0.5); // 最新任务按文件数
    expect(s.current).toBe("y.zip");
  });

  it("排队无百分比；暂停/排队态聚合可见", () => {
    const s = summarizeJobs(
      {
        1: job({ jobId: 1, phase: "queued" }),
        2: job({ jobId: 2, phase: "paused" }),
      },
      [1, 2],
    )!;
    expect(s.percent).toBeNull();
    expect(s.anyQueued).toBe(true);
    expect(s.anyPaused).toBe(true);
  });
});
