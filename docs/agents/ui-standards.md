# UI 标准规范（AGENTS.md 详版拆分）

> 本文档是 AGENTS.md §4 组件标准规范的详版，规则效力等同主文档。
> 新增或修改任何 UI 前必读；与主文档冲突时以主文档为准。

### 4.1 设计 Token（唯一取值来源）

- **视觉语言：极简现代 · 便签卡片**——浅灰画布（四周留白）上平铺白色大圆角卡片窗格（卡片圆角默认 10px、无投影），卡片间靠**沟槽**分隔；分隔条 = 隐形沟槽，悬停/拖拽以强调色轻染；**激活卡片 = 3px 强调色实线描边（无底色变化、无投影，圆角粗细恒定）**；填充式输入、pill 标签、内嵌胶囊滚动条、工具栏图标化。**边界清晰度优先于去装饰**（沟槽/边框不足时允许阴影兜底）
- **面板圆角与组件间隔统一规范（2026-11-03 定案）**：面板级圆角一档到底 `--np-radius-pane`（窗格/侧栏卡/导航树/暂存架/顶栏/全盘搜索页/Dialog/菜单编辑器/任务列表/剪贴板浮窗等全部同值；`--np-radius-xl` 已退役删除）；瞬态小浮层（菜单/Popover/Toast/地址补全/右键菜单）与内嵌凹陷框保留小一档 `--np-radius-lg`、控件 6px、pill 另计。两值经设置「外观 → 面板圆角（0–24，默认 10）/ 组件间隔（4–24，默认 6）」由 `stores/settings.applyMetrics` 以 :root 内联覆写 `--np-radius-pane` 与 `--np-gutter`（分隔条可拖热区依赖 gutter 宽度，下限 4px），全部引用点即时跟随
- **同排卡片标题行逐像素对齐（2026-11-12 定案）**：共用标题行类 `.np-side-h` 的面板（边栏方案卡 `.np-side-card` / 暂存卡 `.np-shelf` / 导航树 `.np-navtree`）容器 padding 必须逐边同值（现值 `2px 6px 6px`）——标题行内边距之外，标题的落点由容器 padding 决定，容器不同值即标题错位（本次偏差：`.np-navtree` 独用 `8px`，标题低 6px 右移 2px）。新增同排卡片只准复制姊妹卡容器 padding，标题行类禁止另起炉灶
- **玻璃拟态 token 组（2026-11-12 定案 = 右键菜单「霜」方案，design/menu-proposal-c-frost.html）**：`--np-glass`（半透明底）/ `--np-glass-ring`（内高光描边）/ `--np-glass-hover`（高光悬停条）/ `--np-glass-shadow`（光晕投影），深浅主题各一套，定义于 index.css token 区。**目前仅右键菜单作用域消费**（`.np-ctx` 顶层容器 + `.np-ctx-pop` 子菜单 Popover 通道，ContextMenu.tsx 传入；实现 = `backdrop-filter: blur(22px) saturate(1.4)` + accent 左指示条 `::before`，`@supports not (backdrop-filter)` 回退实底卡片）——其余菜单/Popover 家族维持实底脸；推广到全浮层家族前须先评估低 GPU 环境（RDP/远程会话）帧耗
- **按钮焦点描边（2026-10-12 定案）**：所有按钮（Blueprint `.bp6-button` 与自绘 `button`）`:focus` / `:focus-visible` 一律 `outline: none`——鼠标点击不得残留蓝色（或任何）焦点框；不依赖 `:focus-visible` 启发式做区分（Chromium 在脚本回流焦点/连续交互时会误匹配）。键盘可达性由控件自身的激活/悬停态承担，规则实现见 index.css「全局按钮焦点态」
- **拖拽条与激活描边统一（2026-10-14 定案）**：所有面板/栏宽拖拽条（窗格分隔条、侧栏/导航树把手、全盘搜索预览分隔、右键菜单编辑器栏宽把手）统一「隐形沟槽 + 悬停/拖拽浮现 2px `--np-accent-border` 细线」，配方单源于 index.css「拖拽条统一规范」段；唯一特例 = 表头列宽把手 `.np-col-grip`（常显发丝线，2026-10-12 定案：把手必须可见可发现）。输入框聚焦 / NpSelect 开态 / 行内重命名等激活淡染描边统一走 `--np-ring` token。空态文案、辅助说明小字、pill 胶囊三类高频小样式在 index.css 组件样式类段首设「统一基方」分组声明，新增成员只补布局/间距差异、禁止复写基方
- **所有**颜色、字号、行高、间距、圆角、阴影只允许定义在 `src/index.css` 的 `--np-*` CSS 变量里
- 组件样式**禁止裸值**：颜色、字号、圆角、阴影、密度档（行高/图标档等）不允许裸值（如 `color: #3b82f6`），一律 `var(--np-*)`；全圆角（pill/圆点/细线端头）一律 `--np-radius-pill`，禁止 99px/999px 裸值混写
  - 例外 1：布局语义类 Tailwind 工具类（`flex` / `min-w-0` / `truncate` 等）不受限
  - 例外 2：JS 逻辑需要的密度数字集中在 `src/lib/tokens.ts`（`DENSITY`），与 `--np-*` 有对应的必须同名同值（如 `rowH: 28` ↔ `--np-row-h: 28px`），改一处必须改另一处；纯 JS 启发式（如右键菜单定位钳制）也集中在 DENSITY 并注释说明
  - 例外 3：index.css 组件类内的间距微调（gap/padding 的 1–10px 级布局值）允许裸值，但同一语义必须取值一致
