import { describe, expect, it } from "vitest";

import { clipKindMeta, formatSize, relTime } from "../cliphist";

describe("relTime", () => {
  const NOW = 1_700_000_000_000;

  it("各档位边界", () => {
    expect(relTime(NOW, NOW)).toBe("刚刚");
    expect(relTime(NOW - 59_000, NOW)).toBe("刚刚");
    expect(relTime(NOW - 60_000, NOW)).toBe("1 分钟前");
    expect(relTime(NOW - 59 * 60_000, NOW)).toBe("59 分钟前");
    expect(relTime(NOW - 60 * 60_000, NOW)).toBe("1 小时前");
    expect(relTime(NOW - 23 * 3_600_000, NOW)).toBe("23 小时前");
    expect(relTime(NOW - 24 * 3_600_000, NOW)).toBe("1 天前");
    expect(relTime(NOW - 29 * 86_400_000, NOW)).toBe("29 天前");
  });

  it("30 天以上回落到日期；未来时间钳为刚刚", () => {
    expect(relTime(NOW - 40 * 86_400_000, NOW)).toBe(
      new Date(NOW - 40 * 86_400_000).toLocaleDateString(),
    );
    expect(relTime(NOW + 5_000, NOW)).toBe("刚刚");
  });
});

describe("formatSize", () => {
  it("B/KB/MB 档位与一位小数", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1048576)).toBe("1.0 MB");
    expect(formatSize(3 * 1048576 + 716_800)).toBe("3.7 MB");
  });
});

describe("clipKindMeta", () => {
  it("四种已知类型与未知回退", () => {
    expect(clipKindMeta("text").label).toBe("文本");
    expect(clipKindMeta("image").label).toBe("图片");
    expect(clipKindMeta("files").label).toBe("文件");
    expect(clipKindMeta("dirs").label).toBe("文件夹");
    // 未知类型回退文本（后端新增类型时前端不崩）
    expect(clipKindMeta("whatever").label).toBe("文本");
  });
});
