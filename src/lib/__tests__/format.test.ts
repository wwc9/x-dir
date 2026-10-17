import { describe, expect, it } from "vitest";
import {
  ALargeSmall,
  AppWindow,
  Box,
  Captions,
  Cog,
  Container,
  Database,
  Disc3,
  FileClock,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  Camera,
  FileJson,
  FileKey,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Folder,
  GitBranch,
  HardDrive,
  ListMusic,
  Mail,
  Magnet,
  Package,
  Presentation,
  Scale,
  SquareTerminal,
} from "lucide-react";

import { formatBytes, formatSize, formatTime } from "../format";
import { BY_EXT, fileIcon, typeName } from "../fileIcons";
import { fileNameOf, isValidName, parentPath } from "../path";

describe("formatSize", () => {
  it("目录恒为 —", () => {
    expect(formatSize({ isDir: true, size: 0 })).toBe("—");
  });
  it("1024 进制与单位", () => {
    expect(formatSize({ isDir: false, size: 0 })).toBe("0 B");
    expect(formatSize({ isDir: false, size: 512 })).toBe("512 B");
    expect(formatSize({ isDir: false, size: 1536 })).toBe("1.5 KB");
    expect(formatSize({ isDir: false, size: 1048576 })).toBe("1.0 MB");
  });
  it("formatBytes：目录体积求和等裸字节数入口，与 formatSize 同规则", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

describe("formatTime", () => {
  it("yyyy-MM-dd HH:mm", () => {
    expect(formatTime(new Date(2026, 9, 10, 8, 5).getTime())).toBe("2026-10-10 08:05");
  });
  it("0 显示为 —", () => {
    expect(formatTime(0)).toBe("—");
  });
});

describe("fileIcon / typeName", () => {
  it("文件夹/驱动器/兜底图标", () => {
    expect(fileIcon("x", true).icon).toBe(Folder);
    expect(fileIcon("x", true, true).icon).toBe(HardDrive);
    expect(fileIcon("noext", false).icon).toBe(File);
  });
  it("扩展名映射到 Lucide 图标", () => {
    expect(fileIcon("a.rs", false).icon).toBe(FileCode);
    expect(fileIcon("b.zip", false).icon).toBe(FileArchive);
    expect(fileIcon("c.png", false).icon).toBe(FileImage);
    expect(fileIcon("d.xlsx", false).icon).toBe(FileSpreadsheet);
    expect(fileIcon("e.exe", false).icon).toBe(AppWindow);
  });

  it("2026-10-15 扩充分类：图标符合类型描述", () => {
    // 办公三件套分色分标
    expect(fileIcon("a.docx", false)).toMatchObject({ icon: FileText, colorVar: "--np-icon-doc" });
    expect(fileIcon("a.pptx", false)).toMatchObject({ icon: Presentation, colorVar: "--np-icon-slide" });
    expect(fileIcon("a.key", false)).toMatchObject({ icon: FileKey, colorVar: "--np-icon-exe" }); // 私钥优先于 Keynote
    // 配置 / 终端脚本 / 数据库
    expect(fileIcon("a.yaml", false).icon).toBe(FileCog);
    expect(fileIcon("a.json", false).icon).toBe(FileJson);
    expect(fileIcon("a.sh", false).icon).toBe(SquareTerminal);
    expect(fileIcon("a.bat", false).icon).toBe(FileTerminal);
    expect(fileIcon("a.sqlite", false).icon).toBe(Database);
    // 相机 RAW / 3D / 字幕 / 播放列表 / 种子 / 镜像
    expect(fileIcon("a.cr3", false).icon).toBe(Camera);
    expect(fileIcon("a.stl", false).icon).toBe(Box);
    expect(fileIcon("a.srt", false).icon).toBe(Captions);
    expect(fileIcon("a.m3u", false).icon).toBe(ListMusic);
    expect(fileIcon("a.torrent", false).icon).toBe(Magnet);
    expect(fileIcon("a.iso", false).icon).toBe(Disc3);
    // 安装包 / 系统组件 / 证书 / 字体 / 邮件 / 备份
    expect(fileIcon("a.apk", false).icon).toBe(Package);
    expect(fileIcon("a.dll", false).icon).toBe(Cog);
    expect(fileIcon("a.pem", false).icon).toBe(FileKey);
    expect(fileIcon("a.ttf", false)).toMatchObject({ icon: ALargeSmall, colorVar: "--np-icon-font" });
    expect(fileIcon("a.eml", false).icon).toBe(Mail);
    expect(fileIcon("a.bak", false).icon).toBe(FileClock);
    // 大小写不敏感 + 无扩展名开发文件（按文件名匹配）
    expect(fileIcon("B.ZIP", false).icon).toBe(FileArchive);
    expect(fileIcon("Dockerfile", false).icon).toBe(Container);
    expect(fileIcon("LICENSE", false).icon).toBe(Scale);
    expect(fileIcon(".gitignore", false).icon).toBe(GitBranch);
  });

  it("覆盖规模（2026-10-15 扩充底档：≥ 220 扩展名）", () => {
    expect(Object.keys(BY_EXT).length).toBeGreaterThanOrEqual(220);
  });

  it("类型描述覆盖主要格式", () => {
    for (const ext of ["docx", "pptx", "xlsx", "pdf", "zip", "iso", "exe", "ttf", "sqlite", "srt", "torrent", "bak"]) {
      expect(typeName(`a.${ext}`, false)).not.toBe(`${ext.toUpperCase()} 文件`);
    }
    expect(typeName("a.png", false)).toBe("图片文件");
    expect(typeName("a.cr3", false)).toBe("相机 RAW");
    expect(typeName("a.stl", false)).toBe("3D 模型");
  });
  it("图标颜色全部来自 token 变量", () => {
    for (const spec of [fileIcon("a", true), fileIcon("b.rs", false), fileIcon("c", false)]) {
      expect(spec.colorVar).toMatch(/^--np-icon-/);
    }
  });
  it("类型描述", () => {
    expect(typeName("a.pdf", false)).toBe("PDF 文档");
    expect(typeName("x.qqq", false)).toBe("QQQ 文件");
    expect(typeName("noext", false)).toBe("文件");
    expect(typeName("c", true)).toBe("文件夹");
  });
});

describe("path helpers", () => {
  it("parentPath 与 Rust 端一致", () => {
    expect(parentPath("C:\\a\\b")).toBe("C:\\a");
    expect(parentPath("C:\\a")).toBe("C:\\");
    expect(parentPath("C:\\")).toBeNull();
  });
  it("fileNameOf", () => {
    expect(fileNameOf("C:\\a\\b.txt")).toBe("b.txt");
    expect(fileNameOf("C:\\")).toBe("C:");
  });
  it("isValidName 与 Rust 端一致", () => {
    expect(isValidName("a.txt")).toBe(true);
    expect(isValidName("新建文件夹")).toBe(true);
    expect(isValidName("")).toBe(false);
    expect(isValidName("a<b")).toBe(false);
    expect(isValidName("x.")).toBe(false);
    expect(isValidName("con.txt")).toBe(false);
  });
});