- 色板为中性灰 + 单一强调色（浅 `#3574f0` / 深 `#5C9DFF`），强调色只用于激活态与主操作；调整主题只改 `index.css` 的 `:root` / `.dark` 两段。**深色主题灰阶（2026-11-11 定案）参考 zcode 深色方案截图取样定值**：画布 `#161616` / 浮起面板 `#2B2B2B` / 填充输入 `#3a3a3a` / 正文 `#D4D4D4` / muted `#8f8f8f` / 成功绿 `#46BF72`——zcode 为无边框语言、层级纯靠明度差，`--np-border` 仅为 popover ring 等线场景保留中性一档（`#454545`）；强调色仍为蓝（单一强调色决策不变）。原生窗口底色（`stores/settings.ts` 的 setBackgroundColor/syncBorderColor `#161616`）与 `--np-bg` 同值，改画布色必须两处同改
- Blueprint 控件的对齐覆盖集中在 `index.css` 的"Blueprint 对齐覆盖"段（只动圆角/底色/描边）

### 4.2 组件选用优先级

1. **Blueprint 内置优先**：能用 `@blueprintjs/core` 现成组件就不自写
2. Blueprint 不提供时：token 化自研（样式类定义在 `index.css`，类名 `np-*` 前缀）
3. 明确**不引入 Blueprint** 的部分（有等效自研/第三方，理由如下）：

| 部分 | 方案 | 理由 |
|---|---|---|
| 虚拟文件列表 | TanStack Virtual + `np-row` 自绘行 | Blueprint 无虚拟列表；列表是性能铁律核心，必须自控 |
| 导航树 | `NavTree.tsx` + `stores/navtree.ts`（TanStack Virtual 扁平化） | 全局共用目录树，侧边栏右侧可拖宽；点击=活动窗格导航，`list_dirs` 懒加载子目录；偏好存 settings.json；「此电脑」根节点恒展开不可折叠（2026-11-12 定案：省去折叠箭头列，盘符提为顶层行与根行同缩进，其下目录 depth 1） |
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

0. **先通读本规范（AGENTS.md 硬性要求，2026-11-10 定案）**：绘制或更新任何
   UI 界面——新功能、改样式、调布局、新增/修改对话框——必须先完整阅读本文档
   （重点 §4.4 密度、§4.7 二级页面、§4.9 参数面板对齐细则），完成后按 §4.7
   验收口径自查；规范未覆盖的视觉偏差（控件自带默认样式导致的字号/行距/
   对齐问题）修完后把结论补回本文档条款，防止同类问题再犯
