import { describe, expect, it } from "vitest";

import type { JobInfo } from "../../stores/jobs";
import {
  resolveIsland,
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
