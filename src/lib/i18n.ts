// 轻量 i18n（2026-10-21）：中文源串为键、en 词典映射，未收录串回落中文原样
// 显示——组件可渐进式接入（包一层 t() 即可）。语言存 settings.lang，
// useT() 订阅切换即时重渲染；新增语言 = 在本文件增加一个词典与 lang 取值。
import { useCallback } from "react";

import { useSettings } from "../stores/settings";

/** 英文词典：键 = 中文源串（与代码内字面量逐字一致），值 = 英文文案；
 *  {x} 占位符经 t(s, params) 替换 */
const EN: Record<string, string> = {
  // ── 顶栏 ──
  "浏览记录": "History",
  "移除收藏": "Remove favorite",
  "收藏夹": "Favorites",
  "窗格布局预设": "Pane layout presets",
  "显示/隐藏导航树（所有窗格共用）": "Show/hide nav tree (shared across panes)",
  "全盘搜索": "Global search",
  "定制右键菜单与工具栏": "Customize context menu & toolbar",
  "设置": "Settings",
  "关于 X-Dir": "About X-Dir",
  "关于 X-Dir（发现新版本 {v}）": "About X-Dir (new version {v} found)",
  "拖动窗口 · 双击最大化/还原": "Drag to move · Double-click to maximize/restore",
  "切换为浅色主题": "Switch to light theme",
  "切换为深色主题": "Switch to dark theme",
  "最小化": "Minimize",
  "最大化": "Maximize",
  "还原": "Restore",
  "关闭窗口": "Close window",
  "界面缩放 {p}% · Ctrl+滚轮 / Ctrl+加减号调整 · 点击重置 100%":
    "UI zoom {p}% · Ctrl+scroll or Ctrl+plus/minus to adjust · Click to reset to 100%",
  "切换到英文界面": "Switch to English",

  // ── 边栏（布局方案 + 暂存区）──
  "布局方案": "Layouts",
  "暂存区": "Staging",
  "暂存区还是空的": "Staging is empty",
  "拖入文件/文件夹即可暂存，跨会话保留":
    "Drop files or folders to stage them; they persist across sessions",
  "展开边栏": "Expand sidebar",
  "折叠边栏": "Collapse sidebar",
  "切换到默认方案": "Switch to the default layout",
  "默认方案": "Default layout",
  "保存当前布局到选中方案": "Save current layout to the selected scheme",
  "把当前窗口组合另存为新方案": "Save current panes as a new scheme",
  "删除方案": "Delete scheme",
  "清空暂存区": "Clear staging",
  "移出暂存区": "Remove from staging",
  "拖动调整上下高度": "Drag to resize height",
  "拖动调整宽度": "Drag to resize width",
  "移动：拖动条目到窗格即移动，并移出暂存（当前模式）":
    "Move: dragging an item to a pane moves it and removes it from staging (current mode)",
  "切换为移动：拖动条目到窗格即移动，并移出暂存":
    "Switch to Move: dragging an item to a pane moves it and removes it from staging",
  "复制：拖动条目到窗格即复制，保留原件（当前模式）":
    "Copy: dragging an item to a pane copies it, keeping the original (current mode)",
  "切换为复制：拖动条目到窗格即复制，保留原件":
    "Switch to Copy: dragging an item to a pane copies it, keeping the original",
  "当前方案（改动后点上方保存覆盖）":
    "Current scheme (click save above to overwrite changes)",
  "当前方案（改动后点上方保存图标覆盖）":
    "Current scheme (click the save icon above to overwrite changes)",
  "点击切换到此布局": "Click to switch to this layout",

  // ── 窗格工具提示（toolTitle 复合串）──
  "上一级（Backspace）": "Up (Backspace)",
  "新建文件夹（Ctrl+Shift+N）": "New folder (Ctrl+Shift+N)",
  "搜索当前文件夹（Ctrl+F）": "Search current folder (Ctrl+F)",
  "交换窗格（点选目标窗格换位）": "Swap panes (click the target pane to swap)",
  "在终端打开当前文件夹": "Open current folder in terminal",
  "收藏当前文件夹": "Favorite this folder",
  "（再点一次或 Esc 退出）": " (click again or press Esc to exit)",
  "（启用条件未满足）": " (requirements not met)",

  // ── 内置功能标签（右键菜单 / 窗格工具栏 / 定制页共用）──
  "打开": "Open",
  "在新标签打开": "Open in new tab",
  "重命名": "Rename",
  "批量重命名": "Batch rename",
  "删除": "Delete",
  "永久删除": "Delete permanently",
  "属性": "Properties",
  "剪切": "Cut",
  "复制": "Copy",
  "粘贴": "Paste",
  "复制路径": "Copy path",
  "复制名称": "Copy name",
  "新建文件夹": "New folder",
  "新建文本文件": "New text file",
  "批量新建文件夹": "Batch new folders",
  "新建": "New",
  "全选": "Select all",
  "反向选择": "Invert selection",
  "预览": "Preview",
  "刷新": "Refresh",
  "切换隐藏文件": "Toggle hidden files",
  "复制到窗格": "Copy to pane",
  "移动到窗格": "Move to pane",
  "上一级": "Up",
  "视图类型": "View mode",
  "地址框": "Address bar",
  "搜索当前文件夹": "Search current folder",
  "横向分裂": "Split horizontally",
  "纵向分裂": "Split vertically",
  "交换窗格": "Swap panes",
  "颜色标记": "Color tag",
  "添加到收藏夹": "Add to favorites",
  "添加到暂存区": "Add to staging",
  "更多系统选项": "More system options",
  "在终端打开": "Open in terminal",
  "压缩为 zip": "Compress to zip",
  "解压到此处": "Extract here",
  "按规则归类": "Organize by rule",
  "查找重复文件": "Find duplicates",
  "清理空文件/空文件夹": "Clean empty files/folders",
  "空间分析": "Space analysis",
  "文件夹比较": "Compare folders",
  "PDF 合并": "Merge PDFs",
  "PDF 拆分为单页": "Split PDF into pages",
  "PDF 提取页": "Extract PDF pages",
  "PDF 删除页": "Delete PDF pages",
  "PDF 旋转": "Rotate PDF",
  "PDF 轻压缩": "Lightly compress PDF",
  "PDF 加水印": "Watermark PDF",
  "图片压缩": "Compress images",
  "图片加水印": "Watermark images",
  "图片格式转换": "Convert image format",
  "图片尺寸调整": "Resize images",
  "宫格拼图": "Image montage",
  "图片合并转 PDF": "Combine images to PDF",
  "转为 PDF": "Convert to PDF",
  "清理隐私属性": "Remove metadata",
  "导出文本 TXT": "Export as TXT",
  "编码转换": "Convert encoding",
  "CSV 合并": "Merge CSVs",
  "Excel 合并": "Merge Excel files",
  "文本合并": "Merge text files",
  "导出文件清单": "Export file list",

  // ── 功能分组（定制页聚类标题）──
  "文件": "Files",
  "剪贴板": "Clipboard",
  "新建与选择": "New & select",
  "视图": "View",
  "窗格协作": "Pane collaboration",
  "窗格工具": "Pane tools",
  "标记与系统": "Tags & system",
  "整理": "Organize",
  "图片处理": "Images",
  "办公": "Office",
  "跳转到 {g}": "Jump to {g}",
  "暂无浏览记录": "No history yet",
  "清空浏览记录": "Clear history",
  "应用默认方案（可保存覆盖；不可删除）":
    "Apply the default layout (can be saved over; cannot be deleted)",
  "{label}（拖入菜单或工具栏对应区域；可两面共享）":
    "{label} (drag into the menu or toolbar; shared by both)",
  "{label}（仅可拖入工具栏）": "{label} (toolbar only)",
  "出现条件": "Condition",
  "出现条件设置": "Condition settings",
  "—— 分割线 ——": "—— Separator ——",
};

/** 翻译：zh 原样返回；en 查词典、未收录回落中文；params 替换 {x} 占位符 */
export function t(
  s: string,
  params?: Record<string, string | number>,
): string {
  let out = useSettings.getState().lang === "en" ? (EN[s] ?? s) : s;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = out.split(`{${k}}`).join(String(v));
    }
  }
  return out;
}

/** 组件内使用：订阅语言字段，切换时所在组件重渲染 */
export function useT() {
  const lang = useSettings((s) => s.lang);
  return useCallback(
    (s: string, params?: Record<string, string | number>) => {
      let out = lang === "en" ? (EN[s] ?? s) : s;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          out = out.split(`{${k}}`).join(String(v));
        }
      }
      return out;
    },
    [lang],
  );
}
