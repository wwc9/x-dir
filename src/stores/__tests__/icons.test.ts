// icons store：refreshBin 强制重取语义（2026-11-26 回收站图标跟随系统空/满态）。
// Rust 端对哨兵路径跳过 LRU 每次现提；前端 refreshBin 须剔旧图/清负缓存/
// 清在途去重后重发，否则 icons/missed/pending 三处去重会把旧图标钉死。
// getFileIcons vi.mock 拦截，记录调用序列断言「确实重发了 IPC」
import { beforeEach, describe, expect, it, vi } from "vitest";

const getFileIcons = vi.hoisted(() => vi.fn<() => Promise<Record<string, string>>>());

vi.mock("../../lib/ipc", () => ({
  api: { getFileIcons },
  RECYCLE_BIN: "::{RecycleBin}",
}));

// node 环境 window 桩：setTimeout 同步触发（schedule immediate 立刻 flush）
vi.stubGlobal("window", {
  setTimeout: (fn: () => void) => {
    fn();
    return 0;
  },
  clearTimeout: () => undefined,
});

import { useIcons } from "../../stores/icons";

const BIN = "::{RecycleBin}";
/** flush→getFileIcons→then→setState 的微任务链排空 */
const drain = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  getFileIcons.mockReset();
  useIcons.setState({ icons: {}, exts: {} });
});

describe("icons store：refreshBin 跟随系统空/满态", () => {
  it("常规请求落表后，refreshBin 剔旧图并重发 IPC 换新图", async () => {
    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,OLD" });
    useIcons.getState().requestIcons([BIN], true);
    await drain();
    expect(useIcons.getState().icons[BIN]).toBe("data:image/png;base64,OLD");

    // 系统空→满翻面：refreshBin 必须重新发 IPC（旧图已被去重挡住不会自取）
    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,NEW" });
    useIcons.getState().refreshBin();
    expect(useIcons.getState().icons[BIN]).toBeUndefined(); // 剔旧即时生效
    await drain();
    expect(getFileIcons).toHaveBeenCalledTimes(2);
    expect(useIcons.getState().icons[BIN]).toBe("data:image/png;base64,NEW");
  });

  it("无旧图/负缓存态下 refreshBin 同样能拉到图", async () => {
    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,FIRST" });
    useIcons.getState().refreshBin();
    await drain();
    expect(useIcons.getState().icons[BIN]).toBe("data:image/png;base64,FIRST");
  });
});
