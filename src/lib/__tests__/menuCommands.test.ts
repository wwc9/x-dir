import { describe, expect, it } from "vitest";

import type { MenuEntry } from "../ipc";
import {
  areaLabel,
  BUILTIN_FNS,
  builtinByKey,
  builtinToolbarEntry,
  condSentence,
  defaultMenuEntries,
  defaultToolbarEntries,
  effectiveArea,
  ensureFixedEntries,
  ensureToolbarAddr,
  entryVisible,
  fnGroups,
  isFixedEntryId,
  parseExts,
  spyGroup,
  stripCustomEntries,
} from "../menuCommands";

const f = (name: string) => ({ name, isDir: false });
const d = (name: string) => ({ name, isDir: true });

describe("条件人话预览（areaLabel / condSentence）", () => {
  it("启用时机标签三态：总是 / 选中时 / 未选中时", () => {
    expect(areaLabel("sel")).toBe("选中时");
    expect(areaLabel("blank")).toBe("未选中时");
    expect(areaLabel("both")).toBe("总是");
  });

  it("启用时机与对象/数量/类型的组合文案", () => {
    const base = { target: "all" as const, minCount: 1, maxCount: 0, exts: "" };
    expect(condSentence(base, "sel")).toBe("选中条目时显示 · 对象不限 · 数量不限");
    expect(condSentence(base, "both")).toBe("总是显示 · 对象不限 · 数量不限");
    expect(condSentence(base, "blank")).toBe("未选中时显示（空白处） · 对象不限 · 数量不限");
    expect(
      condSentence({ ...base, target: "file" as const, minCount: 2, exts: "pdf" }, "sel"),
    ).toBe("选中条目时显示 · 仅文件 · 至少 2 项 · 类型 pdf（不区分大小写）");
    expect(
      condSentence({ ...base, target: "dir" as const, maxCount: 1 }, "sel"),
    ).toBe("选中条目时显示 · 仅文件夹 · 至多 1 项");
    expect(
      condSentence({ ...base, minCount: 2, maxCount: 5, exts: "csv, tsv" }, "both"),
    ).toBe("总是显示 · 对象不限 · 第 2–5 项 · 类型 csv / tsv（不区分大小写）");
  });
});

describe("出现位置能力位收窄（effectiveArea）", () => {
  it("sel/blank 直接受能力位约束，不支持即不显示", () => {
    expect(effectiveArea(true, false, "sel")).toBe("sel");
    expect(effectiveArea(true, false, "blank")).toBe(null);
    expect(effectiveArea(false, true, "sel")).toBe(null);
    expect(effectiveArea(false, true, "blank")).toBe("blank");
  });
  it("both 收窄到支持的一侧（不限 = 在支持的区域都出现）", () => {
    expect(effectiveArea(true, true, "both")).toBe("both");
    expect(effectiveArea(true, false, "both")).toBe("sel");
    expect(effectiveArea(false, true, "both")).toBe("blank");
    expect(effectiveArea(false, false, "both")).toBe(null);
  });
});

describe("菜单条目条件（entryVisible）", () => {
  const base = { target: "all" as const, minCount: 1, maxCount: 0, exts: "" };

  it("blank 区域恒可见（能力开关由渲染端约束）", () => {
    expect(entryVisible(base, "blank", null)).toBe(true);
    expect(entryVisible({ ...base, exts: "pdf" }, "blank", null)).toBe(true);
  });

  it("sel：空选中不可见；数量上下限生效", () => {
    expect(entryVisible(base, "sel", [])).toBe(false);
    expect(entryVisible(base, "sel", [f("a")])).toBe(true);
    expect(entryVisible({ ...base, minCount: 2 }, "sel", [f("a")])).toBe(false);
    expect(entryVisible({ ...base, maxCount: 1 }, "sel", [f("a"), f("b")])).toBe(false);
  });

  it("对象类型：仅文件 / 仅文件夹（混合选中不适用）", () => {
    expect(entryVisible({ ...base, target: "file" }, "sel", [d("x")])).toBe(false);
    expect(entryVisible({ ...base, target: "dir" }, "sel", [f("a")])).toBe(false);
    expect(entryVisible({ ...base, target: "file" }, "sel", [f("a"), f("b")])).toBe(true);
  });

  it("扩展名白名单：须为匹配扩展名的文件（文件夹不适用）", () => {
    const pdf = { ...base, exts: "pdf" };
    expect(entryVisible(pdf, "sel", [f("a.pdf")])).toBe(true);
    expect(entryVisible(pdf, "sel", [f("a.PDF")])).toBe(true);
    expect(entryVisible(pdf, "sel", [f("a.txt")])).toBe(false);
    expect(entryVisible(pdf, "sel", [f("a.pdf"), d("dir")])).toBe(false);
  });
});

