# AGENTS.md · X-Dir 编码规范与组件标准

> 本文件是 AI 编码代理与人类贡献者的强制约定。需求源见 `REQUIREMENTS.md`；
> 两者冲突时以 REQUIREMENTS.md 的产品决策为准，以本文件的工程规范为准。
> 2026-10-10 起 UI 层统一基于 **Blueprint.js v6**（Apache-2.0），全部样式经 **np-\* 设计 token**。

## 1. 工具链强制

- 前端：`tsc --strict`（build 内置）、ESLint/Prettier（引入后补）、`npx vitest run` 必须全绿
- Rust：`cargo fmt`、`cargo clippy -- -D warnings`、`cargo test` 必须全绿
- 构建验证：`npm run build`（前端）+ `cargo check`（后端）零 error、零 warning

## 2. 性能三铁律（code review checklist，REQUIREMENTS.md §4.3）

- [ ] 文件列表只做虚拟滚动，DOM 只有可见行
- [ ] 图标/缓存有上限（LRU），只对可见窗格生效
- [ ] 前端 store 不囤整目录元数据；扫描/排序/过滤全部在 Rust 端分页下发
- 另加：布局树操作只允许写 `lib/layoutTree.ts` 纯函数并配单测

## 3. IPC 与类型

- IPC 类型唯一来源是 Rust 结构体；TS 侧手工镜像于 `src/lib/ipc.ts`（serde `rename_all = "camelCase"`），**禁止只改一端**
- 改命令签名必须同步：`src-tauri/src/commands/*` + `src/lib/ipc.ts` + 本文档无涉及

## 4. 组件标准规范（核心章节）

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

### 4.3 已采用清单（改 UI 先看这张表）

