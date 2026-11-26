// icons store：refreshBin 现提比较式刷新（2026-11-26 回收站图标跟随系统空/满态）。
// Rust 端对哨兵路径跳过 LRU 每次现提；前端直发 IPC（绕过 icons/missed/pending
// 三处去重——任一处都会挡住同路径重取），值变才写 state：3s 轮询期未翻面时
// 零重渲染零闪动，翻面时旧图保留至新图抵达、不回落 Lucide。
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
  it("常规请求落表后，refreshBin 重发 IPC；翻面时旧图保留至新图抵达", async () => {
    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,OLD" });
    useIcons.getState().requestIcons([BIN], true);
    await drain();
    expect(useIcons.getState().icons[BIN]).toBe("data:image/png;base64,OLD");

    // 系统空→满翻面：refreshBin 必须重新发 IPC（三处去重会挡住常规重取）
    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,NEW" });
    useIcons.getState().refreshBin();
    // 新图抵达前旧图保留（不再剔旧回落 Lucide 造成逐帧闪动）
    expect(useIcons.getState().icons[BIN]).toBe("data:image/png;base64,OLD");
    await drain();
    expect(getFileIcons).toHaveBeenCalledTimes(2);
    expect(useIcons.getState().icons[BIN]).toBe("data:image/png;base64,NEW");
  });

  it("值未翻面时 refreshBin 不写 state——3s 轮询零重渲染", async () => {
    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,OLD" });
    useIcons.getState().requestIcons([BIN], true);
    await drain();
    const before = useIcons.getState().icons;

    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,OLD" });
    useIcons.getState().refreshBin();
    await drain();
    expect(getFileIcons).toHaveBeenCalledTimes(2); // IPC 照发（Rust 端现提）
    expect(useIcons.getState().icons).toBe(before); // 引用不变 = 订阅方零通知
  });

  it("无旧图/负缓存态下 refreshBin 同样能拉到图", async () => {
    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,FIRST" });
    useIcons.getState().refreshBin();
    await drain();
    expect(useIcons.getState().icons[BIN]).toBe("data:image/png;base64,FIRST");
  });

  it("现提失败不顶掉旧图也不落负缓存——下轮轮询自重试", async () => {
    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,OLD" });
    useIcons.getState().requestIcons([BIN], true);
    await drain();

    getFileIcons.mockResolvedValueOnce({}); // 瞬时提取失败：无产出
    useIcons.getState().refreshBin();
    await drain();
    expect(useIcons.getState().icons[BIN]).toBe("data:image/png;base64,OLD");

    getFileIcons.mockResolvedValueOnce({ [BIN]: "data:image/png;base64,NEW" });
    useIcons.getState().refreshBin();
    await drain();
    expect(useIcons.getState().icons[BIN]).toBe("data:image/png;base64,NEW");
  });
});
