// 快捷键清单单一来源：设置面板「快捷键」页与 lib/__tests__/keyboard.test.ts
// 共用（清单与测试用例经 scope=id 对齐，防止单边漂移）。
// keys = 组合键展示串列表（段以 + 分隔，"A / B" 表示同档位多键）；
// scope = global（经 onGlobalKeyDown 全局路由，测试强制逐条覆盖）
//       | component（输入框/浮层控件内部处理，清单展示用）
//       | system（系统级热键/独立窗口内按键，由 Rust 插件或截图/贴图窗自行
//         处理，不经 onGlobalKeyDown；仅清单展示）。

export interface ShortcutItem {
  id: string;
  keys: string[];
  label: string;
  scope: "global" | "component" | "system";
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "全局",
    items: [
      { id: "gsearch-open", keys: ["Ctrl+Shift+F"], label: "全盘搜索", scope: "global" },
      {
        id: "zoom",
        keys: ["Ctrl+=", "Ctrl+-", "Ctrl+0"],
        label: "界面缩放：放大 / 缩小 / 重置 100%",
        scope: "global",
      },
      { id: "menu-close", keys: ["Esc"], label: "关闭右键菜单", scope: "global" },
      {
        id: "menu-page-close",
        keys: ["Esc"],
        label: "关闭右键菜单编辑页（输入框内先失焦）",
        scope: "global",
      },
      {
        id: "gsearch-page-close",
        keys: ["Esc"],
        label: "关闭全盘搜索页（输入框内亦直接关闭）",
        scope: "global",
      },
      { id: "input-blur", keys: ["Esc"], label: "输入框失焦（退出编辑状态）", scope: "global" },
    ],
  },
  {
    title: "窗格与布局",
    items: [
      { id: "pane-focus-n", keys: ["Ctrl+1 ~ 9"], label: "聚焦第 N 窗格（布局 DFS 序）", scope: "global" },
      { id: "pane-focus-dir", keys: ["Alt+← / → / ↑ / ↓"], label: "焦点移至该方向最近的窗格", scope: "global" },
      { id: "pane-split", keys: ["Ctrl+Shift+H", "Ctrl+Shift+V"], label: "活动窗格横向 / 纵向分裂", scope: "global" },
      { id: "pane-close", keys: ["Ctrl+Shift+W"], label: "关闭活动窗格", scope: "global" },
      {
        id: "copy-to-pane",
        keys: ["Ctrl+Shift+C"],
        label: "复制选中项到目标窗格（每窗格记忆上次选过的对侧，未记忆 = 首个其他窗格）",
        scope: "global",
      },
      {
        id: "move-to-pane",
        keys: ["Ctrl+Shift+X"],
        label: "移动选中项到目标窗格（同上）",
        scope: "global",
      },
      { id: "swap-cancel", keys: ["Esc"], label: "取消交换窗格的选择模式", scope: "global" },
    ],
  },
  {
    title: "标签页",
    items: [
      { id: "tab-new", keys: ["Ctrl+T"], label: "新建标签", scope: "global" },
      { id: "tab-close", keys: ["Ctrl+W"], label: "关闭当前标签", scope: "global" },
      { id: "tab-cycle", keys: ["Ctrl+Tab", "Ctrl+Shift+Tab"], label: "标签右移 / 左移（活动窗格内）", scope: "global" },
    ],
  },
  {
    title: "导航与视图",
    items: [
      { id: "addr-focus", keys: ["Alt+D"], label: "聚焦活动窗格的地址栏", scope: "global" },
      { id: "search-pane", keys: ["Ctrl+F"], label: "搜索当前文件夹（递归）", scope: "global" },
      {
        id: "view-filter",
        keys: ["Ctrl+E"],
        label: "视图内过滤当前文件夹（名称 / 拼音首字母，不递归；Esc 退出还原）",
        scope: "global",
      },
      { id: "nav-up", keys: ["Backspace"], label: "上级目录", scope: "global" },
      { id: "refresh", keys: ["F5"], label: "刷新活动窗格", scope: "global" },
      { id: "view-cycle", keys: ["F3"], label: "循环切换视图（详细信息 ↔ 列表）", scope: "global" },
      { id: "mouse-nav", keys: ["鼠标 X1 / X2"], label: "后退 / 前进（活动标签历史）", scope: "component" },
    ],
  },
  {
    title: "快速预览",
    items: [
      { id: "preview-toggle", keys: ["Space"], label: "开 / 关快速预览", scope: "global" },
      { id: "preview-cycle", keys: ["↑ / ↓"], label: "预览中切换上一个 / 下一个文件", scope: "global" },
      { id: "preview-search", keys: ["Ctrl+F"], label: "预览内查找（PDF / 文本 / 表格 / 文档；Enter / Shift+Enter 跳命中）", scope: "global" },
      { id: "preview-open-file", keys: ["Enter"], label: "预览中用默认程序打开", scope: "global" },
      { id: "preview-close", keys: ["Esc"], label: "关闭快速预览", scope: "global" },
    ],
  },
  {
    title: "列表选择",
    items: [
      { id: "sel-arrow", keys: ["↑ / ↓ / ← / →"], label: "移动选择（配合 Shift 为范围选）", scope: "global" },
      { id: "sel-page", keys: ["PageUp / PageDown"], label: "翻页移动选择（配合 Shift 为范围选）", scope: "global" },
      { id: "sel-homeend", keys: ["Home / End"], label: "跳到首项 / 末项（配合 Shift 为范围选）", scope: "global" },
      { id: "select-all", keys: ["Ctrl+A"], label: "全选", scope: "global" },
      { id: "type-ahead", keys: ["A-Z / 0-9"], label: "输入字符跳转到匹配文件名（连续输入累积前缀；中文按拼音首字母）", scope: "global" },
      { id: "sel-clear", keys: ["Esc"], label: "先关闭窗格内搜索，再退视图过滤，最后清空选择", scope: "global" },
    ],
  },
  {
    title: "文件操作",
    items: [
      { id: "open", keys: ["Enter"], label: "打开（文件夹进入 / 文件默认程序打开）", scope: "global" },
      { id: "rename", keys: ["F2"], label: "就地重命名", scope: "global" },
      { id: "delete", keys: ["Delete"], label: "删除到回收站（可设删除前确认）", scope: "global" },
      { id: "delete-permanent", keys: ["Shift+Delete"], label: "永久删除（强制确认，不可恢复）", scope: "global" },
      { id: "clipboard", keys: ["Ctrl+C / Ctrl+X / Ctrl+V"], label: "应用内剪贴板：复制 / 剪切 / 粘贴", scope: "global" },
      { id: "new-folder", keys: ["Ctrl+Shift+N"], label: "新建文件夹", scope: "global" },
      { id: "undo", keys: ["Ctrl+Z"], label: "撤销：回收站删除还原 / 重命名改回 / 移动移回 / 新建移入回收站", scope: "global" },
      { id: "redo", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], label: "重做：再执行一遍刚撤销的操作", scope: "global" },
      { id: "properties", keys: ["Alt+Enter"], label: "属性", scope: "global" },
      { id: "context-menu", keys: ["Shift+F10", "菜单键"], label: "呼出选中项右键菜单", scope: "global" },
    ],
  },
  {
    title: "输入框与浮层",
    items: [
      { id: "addr-go", keys: ["Enter"], label: "地址栏：前往", scope: "component" },
      { id: "addr-revert", keys: ["Esc"], label: "地址栏：还原路径并失焦", scope: "component" },
      { id: "addr-sugg", keys: ["↑ / ↓ / Tab"], label: "地址栏补全：选择候选 / 补全", scope: "component" },
      { id: "search-close", keys: ["Esc"], label: "窗格内搜索框：关闭搜索", scope: "component" },
      { id: "filter-close", keys: ["Esc"], label: "视图过滤框：退出过滤（列表还原）", scope: "component" },
      { id: "rename-commit", keys: ["Enter / Esc"], label: "就地重命名：提交 / 取消", scope: "component" },
      { id: "gsearch-navigate", keys: ["↑ / ↓ / Enter"], label: "全盘搜索：移动选择 / 打开", scope: "component" },
      { id: "gsearch-close", keys: ["Esc"], label: "关闭全盘搜索", scope: "component" },
      { id: "dialog-esc", keys: ["Esc"], label: "对话框：关闭（= 取消）", scope: "component" },
      { id: "zoom-wheel", keys: ["Ctrl+滚轮"], label: "界面缩放（与浏览器习惯一致）", scope: "component" },
      { id: "img-zoom", keys: ["滚轮"], label: "图片预览：缩放图片", scope: "component" },
    ],
  },
  {
    title: "截图与贴图",
    items: [
      {
        id: "shot-open",
        keys: ["Ctrl+Alt+A"],
        label: "截图（系统级热键，X-Dir 运行时任意界面生效；键位可在设置 → 截图更改）",
        scope: "system",
      },
      {
        id: "shot-esc",
        keys: ["Esc / 右键"],
        label: "截图：逐层取消（文字 → 标注 → 工具 → 选区 → 关闭）",
        scope: "system",
      },
      { id: "shot-copy", keys: ["Enter / 双击"], label: "截图：复制到剪贴板", scope: "system" },
      { id: "shot-pin", keys: ["Ctrl+P"], label: "截图：贴图（钉在屏幕上）", scope: "system" },
      { id: "shot-undo", keys: ["Ctrl+Z / Ctrl+Y"], label: "截图：撤销 / 重做标注", scope: "system" },
      {
        id: "shot-nudge",
        keys: ["WASD / 方向键"],
        label: "截图：微调十字准星 / 平移选区框（Shift = 10px 大步）",
        scope: "system",
      },
      {
        id: "shot-scroll-keys",
        keys: ["Enter / Esc"],
        label: "滚动截图浮条：完成出图 / 取消丢弃",
        scope: "system",
      },
      { id: "pin-wheel", keys: ["滚轮 / Alt+滚轮"], label: "贴图：缩放 / 调整不透明度", scope: "system" },
      { id: "pin-move", keys: ["左键拖动"], label: "贴图：移动位置", scope: "system" },
      { id: "pin-close", keys: ["双击 / Esc"], label: "贴图：关闭", scope: "system" },
    ],
  },
];

/** scope=global 的全部 id（测试覆盖校验用） */
export const GLOBAL_SHORTCUT_IDS: string[] = SHORTCUT_GROUPS.flatMap((g) =>
  g.items.filter((i) => i.scope === "global").map((i) => i.id),
);