| 场景 | 组件 | 备注 |
|---|---|---|
| **弹层统一规范（2026-10-12）** | 面板一律 `--np-surface` 底 + `--np-shadow`；Dialog = `--np-radius-xl`、浮层（菜单/Popover/补全/右键菜单）= `--np-radius-lg` | Dialog 三段 header/body/footer 全透明（Blueprint 白头灰身默认已覆写），footer 用 `--np-hairline` 分隔；**新增浮层禁自带灰底**；输入框/内嵌列表用 `--np-surface-2` 作凹陷层级 |
| 对话框 | `Dialog` + `DialogBody`/`DialogFooter` | 编排层是 `useUi.openDialog()` promise API，**调用方不许直接碰 Dialog**；确认按钮 intent 统一二映射（2026-10-15 定案）：主操作 = primary（accent 实心）/ 危险 = danger（danger 实心），Blueprint 原生 warning 琥珀弃用——intent 按钮样式经 index.css 全局压回 token（圆角/底色/悬停 = fg 混色），新弹窗不许自带 intent 配色 |
| 右键菜单/下拉 | `Menu` + `MenuItem`/`MenuDivider`；右键定位层在 `components/ContextMenu.tsx` | 右键菜单数据流：`useUi.openMenu(items, x, y)` |
| 弹出层 | `PopoverNext`（placement="bottom-start/end"，`arrow={false}`） | 工具栏下拉、地址栏历史。**禁用经典 `Popover`**：其 react-popper 依赖在 React 19 下静默错位（Blueprint v6 官方警告）；面板外观经 index.css 的 `.bp6-popover` 覆盖与菜单统一为 surface 卡片 |
| 提示播报（2026-10-15 并入灵动岛，独立 Toast 窗口移除） | `useUi.toast(text, kind)` = `stores/island` 回执别名（error→fail 驻留 6s / 其余→ok 4s，同文本去重刷新驻留期） | 全部提示统一在顶栏灵动岛动态展示几秒后缩回；调用方 API 不变，新代码继续用 `useUi.getState().toast(text, kind)` |
| 按钮/输入 | `Button minimal size="small"`、`InputGroup size="small"` | 全局密度统一 small |
| 下拉选择 | `NpSelect`（`components/NpSelect.tsx`，PopoverNext + Menu） | 触发钮 np-select 填充式（`--np-ctl-h` 高、surface-2 底、开态 surface 底 + accent 描边、箭头旋转 180°）；弹层 = surface 卡片 Menu，选中项 Check 标记；**禁用 HTMLSelect**——原生下拉弹层系统级渲染无法样式化（2026-10-13 定案）；也禁用 Blueprint Select（内部经典 Popover，React 19 禁用） |
| 开关/选择 | `Switch`（v6 无 small，默认即紧凑）、`RadioGroup`、`ButtonGroup` | 开关与分段选择用 Blueprint 现成件，分段控件激活态 = accent 填充 |
| 进度（2026-10-15 并入灵动岛，原左下角 JobCenter 移除） | `components/JobList.tsx`（任务卡列表，经 `IslandPill` 锚定岛下方渲染）+ `stores/jobs.expanded`（pill 与面板共用开合） | 任务迷你态在 pill（迷你进度条 + 标签/计数/百分比，不确定态降透明示意），点击展开任务面板：逐条进度条 + 暂停/继续（仅 copy/move）+ 取消；完成/失败经灵动岛回执播报（toast 已路由为回执）；**默认引擎翻转（2026-10-15 定案）**：`nativeFileOps` 出厂默认改为 false——原生 IFileOperation 的进度/冲突交系统 UI 且快操作不弹进度窗，与灵动岛实时进度相悖；原生引擎改为可选开启（系统冲突框/Explorer 同款行为场景），已存档 true 的用户需在设置 → 文件操作手动切换；**僵尸条目修复（2026-10-15 定案）**：极快任务的 done 事件先于 register 到达时，register 落袋即除（任务已终态，补发成功回执），不再滞留列表 |
| 图标 | `AppIcon` / `ic()`（Lucide） | 见 4.5 |
| 搜索/补全输入 | `InputGroup`（np-search / np-addr）+ 自研 `np-sugg` 下拉（V2） | 文件系统建议来自 `suggest_paths` 命令；左侧自定义图标一律用 `leftElement`——**禁用 `leftIcon` 传 ReactNode**（v6 对元素图标走 cloneElement 返回裸 SVG，不包 `.bp6-icon`，绝对定位 CSS 失效会脱位到输入框外，2026-10-13 定案） |
| PDF 处理 | Rust `pdf` 模块（lopdf MIT）+ 右键"PDF 合并/拆分为单页/加水印/提取页/删除页/旋转/轻压缩"与"图片合并转 PDF" | 全部走任务引擎（JobCenter 进度/取消）；水印 = 文字经 ab_glyph（Apache-2.0，运行时读系统字体不打包）栅格化 → SMask 半透明 45° 叠加，旁写 *_水印.pdf 不覆盖原文件；拆分输出 <stem>_分页\ 子文件夹；合并按选中序、同名覆盖；**页级编辑（2026-10-14）**：页码范围表达式（`1-3,5,8-`，`parse_page_ranges` 纯函数 + cargo test）驱动提取/删除（均旁写新文件）、旋转（全部页相对 ±90/180/270，原地保存可逆向还原）、轻压缩（对象去重 + 对象流化，旁写 *_压缩.pdf）；图片转 PDF = PNG（png crate）/JPEG（jpeg-decoder MIT/Apache-2.0）解码为 RGB8 → FlateDecode Image XObject，每图一页；菜单条件纯函数 lib/pdfOps.ts 配单测 |
| 办公批处理（2026-10-14） | Rust `office` 模块 + `fs/textops.rs` + 批量重命名 `lib/batchRename.ts`（纯函数配单测）+ DialogHost「批量重命名」面板 | **Office/WPS 转 PDF** = PowerShell COM 派发（MS Office 优先、WPS ProgID 回退；转换引擎不打包——AGPL 系硬红线），旁写 <stem>.pdf，需已装 Office/WPS；**隐私属性清理** = zip 重打包抹 docProps（作者/公司/修订/时间等），旁写 *_清洁.ext，仅 OOXML 容器；**导出文本 TXT** 复用预览抽取管线；**编码转换**（utf8bom/utf8/gbk，encoding_rs）旁写 _<后缀>.ext；**CSV 合并**去重复表头、**文本合并**空行分隔，输出 UTF-8 BOM；**Excel 合并**（2026-10-17）= calamine 读（xlsx/xlsm/xls/xlsb/ods）→ rust_xlsxwriter 写 .xlsx（MIT，表格写出唯一宽松协议方案），两模式 np-seg：分表保留（目标表名清洗纯函数 sanitize/allocate_sheet_name：禁字符换 ·、31 字符截断、同名自动 (2)）/ 纵向拼接（重复表头自动去除，逐格保留数值类型，日期转字符串 to_ymd_hms_milli 免 chrono），核心 run_merge_core 配 cargo test，单表 1,048,576 行 + 500 万格护栏；**批量新建文件夹**（2026-10-17）= 名单/序号模板（{} 占位按止号位数补零）两输入模式，预演纯函数 lib/folderBatch.ts 配单测（非法名/名单内重名标红、与磁盘重名按 (2) 递增与 jobs::pick 同语义），执行 `create_dirs`（同步轻命令不入任务引擎，单次上限 500，Rust 端 available_name 兜底竞态）；**压缩为 zip**（文件平铺/文件夹含顶层递归）；**按规则归类** = 前端编排（扩展名/修改年月分组建子夹 + 既有 transfer 移动）；**批量重命名** = 查找替换+前后缀+序号（扩展名保护、目标重名/非法名检测），规则纯函数在 lib/batchRename.ts，对话框经 `useUi.openDialog({type:"batchRename"})`，执行走 applyRenames（逐条入撤销栈）；输出一律旁写不覆盖原文件 |
| 右键菜单（数据驱动，2026-10-13 重构） | `lib/menuCommands.ts`（内置功能注册表 + entryVisible 条件纯函数 + 默认布局构建器，配单测）+ `components/MenuEditor.tsx`（双栏编辑器）+ FileList `builtinMenuItem` 执行器 | 菜单布局 = settings.menuEntries（有序 MenuEntry：builtin/sep × area(启用时机三档：总是/选中时/未选中时，2026-10-14 定案与工具栏统一语义并以 np-seg 分段快选编辑——菜单语境 = 两处出现/仅选中右键/仅空白处右键，渲染仍按 supportsSel/supportsBlank 收窄，如「打开」选总是等效选中时) × cond(对象/数量/扩展名，类型不区分大小写)；条目行恒展示四个条件摘要 chip）；条件编辑器 = 锚定条目的 PopoverNext 浮层（不推移布局）+ 分段快选行（方案 A，np-seg：启用时机/对象类型/选中数量，自定义数量露出上下限下拉；文件类型为文本输入、仅对象类型=「仅文件」时可配置）+ condSentence 人话实时预览（menuCommands 纯函数配单测）；功能库**仅拖拽添加**（点击不入场，2026-10-14 定案）；55 个内置功能入功能库（含 PDF 七件套、办公批处理、图片处理五件套（2026-10-15），复制路径/名称、在终端打开、永久删除、添加到收藏夹、反向选择、切换隐藏文件、解压到此处/查找重复文件/空间分析/文件夹比较/清理空文件与空文件夹（2026-10-17）、「新建」子菜单（2026-10-15：文件夹/文本/Word/Excel/PowerPoint/Markdown，0 字节文件与资源管理器 NullFile 同轨）+ 批量新建文件夹（2026-10-17）+ Excel 合并（2026-10-17））；**基础固定功能（2026-10-15 定案）**：open/cut/copy/paste/rename/delete/properties 七项常驻菜单——不可移除/清空/被预设丢失（`ensureFixedEntries` 在加载/导入/预设应用/清空后归一化补齐），可拖动排序与改条件，编辑器行带「固定」chip；渲染端固定尾项「编辑菜单…」（specMenuItems 恒定追加 + 此电脑空白菜单），任何配置下直达编辑页，不属 menuEntries 存储；**同一内置功能全布局唯一**（id = `builtin:<key>`，编辑器按此去重）；「重置为默认方案」与「清空」驻「启用菜单」标题行右侧（2026-10-15 定案取代编辑器页脚横条）均经确认弹窗；多套预设已下线（2026-10-15 二次定案：MENU_PRESETS 移除，重置 = defaultMenuEntries + ensureFixedEntries 归一化）；编辑器支持拖拽排序/增删/条件自定义（参考 macOS Commander One）；旧档由 settings.load 迁移（defaultMenuEntries + 自定义条目剔除，2026-10-14 命令模板下线）；FileList 只按规范渲染，禁止再往 rowMenuItems 硬编码新菜单项——新功能 = 注册表加一行 + 执行器加一个 case |
| 全盘搜索面板 | **整页 `np-gsearchpage`**（2026-10-16 三次定案弃浮窗：`components/GlobalSearch.tsx` 导出 `GlobalSearchPage`，占满顶栏以下内容区替换侧栏+窗格区；App.tsx 按页条件挂载；**四次定案：边框语言与主界面窗格一致**——surface 卡 + 1px border + radius-pane，无额外内边距，结果/预览区弃 sunken 灰卡改平铺 surface + 发丝线分隔（预览 = border-left），切换主界面无差异感；**五次定案：单行紧凑控制条**——搜索框（定宽 300 + ? 帮助）并入过滤行行首，类型/范围/常用类型/结果过滤/预览/上限一行装完（窄窗 flex-wrap 兜底），头部行只留返回钮 + 标题 + 最近搜索 chips；头部行 = 返回钮 + 标题 + 搜索框（**定宽 480 不拉满**，五次定案改入过滤行）；Esc 关闭 = shortcuts `gsearch-page-close`，输入框内由页面 onKeyDown 直接关并 stopPropagation）+ TanStack Virtual 自绘行 | 唤起 = 顶栏按钮 / Ctrl+Shift+F；数据来自 `search_all` 命令（固定盘并行遍历 + 拼音首字母/全拼多音字匹配，Rust 端 `fs/search.rs`）；Ctrl+F 仍是窗格内递归搜索；结果行图标与文件列表同规则（真实图标开启时走 stores/icons 路径表/扩展名表 + 空位淡入，可见窗批量请求）。**查询语法对齐 Everything（2026-10-16，`fs/matcher.rs` 两引擎同语义 + cargo test）**：`ext:jpg;png` 扩展名（`;` 取 OR、前导点可省、`!` 可取反，纯扩展名查询也走索引通道）、`size:>100mb` 体积（`>` `>=` `<` `<=`/精确/`A..B`·`A-B` 区间，单位 b~tb）、`dm:today|yesterday|thisweek|lastweek|thismonth|lastmonth|thisyear|lastyear|last<N>days|2025[-MM[-DD]]` 修改时间（GetLocalTime 本地时区自然日对齐，支持比较前缀与 `A..B` 区间）、词前 `!` 排除（名称/路径/属性词通吃）、双引号短语 = 含空格字面子串；体积/时间词在索引通道排序后补元数据判定（取属性有护栏封顶）。**常用类型预设（2026-10-16）**：`GSEARCH_TYPE_PRESETS` + `composeTypeFilterQuery`（lib/searchStream.ts 配单测）前端组合 `ext:` 词随查询下发（不改 IPC，历史/高亮仍用原始输入）；**类型单一选择器（2026-10-16 六次定案，原 类型 seg + 常用类型 二合一去重，Everything Filters 菜单同款）**：NpSelect 一档装下 全部/文件/文件夹 + 常用类型预设（`TYPE_SEL_OPTIONS`；**七次定案拉平为单一清单**——预设均为文件故分组线移除，文件夹并入同列），files/dirs 直发 typeFilter、预设键组合 ext: 词；**磁盘范围选择移除（2026-10-16 七次定案）**：恒全库检索（roots 省略 = 服务端全部固定盘，scope 状态与 seg UI 删除）；控制条顺序 = 搜索框（360）→ 类型 → 结果过滤 → 上限 →（弹性）→ 预览开关驻右，搜索框加宽 300→360；**结果过滤框样式统一（2026-10-16）**：套统一填充式输入配方（surface-2 无描边、聚焦 surface + ring，同 np-gsearch-input/np-nav），宽 170。**列头点击排序 + 修改时间列（2026-10-16 二次定案）**：点名称/位置/大小/修改时间列头排序（同列再点反向，accent 箭头指示，类型列不可排），排序 NpSelect 移除；gsearch 列组增 mtime（`GS_COL_DEFAULTS` 五列、默认宽总和 667 ≤ 720 弹窗内容宽 670），**mtime 参与逐级隐藏**（面板 <`GS_MTIME_MIN`=660 隐藏——预览开启时面板 ~647 恰好让位，`gsMtimeVisible` 三方同源：visibleColWidths/表头/行），`gsearchColWidths` 增 mtime 键（sanitize 补默认）；**多选与批量（2026-10-16）**：行点击 = 单选/Ctrl 翻选/Shift 锚点范围，Shift+↑↓ 扩展，Ctrl+A（输入框空时）全选，Esc 先清多选再关页面；多选按路径存（排序/过滤下稳定），右键在选集内 = 批量菜单（复制完整路径 N 条 / 复制·移动到窗格 ▸（同 FileList 的 dfsPanes+transfer+setPaneTarget 记忆流）/ 删除到回收站（confirmDialog+deleteItems 任务引擎）），右键未选行先改单选；状态栏"已选 N 项"；**Ctrl+Enter** = 打开所在文件夹（Everything 同款）。**界面补全（2026-10-16 二次定案；三次定案随整页化修正）**：结果区高度 = 整页 flex 铺满顶栏以下（`--np-gsearch-h` 固定高度 token 随浮窗退役）；搜索框右端 ？按钮 = 查询语法速查弹层（np-gsearch-help）；名称/位置列悬停 tooltip；状态栏索引引擎改"全库 N 万条"（原"扫描 N 项"语义不符）；**四次定案补**：最近搜索 chips 从独立行收进头部右侧（出现/消失不推挤布局），过滤行/状态条改发丝线定高行（与窗格导航/状态条同语言）。**索引模式控制组移入（2026-10-16 定案，设置面板「全盘搜索」页原区块移除、留指引文案）**：`components/IndexMode.tsx`（`useIndexStatus` 2s 轮询 + `IndexModeBar`）驻状态条左端 = [dot+标签 chip] + [Switch 常驻开关（UAC 流程 + 失败回滚 toast），开关必须直接可见（2026-10-16 二次定案：首版藏于弹层被用户打回）]；**建索引进度可视（2026-10-16 三次定案）**：阶段归约纯函数 `lib/indexPhase.ts`（`analyzeIndexPhase` 配单测）把轮询回执归约为 off/starting/building/ready/error/down 六阶段——Rust `index_status` 增 `configured`（daemon.json 启用卷清单，建索引期间 volumes 尚无该卷条目，据此判"初建中"）；开关打开即自动弹进度浮层（逐卷 转圈=初建中/Check=就绪+条目数/X=错误原因），chip 标签与 dot 随阶段切换（启动中…/建索引中=accent 脉冲/索引模式/索引错误/守护离线=danger），启动宽限 15s（`INDEX_START_GRACE_MS`，超时回落离线），全部就绪/出错经灵动岛回执播报一次（`readySummary`/`errorSummary` 纯函数）；**USN 日志重置自愈（2026-10-16）**：守护 `read_usn` 对日志重置族错误码（未激活 1179 / 删除中 1178 / 日志项已被删除 1181 / 功能不支持 1）一律返回 `JOURNAL_RESET` → `run_volume` 全量重建并继续，不再终止卷线程；Win32 错误码改用 Foundation 权威常量（本地手抄曾有 1172 错值——实为 ERROR_NO_TRACKING_SERVICE，正确未激活码 1179，改常量引用防再漂移），失败弹层附处置指引；**索引查询性能（2026-10-16 定案；真实 458 万条目实测：中文子串全量查询 3182ms → 284ms，拼音首字母/全拼词走快通道毫秒级）**：拼音通道三层加速——① 每条目 `py_mask`（`pinyin_letter_mask` 建库期预生成）做 DP 必要条件预筛（查询掩码 ⊆ 条目掩码才进 DP）；② **首字母通道改用建库期预生成首字母串**（init arena，`pinyin_initials` 同语义），查询 = u8 contains 精确判定，免解码免 DP；③ 全拼通道配零分配位图 DP（`pinyin_contains_chars` ≤63 字节走位图快版，>63 回落 Vec 版，差分测试锁语义一致）+ 读音预编译表（`PinyinTables`：CJK 直接寻址 + 去声调读音平铺，查询路径零二分零分配）；合成基准（60 万条目，`bench_synthetic_pinyin_scan` #[ignore] 可复测）：首字母词 2.6ms / 全拼词 10.5ms / 字母集命中最坏词 100ms；真实基准（`bench_real_index_query` #[ignore]）：mmap 打开 0.1ms + 扫描与路径重建 257ms（内存带宽主导的单次线性扫描）+ 排序补元数据 27ms；**首字母多音字语义收窄（2026-10-16）**：两引擎首字母通道统一为第一读音（"cq" 不再命中"重庆"，全拼 "chongqing"/"zhongqing" 不受影响），与 type-ahead 同语义；索引格式 **FORMAT_VERSION=3**（EntryRec 增 py_mask/init 段 + header 增 initials_len），旧 .idx 自动判废触发守护重建；**整页互斥与顶栏联动（2026-10-16 四次定案）**：`openGlobalSearch`/`openMenuPage` 互斥（打开其一即关另一页，ui.ts 保证），ui.exitPages() 供顶栏主界面类按钮（导航树/浏览记录/收藏夹/设置/布局预设）先回主界面再执行动作；顶栏两页按钮带 active 态且再点即关（toggle）；**Ctrl+Shift+F 在定制页内 = 切换到全盘搜索页**（分支移到模态守卫之前）；**两整页头部排布一致**：返回钮 + 标题紧随其左（np-menupage-title 去 600/右距），头部行同高 nav-h、底部 hairline；**返回钮加大**（30px 高、14px 横距，两页共用 np-menupage-back）；**拼音命中汉字高亮（2026-10-16）**：`highlightParts` 增可选 `py` 参（`FileEntry.py` = Rust `pinyin_initials` 产物）——子串未命中的词在 py 串上找位置，经 `pinyinHighlightRange`（码位区间→名称字符区间，对齐规则同 Rust 构建侧，配单测）映射回汉字区间标记，与 Rust 首字母通道同语义（py 命中即安全高亮）；全拼通道暂不标记（前端无读音表）；**防抖自适应（2026-10-16）**：索引就绪（开关开 + 守护存活）120ms，否则 300ms；仅类型预设无输入词也允许搜索（空输入选"文档" = 列出全部文档）；输入框占位回显语法。**结果二次过滤（2026-10-15）**：过滤行右端 np-gsearch-rowfilter 定宽输入框，纯客户端按名称/拼音首字母子串收窄已加载结果（不重新搜索），状态条回显"过滤后 N/M"，越界选中自动钳制末项。**内嵌预览右栏（2026-10-13 定案）**：渲染核心 = `preview/PreviewBody.tsx`（与 QuickPreview 大浮层共用，容器无关）；交互 = 单击选中后预览、双击/Enter 打开，悬浮不高亮选中；列宽/面板宽拖拽寄存 settings（`gsearchColWidths` / `gsearchPreviewWidth`），开关寄存 `gsearchPreview`；**列宽 Explorer 口径（2026-10-15；2026-10-16 整页化沿用）**：与窗格列表同款——`detailsContentWidth`（ColGroup `"gsearch"`：名称/位置/大小/类型恒显 + mtime ≥660）撑内容层/表头 min-width，放不下即 `.np-gsearch-list` 横滚（np-scroll-x）+ `.np-head-clip` 裁剪 + onScroll transform 同步平移（页面宽随窗口，阈值语义不变） |
| 效率增强包（2026-10-15） | 目标窗格传输（`stores/layout.paneTargets` 会话记忆 + ListHandlers `onTransferToPane`，Ctrl+Shift+C/X 与右键"复制/移动到窗格 ▸"同走 operations.transfer，点选子菜单即记忆目标）· 视图内过滤（Rust `list_dir` 增 `nameFilter` 参数：名称/拼音首字母子串、多词 AND，`fs/sort.rs::name_filter_terms` 配 cargo test；前端 `panes.filter` + Pane 过滤条 np-filterbar，200ms 防抖提交；导航进新目录即还原、后退/前进保留、此电脑页不响应）· 选择记忆（`panes.selMemory` 按路径快照选中集+锚点，单标签上限 50 目录，settings.rememberSelection 开关默认开，显式清空后离开 = 记忆清除）· 文件夹预览卡（`preview/FolderPreview`：直接子项数 = list_dir total 快照直取，递归体积 = dirSizes best-effort 异步补齐；PreviewBody 按 `entry.isDir` 路由，QuickPreview Enter 对文件夹 = 活动窗格导航进入）· type-ahead 回显 pill（`useUi.typeAhead` 由 lib/keyboard 维护，np-typeahead 仅活动窗格渲染，任何 Esc 路径顺带清空）· 重做（lib/undo `redoStack`：rename/newfolder 完成即压回撤销栈，trash/move 由任务 onDone 门控；keyboard Ctrl+Z 分支加 `!shift` 守卫，Ctrl+Y / Ctrl+Shift+Z 走 redo）· 地址栏面包屑（np-addrwrap + np-addr-crumbs 非聚焦覆盖层，`:focus-within` 隐藏，超 5 段中段省略）· 标签右键菜单（layout.duplicateTab/closeOtherTabs/closeTabsRight）· 中键新标签（列表行/导航树 button===1 preventDefault 拦自动滚动）· 新标签继承当前路径（`layout.newTab` 缺省取活动标签路径）· 鼠标 X1/X2 历史导航（`lib/mouseNav.ts`，App 装卸，WebView2 先行吞键则无操作） | 快捷键全部入 lib/shortcuts.ts 清单并与 keyboard.test 双向对齐；新增 np-* 类（np-filterbar/np-typeahead/np-crumb 系）均已在 index.css 定义（cssClasses 审计通过）；list_dir 签名变更已双端同步（src-tauri/src/commands/files.rs + src/lib/ipc.ts） |
| 真实图标 | `<img className="np-realicon">` / `np-icon-slot`（V2） | 数据来自 `get_file_icons`（PNG data URL），尺寸走 `--np-realicon`（2026-10-15 提至 18px：真实图标源为 32px 系统大图标，放大不糊；文件行 Lucide 兜底经 `.np-row > svg.lucide` 对齐同尺寸）；"此电脑"页盘符同走真实图标（盘符根 Rust 端专属提取）；导航树"此电脑"根节点固定 Lucide `Computer` 图标（伪路径 `::{ThisPC}` 无真实图标可取，2026-10-12 定案） |
| 暂存区（2026-10-17） | Sidebar 下半 `.np-shelf`（`data-shelf` 投放区，与布局方案列表各占边栏一半）+ `settings.staging`（`lib/shelf.ts` 纯函数：路径大小写不敏感去重、上限 200 整条忽略、无扩展名≈文件夹的展示类型启发，配 vitest）+ 菜单功能 `shelfAdd`「添加到暂存区」（标记与系统组，非固定项不入默认菜单） | 拖入 = `oleDispatch.handleDrop` 前置分流：命中 `[data-shelf]` 即入库返回，不进窗格传输（Explorer 拖入同管线）；OLE 悬停高亮 = 组件订阅 `useDnd` 坐标与自身矩形判定（`.np-shelf.on` 淡染 + 虚线框）；拖出 = 行 mousedown 位移 ≥5px 触发 `api.startDrag`（同文件行管线），落窗格即移动，返回 effect ≠ "none" 即移出暂存；**`start_drag` Rust 端新增 `"drop"` 返回值**——WebView2 网页落点不回写 effect 标志（实测 effect=NONE 但 hr=DRAGDROP_S_DROP），据 hr 区分「已放置/取消」，FileList 行拖拽的 bumpRefresh 同步受益 |
| 定制（2026-10-15 定名，原「自定义」/创意工坊/右键菜单独立页） | `components/MenuEditorPage.tsx`（整页壳层 `np-menupage`，useUi.menuPage 驱动，顶栏魔棒钮（WandSparkles）开、Esc 返回——输入框内先失焦，`lib/shortcuts.ts` menu-page-close）+ `components/MenuEditor.tsx`（上双栏 = 启用菜单 / 功能库，下横条 = 窗格工具栏编辑区，两投放区共享功能库） | 占满顶栏以下区域替换侧栏+窗格区；内容 = MenuEditor（右键菜单 + 窗格工具栏）；**面板高度以顶栏下方实际空间为准**（min-height: 0 钳制 flex 最小尺寸，页面本体不滚动，功能库/启用菜单超出在各自列表内部滚动）；**窗格工具栏横排条带置于两栏上方（2026-10-14 定案）**模拟窗格实际导航栏 np-nav 的样子（图标+标题文本按钮 + 地址框占位同排，左缘竖线 = 插入指示，恒定高度不随双栏挤压），点击条目（或菜单行尾箭头）弹出条件编辑浮层（PopoverNext 锚定条目、不推移布局，2026-10-14 定案取代内联折叠展开）；**命令模板已下线（2026-10-14 定案）**——功能库只含内置功能与分割线，旧档 custom 条目由 `stripCustomEntries` 加载时剔除，模板数据（settings.customCommands）留档不再渲染；**功能库分组重整（2026-10-15 定案）**——「窗格」拆为窗格协作（两面共享的互传）/ 窗格工具（仅工具栏），「新建与视图」拆为新建与选择 / 视图，组序按使用频率与逻辑流（注册表顺序 = 展示顺序、同组连续，`fnGroups()` + vitest 固定断言），功能库搜索框走统一填充式输入规范（`Search` leftElement + surface-2 常态带 hairline 内描边、聚焦 surface + `--np-ring`，同 np-nav / np-gsearch-input 配方）；**功能库 A+B 改版（2026-10-15 定案）**——库主体 = 左分组目录（`.np-menued-rail`，点击平滑跳转 + `spyGroup` scrollspy 纯函数配单测，跳转动画期间挂起 spy，激活 = accent 填充 + 计数徽标）+ 右胶囊墙（`.np-menued-wall` 内容恒全量、跳转只移动视口不裁剪；条目 pill 化 `--np-ctl-h` 高，启用面 = 图标徽章 `np-menued-mark`（accent 淡染底 + Menu/PanelTop 语义图标，2026-10-15 二次定案取代圆点），分割线常驻「布局」簇）；功能库标题行单行收纳 = 标题 + 计数徽标 + 定宽 160px 搜索框 + 「只展示未启用的功能」开关 + 图例（2026-10-15 二次定案：原库底过滤条上移，`flex-wrap` 兜底窄窗）；编辑器页脚横条已移除（清空/重置为默认方案入「启用菜单」标题行、重置为默认方案在工具栏区标题行——动作归属各自卡片）；**三行头统一（2026-10-15 定案，二次修订取消加粗）**：窗格工具栏/启用菜单/功能库三行标题 13px 正文色、不加粗（`.np-menued-title` 移出辅助小字基方，簇名/浮层标题同步去 600）、行高恒 `--np-ctl-h` 对齐，行内按钮/开关/搜索框字号统一正文档；scrollspy 阈值/跳转锁时长在 DENSITY（`libSpyThreshold`/`libJumpLockMs`） |
| 窗格工具栏（2026-10-15 定案，与右键菜单共享功能库） | `BUILTIN_FNS` 统一注册表（2026-10-14 定案：**全部内置功能均可入工具栏**，无能力位——窗格工具 up/view/addr/search/splitH/splitV/swap 仅工具栏、其余功能菜单+工具栏两面共享）+ `settings.toolbarEntries`（有序 MenuEntry，load 迁移旧 paneTools + `ensureToolbarAddr` 归一化）+ Pane 目录驱动渲染（原生键直执行；菜单功能经 listRegistry 的 `builtinMenuItem` 执行器按当前窗格选中项解析，带子菜单的功能用弹出菜单/二级菜单承载）+ MenuEditor 两栏上方「窗格工具栏」横排条带区（模拟窗格导航栏） | 工具栏默认布局 = 定稿 10 键（2026-10-15 二次定案：上一级/新建文件夹/刷新/地址框/复制路径/添加到收藏夹/搜索当前文件夹/在终端打开/横向分裂/纵向分裂，视图类型与交换窗格不入默认）；条目默认作用域（`builtinToolbarEntry`）：文件夹作用域键 = 「当前文件夹」恒可用（含不在默认表的 view/swap，与默认表解耦），其余功能 = 「依赖选中项」+ 注册表默认条件；**条件判定 = 当前窗格选中项完整判定**（对象/数量/扩展名，`entryVisible`，未满足置灰 `.np-tool-off`；窗格工具与「当前文件夹」作用域恒可用）；编辑条带 = 图标+标题文本按钮 + 地址框占位同排（同 np-nav 观感，tooltip 带条件回显），点击条目弹出条件编辑浮层、拖入启用/排序（左缘竖线 = 插入指示）、拖出卡片移除；**投放区 = 整张工具栏卡**（`data-toolbar-zone` 挂卡片而非条带，与左栏 `data-menued-left` 同理），分割线拖入卡片红染弹回；**地址框 = 固定条目**（`builtin:addr`，不可移除/清空、可排序，真实地址栏由它驱动，`ensureToolbarAddr` 保证常驻第 4 位）；功能库展示与过滤见「定制」行（A+B 改版：胶囊墙 + 圆点启用标记 + 标题行开关）；收纳档 TOOL_TIER（未分档键默认 only-wide 收纳进「更多」），「更多」菜单随配置联动；**重置为默认方案（2026-10-15 二次定案）**：多套预设（TOOLBAR_PRESETS/MENU_PRESETS）下线，工具栏区标题行单按钮确认后重置为 `defaultToolbarEntries()`（应用后 `ensureToolbarAddr` 兜底） |
| 设置面板 | **Dialog 浮窗**（`np-settingsdlg`，2026-10-14 回归浮窗样式）+ `components/SettingsPanel.tsx`（左分类导航 + 内容页） | 七类 tab：外观/浏览/文件操作/全盘搜索/着色规则/快捷键/配置（状态在 useUi.settingsTab，设置钮开「外观」页，开合与直达分类经同一状态驱动 Dialog isOpen）；行 = 标题+说明 ▸ 控件（`.np-set-row`）；分段选择走通用 `np-seg`（激活态 accent 填充，全窗格复用）；规则编辑区 = surface-2 凹陷面板；快捷键页数据源 = `lib/shortcuts.ts`（键位 pill `.np-kbd`）；配置导出/导入走 plugin-dialog 原生保存框；主题切换带圆形扩散特效（2026-10-15 定案）：View Transitions 从触发点 clip-path 圆形揭示新主题（`setThemeWithFx`，stores/settings），CSS 关默认交叉淡化，减少动效偏好/不支持时直切；**索引模式开关已移出（2026-10-16 定案）**：「全盘搜索」页仅剩预览面板开关 + 指引文案，索引模式管理入全盘搜索面板状态条（见「全盘搜索面板」行） |
| 顶栏灵动岛（2026-10-15） | `lib/island.ts`（通道仲裁纯函数 `resolveIsland`/`summarizeJobs` 配单测，空闲态 = 路径（无轮播））+ `stores/island.ts`（回执栈/活动时间戳/搜索进度）+ `components/IslandPill.tsx`（顶栏中央渲染，TitleBar 挂载） | 默认回落 = 活动窗格路径 pill（静态态 `pointer-events:none` 透传拖拽区，有选中带「已选 N 项」后缀）；通道优先级（高→低）：任务（迷你进度条 + 百分比/计数/排队/暂停，点击展开锚定岛下的任务面板 JobList——开合在 stores/jobs.expanded）> 交换窗格模式（点击取消）> 全盘搜索进行中（命中数实时，`GlobalSearch` loading/stream 上报）> 事件回执（任务完成/失败/取消、工作区恢复、**全部 useUi.toast 提示已路由至此（2026-10-15 二次定案，独立 Toast 窗口移除）**、同文本去重、驻留 `DENSITY.islandReceiptMs`，点击消去）> 剪贴板持有（纯指示不响应点击，2026-10-15 二次定案：粘贴仍走 Ctrl+V/右键菜单；静态态透传拖拽区）> 路径；空闲态不做轮播（2026-10-15 二次定案：路径即"我在哪"，空闲不制造动态）；回执驻留 `DENSITY.islandReceiptMs`，1s 心跳驱动过期 |
| 工具箱（2026-10-14） | Rust `fs/archive.rs`（zip 逐条目 + sevenz-rust 整包，防 zip-slip）+ `fs/analyze.rs`（SHA-256 重复指纹/目录体积/双文件夹比较）+ `commands/archive_cmds.rs`/`analyze_cmds.rs`（async + spawn_blocking，不占主线程）+ `components/AnalyzeDialogs.tsx` | **解压到此处** = 每包解到 `<目标>/<包名>/` 子目录（重名自动 (2)，走任务引擎）；**查找重复文件** = 同体积粗分 → SHA-256 指纹成组，默认勾选每组副本、删除走回收站；**清理空文件/空文件夹**（2026-10-17）= `scan_empty` 递归扫描（0 字节文件 + 字面空目录——只含空子目录的父目录不算，防误删），两组默认全选勾删走回收站、上限 MAX_FILES 护栏；**空间分析** = 直接子项体积条（TreeSize 式），点文件夹钻取；**文件夹比较** = 相对路径对齐三段差异（A 独有/B 独有/内容不同，体积+mtime 判据），勾选后按方向复制同步（走 transfer 冲突流程）；上限护栏（MAX_FILES/MAX_HASH/MAX_GROUPS）防病态目录 |
| 图片处理（2026-10-15） | Rust `img/mod.rs`（image MIT/Apache-2.0 底座 + oxipng MIT 无损优化 + color_quant MIT/Apache-2.0 PNG8 量化——**GPL 系 libimagequant 硬红线不采用**；kamadak-exif MIT/Apache-2.0 EXIF 方向烘焙；文字水印复用 `pdf/stamp.rs` ab_glyph 光栅化）+ `commands/img_cmds.rs`（任务引擎串行槽，进度/取消/灵动岛回执）+ `components/ImgDialogs.tsx` 五对话框（np-seg 分段 + NpSelect，表单行复用 np-bren-* 基类）+ `lib/imgOps.ts`（IMG_EXTS/拼图输出名纯函数配单测）+ 功能库「图片处理」组五条目 | **压缩** = Auto（JPEG→JPEG@质量、PNG→PNG8、其余→JPEG）/ JPEG / PNG8 / 无损优化，旁写 *_压缩.*；**水印** = 文字/贴图 × 平铺45°/右下角标 × 三档不透明度与大小（尺寸 = 短边/scaleDiv），输出保持原格式旁写 *_水印.*；**格式转换** = PNG/JPEG/BMP/TIFF/ICO(≤256px)/WebP无损，EXIF 方向可烘焙（默认开，顺带抹除位置元数据），旁写 *_转换.*；**尺寸调整** = 百分比(1–800)/指定宽/指定高(≤20000px)，宽高比恒定，Lanczos3/Triangle 两档 + 仅缩小开关，旁写 *_缩放.*；**宫格拼图** = 4–36 张 → 列数2–4×格子512–1024×间距0–16 网格画布，裁切填满/完整留白，白/黑/透明底（透明强制 PNG），输出 `拼图_yyyymmdd_hhmmss.png` 重名自动 (2)；全部功能旁写不覆盖原文件、批处理上限 200 张（拼图 36）

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

