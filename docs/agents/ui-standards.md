# UI 标准规范（AGENTS.md 详版拆分）

> 本文档是 AGENTS.md §4 组件标准规范的详版，规则效力等同主文档。
> 新增或修改任何 UI 前必读；与主文档冲突时以主文档为准。

### 4.1 设计 Token（唯一取值来源）

- **视觉语言：极简现代 · 便签卡片**——浅灰画布（四周留白）上平铺白色大圆角卡片窗格（14px 圆角、无投影），卡片间靠**沟槽**分隔；分隔条 = 隐形沟槽，悬停/拖拽以强调色轻染；**激活卡片 = 3px 强调色实线描边（无底色变化、无投影，圆角粗细恒定）**；填充式输入、pill 标签、内嵌胶囊滚动条、工具栏图标化。**边界清晰度优先于去装饰**（沟槽/边框不足时允许阴影兜底）
- **按钮焦点描边（2026-10-12 定案）**：所有按钮（Blueprint `.bp6-button` 与自绘 `button`）`:focus` / `:focus-visible` 一律 `outline: none`——鼠标点击不得残留蓝色（或任何）焦点框；不依赖 `:focus-visible` 启发式做区分（Chromium 在脚本回流焦点/连续交互时会误匹配）。键盘可达性由控件自身的激活/悬停态承担，规则实现见 index.css「全局按钮焦点态」
- **拖拽条与激活描边统一（2026-10-14 定案）**：所有面板/栏宽拖拽条（窗格分隔条、侧栏/导航树把手、全盘搜索预览分隔、右键菜单编辑器栏宽把手）统一「隐形沟槽 + 悬停/拖拽浮现 2px `--np-accent-border` 细线」，配方单源于 index.css「拖拽条统一规范」段；唯一特例 = 表头列宽把手 `.np-col-grip`（常显发丝线，2026-10-12 定案：把手必须可见可发现）。输入框聚焦 / NpSelect 开态 / 行内重命名等激活淡染描边统一走 `--np-ring` token。空态文案、辅助说明小字、pill 胶囊三类高频小样式在 index.css 组件样式类段首设「统一基方」分组声明，新增成员只补布局/间距差异、禁止复写基方
- **所有**颜色、字号、行高、间距、圆角、阴影只允许定义在 `src/index.css` 的 `--np-*` CSS 变量里
- 组件样式**禁止裸值**：颜色、字号、圆角、阴影、密度档（行高/图标档等）不允许裸值（如 `color: #3b82f6`），一律 `var(--np-*)`；全圆角（pill/圆点/细线端头）一律 `--np-radius-pill`，禁止 99px/999px 裸值混写
  - 例外 1：布局语义类 Tailwind 工具类（`flex` / `min-w-0` / `truncate` 等）不受限
  - 例外 2：JS 逻辑需要的密度数字集中在 `src/lib/tokens.ts`（`DENSITY`），与 `--np-*` 有对应的必须同名同值（如 `rowH: 28` ↔ `--np-row-h: 28px`），改一处必须改另一处；纯 JS 启发式（如右键菜单定位钳制）也集中在 DENSITY 并注释说明
  - 例外 3：index.css 组件类内的间距微调（gap/padding 的 1–10px 级布局值）允许裸值，但同一语义必须取值一致
- 色板为中性灰 + 单一强调色（浅 `#3574f0` / 深 `#5C9DFF`），强调色只用于激活态与主操作；调整主题只改 `index.css` 的 `:root` / `.dark` 两段
- Blueprint 控件的对齐覆盖集中在 `index.css` 的"Blueprint 对齐覆盖"段（只动圆角/底色/描边）

### 4.2 组件选用优先级

1. **Blueprint 内置优先**：能用 `@blueprintjs/core` 现成组件就不自写
2. Blueprint 不提供时：token 化自研（样式类定义在 `index.css`，类名 `np-*` 前缀）
3. 明确**不引入 Blueprint** 的部分（有等效自研/第三方，理由如下）：

