// 设置页搜索（2026-11-25 用户需求「设置页搜索框」）：跨分类行索引 + 过滤
// 纯函数（配 vitest）。行是内联 JSX 无法自动导出，索引为手维护清单——与
// SettingsPanel 各 SetRow 标题逐字对齐，新增设置行时在此补一行。
import type { SettingsTabId } from "../components/SettingsPanel";

export interface SettingsIndexEntry {
  tab: SettingsTabId;
  /** 行标题（与 SetRow label 逐字一致） */
  title: string;
}

export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  // ── 外观 ──
  { tab: "appearance", title: "主题" },
  { tab: "appearance", title: "界面缩放" },
  { tab: "appearance", title: "强调色" },
  { tab: "appearance", title: "真实文件图标" },
  { tab: "appearance", title: "面板圆角" },
  { tab: "appearance", title: "组件间隔" },
  { tab: "appearance", title: "窗口毛玻璃" },
  { tab: "appearance", title: "背景图案" },
  { tab: "appearance", title: "模糊强度" },
  { tab: "appearance", title: "霜面浓度" },
  { tab: "appearance", title: "弹层模糊" },
  { tab: "appearance", title: "弹层浓度" },
  { tab: "appearance", title: "自定义图片" },
  { tab: "appearance", title: "蒙版浓度" },
  // ── 性能 ──
  { tab: "perf", title: "性能模式" },
  // ── 浏览 ──
  { tab: "browse", title: "新标签默认视图" },
  { tab: "browse", title: "新标签默认排序" },
  { tab: "browse", title: "「在终端打开」使用的 shell" },
  { tab: "browse", title: "显示隐藏文件" },
  { tab: "browse", title: "是否展示文件夹的大小" },
  { tab: "browse", title: "记忆目录选中集" },
  { tab: "browse", title: "启动时恢复上次会话" },
  // ── 文件操作 ──
  { tab: "ops", title: "删除前确认" },
  { tab: "ops", title: "关闭窗格前确认" },
  { tab: "ops", title: "系统进度与冲突框" },
  // ── 全盘搜索 ──
  { tab: "search", title: "呼出热键（自定义）" },
  { tab: "search", title: "预览面板" },
  // ── 截图 ──
  { tab: "shot", title: "启用截图" },
  { tab: "shot", title: "截图快捷键" },
  { tab: "shot", title: "立即试一次" },
  { tab: "shot", title: "十字辅助线" },
  // ── 剪贴板 ──
  { tab: "clip", title: "启用剪贴板历史" },
  { tab: "clip", title: "呼出热键（自定义）" },
  { tab: "clip", title: "选中后直接粘贴" },
  { tab: "clip", title: "历史容量" },
  { tab: "clip", title: "清理历史条目" },
  { tab: "clip", title: "排除应用" },
  { tab: "clip", title: "富文本保真" },
  { tab: "clip", title: "保留天数" },
  { tab: "clip", title: "备份导出" },
  { tab: "clip", title: "备份导入" },
  // ── 日历 ──
  { tab: "calendar", title: "启用工作日历" },
  { tab: "calendar", title: "呼出热键（自定义）" },
  { tab: "calendar", title: "显示农历与节气" },
  { tab: "calendar", title: "格子着色维度" },
  // ── 着色规则 ──
  { tab: "rules", title: "着色规则" },
  // ── 快捷键 ──
  { tab: "keys", title: "快捷键清单" },
  // ── 配置 ──
  { tab: "config", title: "开机自启" },
  { tab: "config", title: "打开配置保存位置" },
  { tab: "config", title: "导出配置文件" },
  { tab: "config", title: "导入配置文件" },
  { tab: "config", title: "欢迎引导" },
];

/** 过滤：标题/分类名的子串匹配（大小写不敏感；空查询 = 全部）。 */
export function searchSettings(
  query: string,
  tabLabels: Record<string, string>,
): SettingsIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTINGS_INDEX.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      (tabLabels[e.tab] ?? "").toLowerCase().includes(q),
  );
}