## 5. 目录约定

见 REQUIREMENTS.md §6.2。补充：

- `src/index.css` = token + 全局/组件样式（唯一样式文件）
- `src/lib/tokens.ts` = JS 侧密度常量（与 CSS token 同步）
- `src/lib/fileIcons.ts` = 图标/类型映射
- `src/lib/shortcuts.ts` = 快捷键清单单一来源（设置「快捷键」页渲染；与 `lib/__tests__/keyboard.test.ts` 双向对齐：清单漏测或孤儿覆盖均判失败；新增快捷键 = 先改清单再实现）
- `design/preview.html` = 独立静态 UI 预览（不参与构建）
- `tools/gen-file-icon-preview.mjs` = 从 `lib/fileIcons.ts` 生成 `design/file-icons-preview.html` 全量图标预览（node 直跑，typescript API 剥类型 + react-dom/server 渲染）

## 6. 测试要求

- 布局树操作（`lib/layoutTree.ts`）改动必须带 vitest 用例
- 全局快捷键（`lib/keyboard.ts`）新增/改动必须同步 `lib/shortcuts.ts` 清单，且 `keyboard.test.ts` 的覆盖对齐用例保持全绿
- Rust `fs`/`jobs` 纯逻辑（排序/路径/冲突/分页）必须带 cargo test
- 图标映射（`lib/fileIcons.ts`）扩展时补映射断言
- 路径纯函数（`lib/path.ts`）行为由 `path.test.ts` 锁定（盘符根/保留名/非法字符等边角），改行为先改用例
- 三条规范审计测试（2026-10-15 体检引入，新代码违反即 CI 失败）：
  `iconRule.test.ts` = lucide 图标只许经 `AppIcon`/`ic()` 渲染（除 AppIcon.tsx 本体）；
  `apiBinding.test.ts` = `lib/ipc.ts` 的 api 方法必须有 UI 调用点（防死绑定滞留）；
  `cssClasses.test.ts` = TSX 引用的 `np-*` 类必须在 index.css 有定义或入白名单（白名单仅收 JS 查询钩子/语义标记类，新成员必须注释理由）


