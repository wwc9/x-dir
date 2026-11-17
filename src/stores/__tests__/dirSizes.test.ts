// 文件夹体积缓存 store（2026-11-17「是否展示文件夹的大小」定案）：
// normKey 收录 / 在飞去重 / LRU 上限
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../lib/ipc";
import { useDirSizes } from "../dirSizes";

const dirSizesSpy = () =>
  vi.spyOn(
    api as unknown as Record<string, (dir: string) => Promise<unknown>>,
    "dirSizes",
  );

beforeEach(() => {
  vi.clearAllMocks();
  useDirSizes.setState({ sizes: {} });
});

describe("dirSizes store", () => {
  it("request 拉取并按 normKey 收录（大小写/尾反斜杠命中同键）；文件行跳过", async () => {
    dirSizesSpy().mockResolvedValue([
      { name: "a", path: "E:\\Data\\A", isDir: true, size: 100, files: 2 },
      { name: "f.txt", path: "E:\\Data\\A\\f.txt", isDir: false, size: 5, files: 1 },
    ]);
    useDirSizes.getState().request("e:\\data\\a\\");
    await vi.waitFor(() =>
      expect(useDirSizes.getState().sizes["e:\\data\\a"]).toBe(100),
    );
    expect(
      Object.keys(useDirSizes.getState().sizes).some((k) => k.includes("f.txt")),
    ).toBe(false);
  });

  it("在飞去重：同一父目录并发 request 只调一次 API", async () => {
    let resolve!: (v: unknown) => void;
    dirSizesSpy().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    useDirSizes.getState().request("E:\\x");
    useDirSizes.getState().request("E:\\x");
    resolve([]);
    await vi.waitFor(() => expect(dirSizesSpy().mock.calls.length).toBe(1));
  });

  it("LRU 上限 500：超限丢最旧", async () => {
    dirSizesSpy().mockImplementation((dir: string) =>
      Promise.resolve([
        { name: "d", path: `${dir}\\d`, isDir: true, size: 1, files: 1 },
      ]),
    );
    for (let i = 0; i < 501; i++) {
      useDirSizes.getState().request(`E:\\lru\\${String(i).padStart(4, "0")}`);
      await Promise.resolve();
    }
    const sizes = useDirSizes.getState().sizes;
    expect(Object.keys(sizes).length).toBeLessThanOrEqual(500);
    expect(sizes["e:\\lru\\0000\\d"]).toBeUndefined();
    expect(sizes["e:\\lru\\0500\\d"]).toBe(1);
  });
});