1. 查 features.md「基础组件定案」→ 有现成组件直接用
2. 没有 → 查 Blueprint 是否有 → 有则包一层 `np-*` 样式，并按 §4.4/§4.7 显式
   紧凑化（Blueprint 默认字号 14px/间距与本项目密度不一致，不覆盖即偏差）
3. 都没有 → token 化自研，样式类进 `index.css`，交互纯函数进 `lib/`，并更新本表
4. PR 中出现裸色值/裸像素即打回

### 4.7 二级页面统一规范（2026-10-13 定案）

适用范围：所有以 Dialog / 浮层承载的二级界面——全盘搜索、设置浮窗、确认/警告/输入/冲突/属性/批量重命名对话框、布局预设、右键菜单、地址补全（**整页例外**：定制页 `np-menupage`，视觉规范同本节执行，2026-10-14 定案）。新增或修改二级页面必须按本节执行。

- **承载与圆角**：Dialog = `np-dialog`（`--np-radius-pane` + `--np-surface` + `--np-shadow`，三段全透明，footer 以 `--np-hairline` 分隔；2026-11-03 起与窗格卡片同档、随设置可调）；页内浮层（下拉/弹出面板）= `PopoverNext` + `Menu` 的 surface 卡片（`--np-radius-lg` + `--np-shadow`）；禁用原生 select 弹层与经典 Popover
- **标题必有（2026-11-10 定案）**：每个 Dialog 必须有标题行——新对话框类型必须登记进 DialogHost 的 `title` 映射链，漏登记 = 只剩右上角关闭钮，验收打回；纯信息（范围/落点/条数等）不占参数行，并入 `np-dialog-muted` 收尾说明（整句人话，含落点与重名规则）
- **高度**：控件（按钮/输入/NpSelect 触发钮）统一 `--np-ctl-h: 24px`；列表行 `--np-row-h: 28px`；紧凑间距 `--np-gap: 4px`、区块间距 `--np-gutter: 6px`；分区线 = 1px `--np-hairline`（如 `.np-set-sep`）
- **颜色**：面板底 `--np-surface`；填充控件（输入框/触发钮/凹陷列表）`--np-surface-2`；悬停 `--np-hover`；打开/激活态 = surface 底 + accent 淡染描边（`0 0 0 2px` 45% 透明 accent，同 np-nav 输入框焦点态）；文字 `--np-fg`、辅助 `--np-muted`；accent 只用于激活与主操作，danger 只用于删除类动作
- **字号**：正文 `--np-font-ui: 13px`、标签/辅助说明 `--np-font-sm: 11px`；**Blueprint
  控件自带文案（Checkbox/Switch/Radio label 等）默认 14px，进入二级页面必须显式
  紧凑化对齐两档**（`.np-dialog .bp6-checkbox` / `.bp6-switch` 全局覆盖已落地——
  前者 2026-11-10 导出清单面板用户反馈补条款，后者 2026-11-11 工具界面全量
  审查补齐）；行节奏以 `--np-ctl-h` 为统一基线，行内控件高度不一时拉齐居中；
  **应用口径（2026-11-10 二次定案）**：内容文字与各级标题/行标题一律正文 13px
  （分节标题「处理顺序」、清单行文件名等不降辅助档——同面板混排 11/13px 即
  字号不一），辅助 11px 仅用于真正的小附属元素（清单序号 pos、键帽等）与
  muted 色说明行
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
- **承载组件（2026-10-21 定案）**：交互控件的提示由全局自绘 `np-tip` 承载（`lib/tooltip.ts` 委托单例，方案 B 卡片键帽，120ms）——按钮/输入/行控件写 `data-tip="文本"`，快捷键写 `data-kbd="Ctrl+Shift+F"`（渲染为键帽 chip），**不再写原生 `title`**（原生仅保留：内容截断省略号、Dialog 标题 prop、非交互信息条）；新增按钮默认零成本接入（写属性即生效）