## 7. 提交规范

- Conventional Commits：`feat: / fix: / refactor: / docs: / test: / chore:`
- 涉及 UI 的提交必须说明是否新增 token、是否新增依赖

## 8. 开源合规

- **本项目将开源（2026-10-13 定案；开源许可证选型待定，定案后同步 LICENSE/README 与本条）**：
  一切依赖与资产按"将随本项目一并再分发"口径评估——
  **AGPL 系依赖是硬红线**（传染整个作品 + 网络条款要求向使用者提供源码，如 MuPDF、
  Ghostscript），任何引入建议直接打回；宽松协议白名单见下条
- 依赖只允许宽松协议（MIT/Apache-2.0/BSD/0BSD）；引入任何 GPL 系依赖需在 REQUIREMENTS.md 层面重新决策
- 发布前生成 `THIRD-PARTY-NOTICES.txt`（cargo-about / license-checker），当前已知：Tauri MIT-Apache、React/MIT、Blueprint Apache-2.0、TanStack MIT、react-resizable-panels MIT、png/MIT（V2 图标 PNG 编码）、notify/MIT、trash/(MIT OR Apache-2.0)、pinyin/MIT、lopdf/MIT（PDF 合并/拆分/水印/页级编辑）、flate2/(MIT OR Apache-2.0)（流压缩）、ab_glyph/Apache-2.0（水印文字光栅化，运行时读系统字体不打包）、jpeg-decoder/(MIT OR Apache-2.0)（图片合并转 PDF 的 JPEG 解码）、zip/MIT（OOXML 隐私清理重打包 + 压缩为 zip）、quick-xml/MIT/Apache-2.0（OOXML/ODF 抽取）、calamine/MIT（xlsx/xls 预览读取 + Excel 合并读取）、rust_xlsxwriter/MIT（Excel 合并写出，唯一宽松协议的 xlsx 写库）、encoding_rs/(MIT OR Apache-2.0)（编码探测/转换）、tiff/MIT-Apache（预览）、sevenz-rust/Apache-2.0（7z 清单）、image/(MIT OR Apache-2.0)（图片批处理解码/编码/缩放/合成）、oxipng/MIT（PNG 无损优化）、color_quant/(MIT OR Apache-2.0)（PNG8 调色板量化）、kamadak-exif/(MIT OR Apache-2.0)（EXIF 方向读取）（全盘搜索拼音首字母匹配）、memmap2/MIT（全盘索引 mmap 只读查询）、sha2/(MIT OR Apache-2.0)（重复文件查找内容指纹）、tauri-plugin-dialog/Apache-2.0（配置导出/导入与清单导出的原生保存对话框）、webview2-com/(MIT OR Apache-2.0)（关闭 WebView2 浏览器加速键 F5/Ctrl+R/Ctrl+F/Ctrl+P，快捷键由前端 lib/keyboard.ts 全权路由）
- 配置集中化（2026-10-12）：用户偏好统一存 settings.json（含侧边栏/列宽/导航树等 UI 偏好，原 localStorage 已迁移）；工作区=workspaces/*.json；导出=设置 → "配置"区（`export_config` 打包两者为单 JSON，version 字段供导入对齐）；导入（2026-10-14）= `import_config` 校验 app/version 后整体覆盖 settings.json 与 workspaces/*.json（前端热重载设置 + 事件刷新方案列表）。UI 偏好禁止再直写 localStorage