describe("出厂菜单布局（defaultMenuEntries）", () => {
  it("内置功能默认条件（防回归）：拖入功能库即带合理约束", () => {
    // 执行器只处理首项的功能限单选；批量类功能限 ≥2
    expect(builtinByKey("open")?.cond.maxCount).toBe(1);
    expect(builtinByKey("rename")?.cond.maxCount).toBe(1);
    expect(builtinByKey("properties")?.cond.maxCount).toBe(1);
    expect(builtinByKey("openTab")?.cond).toMatchObject({ target: "dir", maxCount: 1 });
    expect(builtinByKey("batchRename")?.cond.minCount).toBe(2);
    expect(builtinByKey("pdfMerge")?.cond).toMatchObject({ target: "file", minCount: 2, exts: "pdf" });
    // 双区域能力位 + 粘贴默认不限（列表排满无空白处时也可右键粘贴）
    expect(builtinByKey("paste")?.area).toBe("both");
    expect(builtinByKey("paste")?.supportsSel).toBe(true);
    expect(builtinByKey("toggleHidden")?.supportsSel).toBe(false);
  });

  it("id 唯一且覆盖全部内置功能引用", () => {
    const entries = defaultMenuEntries();
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(entries.length);
    for (const e of entries) {
      if (e.kind === "builtin") {
        expect(BUILTIN_FNS.some((f) => `builtin:${f.key}` === e.id)).toBe(true);
      }
    }
  });

  it("含关键功能与两个区域", () => {
    const ids = defaultMenuEntries().map((e) => e.id);
    for (const key of ["open", "delete", "properties", "paste", "new", "copyPath", "rename"]) {
      expect(ids).toContain(`builtin:${key}`);
    }
    const areas = new Set(defaultMenuEntries().map((e) => e.area));
    expect(areas.has("sel")).toBe(true);
    expect(areas.has("blank")).toBe(true);
  });

  it("功能注册表 key 唯一", () => {
    const keys = new Set(BUILTIN_FNS.map((f) => f.key));
    expect(keys.size).toBe(BUILTIN_FNS.length);
  });

  it("功能能力位自洽：菜单能力至少支持一个区域，默认区域在支持范围内", () => {
    for (const f of BUILTIN_FNS) {
      // 仅窗格工具（supportsSel/Blank 双 false）合法地不可入菜单——只能进工具栏
      if (f.supportsSel || f.supportsBlank) {
        expect(f.area === "sel" ? f.supportsSel : f.supportsBlank).toBe(true);
      }
    }
  });

  it("功能库分组（2026-10-15 重整）：组序固定、同组连续、窗格工具仅工具栏", () => {
    // 展示组序 = 注册表首现顺序：按使用频率与逻辑流排列
    const groups = [...new Set(BUILTIN_FNS.map((f) => f.group))];
    expect(groups).toEqual([
      "文件",
      "剪贴板",
      "新建与选择",
      "视图",
      "窗格协作",
      "窗格工具",
      "标记与系统",
      "整理",
      "PDF",
      "图片处理",
      "办公",
      "表格与文本",
    ]);
    // 同组条目在注册表内连续（无跨表穿插的组）
    const firstIdx = new Map<string, number>();
    BUILTIN_FNS.forEach((f, i) => firstIdx.set(f.group, firstIdx.get(f.group) ?? i));
    BUILTIN_FNS.forEach((f, i) => {
      expect(i - firstIdx.get(f.group)!).toBeLessThan(
        BUILTIN_FNS.filter((x) => x.group === f.group).length,
      );
    });
    // 「窗格工具」组 = 全部仅工具栏能力位（双 false），不混入两面共享功能
    for (const f of BUILTIN_FNS.filter((x) => x.group === "窗格工具")) {
      expect(f.supportsSel).toBe(false);
      expect(f.supportsBlank).toBe(false);
    }
    for (const f of BUILTIN_FNS.filter((x) => x.group === "窗格协作")) {
      expect(f.supportsSel || f.supportsBlank).toBe(true);
    }
  });

  it("工具栏条目默认作用域（2026-10-14 定案：全部功能可入工具栏）", () => {
    // 出厂 12 键 = 文件夹作用域（恒可用）；菜单功能 = 依赖选中项 + 注册表默认条件
    expect(builtinToolbarEntry("up").area).toBe("blank");
    expect(builtinToolbarEntry("addr").area).toBe("blank");
    expect(builtinToolbarEntry("copyPath").area).toBe("blank");
    expect(builtinToolbarEntry("openTerminal").area).toBe("blank");
    expect(builtinToolbarEntry("pdfMerge").area).toBe("sel");
    expect(builtinToolbarEntry("pdfMerge").cond).toMatchObject({
      target: "file",
      minCount: 2,
      exts: "pdf",
    });
    expect(builtinToolbarEntry("delete").area).toBe("sel");
    expect(builtinToolbarEntry("delete").cond).toMatchObject({ target: "all" });
  });

  it("2026-10-14 扩充的功能已注册（复制路径/名称、终端、收藏、永久删除、反选、显隐）", () => {
    const keys = new Set(BUILTIN_FNS.map((f) => f.key));
    for (const key of [
      "copyPath",
      "copyName",
      "openTerminal",
      "addFavorite",
      "deletePerm",
      "reverseSelect",
      "toggleHidden",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it("2026-10-17 工具箱三件已注册（批量建夹/空文件清理/Excel 合并）并带合理默认条件", () => {
    const keys = new Set(BUILTIN_FNS.map((f) => f.key));
    for (const key of ["newFolders", "findEmpty", "xlsxMerge"]) {
      expect(keys.has(key)).toBe(true);
    }
    // 批量建夹 = 空白处语境（与 newFolder 同区）
    expect(builtinByKey("newFolders")?.supportsBlank).toBe(true);
    // 空文件清理与查重同款：单目录入场
    expect(builtinByKey("findEmpty")?.cond).toMatchObject({
      target: "dir",
      maxCount: 1,
    });
    // Excel 合并：≥2 个表格文件，读取口径对齐 calamine
    expect(builtinByKey("xlsxMerge")?.cond).toMatchObject({
      target: "file",
      minCount: 2,
      exts: "xlsx,xlsm,xls,xlsb,ods",
    });
  });
});

describe("扩展名解析（parseExts）", () => {
  it("中英文逗号/分号/空格混排与点号归一", () => {
    expect(parseExts(".TXT， md;zip 7z")).toEqual(["txt", "md", "zip", "7z"]);
    expect(parseExts("")).toEqual([]);
  });
});

describe("命令模板下线清理（stripCustomEntries）", () => {
  const customEntry: MenuEntry = {
    id: "custom:cmd-1",
    kind: "custom",
    area: "sel",
    cond: { target: "all", minCount: 1, maxCount: 0, exts: "" },
  };

  it("只剔除 custom 条目；builtin 与 sep 原序保留", () => {
    const entries = [...defaultMenuEntries(), { ...customEntry, id: "custom:x" }];
    const out = stripCustomEntries(entries);
    expect(out.some((e) => e.kind === "custom")).toBe(false);
    expect(out.filter((e) => e.kind === "builtin").length).toBe(
      entries.filter((e) => e.kind === "builtin").length,
    );
    expect(out.filter((e) => e.kind === "sep").length).toBe(
      entries.filter((e) => e.kind === "sep").length,
    );
  });

  it("无 custom 条目时原样返回（等值）", () => {
    const entries = defaultMenuEntries();
    expect(stripCustomEntries(entries)).toEqual(entries);
    expect(stripCustomEntries([])).toEqual([]);
  });
});

describe("基础固定功能（FIXED_KEYS / ensureFixedEntries）", () => {
  it("isFixedEntryId 只认七项基础功能", () => {
    expect(isFixedEntryId("builtin:open")).toBe(true);
    expect(isFixedEntryId("builtin:properties")).toBe(true);
    expect(isFixedEntryId("builtin:openTab")).toBe(false);
    expect(isFixedEntryId("builtin:pdfMerge")).toBe(false);
    expect(isFixedEntryId("custom:cmd-x")).toBe(false);
    expect(isFixedEntryId("sep:abc")).toBe(false);
  });

  it("归一化空数组 = 仅剩固定功能（清空语义）", () => {
    expect(ensureFixedEntries([]).map((e) => e.id)).toEqual([
      "builtin:open",
      "builtin:cut",
      "builtin:copy",
      "builtin:paste",
      "builtin:rename",
      "builtin:delete",
      "builtin:properties",
    ]);
  });

  it("布局缺失的固定项按 FIXED_KEYS 顺序追加到末尾，重复去重", () => {
    // 模拟缺 cut/copy/rename/delete 的布局（如仅剩 open/paste/properties 的精简档）
    const base = defaultMenuEntries().filter(
      (e) => !["builtin:cut", "builtin:copy", "builtin:rename", "builtin:delete"].includes(e.id),
    );
    const fixed = ensureFixedEntries(base);
    for (const key of ["open", "cut", "copy", "paste", "rename", "delete", "properties"]) {
      expect(fixed.filter((e) => e.id === `builtin:${key}`).length).toBe(1);
    }
    expect(fixed.slice(base.length).map((e) => e.id)).toEqual([
      "builtin:cut",
      "builtin:copy",
      "builtin:rename",
      "builtin:delete",
    ]);
    // 自定义条目原样保留、原有顺序不动
    const withCustom = [
      ...defaultMenuEntries(),
      { id: "custom:cmd-1", kind: "custom" as const, area: "sel" as const, cond: { target: "all" as const, minCount: 1, maxCount: 0, exts: "" } },
    ];
    const out = ensureFixedEntries(withCustom);
    expect(out[out.length - 1].id).toBe("custom:cmd-1");
  });
});

describe("默认工具栏布局（defaultToolbarEntries，2026-10-15 定案）", () => {
  it("默认排列 = 定稿 10 键：视图类型/交换窗格不入默认", () => {
    expect(defaultToolbarEntries().map((e) => e.id)).toEqual([
      "builtin:up",
      "builtin:newFolder",
      "builtin:refresh",
      "builtin:addr",
      "builtin:copyPath",
      "builtin:addFavorite",
      "builtin:search",
      "builtin:openTerminal",
      "builtin:splitH",
      "builtin:splitV",
    ]);
  });

  it("作用域键与默认表解耦：不在默认表的 view/swap 拖入仍恒可用", () => {
    expect(builtinToolbarEntry("view").area).toBe("blank");
    expect(builtinToolbarEntry("swap").area).toBe("blank");
    // 依赖选中的功能保持 sel + 注册表默认条件
    expect(builtinToolbarEntry("pdfMerge").area).toBe("sel");
    expect(builtinToolbarEntry("delete").area).toBe("sel");
  });
});

describe("功能库目录（fnGroups / spyGroup，2026-10-15 A+B 改版）", () => {
  it("fnGroups = 注册表首现顺序的 11 组（目录渲染顺序）", () => {
    expect(fnGroups()).toEqual([
      "文件",
      "剪贴板",
      "新建与选择",
      "视图",
      "窗格协作",
      "窗格工具",
      "标记与系统",
      "整理",
      "PDF",
      "图片处理",
      "办公",
      "表格与文本",
    ]);
  });

  it("spyGroup 取视口顶部触及的最新簇；高于首簇返回 null", () => {
    const cs = [
      { group: "文件", top: 0 },
      { group: "剪贴板", top: 100 },
      { group: "视图", top: 200 },
    ];
    expect(spyGroup(cs, 0, 0)).toBe("文件");
    expect(spyGroup(cs, 99, 0)).toBe("文件");
    expect(spyGroup(cs, 100, 0)).toBe("剪贴板");
    expect(spyGroup(cs, 176, 24)).toBe("视图"); // 176 + 24 ≥ 200
    expect(spyGroup(cs, 175, 24)).toBe("剪贴板");
    expect(spyGroup([], 0, 24)).toBeNull();
  });
});

describe("工具栏地址框固定条目（ensureToolbarAddr）", () => {
  it("默认布局含地址框且位于第 4 位（上一级/新建/刷新之后）", () => {
    const entries = defaultToolbarEntries();
    expect(entries[3]?.id).toBe("builtin:addr");
    expect(entries.filter((e) => e.id === "builtin:addr").length).toBe(1);
  });

  it("缺失时补插第 3 位（钳制表长），重复去重", () => {
    const noAddr = defaultToolbarEntries().filter((e) => e.id !== "builtin:addr");
    expect(ensureToolbarAddr(noAddr)[3]?.id).toBe("builtin:addr");
    // 短表：钳制到末尾
    const tiny = ensureToolbarAddr([builtinToolbarEntry("up")]);
    expect(tiny[tiny.length - 1].id).toBe("builtin:addr");
    const dup = [
      builtinToolbarEntry("addr"),
      ...defaultToolbarEntries(),
      builtinToolbarEntry("addr"),
    ];
    expect(ensureToolbarAddr(dup).filter((e) => e.id === "builtin:addr").length).toBe(1);
  });
});
