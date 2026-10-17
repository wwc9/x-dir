// 前端密度常量：与 index.css 的 --np-* 变量保持一致（AGENTS.md：密度只在这里和 tokens 改）

export const DENSITY = {
  rowH: 28,
  cellWList: 190,
  overscan: 6,
  // 图标四档（AGENTS §4.5）：xs=行内小动作 sm=按钮内图标 md=文件类型/标题示意 lg=空态示意
  iconXs: 12,
  iconSm: 14,
  iconMd: 16,
  iconLg: 20,
  // 右键菜单定位钳制（纯 JS 启发式估算，无 CSS 同名 token）：
  // 菜单最大宽度估算 / 单菜单项高度估算 / 上下安全边距
  menuClampW: 240,
  menuRowH: 30,
  menuEdge: 24,
  // 布局方案缩略图（描线 SVG）三档，与 index.css 的 .np-side-thumb* 选择器同值：
  // 折叠态 np-side-mini=18 / 方案列表 np-side-item=24 / 预设瓷砖 np-layouttile=28
  sideThumbSm: 18,
  sideThumbMd: 24,
  sideThumbLg: 28,
  // 快速预览文本直读上限（纯 JS 启发式，无同名 CSS token）：超过即截断提示"用默认程序打开"
  previewTextMaxBytes: 2_000_000,
  // 首字母跳转缓冲超时（纯 JS 启发式，无同名 CSS token）：停顿超过即清空缓冲重新累积
  typeAheadMs: 1000,
  // 功能库目录 scrollspy（纯 JS 启发式，无同名 CSS token）：滚动容器视口顶部
  // 触发高亮切换的下探阈值（px）；目录点击平滑跳转期间挂起 spy 的解锁时长（ms）
  libSpyThreshold: 24,
  libJumpLockMs: 600,
  // 顶栏灵动岛（纯 JS 启发式，无同名 CSS token）：事件回执驻留时长
  islandReceiptMs: 4_000,
  // 定制页拖拽幽灵（纯 JS 启发式，无同名 CSS token）：拖拽浮标相对光标的右/下偏移
  dragGhostDx: 10,
  dragGhostDy: 8,
} as const;
