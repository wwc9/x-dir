// 快捷键统一规范审计（2026-11-25 规范化定案，第七条规范审计）：
// ① 修饰键书写序固定 Ctrl→Shift→Alt（展示与文档一致，杜绝 Ctrl+Alt+F / Alt+Ctrl+F 两写法并存）；
// ② scope=global 组合冲突审计——同组合多处出现必须在「上下文白名单」内（互斥上下文复用合法，
//    无白名单的重复 = 两功能同抢一键，后注册者永不可达）；
// ③ 资源管理器兼容底线清单——Win 文件管理器高频键必须常在清单中（防误删）。
import { describe, expect, it } from "vitest";
import { SHORTCUT_GROUPS } from "../shortcuts";

/** 规范修饰键序：Ctrl → Shift → Alt（单一修饰键任一位置皆合法） */
const ORDERED_COMBO = /^(Ctrl\+)?(Shift\+)?(Alt\+)?[^+]+$/;

/** 组合解析：keys 串展开为单组合列表（"A / B" 多键、区间 "~" 与纯鼠标/按键描述跳过） */
function combos(keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (k.includes("~") || /[滚动拖动双击右键菜单键]/.test(k)) continue;
    for (const seg of k.split(" / ")) {
      if (/^[A-Za-z0-9+]+$/.test(seg)) out.push(seg);
    }
  }
  return out;
}

const items = SHORTCUT_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ ...i, group: g.title })),
);
const globalItems = items.filter((i) => i.scope === "global");

describe("快捷键统一规范审计（2026-11-25 定案）", () => {
  it("① 修饰键书写序固定：Ctrl→Shift→Alt", () => {
    for (const item of items) {
      for (const combo of combos(item.keys)) {
        expect(
          ORDERED_COMBO.test(combo),
          `${item.id}: "${combo}" 修饰键序违反 Ctrl→Shift→Alt 规范`,
        ).toBe(true);
      }
    }
  });

  it("② scope=global 同组合必须命中上下文白名单（互斥上下文复用）", () => {
    // 白名单：键 → 允许复用的互斥上下文（同一时刻只有一个生效）
    const ALLOWED: Record<string, string> = {
      // Esc = 分层取消（菜单→搜索→过滤→选择→浮层，keyboard.ts 固定优先级）
      Esc: "分层取消链（keyboard.ts 固定优先级）",
      // Enter = 列表打开 / 预览打开文件 / 日历新增（互斥视图）
      Enter: "互斥视图（列表 / 预览开 / 日历页）",
      // Ctrl+F = 窗格递归搜索 / 预览内查找（预览开启时走预览分支）
      "Ctrl+F": "窗格 vs 预览内查找（预览开启互斥）",
      // Alt+Enter 列表属性、Ctrl+A 文本容器全选让路等以键上下文守卫
      "Alt+Enter": "列表属性（文本选区让路守卫在后）",
      // Backspace = 上级目录 / type-ahead 回删缓冲（缓冲激活时才回删，否则上级）
      Backspace: "type-ahead 缓冲激活时回删，否则上级目录",
      // Tab / Shift+Tab 同理（缓冲激活 = 命中集循环；否则浏览器焦点）
      Tab: "type-ahead 缓冲激活时循环命中，否则默认焦点",
      // Ctrl+Shift+C / X 与文本复制让路守卫（选区在场交还浏览器）
      "Ctrl+Shift+C": "复制到目标窗格（文本选区让路守卫在后）",
      "Ctrl+Shift+X": "移动到目标窗格（文本选区让路守卫在后）",
      // 系统级（scope=system）不在 global 审计范围；此处仅约束 scope=global
    };
    const seen = new Map<string, string>();
    for (const item of globalItems) {
      for (const combo of combos(item.keys)) {
        const prev = seen.get(combo);
        if (prev && prev !== item.id) {
          expect(
            ALLOWED[combo],
            `"${combo}" 被 ${prev} 与 ${item.id} 同时占用且无白名单`,
          ).toBeDefined();
        }
        seen.set(combo, item.id);
      }
    }
  });

  it("③ 资源管理器兼容底线清单：Win 文件管理器高频键必须常在", () => {
    const all = new Set(items.flatMap((i) => combos(i.keys)));
    const required: [string, string][] = [
      ["Ctrl+C", "复制"],
      ["Ctrl+X", "剪切"],
      ["Ctrl+V", "粘贴"],
      ["Ctrl+A", "全选"],
      ["Ctrl+Z", "撤销"],
      ["Ctrl+Shift+N", "新建文件夹"],
      ["F2", "重命名"],
      ["F5", "刷新"],
      ["Delete", "删除"],
      ["Backspace", "上级目录"],
      ["Enter", "打开"],
      ["Alt+Enter", "属性"],
      ["Ctrl+F", "搜索"],
      ["Alt+D", "聚焦地址栏"],
      ["Ctrl+L", "聚焦地址栏（浏览器惯例）"],
    ];
    for (const [combo, what] of required) {
      expect(all.has(combo), `资源管理器兼容键 ${combo}（${what}）缺失`).toBe(true);
    }
  });
});