### 4.9 参数对话框布局规范（2026-10-22 定案；2026-11-10 增双列对齐细则；
  2026-11-11 增输入框填充与提示文本完整可见条款）

右键功能参数对话框（PDF 合并/按文件夹合并/加水印等待处理类弹窗）统一布局：

- **双列参数面板与对齐细则（2026-11-10 定案，导出清单面板七轮迭代沉淀；适用
  全部参数容器 = `np-bren-form.is-cols` / `np-pdfmform` / `np-wm-form`，2026-11-10
  二批全量对齐）**：
  - **布局**：双列用 `np-bren-form.is-cols`（grid `max-content + 1fr` 两列轨；
    `np-bren-field` 转 `display: contents` 使标签/控件直接成为两列网格项）——
    标题列按最宽标签自动定轨（i18n 安全，EN 长标签不破版），标题列与选项列
    **各自左对齐**；**每行必须单控件**——「输入框 + 单位后缀」等组合控件用
    `np-filext` 并排 flex 容器打包（`inline-flex + align-items: center + gap`，
    输入框 `flex: 1`，如导出清单的 文件名+.xlsx），红字校验提示移到表单下方
    独立行，多控件行会错轨
  - **横向中轴对齐**：全部行按 `--np-ctl-h` 基线 `min-height + align-self: center`
    拉齐；**仅此不够**——标题 span 与 Checkbox 是 block 盒，盒子居中了盒内文本
    仍从顶部排布，必须再转 `inline-flex + align-items: center` 才真正同轴
    （文字中线与 Seg/输入框一致）
  - **Blueprint 自带样式三处必覆盖 + 一处必规避**（不覆盖即出现字号/行距/对齐偏差）：
    ① 控件文案默认 14px → `.np-dialog .bp6-checkbox` 等显式对齐正文 13px；
    ② `.bp6-control` 自带 `margin-bottom: 8px` → 参数表单内清零（行距只由
    网格 gap 供给，禁止控件自带边距参与节奏）；③ 复选框指示器自带
    `margin-top: -3px`（行内排版基线补偿）→ flex 居中语境归零（隐藏 input 为
    `position: absolute` 不参与 flex，转 flex 安全）；④ **单位后缀禁用
    `InputGroup rightElement`**——其 action 容器 `position: absolute; top: 0`
    钉死输入框顶部，与输入文字的垂直居中链路相互独立，像素级 CSS 修正两轮
    皆失败（2026-11-10 导出清单教训），结构性规避 = `np-filext` 并排 flex
    容器（对齐由构造保证）
  - **输入宽度两档 + 提示文本完整可见（2026-11-11 用户反馈 placeholder 被
    裁剪定案）**：输入框全局基线 = `.np-bren-field > .bp6-input-group`
    **120px 短输入档**（数字/页码类，避免数字框突兀拉满——有意的设计决定），
    三种网格容器各配 **wide 行满宽档**恢复长文本输入可用：
    `np-bren-form.is-cols` 加 `.np-bren-field.np-wide > .bp6-input-group
    { width: auto; min-width: 0 }`（grid 项 width:auto 回落 justify-self:
    stretch 拉伸；display:contents 变体此前漏配此档 = 本次截断根因），
    `np-pdfmform.np-two-col` 与 `np-wm-form` 已有同款。验收口径：**任何
    输入框的 placeholder 必须完整可读**——短输入档 120px 只放 ≤6 字提示
    （"1"/"到末页"），长提示（口令/表达式/规则类）一律 wide 行满宽
    （默认 460px 弹窗下 ~300px ≈ 20 汉字预算）；写 placeholder 前先做
    文案预算：与行标题重复的术语、超过预算的解释移入 muted 说明行，
    占位文本只留操作指引，禁止靠截断"赌"用户看得懂。「输入框 + 单位后缀」
    组合仍走 `np-filext` 打包（拆分对话框命名规则行 2026-11-11 同步规范化：
    裸 span 后缀在 display:contents 网格下是独立网格项，有错轨隐患）
  - **参数标题字号**：与选项并排的行标题用**正文 13px**（`--np-font-ui`，muted
    色区分层级）；11px 辅助字（`--np-font-sm`）只用于独立说明行，不得用于
    双列面板的行标题（与选项并排时大小/中轴视觉皆不齐）
  - **行距口径**：行与行、行与说明行的间距只由容器 gap/一个 margin-bottom
    供给，**禁止控件自带边距参与**——多源边距是行距不一致的常见根因
  - **默认值与记忆口径**：参数记忆走 `settings.dialogPrefs`（loadDialogPrefs/
    saveDialogPrefs）；**用户点名"某项为默认"的参数不持久化**（每次打开恒为
    该默认，记忆值会反压新默认；本次清除数据治标不治本），其余参数记忆