| 部分 | 方案 | 理由 |
|---|---|---|
| 虚拟文件列表 | TanStack Virtual + `np-row` 自绘行 | Blueprint 无虚拟列表；列表是性能铁律核心，必须自控 |
| 导航树 | `NavTree.tsx` + `stores/navtree.ts`（TanStack Virtual 扁平化） | 全局共用目录树，侧边栏右侧可拖宽；点击=活动窗格导航，`list_dirs` 懒加载子目录；偏好存 localStorage |
| 详情列宽拖拽 | 共享把手 `components/ColGrip.tsx`（FileList / GlobalSearch 表头共用）+ `stores/layout.ts`（窗格）/ `stores/columns.ts`（全盘搜索） | 列宽经容器节点 `--np-colw-*` CSS 变量下发，表头与行共用 `np-col-*` 类保证对齐；纯函数 `lib/columns.ts` 配单测；**每窗格独立（2026-10-15）**：窗格列宽寄存布局树 `PaneNode.colWidths`（`setPaneColWidths` 纯函数），随工作区/「上次会话」持久化，`settings.colWidths` 降级为全局默认回落（旧档/未拖过的窗格），全盘搜索仍寄存 `gsearchColWidths`（互不干扰）；**列宽 Explorer 口径**：各列定宽互不影响，可见列总宽超出窗格即 `.np-rows` 横向滚动——内容层/表头按自然宽（`detailsContentWidth` 纯函数）撑 min-width，表头经 onScroll transform 与行同步横滚；自然宽的逐级隐藏列阈值（480/380/300）镜像 index.css 容器查询 479/379/299，两处必须同改 |
| 窗格分割 | react-resizable-panels v4 | 对应分割树模型；`Group/Panel/Separator` |
| 图标 | `lucide-react`（经 `components/AppIcon.tsx` 封装） | 1500+ 线条图标，MIT；2px 描边与"极简现代"语言同源（2026-10-10 定案，替换 Blueprint Icons） |
| 下拉选择 | `NpSelect.tsx`（PopoverNext + Menu 自研） | 原生 select 弹层是系统级渲染无法样式化；Blueprint Select 依赖经典 Popover（React 19 静默错位，见 §4.3）（2026-10-13 定案，替换 HTMLSelect） |


### 4.4 密度规范（文件管理器紧凑标准）

- 列表行高 `--np-row-h: 28px`、表头 `--np-head-h: 26px`、导航 `--np-nav-h: 34px`、标签条 `--np-tab-h: 24px`、状态条 `--np-status-h: 24px`（2026-10-13 与 index.css 现值对齐）
- 控件高 `--np-ctl-h: 24px`（HTMLSelect 等无 size prop 的控件紧凑化基准，与 Blueprint small 档同值）
- 字号仅两档：正文 `--np-font-ui: 13px`、辅助 `--np-font-sm: 11px`
- Blueprint 控件一律 `size="small"` / `minimal`（Switch 例外，默认即小）
- 新增密度值先加 token 再使用，禁止在使用点写数字

### 4.5 图标规范（Lucide，2026-10-10 定案；尺寸档位 2026-10-11 定案）

- **唯一图标库：`lucide-react`**，全项目禁止混入其他图标库或手绘 SVG
- **唯一渲染入口：`components/AppIcon.tsx`**
  - 直接使用：`<AppIcon icon={SomeIcon} size={DENSITY.iconMd} colorVar="--np-icon-code" />`
  - Blueprint 控件的 `icon=` 槽（接受 ReactNode）：`icon={ic(SomeIcon)}`（默认 sm 档）
- **尺寸四档（2026-10-11 定案）**：只允许 `DENSITY.iconXs/Sm/Md/Lg`（与 index.css `--np-icon-xs/sm/md/lg` 同名同值），调用点出现裸数字即打回；描边恒 `strokeWidth 2`
  - `xs 12` = 行内附属小动作（方案/规则删除叉等）
  - `sm 14` = **一切按钮内的图标**（顶栏、窗格导航栏、侧边栏功能排、标签条、对话框页脚、菜单项、窗口控制钮）
  - `md 16` = **文件类型图标**（列表/搜索/全盘搜索行；2026-10-15 起文件行显示尺寸统一走 `--np-realicon: 18`，Lucide 兜底经 CSS 对齐）+ 对话框/面板标题示意
  - `lg 20` = 预留（空态大示意）
  - 口诀：**按钮里 = sm；代表"文件" = md；行内小动作 = xs；独立示意 = lg**
  - `AppIcon`/`ic()` 默认档 = sm，新代码不传尺寸即正确
- **文件类型图标唯一来源：`src/lib/fileIcons.ts`**（扩展名 → Lucide 组件 + `--np-icon-*` 色变量）。2026-10-15 扩充（已全部应用）：覆盖 375+ 扩展名（代码/配置/办公三件套/图片/相机 RAW/3D/音频/视频/字幕/压缩/镜像/安装包/字体/数据库/证书/备份），**38 种图标**按语义细分（常见格式各有专属图标：RAW=Camera、设计=PenTool、字幕=Captions、光盘=Disc3、虚拟磁盘=HardDrive、种子=Magnet、安装包=Package、Java 包=Coffee、系统组件=Cog、字体=ALargeSmall 等），分类常量 + `BY_EXT`（含 `.gitignore` 等 dotfile）+ `BY_NAME`（Dockerfile 等无扩展名文件）+ `TYPE_GROUPS` 分组类型名；新增颜色 token `--np-icon-doc/-slide/-font`；新文件类型 = 在对应分类常量行加一格 + `TYPE_GROUPS` 补类型名；预览页 = `node tools/gen-file-icon-preview.mjs` 生成 `design/file-icons-preview.html`（浅/深切换，数据单一源）
- 颜色只走 `--np-icon-*` token，图标继承/显式传入，禁止写死色值
- **功能图标颜色三档（2026-10-12 定案，顶栏/导航/侧栏/标签条统一执行）**：
  - 常规 = 继承按钮文字色（`ic()`/`AppIcon` **不传 `colorVar`**），按钮文字统一 `--np-fg`，禁再引第三种灰
  - 激活/强调 = `--np-accent`（活动窗格导航、开关开启态、当前排序方向）
  - 危险 = `--np-danger`（仅关闭类动作的 hover/确认态）
  - 特例两处：顶栏品牌位 = 九宫格对角渐变 logo SVG（2026-10-12 定稿：亮蓝→天蓝→冰蓝 直角九宫格，与桌面/任务栏应用图标同源，图标资产由 `tools/gen-logo-icon.mjs` 生成）；文件类型图标 = `--np-icon-*` 语义色族（代表"文件"，不受本档约束）
  - PR 中给 UI 功能图标传语义 `colorVar`（非文件类型图标场景）即打回
