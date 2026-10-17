// lib/path.ts 纯函数回归测试：Windows 路径拆拼/命名合法性（与 Rust fs/path.rs 行为对齐）
import { describe, expect, it } from "vitest";

import { driveRootOf, fileNameOf, isValidName, joinPath, parentPath } from "../path";

describe("fileNameOf", () => {
  it("普通路径取末段", () => {
    expect(fileNameOf("E:\\a\\b\\file.txt")).toBe("file.txt");
  });
  it("尾部反斜杠先裁剪再取末段", () => {
    expect(fileNameOf("E:\\a\\b\\dir\\")).toBe("dir");
  });
  it("多个尾反斜杠同样裁剪", () => {
    expect(fileNameOf("E:\\a\\\\")).toBe("a");
  });
  it("无分隔符的裸名原样返回", () => {
    expect(fileNameOf("file.txt")).toBe("file.txt");
  });
  it("盘符根返回盘符根本身", () => {
    expect(fileNameOf("E:\\")).toBe("E:");
    expect(fileNameOf("E:\\\\")).toBe("E:");
  });
});

describe("parentPath", () => {
  it("深层路径返回父目录", () => {
    expect(parentPath("E:\\a\\b\\c")).toBe("E:\\a\\b");
  });
  it("一级目录返回盘符根", () => {
    expect(parentPath("E:\\a")).toBe("E:\\");
  });
  it("盘符根返回 null", () => {
    expect(parentPath("C:\\")).toBeNull();
    expect(parentPath("C:\\\\")).toBeNull();
  });
  it("无分隔符返回 null", () => {
    expect(parentPath("file.txt")).toBeNull();
  });
  it("尾反斜杠不影响结果", () => {
    expect(parentPath("E:\\a\\b\\")).toBe("E:\\a");
  });
});

describe("isValidName", () => {
  it("合法名通过", () => {
    expect(isValidName("报告 2026.pdf")).toBe(true);
  });
  it("点开头文件（.gitignore）合法", () => {
    expect(isValidName(".gitignore")).toBe(true);
  });
  it("空名拒绝", () => {
    expect(isValidName("")).toBe(false);
  });
  it("超长名（>255）拒绝", () => {
    expect(isValidName("a".repeat(256))).toBe(false);
    expect(isValidName("a".repeat(255))).toBe(true);
  });
  it("非法字符逐个拒绝", () => {
    for (const ch of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
      expect(isValidName(`a${ch}b`)).toBe(false);
    }
  });
  it("控制字符拒绝", () => {
    expect(isValidName("a\u0007b")).toBe(false);
  });
  it("尾点/尾空格拒绝", () => {
    expect(isValidName("name.")).toBe(false);
    expect(isValidName("name ")).toBe(false);
  });
  it("Windows 保留设备名拒绝（大小写不敏感）", () => {
    for (const n of ["con", "PRN", "aux", "nul", "com1", "COM9", "lpt4"]) {
      expect(isValidName(n)).toBe(false);
      expect(isValidName(`${n}.txt`)).toBe(false);
    }
  });
  it("保留名作为子串不算保留", () => {
    expect(isValidName("console.log")).toBe(true);
    expect(isValidName("com10")).toBe(true);
  });
});

describe("driveRootOf", () => {
  it("深层路径返回大写盘根", () => {
    expect(driveRootOf("e:\\a\\b")).toBe("E:\\");
    expect(driveRootOf("C:\\x")).toBe("C:\\");
  });
  it("无法识别返回 null", () => {
    expect(driveRootOf("relative\\path")).toBeNull();
    expect(driveRootOf("")).toBeNull();
  });
});

describe("joinPath", () => {
  it("普通目录以反斜杠拼接", () => {
    expect(joinPath("E:\\a", "b.txt")).toBe("E:\\a\\b.txt");
  });
  it("盘符根目录（已带尾反斜杠）不重复加", () => {
    expect(joinPath("E:\\", "b.txt")).toBe("E:\\b.txt");
  });
});