- **验收自查清单（2026-11-10 二批审查遗漏教训成文——审查必须按本清单逐面板
  过一遍，禁止只查参数行；遗漏教训 = 清单区↔参数区间距为 0 与清单行 11px
  字号混排均发生在参数行之外）**。按结构分层逐层核对：
  1. **结构层**：三段齐备（清单/参数/页脚）；每两个区块之间有且仅有一个
     间距供给方（清单容器 margin-bottom），不存在 0 间距接缝；
  2. **行层**：每行单控件（组合控件用并排容器打包）；标题列/选项列各自
     左对齐（双列网格）；
  3. **行内层**：标题与选项横向中轴对齐（block 盒必须转 flex 盒内居中，
     仅居中盒子不算对齐）；
  4. **字号层**：同面板内全部可见文字逐元素核对字号——内容文字/各级标题/
     说明行 = 正文 13px，辅助 11px 仅限小附属（序号/键帽）；Blueprint 控件
     自带 14px 必覆盖；
  5. **覆盖层**：Blueprint 三覆盖一规避清单（§4.9 对齐细则）逐项核对；
  6. **标题层**：Dialog 标题已在 DialogHost 链登记；
  7. **默认值层**：用户点名默认的参数不持久化；
  8. **提示文本层（2026-11-11 增）**：逐输入框核对 placeholder 完整可读
     （无省略号截断）——短输入（数字/页码）走 120px 基线且提示 ≤6 字，
     长提示输入在 wide 行满宽；组合控件（输入+后缀）已 np-filext 打包。
  审查中发现规范未覆盖的偏差：先修复、再把结论补回本清单或对应条款。
- **结构三段**：① 待处理清单/预览区置顶（surface-2 凹陷列表，路径单行省略、
  悬停 title 全文；清单容器 `np-pdfmlist` 自带 `margin-bottom: --np-gutter`
  供给与参数区的区块间距——此前为 0，列表框直接贴住策略行，2026-11-10 用户
  反馈补）；② 参数区（np-bren-form 行）；③ **解释收尾 = `np-dialog-note`
  左竖线引用式（2026-11-11 用户定案「解释性文字要有单独样式，条理清晰」，
  三方案比选后定稿，取代裸 np-dialog-muted 收尾）**：左侧 2px
  `--np-accent-border` 竖线（与拖拽条细线同源）= 引用块隐喻，行结构——每条
  信息独立一行（`np-dialog-note-row`），输出预览独立成行且超长省略悬停全文
  （`np-dialog-note-path`）；11px muted 同 np-dialog-muted。表单**中途**的
  短说明/清单区表头（如「处理文件」标题、校验清单统计头）仍用 np-dialog-muted，
  不加竖线；④ Footer（主操作 accent + 取消）。数据经 DialogSpec 直传
  （entries），onDone 返回结构化结果（含 paths 顺序）。