- 选新图标：查 [lucide.dev](https://lucide.dev/icons) → import 组件 → 经 `ic()`/`AppIcon` 使用；留意 lucide 大版本改名（优先用当前导出名，tsc 会兜底）

### 4.6 新增/修改 UI 的流程

1. 查 §4.3 清单 → 有现成组件直接用
2. 没有 → 查 Blueprint 是否有 → 有则包一层 `np-*` 样式
3. 都没有 → token 化自研，样式类进 `index.css`，交互纯函数进 `lib/`，并更新本表
4. PR 中出现裸色值/裸像素即打回

### 4.7 二级页面统一规范（2026-10-13 定案）

适用范围：所有以 Dialog / 浮层承载的二级界面——全盘搜索、设置浮窗、确认/警告/输入/冲突/属性/批量重命名对话框、布局预设、右键菜单、地址补全（**整页例外**：定制页 `np-menupage`，视觉规范同本节执行，2026-10-14 定案）。新增或修改二级页面必须按本节执行。

- **承载与圆角**：Dialog = `np-dialog`（`--np-radius-xl` + `--np-surface` + `--np-shadow`，三段全透明，footer 以 `--np-hairline` 分隔）；页内浮层（下拉/弹出面板）= `PopoverNext` + `Menu` 的 surface 卡片（`--np-radius-lg` + `--np-shadow`）；禁用原生 select 弹层与经典 Popover
- **高度**：控件（按钮/输入/NpSelect 触发钮）统一 `--np-ctl-h: 24px`；列表行 `--np-row-h: 28px`；紧凑间距 `--np-gap: 4px`、区块间距 `--np-gutter: 8px`；分区线 = 1px `--np-hairline`（如 `.np-set-sep`）
- **颜色**：面板底 `--np-surface`；填充控件（输入框/触发钮/凹陷列表）`--np-surface-2`；悬停 `--np-hover`；打开/激活态 = surface 底 + accent 淡染描边（`0 0 0 2px` 45% 透明 accent，同 np-nav 输入框焦点态）；文字 `--np-fg`、辅助 `--np-muted`；accent 只用于激活与主操作，danger 只用于删除类动作
- **字号**：正文 `--np-font-ui: 13px`、标签/辅助说明 `--np-font-sm: 11px`
- **交互风格**：填充式输入；下拉一律 `NpSelect`（选中项 Check 标记、开态箭头旋转 180°）；图标经 `ic()`/`AppIcon`（§4.5）；按钮焦点态按 index.css「全局按钮焦点态」
- **验收口径**：二级界面内不得出现未经样式化的原生系统控件（原生 select 弹层、系统菜单、默认描边控件）；新组件先查 §4.3 清单，取值全部走 `--np-*` token（§4.1）


### 4.8 按钮提示文本（title）规范（2026-10-21 定案）

所有可交互元素的 `title` 提示统一口径（2026-10-21 全量清理落地）：

- **格式**：动作短语（动宾）或名词（入口/区域）；需补充时全角括号紧跟：`刷新（重新读取已展开的目录）`
- **快捷键**：统一全角括号、紧跟动作、无空格 —— `全盘搜索（Ctrl+Shift+F）`；方向键/单键同口径：`下一个（↓）`、`用默认程序打开（Enter）`
- **复合提示**：中点衔接 —— `拖动调整列宽 · 双击恢复默认`
- **开关/切换类**：`显示/隐藏 XX` 或 `名称：当前态（点击切换为另一态）` —— `显示/隐藏导航树（所有窗格共用）`、`自动换行：开（点击改为不换行）`
- **措辞**：通俗中文，不写内部术语（缓存/就地/秒搜等改写为用户动作与结果）；破坏性动作写明后果（`清空暂存区`、`删除到回收站`）；图标按钮必须有 title（无文字可访问名时同时补 `aria-label`）
- **镜像文案**：同一控件在多处出现（如窗格过滤与全盘搜索的类型筛选）提示文本保持逐字一致
