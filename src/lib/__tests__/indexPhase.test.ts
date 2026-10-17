import { describe, expect, it } from "vitest";

import type { IndexStatus } from "../ipc";
import {
  analyzeIndexPhase,
  errorSummary,
  INDEX_START_GRACE_MS,
  readySummary,
} from "../indexPhase";

const NOW = 1_000_000;

function status(partial: Partial<IndexStatus> = {}): IndexStatus {
  return {
    daemonAlive: true,
    enabled: true,
    configured: ["C", "D"],
    volumes: {
      C: { entries: 1000, fresh: true, error: null },
      D: { entries: 2000, fresh: true, error: null },
    },
    ...partial,
  };
}

describe("analyzeIndexPhase", () => {
  it("开关关 = off（忽略守护状态）", () => {
    expect(analyzeIndexPhase(status({ enabled: false }), false, null, NOW).phase).toBe("off");
  });

  it("刚开开关且守护未存活 = starting；超出宽限窗 = down", () => {
    const enabledAt = NOW - 1000;
    expect(analyzeIndexPhase(null, true, enabledAt, NOW).phase).toBe("starting");
    // 无回执但宽限内
    expect(analyzeIndexPhase(status({ daemonAlive: false }), true, enabledAt, NOW).phase).toBe(
      "starting",
    );
    // 超出宽限窗 → 离线（启动失败）
    const stale = NOW - INDEX_START_GRACE_MS - 1;
    expect(analyzeIndexPhase(status({ daemonAlive: false }), true, stale, NOW).phase).toBe("down");
    // 从未记录开启时间（对话框后来才打开）且守护死了 → down
    expect(analyzeIndexPhase(status({ daemonAlive: false }), true, null, NOW).phase).toBe("down");
  });

  it("守护存活但卷无回执 = 建索引中", () => {
    const r = analyzeIndexPhase(
      status({ volumes: { C: { entries: 500, fresh: false, error: null } } }),
      true,
      null,
      NOW,
    );
    expect(r.phase).toBe("building");
    expect(r.vols.find((v) => v.letter === "C")?.state).toBe("building");
    expect(r.vols.find((v) => v.letter === "D")?.state).toBe("building");
  });

  it("全部卷 fresh 且无错误 = ready，汇总条目数", () => {
    const r = analyzeIndexPhase(status(), true, null, NOW);
    expect(r.phase).toBe("ready");
    expect(r.totalEntries).toBe(3000);
  });

  it("任一卷错误 = error；错误卷不计入总数", () => {
    const r = analyzeIndexPhase(
      status({ volumes: { C: { entries: 0, fresh: false, error: "卷不可用" }, D: { entries: 2000, fresh: true, error: null } } }),
      true,
      null,
      NOW,
    );
    expect(r.phase).toBe("error");
    expect(r.totalEntries).toBe(2000);
    expect(errorSummary(r.vols)).toBe("C: 卷不可用");
  });

  it("部分就绪部分在建 = building；readySummary 只列就绪卷", () => {
    const r = analyzeIndexPhase(
      status({ volumes: { C: { entries: 1000, fresh: true, error: null } } }),
      true,
      null,
      NOW,
    );
    expect(r.phase).toBe("building");
    expect(readySummary(r.vols, r.totalEntries)).toBe("C 共 1,000 项");
  });

  it("configured 为空回落 volumes 键；两者皆空 = building", () => {
    const r = analyzeIndexPhase(
      status({
        configured: [],
        volumes: { C: { entries: 10, fresh: true, error: null } },
      }),
      true,
      null,
      NOW,
    );
    expect(r.phase).toBe("ready");
    expect(analyzeIndexPhase(status({ configured: [], volumes: {} }), true, null, NOW).phase).toBe(
      "building",
    );
  });
});