- **列数（2026-11-11 审查按现状改写）**：参数网格按内容三选一——
  `np-bren-form.is-cols`（标签列 max-content + 控件列 1fr）为参数面板**默认**
  形态（导出清单/PDF 拆分/插入空白页/转图片/加密/修改时间/批量新建等）；
  `np-pdfmform.np-two-col`（1fr 1fr 字段对并排）用于短控件成对场景
  （图片水印/缩放/拼图）；`np-pdfmform`（字段整盒两列流式）用于清单类
  面板的少量参数行（Excel 合并/PDF 合并/通用合并/提取删页）。长控件/
  多选项行一律 `wide` 独占整行。
- **输入控件**：一律走全局统一基线（§4.8 承载 + 填充式 surface-2/聚焦 ring），
  组件内禁止再自定义输入底色/描边（尺寸类可覆写）。
- **选项控件**：≤5 项用 `Seg` 分段（T 由 props 自推；options 对象字面量把 T
  推宽时显式泛型收窄 `<Seg<"sheets" | "rows">`——TS 6 下泛型 JSX 合法且为
  类型收窄所必需，2026-11-11 审查以代码为准修正旧「JSX 不写泛型」口径）；
  回调参数显式标注类型；6 项以上用下拉 NpSelect（如插入空白页 12 模式）、
  网格选点（如位置九宫格 np-wm-grid）或连续 Slider（如透明度）。
  Seg 全部 chip **无描边**（2026-11-11 用户两次定案收敛：先去选中 accent
  描边、再去未选灰描边）——选中态 = **sel 淡染蓝底 + accent 文字加粗 +
  ✓ 前缀**，未选 = 无底色 muted 字；蓝/灰底 + pill 圆角即边界信号，不再
  用框线。配方单源 index.css `.np-seg` 段，新增变体只覆写尺寸、禁止复写
  选中态或加回边框。
- **默认值**：新增/快速添加一律带合理默认（如 着色规则 *.pdf + 红、合并输出
  合并文档.pdf、水印 黑体/14/黑/右上/透明度 9），减少空表单上手成本。
- **快速添加**：列表类参数支持输入文本回车即建（Enter 提交 + 默认值兜底），
  与「添加」按钮并存。
- **内联校验（2026-11-03 定案）**：主操作按钮 disabled + 表单下方红字
  （`np-dialog-error`，输入错误）/ 灰字（`np-dialog-muted`，待补指引），
  **不再**点开后弹 alert 补校验；错误文案与执行端（Rust）同口径。
- **参数行关联禁用（2026-11-03 定案；2026-11-11 审查补 is-off 整行降灰口径）**：
  某参数在当前模式下不被执行端读取时整行禁用，不显示"看似可调实则无效"
  的控件——Seg 行 = `Seg disabled` + 标签本即 muted（如 PNG8/无损优化目标
  下的质量档）；输入框行 = 控件 `disabled` + 整行降透明 0.45
  （`np-bren-field.is-off`，np-wm-form 行结构无 field 包裹、k 与 ctl 同名
  `.is-off` 分别降灰；FormRow `off` prop，如 PDF 拆分 每 N 页/书签层级、
  PDF 水印对角线下的字号/边距）。
- **说明收尾带输出预览（2026-11-03 定案；2026-11-11 载体升级 np-dialog-note）**：
  收尾段除旁写规则外附「输出预览：{路径}」（取清单首项所在目录；自动命名的
  以当前时刻示例），预览行独立成行（note-path 超长省略 + title 全文）；
  单文件功能（PDF 提取/删页）以文件行 + 页数回显替代待处理清单。
- **落地范围（2026-11-03）**：图片五件套 / Excel 合并 / 通用合并（图片转
  PDF、CSV、文本、zip 打包）/ PDF 提取页、删除页全部对齐三段式；此前仅有
  PDF 合并与加水印符合。待处理清单共享组件 = `components/FileQueue.tsx`
  （DragFileList + QueueSection，2026-11-03 自 ToolsDialogs 抽出）。
