# 功能定案清单（AGENTS.md 详版拆分）

> 本文档是 AGENTS.md 的功能定案详版，规则效力等同主文档。
> 改造既有功能、新增功能或动后端命令前，先查对应功能域小节：**组件与模块** → 定案要点。
> 新增功能后必须回写对应小节（格式：**组件与模块** 一行 + 定案要点若干条）；跨域批量改造记录在 §13。

## 1. 基础组件定案

### 1.1 弹层与面板

**组件与模块**：`Dialog` / `PopoverNext` / `Menu`；圆角 token `--np-radius-pane` / `--np-radius-lg`。

- 面板一律 `--np-surface` 底 + `--np-shadow`；Dialog 与卡片/窗格/浮层面板统一 `--np-radius-pane`（设置可调，`--np-radius-xl` 已退役）；瞬态浮层（菜单/Popover/补全/右键菜单）用 `--np-radius-lg`。
- Dialog 三段 header/body/footer 全透明（Blueprint 白头灰身默认已覆写），footer 用 `--np-hairline` 分隔；**新增浮层禁自带灰底**。
- 输入框/内嵌列表用 `--np-surface-2` 作凹陷层级。

### 1.2 对话框

**组件与模块**：`Dialog` + `DialogBody`/`DialogFooter`；编排层 `useUi.openDialog()` promise API。

- 调用方不许直接碰 Dialog；新对话框类型必须登记进 DialogHost 的标题映射链（ui-standards §4.7）。
- 确认按钮 intent 二映射：主操作 = primary（accent 实心）/ 危险 = danger（danger 实心），Blueprint 原生 warning 琥珀弃用；intent 按钮样式经 index.css 全局压回 token（圆角/底色/悬停 = fg 混色），新弹窗不许自带 intent 配色。

### 1.3 菜单与弹出层

**组件与模块**：`Menu` + `MenuItem`/`MenuDivider`；右键定位层 `components/ContextMenu.tsx`。

- 右键菜单数据流：`useUi.openMenu(items, x, y)`。
- 弹出层统一 `PopoverNext`（`placement="bottom-start/end"`，`arrow={false}`），用于工具栏下拉、地址栏历史；**禁用经典 `Popover`**——其 react-popper 依赖在 React 19 下静默错位（Blueprint v6 官方警告）；面板外观经 index.css `.bp6-popover` 覆盖，与菜单统一为 surface 卡片。

### 1.4 提示播报与任务进度（灵动岛）

**组件与模块**：`useUi.toast(text, kind)` = `stores/island` 回执别名；任务面板 `components/JobList.tsx`（经 `IslandPill` 锚定岛下渲染）+ `stores/jobs.expanded`。

- 全部提示统一顶栏灵动岛回执播报（error→fail 驻留 6s / 其余→ok 4s，同文本去重刷新驻留期；独立 Toast 窗口已移除）；调用方 API 不变：`useUi.getState().toast(text, kind)`。
- **回执展笺（2026-11-17 方案 A 定案，design/toast-proposal-a-island.html 用户挑选）**：超长回执（`shouldExpandReceipt`：文本 > `ISLAND_SHEET_MIN`=40 字符，≈岛胶囊单行容量）悬停岛胶囊向下展开全文展笺——锚定岛下方（与任务面板同锚点语义），全文换行 + 复制详情 + 固定/取消固定 + 回执自带动作钮 + 关闭。机制：岛胶囊显式视口钳制 `max-width: min(46vw, 540px)`（旧 `max-width:100%` 在顶栏 flex 链失效，长回执挤穿工具栏盖住搜索/缩放/刷新——本次事故根因）+ `.np-tb-fill` 补 `min-width:0`；心跳 `prune(now, holdId)` 对悬停中的回执**续期**（移开恢复倒计时）；`pinReceipt` 固定回执 `pinned:true` 不自动过期（`resolveIsland` 对 pinned 免过期判定），仅手动消去；阈值内短回执行为与旧版完全一致（无展笺无箭头）。展笺期 tooltip 关闭（data-tip 置空防双层）。测试：island.test.ts 展笺阈值/pinned 仲裁/prune hold 续期三组。
- 任务迷你态在 pill（迷你进度条 + 标签/计数/百分比，不确定态降透明示意），点击展开任务面板：逐条进度条 + 暂停/继续（仅 copy/move）+ 取消；完成/失败经灵动岛回执（原左下角 JobCenter 已移除）。
- **原生文件操作引擎 `nativeFileOps` 出厂默认 false**：原生 IFileOperation 的进度/冲突交系统 UI，与灵动岛实时进度相悖；改为可选开启（需系统冲突框场景），已存档 true 的用户在设置 → 文件操作手动切换。
- **僵尸条目防护**：极快任务的 done 事件先于 register 到达时，register 落袋即除（任务已终态，补发成功回执），不再滞留列表。

### 1.5 按钮与输入

**组件与模块**：`Button minimal size="small"`、`InputGroup size="small"`。

- 全局密度统一 small；图标规格与颜色档见 ui-standards §4.5。

### 1.6 下拉选择 NpSelect

**组件与模块**：`components/NpSelect.tsx`（PopoverNext + Menu 自研）。

- 触发钮 np-select 填充式（`--np-ctl-h` 高、surface-2 底、开态 surface 底 + accent 描边、箭头旋转 180°）；弹层 = surface 卡片 Menu，选中项 Check 标记。
- **禁用 HTMLSelect**——原生下拉弹层系统级渲染无法样式化；**禁用 Blueprint Select**——内部经典 Popover（React 19 禁用，见 1.3）。

### 1.7 开关与分段选择

**组件与模块**：`Switch`（v6 无 small，默认即紧凑）、`RadioGroup`、`ButtonGroup`、自研 `np-seg`。

- 分段选择 = np-seg 勾选 chip：配方单源 index.css `.np-seg` 段——选中态 = sel 淡染蓝底 + accent 文字加粗、**无描边**（✓ 前缀 2026-11-23 用户定案退役——「有蓝色选中样式已经比较明显了」；终态口径见 ui-standards §4.9），未选 = 无底色 muted 字；新增变体只覆写尺寸、禁止复写选中态或加回边框。

### 1.8 图标

**组件与模块**：`AppIcon` / `ic()`（Lucide）。

- 唯一图标来源与四档尺寸规范见 ui-standards §4.5；文件类型映射见 `lib/fileIcons.ts`（2.1）。

### 1.9 搜索/补全输入

**组件与模块**：`InputGroup`（np-search / np-addr）+ 自研 `np-sugg` 下拉。

- 文件系统建议来自 `suggest_paths` 命令。
- 左侧自定义图标一律 `leftElement`——**禁用 `leftIcon` 传 ReactNode**（v6 对元素图标走 cloneElement 返回裸 SVG，不包 `.bp6-icon`，绝对定位 CSS 失效会脱位到输入框外）。

## 2. 文件列表与浏览

### 2.1 真实图标

**组件与模块**：`<img className="np-realicon">` / `np-icon-slot`；数据来自 `get_file_icons`（PNG data URL）。

- 尺寸走 `--np-realicon: 18px`（真实图标源为 32px 系统大图标，放大不糊）；文件行 Lucide 兜底经 CSS 对齐同尺寸；"此电脑"页盘符同走真实图标（Rust 端专属提取）。
- 导航树"此电脑"根节点固定 Lucide `Computer`（伪路径 `::{ThisPC}` 无真实图标可取）。
- 图标/类型映射单一来源 `lib/fileIcons.ts`：375+ 扩展名、38 种图标按语义细分（分类常量 + `BY_EXT`（含 dotfile）+ `BY_NAME`（Dockerfile 等）+ `TYPE_GROUPS`）；新文件类型 = 对应分类常量加一格 + `TYPE_GROUPS` 补类型名；预览页 `node tools/gen-file-icon-preview.mjs` 生成。

### 2.2 效率增强包

**组件与模块**：`stores/layout.paneTargets`、`panes.filter`/`panes.selMemory`、`preview/FolderPreview`、`useUi.typeAhead`、`lib/undo`、`lib/palette.ts`、`lib/mouseNav.ts` 等。

- **目标窗格传输**：`paneTargets` 会话记忆 + ListHandlers `onTransferToPane`，Ctrl+Shift+C/X 与右键"复制/移动到窗格 ▸"同走 `operations.transfer`，点选子菜单即记忆目标。
- **视图内过滤**：`list_dir` 增 `nameFilter`（名称/拼音首字母子串、多词 AND，`fs/sort.rs::name_filter_terms` 配 cargo test）；前端 `panes.filter` + 过滤条 np-filterbar（200ms 防抖）；导航进新目录即还原、后退/前进保留、此电脑页不响应。
- **选择记忆**：`panes.selMemory` 按路径快照选中集+锚点，单标签上限 50 目录，`settings.rememberSelection` 默认开，显式清空后离开 = 记忆清除。
- **文件夹预览卡**：`FolderPreview`（直接子项数 = list_dir total 快照直取，递归体积 = dirSizes best-effort 异步补齐）；QuickPreview Enter 对文件夹 = 活动窗格导航进入。
- **type-ahead 回显 pill**：np-typeahead 仅活动窗格渲染，任何 Esc 路径顺带清空。
- **撤销/重做**：`lib/undo` 双栈（新操作使重做分支失效）；rename/newfolder 完成即压撤销栈，trash/move 由任务 onDone 门控；Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 走全局快捷键。
- **地址栏面包屑**：np-addr-crumbs 非聚焦覆盖层（`:focus-within` 隐藏，超 5 段中段省略）。
- **标签**：右键菜单（duplicateTab/closeOtherTabs/closeTabsRight）；标签图标（此电脑=Computer、盘符=HardDrive、目录=Folder/FolderOpen 语义色，realIcons 开启优先真实图标并按标签路径 requestIcons；np-tab 内收窄 14px）。
- **快速命令面板**：唤起入口 = 功能库条目 `builtin:palette`（2026-11-12 入库为普通功能，可拖入右键菜单/窗格工具栏、可改条件可移除；默认右键菜单尾段自带；工具栏按钮按按钮锚位直开 Pane.openPaletteAt，右键菜单条目按菜单落点锚位）→ `openPalette` 贴身轻浮窗（无遮罩点击外部即关；搜索跨全库：名称/说明/分组 + 空格分词 AND + 名称首词 mark 高亮；↑↓ 循环 / Enter 执行 / Esc 关闭；定宽 320、无吸附箭头（2026-11-12 用户反馈：菱形咬掉搜索胶囊左上角，收窄 440→380→340→320 同日三轮定案）；排序 = 可用项稳定置顶、不可用沉底（2026-11-12 定案），两块内部按**功能相关度**降序（2026-11-19 用户需求「除了可用功能排在前面，还要按照功能相关度排序」：`paletteRelevance` 现场评分——作用于所选 +2 / 对象类型贴合〔纯文件/纯文件夹 target〕+1 / **扩展名专精**〔cond.exts 非空且可用性已保证全命中〕+3 / 高频清单成员 +1；仅可用项计分，不可用块保持注册表原序不跳动；空白现场全体同分序 → 高频 12 项 `PALETTE_QUICK_KEYS` 置顶语义不变，右键 PDF/图片时专精功能族升到通用功能之前；同分显式 order 决胜不依赖引擎稳定序；`builtin:palette` 自身不入清单——面板唤起入口自列无意义）；执行与右键菜单同一执行器 `builtinMenuItem`，现场条件不满足整行降灰 0.45 + data-tip 说明；`menuCommands` BuiltinFn 增 icon 字段，78 项随注册表入库）；过滤/可用性/排序/定位钳制纯函数 `lib/palette.ts` 配 vitest。
- **鼠标**：中键新标签（列表行/导航树 preventDefault 拦自动滚动）；X1/X2 历史导航（`lib/mouseNav.ts`，App 装卸）；新标签继承当前路径。
- 快捷键全部入 `lib/shortcuts.ts` 清单并与 `keyboard.test.ts` 双向对齐；新增 np-* 类均已在 index.css 定义（cssClasses 审计通过）。

### 2.3 窗格状态条选中统计

**组件与模块**：`lib/selStats.ts`（selStats/formatShortTime 纯函数配 vitest）+ FileList 状态条接线。

- 多选纯文件 = 「选中 N 项 (合计大小)」（越页未命中只计数）；多选含文件夹 = 仅数量（文件夹大小需递归统计，混入部分和会误导）。
- 单选 = 行内属性条「名称 · 大小 · 修改于 MM-dd HH:mm」（文件夹显示「名称 · 文件夹」），免开属性对话框；选择记忆恢复到未加载页时回落旧「选中 N 项」形态。

### 2.4 窗格错误态与逃生口

**组件与模块**：FileList 错误块（np-list-error-* 五类）+ `lib/ipc.ts` `cmd()` 错误归一（CmdError：code+message+toString）。

- 根因 = Rust AppError 序列化为 `{code,message}` 对象 reject，`String(e)` 渲染 `[object Object]`；cmd() 统一改抛 CmdError（`toString()` 直得用户可读文案），全部既有 toast/String 调用点零改动痊愈。
- 错误态分层渲染：E_NOT_FOUND =「文件夹不存在」+ 失败路径 + 人话提示；E_PERM =「无法打开此位置」+ 权限提示；其余透出后端 message。
- **逃生口两钮**（任何加载错误恒显示）：「打开桌面」（getKnownFolder("desktop")，OneDrive 重定向正确）、「打开此电脑」（THIS_PC 伪路径导航）。

### 2.5 刷新口径与缓存一致性（2026-11-17 用户实测事故定案）

**事故**：删除文件夹 → 外部（资源管理器）复制同名文件夹进来 → X-Dir 停在陈旧快照（显示为空），工具栏刷新无效，重启才恢复。三因叠加，全部修复：

- **刷新口径分层定案**：软刷新（refreshTick 不带 force）只用于自动链路（dir-changed/job-done/拖放后），语义 = 「后端缓存已被同一事件失效，重拉即可」；**任何用户手动刷新必须强制重扫**（`force_rescan=true` 绕过快照缓存）。F5/右键「刷新」本就走 `onRefresh(true)`，唯独窗格工具栏 ↻（Pane runTool "refresh"）漏成软刷新——已改走 `getList(tabId)?.onRefresh(true)`。新入口刷新一律对齐强制口径。
- **watcher 僵尸复活**（`watch.rs` WatchManager::watch）：被监控目录删除时表项不注销、watcher 死亡；旧实现同路径重复 watch 只加引用计数，重建目录的新事件永远失联。定案 = 重复 watch 一律**换新 watcher**（旧 watcher 连同事件通道丢弃，旧事件线程随 rx.recv() 出错自然退场；watcher 创建在表锁外）。回归测试 `rewatch_after_recreate_receives_events` 锁定：删→重建→重挂→新目录内事件必达。
- **删除失效含自身**（`jobs/mod.rs` Delete 分支）：dirty_dirs 此前只有父目录，被删文件夹自身的快照留缓存——同名删除→重建后进入新目录命中删除前的陈旧快照。定案 = 被删路径自身一并 push 进 dirty_dirs（文件路径为键无快照，失效是无害 no-op）。
- 残余边界（已知可接受）：标签全程停在 X 内部（导航不离开）时 watcher 僵尸不会被重挂治愈（无重新 watch 的触发点）——手动强制刷新可随时兜底；下一次导航（离开再进入）即自愈。

### 2.6 当前路径事实源与「返回上一级」（2026-11-17 用户反馈定案）

- **标签当前路径的唯一事实源 = layout 树的 `tab.path`**，`panes.currentPathOf` 改为从树解析（此前只读 panes store 的 `history[historyIndex]`）。两份事实源失配的两个真实场景：① 会话恢复/方案应用重建标签后 history **从未播种**（只在用户导航时生长）——up 对空栈直接失灵，`bumpAffected` 也匹配不到恢复标签（外部变更不自动刷新，前节缓存事故的加重因子）；② 同 id 档被方案二次应用时 history **整体漂移**——up 以陈旧历史头为基点，「返回上一级」不指向当前窗格文件夹的父级。
- **`panes.up` 定案**：以显示路径为基点；history 头 ≠ 当前路径（空缺/漂移）时先把当前路径补入栈再上行——补种同时保住「后退回到子目录」的历史链（navigate 幂等早退使已同步场景零开销）。`bumpAffected` 同步改读 `currentPathOf`。回归测试见 `stores/__tests__/panes.test.ts`（恢复态 up/漂移态 up/盘符根与伪路径不误导航）。

### 2.7 主动动作刷新提速（2026-11-17 用户定案「刷新再快一点」）

`bumpAffected` 分双通道定案：**主动动作收尾（任务完成/重命名/撤销/批量改名）一律 `immediate` 同步刷新命中标签（零延迟）**，不再等 250ms 合并窗；外部 watcher 事件维持 250ms 合并窗（防 notify 连发+job-done 补轮导致反复重拉，跨窗格拖放闪烁的既有护栏）。防双拉去重窗：immediate 刷过的目录记 500ms 账，同目录 watcher 批撞上时**一次性跳过**（X-Dir 内部动作自身也会触发 watcher，否则同一次变更双拉列表）；去重窗外（或过期后）的真实变更照常入窗。调用点分工：jobs.ts `bumpAffectedOf`（任务收尾）/FileList 重命名跨窗格同步/operations 批量重命名/undo 恢复 = immediate；jobs.ts 的 dir-changed 监听 = 合并窗。回归测试见 panes.test.ts（immediate 零延迟/去重窗吞 watcher 回声/窗外真变更入窗）。

## 3. 右键菜单与定制

### 3.1 右键菜单（数据驱动）

**组件与模块**：`lib/menuCommands.ts`（内置功能注册表 + entryVisible 条件纯函数 + 默认布局构建器，配单测）+ `components/MenuEditor.tsx` + FileList `builtinMenuItem` 执行器。**菜单脸 = 玻璃拟态**（2026-11-12 用户定稿 = 方案 C「霜」design/menu-proposal-c-frost.html：`--np-glass` 半透明底 + backdrop blur 22px + 内高光描边 + accent 左指示条悬停 + 危险项红染，作用域 `.np-ctx`/`.np-ctx-pop`，@supports 回退实底卡；规范条款见 ui-standards §4.1 玻璃 token 组）。

- 菜单布局 = `settings.menuEntries`（有序 MenuEntry：builtin/sep × area 启用时机三档（两处出现/仅选中右键/仅空白处右键）× cond（对象/数量/扩展名）；条目行恒展示四个条件摘要 chip）。
- 条件编辑器 = 锚定条目的 PopoverNext 浮层（不推移布局）+ np-seg 分段快选行 + `condSentence` 人话实时预览（配单测）；功能库**仅拖拽添加**（点击不入场）。
- **78 个内置功能**入功能库（含 PDF 家族见 §6、办公批处理见 §7、图片五件套见 §8、功能库入口 `builtin:palette` 2026-11-12 入库「工具」组）；FileList 只按规范渲染，**禁止往 rowMenuItems 硬编码新菜单项**——新功能 = 注册表加一行 + 执行器加一个 case。
- **「工具」组七键**：计算校验值（MD5/SHA-1/SHA-256/SHA-512，行级点亮 + GNU SUMS 无 BOM 保存）/ 校验核对（.md5/.sha256[sums] 逐项比对 ✓✗缺失报告）/ 修改时间与属性（时间四态 + 只读/隐藏位三态）/ 创建链接（硬链接/符号链接旁写）/ 文件分割（.partNNN + .crc SHA-256 清单）/ 文件合并（分组建序 + 验签重组）/ 功能库入口（快捷命令面板唤起）。
- **复制路径 ▸ 变体**（正斜杠/带引号/\\?\ 扩展长/相对/所在文件夹，path.ts 纯函数）+ 复制名称（无扩展名）；行尾转换 ▸（字节级 CRLF/LF 互转不改编码，旁写 _crlf/_lf）。
- **导出文件清单** = 参数面板 ExportListingDialog（穿透子文件夹 / 导出内容三档 / 格式四档 XLSX 默认 / 文件名内联校验，参数随 dialogPrefs 记忆）；列集十列（CSV/MD 同列集，txt = 完整路径）；免保存框直写当前文件夹（默认名 = 文件夹名-文件清单，重名 (2) 递增）；Rust `fs/listing.rs` 单源（行上限 20 万中止）+ `lib/listing.ts` 配 vitest。
- **新建子菜单**：文件夹/文本/Word/Excel/**CSV**/PowerPoint/Markdown/**RTF**/**Python**（2026-11-12 用户选型扩充 CSV/RTF/Python 三项；纯文本系 0 字节与资源管理器 NullFile 同轨，docx/xlsx/pptx 由 Rust `create_file` 落盘最小合法 OOXML 模板、rtf 带规范头 `{\rtf1\ansi}`——方案 A，Office/WPS 干净打开不报修复）；**新建文件夹 = Explorer 式**：不走弹窗——直接落盘「新建文件夹」（重名 (2) 递增，搜索/过滤态由 Rust 同名报错兜底）并立即行内重命名（pendingRevealRef 滚动定位），工具栏钮/右键菜单/Ctrl+Shift+N/「新建」子菜单四入口同口径。
- **基础固定功能**：open/cut/copy/paste/rename/delete/properties 七项常驻——不可移除/清空/被预设丢失（`ensureFixedEntries` 在加载/导入/预设应用/清空后归一化补齐）；「编辑菜单…」恒定尾项直达编辑页（「功能库…」2026-11-12 起入库为普通功能不再固定注入）。
- **出厂默认（2026-11-12 用户定版 = 现用方案收编为出厂默认，新装自动使用）**：菜单 10 条（打开/预览/剪切/复制/粘贴两用 + 分割线 + 删除/重命名/新建/属性 + 分割线 + 「功能库…」尾段两用）；PDF 功能族与 copyPath/copyName 块退出出厂布局（仍可从功能库拖入）。存量档迁移 = menuSeedV 版本化补种（v2=PDF 组仅对已有自定义布局的存量档送达，新装档不再自带；v3=功能库入口 sep+palette 尾段一次性送达，`seedPaletteEntry` 幂等）；此后菜单级新功能入库 = 版本 +1。
- **同一内置功能全布局唯一**（id = `builtin:<key>`）；「重置为默认方案」与「清空」驻「启用菜单」标题行右侧，均经确认弹窗；多套预设已下线（重置 = defaultMenuEntries + ensureFixedEntries 归一化）；旧档由 settings.load 迁移。

### 3.2 定制页

**组件与模块**：`components/MenuEditorPage.tsx`（整页壳 `np-menupage`，顶栏魔棒钮开、Esc 返回——输入框内先失焦）+ `components/MenuEditor.tsx`（上双栏 = 启用菜单/功能库，下横条 = 窗格工具栏编辑区）。

- 占满顶栏以下区域替换侧栏+窗格区；面板高度以顶栏下方实际空间为准（`min-height: 0` 钳制 flex，页面本体不滚动，超出在各自列表内部滚动）。
- 条件编辑浮层 PopoverNext 锚定条目、不推移布局；**命令模板已下线**——功能库只含内置功能与分割线，旧档 custom 条目由 `stripCustomEntries` 加载时剔除。
- **功能库 A+B 改版**：库主体 = 左分组目录（`.np-menued-rail` 点击平滑跳转 + `spyGroup` scrollspy 纯函数配单测，跳转动画期间挂起 spy）+ 右胶囊墙（`.np-menued-wall` 内容恒全量，条目 pill 化，启用面 = 图标徽章 `np-menued-mark`）；分组 8+1 组（剪贴板并入「文件」、视图并入「新建与视图」、窗格协作+工具合并「窗格」、表格并入「办公与表格」、图片转 PDF 移入 PDF 组；`fnGroups()` 配 vitest 固定断言）。
- 标题行单行收纳 = 标题 + 计数徽标 + 定宽搜索框 + 「只展示未启用的功能」开关 + 图例；三行头统一 13px 正文色不加粗、行高恒 `--np-ctl-h`；功能库搜索框走统一填充式输入规范。

### 3.3 窗格工具栏

**组件与模块**：`BUILTIN_FNS` 统一注册表 + `settings.toolbarEntries`（load 迁移旧 paneTools + `ensureToolbarAddr` 归一化）+ Pane 目录驱动渲染。

- **全部内置功能均可入工具栏，无能力位**（窗格工具 up/view/addr/search/splitH/splitV/swap 仅工具栏；其余菜单+工具栏两面共享）。
- 默认布局 = 定版 8 键（2026-11-12 现用方案收编：上一级/新建文件夹/刷新/地址框/复制路径/搜索当前文件夹/横向分裂/纵向分裂；初版 addFavorite/openTerminal 移除，功能库入口可拖入）。
- 条目默认作用域：文件夹作用域键 =「当前文件夹」恒可用，其余 =「依赖选中项」+ 注册表默认条件；**条件判定 = 当前窗格选中项完整判定**（`entryVisible`，未满足置灰 `.np-tool-off`）。
- 编辑条带模拟窗格导航栏 np-nav（图标+标题文本按钮 + 地址框占位同排，左缘竖线 = 插入指示）；点击条目弹条件编辑浮层、拖入启用/排序、拖出卡片移除；**投放区 = 整张工具栏卡**（分割线拖入红染弹回）。
- **地址框 = 固定条目**（`builtin:addr`，不可移除/清空、可排序，`ensureToolbarAddr` 保证常驻第 4 位）。
- 收纳档 TOOL_TIER（未分档键默认 only-wide 收进「更多」，随配置联动）；「重置为默认方案」驻工具栏区标题行（多套预设已下线，重置 = `defaultToolbarEntries()` + ensureToolbarAddr 兜底）。

## 4. 全盘搜索

### 4.1 页面与交互

**组件与模块**：`components/GlobalSearch.tsx` 导出 `GlobalSearchPage`（整页 `np-gsearchpage`，App.tsx 按页条件挂载）+ TanStack Virtual 自绘行。

- 唤起 = 顶栏按钮 / Ctrl+Shift+F；Esc 关闭（shortcuts `gsearch-page-close`，输入框内由页面 onKeyDown 直接关并 stopPropagation）；Ctrl+F 仍是窗格内递归搜索。
- **整页与主界面同语言**：surface 卡 + 1px border + radius-pane，无额外内边距；头部行 = 返回钮 + 标题 + 最近搜索 chips（出现/消失不推挤布局）；**单行紧凑控制条** = 搜索框（360）→ 类型 → 结果过滤 → 上限 →（弹性）→ 预览开关驻右（窄窗 flex-wrap 兜底）。
- 返回钮定稿 = 28px 高 pill 全圆角、sel 淡染底 + accent 箭头文字（`np-menupage-back`，与定制页共用）。
- **整页互斥**：`openGlobalSearch`/`openMenuPage` 互斥（打开其一即关另一页）；`ui.exitPages()` 供顶栏主界面类按钮先回主界面再执行动作；顶栏两页按钮带 active 态且再点即关；Ctrl+Shift+F 在定制页内 = 切换到全盘搜索页。
- 列头点击排序（名称/位置/大小/修改时间，同列再点反向，类型列不可排）；**mtime 列逐级隐藏**（面板 <`GS_MTIME_MIN`=660 隐藏，`gsMtimeVisible` 三方同源：visibleColWidths/表头/行）；**列宽 Explorer 口径**（`detailsContentWidth` 撑 min-width，放不下 `.np-gsearch-list` 横滚 + onScroll transform 同步平移）；列宽/面板宽寄存 settings（`gsearchColWidths` / `gsearchPreviewWidth` / `gsearchPreview`）。
- **多选与批量**：行点击单选/Ctrl 翻选/Shift 锚点范围，Shift+↑↓ 扩展，Ctrl+A（输入框空时）全选，Esc 先清多选再关页面；多选按路径存（排序/过滤下稳定）；右键在选集内 = 批量菜单（复制完整路径 / 复制·移动到窗格 ▸ / 删除到回收站）；**Ctrl+Enter** = 打开所在文件夹；状态栏"已选 N 项"。
- **结果二次过滤**：过滤行右端定宽输入框，纯客户端按名称/拼音首字母子串收窄已加载结果（不重新搜索），状态条回显"过滤后 N/M"，越界选中自动钳制末项。
- **内嵌预览右栏**：渲染核心 = `preview/PreviewBody.tsx`（与 QuickPreview 共用，容器无关）；单击选中后预览、双击/Enter 打开，悬浮不高亮选中。
- **防抖自适应**：索引就绪 120ms，否则 300ms；仅类型预设无输入词也允许搜索；输入框占位回显语法。
- **内容模式已移除**（臃肿）：「文件名/内容」模式分段、范围行、命中行片段、search_content 命令与相关类型/CSS 一并删除；名称搜索行为不变。

### 4.2 查询语法与类型过滤

**组件与模块**：`fs/matcher.rs` 两引擎（窗格递归/全盘）同语义 + cargo test；`GSEARCH_TYPE_PRESETS` + `composeTypeFilterQuery`（`lib/searchStream.ts` 配单测）。

- **查询语法对齐 Everything**：`ext:jpg;png` 扩展名（`;` OR、前导点可省、`!` 取反）；`size:>100mb`（`>` `>=` `<` `<=`/精确/`A..B` 区间，单位 b~tb）；`dm:today|yesterday|thisweek|...|last<N>days|2025[-MM[-DD]]`（本地时区自然日对齐，支持比较前缀与区间）；词前 `!` 排除；双引号短语 = 含空格字面子串。体积/时间词在索引通道排序后补元数据判定（取属性有护栏封顶）。
- **类型单一选择器**：NpSelect 一档装下 全部/文件/文件夹 + 常用类型预设（前端组合 `ext:` 词随查询下发，不改 IPC）；**磁盘范围选择已移除**——恒全库检索（roots 省略 = 服务端全部固定盘）。
- **拼音命中汉字高亮**：`highlightParts` 增可选 `py` 参——子串未命中的词在 py 串上找位置，经 `pinyinHighlightRange`（配单测）映射回汉字区间标记，与 Rust 首字母通道同语义；全拼通道暂不标记。

### 4.3 索引模式与守护

**组件与模块**：`components/IndexMode.tsx`（`useIndexStatus` 2s 轮询 + `IndexModeBar`）驻状态条左端；Rust `index/` 守护进程。

- 状态条 = [dot+标签 chip] + [Switch 常驻开关（UAC 流程 + 失败回滚 toast），开关必须直接可见]；设置面板「全盘搜索」页原区块已移除、留指引文案。
- **建索引进度可视**：阶段归约纯函数 `lib/indexPhase.ts`（`analyzeIndexPhase` 配单测）归约为 off/starting/building/ready/error/down 六阶段；`index_status` 增 `configured`（daemon.json 启用卷清单，用于判"初建中"）；开关打开即自动弹进度浮层（逐卷状态），启动宽限 15s，全部就绪/出错经灵动岛回执播报一次。
- **USN 日志重置自愈**：守护 `read_usn` 对日志重置族错误码（未激活 1179 / 删除中 1178 / 日志项已被删除 1181 / 功能不支持 1）一律返回 `JOURNAL_RESET` → 全量重建并继续，不再终止卷线程；Win32 错误码改用 Foundation 权威常量引用（本地手抄曾有错值），失败弹层附处置指引。

### 4.4 拼音查询性能

**组件与模块**：`fs/search.rs` 拼音通道三层加速 + 索引格式 `FORMAT_VERSION=3`。

- ① 每条目 `py_mask`（建库期预生成）做 DP 必要条件预筛；② 首字母通道用建库期预生成首字母串（u8 contains 精确判定，免解码免 DP）；③ 全拼通道零分配位图 DP（≤63 字节走位图快版，超长回落 Vec 版，差分测试锁语义一致）+ 读音预编译表（`PinyinTables`）。
- 实测（真实 458 万条目）：中文子串全量查询 3182ms → 284ms；拼音首字母/全拼词毫秒级；mmap 打开 0.1ms。合成/真实基准 `bench_synthetic_pinyin_scan` / `bench_real_index_query`（`#[ignore]` 可复测）。
- **首字母多音字语义收窄**：两引擎首字母通道统一为第一读音（"cq" 不再命中"重庆"，全拼不受影响），与 type-ahead 同语义；旧 .idx 自动判废触发守护重建。

## 5. 预览（快速预览 V2）

### 5.1 架构与格式覆盖

**组件与模块**：渲染核心 `preview/PreviewBody.tsx`（QuickPreview 浮层与全盘搜索内嵌共用）+ `previewKind.ts` 路由 + Rust `commands/preview.rs` 纯函数管线 + `lib/previewSearch.ts` / `lib/sheetGrid.ts` 纯函数（配 vitest）。

- **COM 转 PDF 通道**：.doc/.ppt/.pps 复用 office 模块 PowerShell 派发（Office/WPS 双引擎），缓存 `%TEMP%/xdir_preview/<sha256(路径+mtime+size)>.pdf`、24h/100 个自清扫、全局 Mutex 串行；失败回落兜底卡。
- **旧版二进制 Office 原生抽取**（摆脱 Office/WPS 依赖）：`ppt_office` = cfb 拆 OLE 容器读 PowerPoint Document 流（rt_Slide 分节、TextCharsAtom/TextBytesAtom 双编码、上限 100 张/节 128KB）；`doc_office` = WordDocument 流 FIB 校验 → CLX → PlcPcd 分段表逐段解码（压缩 CP1252 / UTF-16LE，控制字符规整）；加密/损坏失败静默回落 COM 通道；kind 沿用 docx/slips（IPC 零改动）；配 cargo test（cfb 写入构造最小 doc/ppt）。
- **其他格式**：.odt/.odp（content.xml 结构化抽取）；.rtf（控制字剥离）；.eml（mailparse：RFC2047 头解码/plain 优先 html 剥标签/附件名单）；.msg（cfb：__substg1.0_ 属性流直读）；.et/.wps/.dps/.ppsx 容器嗅探分流（PK 魔数按 OOXML/ODF 特征部件路由、OLE 报错指引右键转 PDF）。
- **OFD 版式文档文本预览**（GB/T 33190）：`.ofd` 新 PreviewKind；zip 容器 OFD.xml → DocBody/DocRoot → Document.xml → Pages 区逐页抽文；`zip_read_entry_ci` 大小写不敏感兜底；宽容原则：缺页/坏页整节跳过、任一页超限截断、页数上限 200；**图像版式（无文本层）明示提示**（指引专用查看器）而非空白；版式坐标不还原（保真渲染需专用引擎，许可证红线未引入）；配 cargo test（内存 zip 构造最小 OFD）。
- **深度提升**：xlsx 日期列修复（cell_display 复用 format_datetime）；docx 结构化 blocks（标题分级/列表缩进/内嵌表格/分页）；pptx 结构化（大标题/列表缩进/备注）；表格首行表头加粗冻结 + 数值列右对齐 + ods 合并单元格拍平 + 隐藏工作表过滤；epub 封面（OPF cover-image 三路兜底）。
- **表格 numFmt 渲染**：calamine 0.36→0.38（原生 `worksheet_style()`）+ 新模块 `sheet_fmt.rs`——「值+格式码」→ Excel 显示文本：数值占位（小数截位/千分位）、百分数（0.0819→8.19%）、日期时间序列数（1900 系统含闰年 bug 平移）、科学计数、引号字面量与货币前缀、正负分区、General 11 位有效数截断；仅 XLSX/XLSM，其余格式回落 General；端到端 = rust_xlsxwriter 写带格式文件全链路断言。

### 5.2 跨类型交互

**组件与模块**：QuickPreview 头部搜索条 + CSS Custom Highlight API + pdf.js TextLayer。

- **窗口可调 + 尺寸记忆（2026-11-19 用户需求「快速预览窗口要支持调整窗口高度和宽度」）**：`.np-pv` 开 `resize: both`（CSS 原生右下 grip，overflow:hidden 满足前置；min 480×360 / max 94vw·94vh 钳制防塌缩防溢出）；尺寸记忆走 dialogPrefs `quickPreview` 档——开窗 `loadDialogPrefs` 读档（缺省回落 `--np-pv-w/h` 响应式 var），拖拽结束 `saveDialogPrefs` 写档（随 settings.json 持久化/迁移）。实现要点（两代方案教训）：① **监听必须全 window 捕获层委托 + `closest` 现场锚定**——开窗 effect 时 portal 元素未必可查，一次性 querySelector 会空手而归致监听落空（实测拖拽生效但永不落盘的根因）；② 尺寸提交 = grip 角（右下 20px）pointerdown 记起点 → pointerup / 1s 兜底采样，尺寸变了才 `setPvSize`+写档——弃 ResizeObserver（挂载首帧观察回调拿到 CSS var 默认尺寸会把记忆值覆盖回默认）；③ **`loadDialogPrefs` 的 fallback 必须含键**（merge 只拷 fallback 已有键，空对象静默吞掉全部保存值）；④ 导航换文件尺寸保持（跟随会话），关窗重开 = 上次尺寸。CDP 全链路：开窗恢复记忆值 ✓ / 拖拽缩放 ✓ / 落盘 ✓ / 重开精确恢复 ✓ / 宽度顶 94vw 钳制 ✓。
- **预览内查找**（Ctrl+F 经 keyboard pv 分支唤起；shortcuts 清单 preview-search）：高亮走 CSS Custom Highlight API 分组注册（PDF 每页一组）；PDF = 整册文本抽取（≤400 页）命中列表滚页 + textLayer 页内高亮；表格 = 命中格高亮 + scrollToIndex 居中。
- **预览文本复制通道（2026-11-23 用户需求「预览的文本内容要支持复制，工具界面汇总的文本也要支持复制」）**：三通道——① **Ctrl+C/X 选区让路**（keyboard.ts 文本复制让路守卫，置于模态守卫之前：`window.getSelection` 存在非折叠 Range 时 Ctrl+C/X 直接 return 交还浏览器原生复制，不再路由成列表文件复制/剪切——快速预览开着时 ui.dialog 不置位、关于浮窗的 aboutOpen 也不经模态守卫，文本复制此前会被文件复制劫持；Ctrl+A 在选区所在容器 `.np-pv-body` / `.bp6-dialog-body` 内 Range 全选，替代会选中整页 UI 文字的浏览器全选；node 测试环境无 getSelection 整体跳过）；② **右键「复制」菜单**（contextMenu.ts 注册器模式 `registerTextCopyMenu`：右键落在 `.np-pv-body` / `.np-dialog` 内的既有文本选区上时，由主窗口注册的开启器弹应用风格迷你菜单复制选区文本——选区文本在开菜单瞬间先落变量，防点菜单项时 mousedown 折叠选区；shot/clip 轻量窗共用此拦截但**不注册**开启器，避免把主界面 stores 拉进截图 bundle〔§3.6 性能口径〕）；③ **关于浮窗「复制信息」**（页脚一键复制整段汇总：版本/简介/开发者/公众号/开源地址/引擎/设备环境，文案与界面逐项同源）。快捷键清单 clipboard 条目同步注明选中文本语义。
- **PDF 预览旋转（2026-11-23 用户需求「预览要支持对文件旋转，比如 pdf 或图片」）**：QuickPreview 旋转钮从 image 扩展为 image|pdf；PdfPreview 接 `rotateSignal`（与 ImagePreview 同信号协议：宿主递增计数，组件跳过挂载初值）。渲染 = `getViewport({ rotation })` 绝对角叠加页面自带 /Rotate（`(base.rotation + rot) % 360`），显示宽恒 = 内容列宽，90°/270° 时以原页高定标（旋转后视口宽来自 base.height）；文本层用同一旋转视口构建——选中/预览内查找高亮随转不漂移；虚拟列表 `getItemKey` 含 rot（旋转即整列重挂 → measureElement 重测新尺寸，沿用旧键会吃陈旧测量；estimateSize 按宽高比互换估算），翻转前记首屏页码、翻转后 `scrollToIndex` 回锚（页高剧变滚动锚点必漂）；换文档归零。officeBinary 转 PDF 兜底通道同接 rotateSignal（宿主按钮仅 image|pdf 显示）。
- **PDF 文本层**（pdf.js TextLayer，文字可选中复制）+ 页码跳转输入；文本预览换行开关（关 = nowrap + 行号 ≤2 万行）+ 代码语法高亮（highlight.js 懒加载，22 扩展名映射；token 化双主题色板 `--np-code-*` 浅=GitHub Light/深=GitHub Dark）。
- **压缩 JSON 自动排版**：`lib/jsonPretty.ts` 纯函数（整串一行 + 可 parse 的对象/数组 → 2 空格缩进重排；已含换行/纯量/非法/超长/膨胀 >1.5× 一律不动），展示层提示"已自动排版（磁盘内容不变）"。
- **表格行高三档**：`lib/sheetGrid.sheetRowHeights` 纯函数（折行启发与列宽同源；单格上限 6 行防撑爆）+ 右上浮动 np-seg 三档（单行省略/换行自适应/宽松留白）；多行档经 `gridTemplateRows` 显式行轨道下发 + virtualizer 同步重测；新密度 token `--np-sheet-line-h`。

### 5.3 pdf.js 二进制资产自供

**组件与模块**：`import.meta.glob` 资产 URL 映射 + 自定义 `ViteAssetBinaryFactory`（pdf.js 6 统一 BinaryDataFactory 协议）。

- 未嵌入中文字体的 PDF（UniGB-UCS2-H 等预定义 CMap、无 ToUnicode）此前整页汉字不渲染；修复 = cMaps 全量 + standard_fonts + jbig2/openjpeg/qcms wasm 资产映射，getDocument 补 cMapUrl/cMapPacked/standardFontDataUrl/wasmUrl——JBIG2/JPX 扫描件与标准字体回退一并受益。
- 打包产物小文件自动 data: 内联（CSP connect-src 已含 data:）、大文件哈希资产；dev 直连 node_modules；零新增依赖；E2E `verify-out/_e2e_pdf_cmap.mjs` 锁定。

## 6. PDF 工具

### 6.1 PDF 处理（合并/拆分/页级编辑/旋转/轻压缩/图片转 PDF）

**组件与模块**：Rust `pdf` 模块（lopdf）+ 右键菜单功能项 + 菜单条件纯函数 `lib/pdfOps.ts`（配单测）+ 任务引擎（进度/取消）。

- **旁写防覆盖（全局定案）**：全部 PDF 旁写出口统一 `available_name` 同名 (2) 递增——合并/合并Ex/拆分输出目录/水印/提取删除页/轻压缩/图片转 PDF，绝不静默覆盖原文件；前端对话框配套三段校验（非空/合法名/同名红字）+ 输出预览。
- **合并**：按选中序处理；智能默认名（单文件 = 文件名干、多文件 = 所在目录名，回退「合并文档」，`smartArchiveStem` fallback 参数，手动改名冻结）。
- **拆分**：参数化面板 = 拆分方式 按页数 N / 按书签层级（lopdf 大纲遍历，0=顶级、层级空自动取最深、无书签任务报错）+ 命名规则占位符 [原文件名]/[序号]/[页码]（`render_split_name` 与前端 pdfOps 镜像配双侧单测）+ 存入子文件夹 Switch（源文件名子夹，(2) 递增；关 = 直存所在目录）；拆分区间 (start,end) 闭区间经 `build_doc_from_pages` 复用页级提取。
- **页级编辑**：页码范围表达式（`1-3,5,8-`，`parse_page_ranges` 纯函数 + cargo test）驱动提取/删除（均旁写新文件，固定名重复执行 (2) 递增）；**旋转旁写** `<stem>_旋转<eff>.pdf` 不再原地覆盖原件（eff = 顺时针等效度数 90/180/270，tmp+rename 原子保存，`run_rotate` 抽 `rotate_pdf_file` 配真文件单测）；菜单收敛三项 = 顺时针 90°/旋转 180°/逆时针 90°（原「逆时针 90°」与「270°」数学等效重复已收敛）。
- **轻压缩**：对象去重 + 对象流化，旁写 `*_压缩.pdf`。
- **图片转 PDF**：PNG/JPEG 解码为 RGB8 → FlateDecode Image XObject，每图一页（对话框见 13.3 通用合并）。

### 6.2 PDF 加水印参数化

**组件与模块**：`pdf_watermark` 扩参 + `pdf/stamp.rs`（WatermarkOpts）+ PdfWatermarkDialog。

- 文字占位符 [原文件名]/[原文件夹名]/[页码]/[页面标签]/[日期时间]（页码 5 种渲染格式、日期 3 种）；字体 4 种（楷体/黑体/仿宋/等线，缺失回退 msyh 链，Arc 缓存）；8 色板；位置 = 九宫格 + 正反对角线（九宫格 = 边距偏移点，对角线 = ±45° 居中缩放 0.8，选中时字号/边距行禁用降灰）；透明度 0–10（ExtGState ca）；页范围 = 全部/奇/偶 + 自定义（`WmRange::Spec` 逐文档 `parse_page_ranges`，前端 parsePageSpec 同口径预演）；输出默认名 = `[原文件名]-水印`。
- UI = 单列纵排 + 标签列/控件列分别左对齐（np-wm-form 网格，§4.9 双列标准的本对话框级例外）；待处理清单置顶 np-pdfmlist（DragFileList 与合并对话框共用）；字号/边距自由输入 + 即时校验红字（单位 pt）；对话框参数记忆走 `settings.dialogPrefs`（13.4）。
- 位图按文字缓存（容量 4 条防串用）+ 按基准像素量自适应 2–4× 超采样防放大/打印发糊。
- **实现坑（已被 E2E 锁定）**：九宫格 cm 必须按位图缩放（Image Do 画在单位正方形，否则渲染为 1pt 点）；RGB 平面必须逐像素交错（RGB RGB…）——逐通道平面布局会被 pdf.js 读成三条横向色带。
- [页面标签] v1 以页码代替（/PageLabels 解析后续）。

### 6.3 合并扩展（混列/按文件夹/空白页）

**组件与模块**：`pdf_merge` 扩参（mergeByFolder/autoInsertBlankPage/blankPagePosition）+ `PdfMergeEx` 任务（`run_merge_ex` 配 cargo test）+ PdfMergeDialog。

- PDF 与 jpg/png 图片混列、缺失源自动跳过；按文件夹分组合并 = 文件夹递归收集、各组输出 `合并结果-<文件夹名>-<时间戳>.pdf`；空白 A4 页凑偶数（审计底稿打印），位置可选 第1页之前/最后1页之后（lopdf 重建 Kids + Count）。
- 功能拆分：「合并为 PDF」（pdfMerge，条件 仅文件·≥2·pdf/jpg/jpeg/png，单一输出）与「按文件夹合并 PDF」（pdfMergeFolders，条件 仅文件夹·≥2）；右键不再丢多选（已选中项右键保持选集）。
- 菜单条件为声明式无法表达 OR 逻辑，有效性门槛在执行端（<2 文件且未启用空白页时提示）。

## 7. 办公批处理

**组件与模块**：Rust `office` 模块 + `fs/textops.rs` + 批量重命名 `lib/batchRename.ts`（纯函数配单测）+ DialogHost「批量重命名」面板。

- **Office/WPS 转 PDF**：PowerShell COM 派发（MS Office 优先、WPS ProgID 回退；转换引擎不打包——AGPL 系硬红线），旁写 `<stem>.pdf`，需已装 Office/WPS。
- **隐私属性清理**：zip 重打包抹 docProps（作者/公司/修订/时间等），旁写 `*_清洁.ext`，仅 OOXML 容器。
- **导出文本 TXT** 复用预览抽取管线；**编码转换**（utf8bom/utf8/gbk，encoding_rs）旁写 `_<后缀>.ext`；**CSV 合并**去重复表头、**文本合并**空行分隔，输出 UTF-8 BOM。
- **Excel 合并**（2026-11-12 参数集扩展，对标 WPS/Kutools/Power Query 调研定案）：双通道——全部源 .xlsx/.xlsm 且分表保留时走 **umya 保真通道**（跨簿克隆工作表，样式/合并单元格/列宽/冻结窗格/图表/图片原样迁移；载体簿 = 首个源文件清空后并入，规避 umya「空簿 + add_sheet」不登记克隆格样式的怪癖；图表公式随表名重命名经 `PlotArea::formula_mut` 统一重映射，写出 catch_unwind 兜底未建模结构）；否则 **calamine 数据通道**（xlsx/xlsm 源逐格迁移样式与数字格式 + 合并单元格回贴 + 日期写真实日期值，xls/xlsb/ods 纯值）。参数：模式（分表保留/纵向拼接）× 工作表范围（仅可见/含隐藏）× 表名规则（智能·仅表名/仅文件名，multi 按过滤后并入表数判定）× **表头行数**（拼接，默认 1，0 = 无表头全部按数据）× 去重复表头 Switch（0 行表头时禁用；去重 = 后续文件前 N 行整块与首文件相同才跳过——引擎此前未读开关值，2026-11-12 用户反馈修正）× 来源列（拼接：文件名/文件名·表；列头文案在表头首行，其余表头行留空）；关联禁用 = 整行降灰 + 控件真 disabled（is-off 仅样式可误点，2026-11-12 用户反馈「来源列没法选择」根因 = 默认分表模式下灰行仍可点且无效果）；模块 `fs/xlsx.rs` + `fs/xlsx_style.rs`（calamine Style→rust_xlsxwriter Format 映射 + FormatCache 指纹缓存）+ `fs/xlsx_split.rs` 共用；run_merge_core 配 cargo test。
- **Excel 拆分**（2026-11-12 新功能，对标 WPS 智能拆分/Kutools Split Workbook & Split Data）：四模式——按工作表（批量支持；xlsx/xlsm 走 umya 保真通道每表独立重读剥表，xls/xlsb/ods 数据通道）/ 按行数（每 N 行一份）/ 按列值（按显示值分组，空值归「(空)」组，首现顺序）/ 均分 N 份；**表头行数**（rows/value/parts，默认 1，0 = 不带表头；源前 N 行含样式复制到每份顶部，xlsx/xlsm 样式逐格迁移）；输出 = `<stem>_拆分` 子文件夹（可关直落源目录），重名 (2) 递增绝不覆盖；护栏 = 500 份/200 组/200 份、ROW_CAP/CELL_CAP；表信息轻命令 `xlsx_sheet_info`（表名/可见性/行列数/首行 48 格样本，50 万格预算）驱动拆分对话框选表与依据列选择器；对话框四段式 §4.9（清单/参数/note/页脚），rows/value/parts 强制单文件（Rust 命令层兜底）；模块 `fs/xlsx_split.rs`（run_split_core 配 cargo test：保真拆分回读断言合并格/列宽/冻结/表头加粗，数据级拆分断言日期保真与 numFmt 迁移、双行表头块）。
- **批量新建文件夹**：名单/序号模板（`{}` 占位按止号位数补零）两输入模式；预演纯函数 `lib/folderBatch.ts` 配单测（非法名/名单内重名标红、与磁盘重名按 (2) 递增与 `jobs::pick` 同语义）；执行 `create_dirs`（同步轻命令不入任务引擎，单次上限 500，Rust 端 available_name 兜底竞态）。
- **压缩**（菜单「压缩…」，格式 np-seg 三档）：
  - **智能默认名** `smartArchiveStem`：单对象用对象名（文件去扩展名/文件夹全名）、多对象用所在目录名，冲突自动 (2) 递增，手动改名即冻结（纯函数配单测）。
  - zip = 进程内 Deflate + 智能存储（图片/音视频/办公容器等已压缩扩展名 STORE_EXTS 直存提速）+ 条目显式带源 mtime（zip crate 缺 time feature 时默认 1980 纪元）+ AES-256 密码加密（WinZip AE-2 写侧；接收方需 7-Zip/WinRAR 等，Windows 自带解压不支持任何加密 zip）。
  - 7z = 经内嵌 7-Zip（-t7z LZMA2，可选 AES-256 密码 -p + 加密文件名 -mhe=on；密码缺失/错误以 FailReason::Password 回执）。
  - tar.gz = tar::Builder 叠 flate2 GzEncoder 进程内流式（条目 mtime 由 tar 头自带）。
  - **进度字节化同解压**（walk_stats 预扫 total_bytes + 64KB 分块拷贝取消点）；**同名输出冲突** = 对话框内联红字（listDir 现有名集合）+ Rust 端 E_EXISTS 全量兜底；半成品 `<output>.tmp` 原子改名口径三引擎统一。
- **按规则归类**：前端编排（扩展名/修改年月分组建子夹 + 既有 transfer 移动）。
- **批量重命名 = 规则链范式**（参考 Smart File Renamer / Advanced Renamer 定案）：
  - 规则链可堆叠按序生效；4 大类 20 规则：添加（前缀/后缀/插入文字/加序号/加日期/父文件夹名）、替换（查找替换/替换扩展名）、删除（删除文字/删除指定字符/掐头去尾/去首尾空白）、转换（大小写/扩展名小写/简繁转换/转拼音/中文数字/补齐位数/数字加减乘除/日期格式化）；每条规则独立作用域三档（主名/整名/扩展名，ext 段更新跨规则链维护）。
  - 替换支持字面/正则全局匹配 + `$1` 捕获组；非法正则 = compileRegex 与引擎同源判定内联红字 + 该规则静默跳过。
  - 布局：上 = **四列文件表**（np-bren-grid：原文件名/新文件名预览/结果/路径；结果列 90px 定宽人话（将改名/无变化/错误，省略+title）；单一 grid 容器，表头 sticky，内容超宽整列撑宽 + 整表横向滚动；行级勾选参与、只看变更、改动片段 diff 高亮——`diffFragments` 最长公共前后缀标 accent 底色；添加文件 = 原生多选 → Rust `stat_paths` 补全元数据；删除选中 = 移除勾选行）；下 = 规则链（np-rchain 弹性内滚）；整体高度 min(58vh, 560px) 钳制，两区独立滚动；常用任务 chips 驻列表下方工具行。
  - 规则栏 = 添加规则/方案两触发钮（标准主操作蓝 + 计数对齐）；**添加规则 = 两栏二级分类面板 np-rp**（左 4 大类色点+数量，右名称+词槽句式预览，点规则加链尾）；**语句卡 np-rs 单行** = 把手+序号+类型词+启用开关+删除与词槽句式同卡一行（句式超宽行内横滚；**词槽句式即效果**，随参数自动切换）；**卡片指针拖拽排序**（setPointerCapture；NpSelect/输入交互不触发；React portal 冒泡防护：contains 守卫放行防 pointerup 被捕获吞菜单项 onClick；is-over 上缘指示线）；卡内字号统一正文 13px（高特异性 `.np-rchain` 前缀压 Emotion 运行时注入）；卡内控件辨识 = surface+发丝描边配方；空态 = 模板库 4 按钮。
  - **转换类引擎**：中文数字互转（进位+零位折叠+节间补零，≤1e12）、数字补齐 padNum、四则 arith（遍历名称内数字，除法两位小数）、日期格式化 reformatDates（识别 20261107/2026-11-07/2026年11月7日/带时间等写法统一重排）、简繁转换（opencc-js，子路径按方向）、转拼音（pinyin-pro，first=首字母、nonZh consecutive 原样保留）——两依赖均开源白名单，转换器惰性单例。
  - **删除指定字符 removeCls**：8 类字符勾选（空格/数字/汉字/大小写字母/中文符号/英文符号/非法字符）+ 删除/保留双模式；词槽 = ClsSlot 勾选面板 createPortal 到 body + fixed 定位随视口翻转。
  - **错误人话**：「改完后会与第 N 行重名」（批内冲突语义升级：改后撞未变更行 = 撞磁盘现有文件也提前报告）、「含有不允许的字符「?」」（illegalChars 定位）；扩展名保护、批内重名/非法名检测。
  - **方案保存/套用**：规则链存 `settings.renameSchemes`（随 settings.json 持久化与配置导出）；「方案」面板 = 列表套用（withFreshIds 深拷贝重发 id 防串）/删除 + 方案名保存当前链。
  - **撤回入口**：footer「撤回上次重命名」常驻（无可撤回时 disabled + data-tip）——撤销栈顶为 rename 批条目且本次对话框会话未用过时可用，**只能撤回一次**（undoUsed 落锁，重开对话框恢复）；执行走 applyRenames（整批成功项合并为一条撤销栈条目，一次 Ctrl+Z 全撤）。
  - 规则纯函数 `lib/batchRename.ts`（RenameOp 判别联合 + newOp 泛型工厂 + planRenames 链式应用 + describeOp/diffFragments/illegalChars + REN_TEMPLATES 配 30 例单测）；对话框经 `useUi.openDialog({type:"batchRename"})`；输出一律旁写不覆盖原文件。

## 8. 图片处理

**组件与模块**：Rust `img/mod.rs`（image 底座 + oxipng 无损优化 + color_quant PNG8 量化——libimagequant GPL 红线不采用；kamadak-exif EXIF 方向烘焙；文字水印复用 `pdf/stamp.rs` ab_glyph 光栅化）+ `commands/img_cmds.rs`（任务引擎串行槽）+ `components/ImgDialogs.tsx` 五对话框（表单行复用 np-bren-* 基类）+ `lib/imgOps.ts`（IMG_EXTS/拼图输出名纯函数配单测）+ 功能库「图片处理」组五条目。

- **压缩**：Auto（JPEG→JPEG@质量、PNG→PNG8、其余→JPEG）/ JPEG / PNG8 / 无损优化，旁写 `*_压缩.*`；质量档在 PNG8/无损/非 JPEG 目标下禁用降灰（Rust 端本就不读）；「智能」策略遇纯 PNG 清单禁用质量行。
- **水印**：文字/贴图 × 平铺45°/九宫格角标（`img::stamp_at_pos` 复用 pdf::stamp::WmPos，对角线码回落右下）× 不透明度 0–10 滑杆（与 PDF 水印统一口径）× 大小三档 × 8 色板（WatermarkOpts rgb/pos IPC 双端同步，色码经 `pdf::stamp::parse_color` 同源解析），输出保持原格式旁写 `*_水印.*`。
- **格式转换**：PNG/JPEG/BMP/TIFF/ICO(≤256px)/WebP 无损；EXIF 方向可烘焙（默认开，顺带抹除位置元数据），旁写 `*_转换.*`。
- **尺寸调整**：百分比(1–800)/指定宽/指定高(≤20000px)，宽高比恒定，Lanczos3/Triangle 两档 + 仅缩小开关，旁写 `*_缩放.*`。
- **宫格拼图**：4–36 张 → 列数 2–4 × 格子 512–1024 × 间距 0–16 网格画布；裁切填满/完整留白；白/黑/透明底（透明强制 PNG，JPEG 项禁用降灰不再静默回退）；输出 `拼图_yyyymmdd_hhmmss.png` 重名自动 (2)；清单即拼合顺序（超 36 张截断提示）。
- 全部功能旁写不覆盖原文件、批处理上限 200 张（拼图 36）；参数界面统一规范见 13.3/13.4。

## 9. 压缩解压与工具箱

**组件与模块**：Rust `fs/archive.rs`（zip/7z/tar 系逐条目）+ `fs/sevenzip.rs`（内嵌 7-Zip 兜底引擎，防 zip-slip）+ `fs/analyze.rs`（SHA-256 重复指纹/目录体积/双文件夹比较）+ `commands/archive_cmds.rs`/`analyze_cmds.rs`（async + spawn_blocking）+ `components/AnalyzeDialogs.tsx` + `preview/ArchivePreview.tsx`（解压工具行）。

- **解压**：格式 = zip/7z/tar/tar.gz/tgz/gz 进程内 + **rar（含 .partN.rar 分卷）/xz/bz2 经内嵌 7-Zip**（官方未修改 7z.exe/7z.dll 25.01 随 resources 分发，例外资产已备案——见 opensource.md §4）；多文件包解到 `<dest>/<包名>/`（gz/xz/bz2 单文件流旁写内层名，重名自动 (2)，走任务引擎）。
- **入口三处** = 右键「解压到此处」/「解压到…」（目标记忆 `settings.extractDestDir`）+ 预览面板工具行双钮。
- **进度字节化** = 解压前预扫清单求 total_bytes（zip central directory / 7z 两遍开包 / tar 流式无分母 / 7z.exe -ba -slt 声明尺寸 + -bsp1 百分比映射），64KB 分块拷贝取消点（单大条目可即时停）。
- **条目级回执** = zip-slip/解码失败条目计数经 JobProgress.note → JobDone.note 回执「已跳过 N 项非法条目」不再静默。
- **加密闭环** = 解压失败 reason=password → np-input 掩码密码框带密码重试一次；成功回执带「打开」目标目录动作（IslandReceipt.action）。
- **查找重复文件** = 同体积粗分 → SHA-256 指纹成组，统计头 + 导出 CSV，默认勾选每组副本、删除走回收站。
- **清理空文件/空文件夹** = `scan_empty` 递归扫描（0 字节文件 + 字面空目录——只含空子目录的父目录不算，防误删），两组默认全选勾删走回收站、上限 MAX_FILES 护栏。
- **空间分析 = WizTree 式矩形树图改版**：上色块图（`lib/treemap.ts` squarified 纯函数〔面积 ∝ 体积、最差长宽比不劣化的行扩充判据，零尺寸项不入图〕配 vitest 5 例；主题蓝单色 + 浓淡随体积占比分级——sqrt(占比) 压缩动态范围注入 `--tm-bg/--tm-bd`，color-mix 按 `--np-accent` 取色；ResizeObserver 测量容器重排；点击文件夹色块下钻〔面包屑栈回退〕、点击文件色块选中）+ 下体积条清单（TreeSize 式一行读全 + Checkbox 勾选 + 类型图标跟随「真实图标」设置〔realIcons 开 = Rust 提取位图，关 = fileIcon 语义色〕+ 体积占比列）；footer「删除选中（回收站）」走 deletePaths（弹窗内已确认跳过二次确认）；标题行合计体积与项数；Rust dirSizes 零改动（下钻即重查子目录）。
- **文件夹比较** = 相对路径对齐三段差异（A 独有/B 独有/内容不同，体积+mtime 判据），独立勾选 + 双向覆盖复制同步（走 transfer 冲突流程）+ 删除多余回收站动作；上限护栏（MAX_FILES/MAX_HASH/MAX_GROUPS）防病态目录。

## 10. 截图与贴图

### 10.1 架构与会话

**组件与模块**：Rust `commands/shot.rs`（常驻覆盖窗：启动 2.5s 后预热建 `shot` 窗隐藏 idle，会话经 `shot-session` 事件下发、`shot_ready` 回执 show，收场=hide 不销毁，热键重按=就地重拍）+ `shot_dxgi.rs`（DXGI Desktop Duplication 捕获 ~110-160ms 失败回落 xcap/GDI）+ EnumWindows 窗口枚举 + clipboard-manager 写位图 + global-shortcut 热键；前端轻量入口 `shot.html`+`shot/boot.tsx`（截图族四窗共用，不加载主界面 bundle，按 `window.__BOOT__` 分流）+ `shot/ShotOverlay.tsx` + `shot/PinWindow.tsx` + `shot/annot.ts`（选区/箭头/命中纯函数配 vitest）。

- 选型定案见 REQUIREMENTS §3.6（GPL 系截图应用全被红线打回，截屏引擎 xcap + 交互自研）。
- **会话数据**走 `%TEMP%/xdir_shot/` 唯一名 `session_{seq}.bmp`（BMP 编码 memcpy 级 + 唯一名防 WebView2 资源缓存）+ asset protocol 加载，不经 IPC 传大图，收场即清；全链路物理像素（×`__BOOT__.scale` 换算）。
- **贴图建窗必须放专用线程**：`WebviewWindowBuilder::build()` 在主循环自身执行路径上（同步命令内联 / run_on_main_thread 投递均实证）与 WebView2 建窗握手互等永挂——曾致贴图静默无效果 + WebView2 线程拥塞 + 覆盖窗看门狗连挂全挂；修复 = `std::thread` + 60ms 让 end_session 停靠先落地，build 内部派发落到空闲主循环完成。
- **贴图时序「蒙层在场盖住建窗期」**：spawn_pin_window 不先 end_session，贴图窗 show 后发 pin-shown 事件，前端先挂监听再触发建窗、事件到达（或 2.5s 兜底）才收蒙层——贴图原地顶替选区、遮罩随后退场。
- 热键注册由前端驱动（启动 + 设置变更调注册命令，冲突回执）；`hotkeys_sync` 单点全量重建（截图 + cliphist 回调按 id 分发，前端组装统一走 `lib/hotkey.ts` 的 `hotkeySpecs()` 防漂移）；scope `"system"` = 系统级热键不经 onGlobalKeyDown（keyboard.test 不强制覆盖）。
- 共用核心 `spawn_pin_zoomed(app, &PinSpawn{..})`——滚动长图 `shot_pin_file` 同走（命令内联建窗的死锁隐患一并消除）。
- **启动性能批**：shot 覆盖窗（2.5s）与 cliphist 浮窗（+1s）预热拆两个 run_on_main_thread 派发（同闭包连续建两窗停顿叠加成一次长卡顿）；`shot_save_prefs`/`cliphist_save_size` 改 async + spawn_blocking（settings.json 可达上百 KB，RMW 不占主线程）。

### 10.2 标注工具

**组件与模块**：ShotOverlay（进会话默认预选光标下窗口/选区/标注/马赛克/模糊）+ composite 离屏画布（底图+标注按序压平，马赛克/模糊取其像素）。

- 标注色板 = 画布内容色随图保存，非 UI 语义色不适用 `--np-*` 禁令（同 fileIcons 逻辑）；阴影/边框宽度 = 数字滑块连续调节（阴影 0~30px、边框 0~10px）并持久化；边框颜色独立色板（黑默认，与标注色板解耦）。
- **工具栏定案：设置类一律点击即弹面板，不做图标随动切换**；画笔/马克笔合并一钮（点击 = 激活笔族并弹 pen 面板）；**马赛克/模糊合并为一钮**（点击 = 激活打码族 + mask 面板：首行类型 + 次行区域形状）；箭头样式 = `Shape.head`（line/solid/hollow）× `Shape.line`（solid/dashed/curve），ArrowGlyph SVG 预览与 drawShape 几何同源（arrowWingsAt/arrowCurveCtrl 纯函数配 vitest）。
- **空心箭头**：杆止于翼基线（`arrowBaseAt` = 尖沿轴回退 headLen×cos25°）、两翼开放描边不画底边（旧画法空腔被底边闭合填满看不出空心）；面板预览同口径。
- 图标定案：滚动截图 = 自绘 `ScrollShotGlyph`（「竖屏圆角矩形 + 内嵌上下双向箭头」，lucide 无此组合）；序号 = 自绘 `StepMarkGlyph`（居中纯单徽①，无 + 号）；箭头工具 ArrowUpRight→MoveUpRight（视觉尺寸一致性）——自绘均按 lucide 风格（24 viewBox/stroke 2/圆角端点/currentColor），先例非 lucide 不走 AppIcon。
- 行 2 顺序 = 颜色/线宽/阴影/边框/贴图/滚动/OCR + 行尾三钮 = 保存→关闭（红 X 常显 np-shot-danger）→复制并关闭（Enter/双击同效）。
- **选区 OCR 文字识别（2026-11-19 新功能）**：`shot_ocr(x,y,w,h)` 命令（与 shotCopyCrop 同口径 = 选区整数物理矩形）从 SESSION_FRAME 进程内裁剪 → `encode_png_fast` → `spawn_blocking` 跑 `cliphist::ocr_png_text`（Windows.Media.Ocr 系统组件零新依赖；纯识别**不写剪贴板**）；**结果面板可编辑**（2026-11-19 用户定案）：识别完成弹出浮层卡片锚定工具栏正下方（渲染后钳屏，下方放不下翻上方），textarea 自动聚焦可编辑，「复制全文」经 navigator.clipboard 写入 + HUD「已复制 N 字」，Esc 收面板不退出截图；快捷键 Ctrl+O（shortcuts.ts `shot-ocr` scope=system）；识别中按钮 Loader2 转圈（复用 `np-spin`）disabled 防重复；错误 HUD 2.5s（无会话/矩形不合法/未识别出文字/无引擎——无引擎提示加语言包指引）；面板开着 Esc 优先收面板。无帧路径 cargo test 锁定（`ocr无会话帧时报错不panic`），识别本体真机测试 `ocr_recognizes_rendered_text` 门闸。**结果文本规整 + 等宽呈现（2026-11-23 用户反馈「字符间距有点大，是不是空格太多了」）**：Windows.Media.Ocr 对中文截图常在汉字/全角标点乃至西文与汉字之间吐出成串 ASCII 空格（识别噪声，非排版语义）——`cliphist::normalize_ocr_spaces` 在识别出口统一规整（连续空格段任一侧邻接 CJK〔汉字/扩展/兼容/假名/谚文/CJK 符号标点/全角形式〕即整段去除，两侧均非 CJK 的西文词间空格原样保留，全角空格 U+3000 视为显式排版意图不碰，换行结构不动），面板显示与复制全文、剪贴板通道同受益；结果面板 textarea 换等宽字体栈（Consolas/Cascadia Mono/monospace，与 kbd/代码预览同源）字符列位对齐；`normalize_ocr_spaces_rules` cargo test 锁定规则。
- **选区 GIF 录制（2026-11-19 新功能）**：工具栏「录制 GIF」钮（滚动截图旁，lucide Film）两段式入口（`shot_gif_begin/launch` 镜像滚动，选区 ≥96×80）；**参数定案 = fps 8/12/15 浮条可切默认 12（待命/录制中点击循环切档下一帧起生效）+ 选区原始物理尺寸不缩放 + 单次 120s 上限自动收场（计时从点开始起只计真实录制时间，待命/暂停不计时）+ 底部进度条可选默认开（待命态可关）+ **停顿保留秒数可设**（2026-11-20 用户需求「录制前可设置」：浮条「停顿 Ns」chip 循环 1/2/3/5/10，`keep:N` 动作 + `GIF_STATIC_KEEP` 原子，收尾静止段压缩读取，收尾时生效）**。**四态浮条（2026-11-19 用户定案「点开始才录」；2026-11-20 用户需求「增加暂停、取消、保存按钮」扩暂停态）**：待命态（遮罩框定区域不抓帧不计时，Enter=开始）→ 录制态（红点脉冲 + 时长/帧数/实时体积 + **暂停/保存/取消** 三钮）→ 暂停态（红点静止降透明 + 「已暂停」+ 计时冻结不抓帧，继续/保存/取消）→ 生成中态（开启进度条时逐帧合成期间禁操作）。录制循环（`shot_gif.rs`）= xcap `capture_region` 实时抓选区 → `gif::Frame::from_rgba_speed`（ NeuQuant 逐帧独立调色板，speed 10）→ `gif::Encoder` 流式写 `%TEMP%/xdir_shot/gif_{millis}.gif`（内存只持一帧）；帧延迟 10ms 厘秒取整的漂移经余数累加补偿（`gif_delay_cs` 纯函数 + 编码解码 roundtrip 配 cargo test）；帧延迟下限 2cs（浏览器对 <2cs 按 10cs 处理的通行约定）。**暂停计时口径**：录制时长 = 已落账时长 + 当前段起点（暂停时落账、恢复重开段），恢复时 `last_cap=None` 重置帧延迟基点（暂停时长不得计入首帧延迟，否则回放卡一大拍）；`GIF_PAUSED` 原子 + `pause`/`resume` 控制动作，跃迁即时发 `shot-gif-progress`（带 `paused` 字段）供浮条换面。**浮条窗宽 480**（2026-11-20 用户反馈「开始按钮被遮挡/tooltips 不完整」：滚动条 310 固定宽装不下 GIF 按钮组，`bar_layout_sized` 参数化定位算法单一来源、滚动条默认 310×44 不变）；**busy 只作防双击、命令回执即复位**（同日反馈「点开始后无法退出」根因：start 成功后 busy 恒 true → 录制态按钮全 disabled 且 Esc/Enter 通路被拦；状态权威 = Rust phase/progress 事件）。浮条复用 shot-bar 常驻窗（boot 换装 `gifbar` → `GifBar.tsx`），Enter=保存、Esc=取消；每秒 `shot-gif-progress` 事件。结果窗复用 shot-result（boot kind="gif"）：img 原生播放动画，按钮组 = 打开所在文件夹（`shot_result_reveal` opener reveal）+ 保存（`shot_result_save` kind="gif" 走 GIF 过滤器默认名 GIF录制_{stamp}.gif），复制/贴图对动画不适用不显示；窗销毁清临时文件（保存的是副本）。互斥 = `GIF_ACTIVE`/`SCROLL_ACTIVE` 双向拒绝（共享 shot-frame/shot-bar 窗与抓屏）。依赖合规：gif 0.14（MIT OR Apache-2.0，原传递依赖转直接声明）+ color_quant（MIT）零新增树版本；gifski（AGPL）红线打回（opensource.md §2）。**智能剔除重复帧（2026-11-20 用户需求「体积小很多」）**：静止帧（与上一**写入**帧精确字节等值）默认不写盘，时长并入下一变化帧的帧延迟（GIF 静止 = 帧停留，视觉完全一致）；静止超过 1s 兜底上限（`DUP_FLUSH_MS` = 1000，2026-11-20 用户第二轮定案「重复帧延迟 1 秒其余删除，节奏更连贯」，初版 2s 后收紧）补一帧 1×1 近零体积兜底帧，帧延迟全程 ≤1s——**用户提议的「重复帧保留 5fps」不采纳字面方案**：全帧编码下 5fps 重复帧仍要逐帧量化+占满帧体积（静止段体积收益仅 ~58%），延迟合并口径收益 ~96% 且视觉相同（决策纯函数 `dedup_delay` 配 cargo test）；暂停时长经基线平移不计入延迟（恢复时 `last_written` 前移暂停段）；录制停在静止段收尾时补 keepalive 把尾巴时长分段并入（每段 ≤1s，回放时长与节奏 = 录制所见，<100ms 微尾巴不补）；比对 = 上一写入帧原始 RGBA 克隆留存（量化原地消费缓冲，单帧 memcpy 预算 <1ms）。**鼠标指针叠画（2026-11-20 用户需求「指针录制开关」，市场惯例默认开）**：浮条「指针 开/关」chip（待命/录制中可切，下一帧起生效，`cursor:on|off` 控制动作 + `GIF_CURSOR` 原子）；实现 = `GetCursorInfo`（句柄 + 屏幕物理坐标，per-monitor DPI aware 下与选区坐标系同源）→ `GetIconInfo`+`GetDIBits`（32bpp top-down）解码光标位图 → SrcOver 叠进选区帧（`blend_cursor` + `cursor_clip` 越界裁剪纯函数配 cargo test）；**句柄未变走 `CursorCache` 缓存**（免每帧 GetIconInfo/GetDIBits 建读位图）；彩色光标（Vista+ ARGB）直接混合、alpha 全 0 旧式光标用 AND mask 兜底透明度、单色光标（I-beam）按 ICONINFO 上 AND 下 XOR 经典公式绘制；叠画先于重复帧判定（光标动 = 帧变化语义正确，光标静止画面静止仍可剔除）；hbmMask/hbmColor 用完 DeleteObject；系统隐藏光标（flags 无 CURSOR_SHOWING）不画。浮条窗宽 560（指针 chip 入列后 480 偏紧）。**结果窗播放与尺寸适配（2026-11-20 用户反馈「预览要适合 gif 尺寸、支持播放」）**：① 编码器必须 `set_repeat(Repeat::Infinite)` 写 NETSCAPE2.0 循环块——**缺省不写循环扩展 = 浏览器只播一遍**，结果窗等进度条合成弹出时已播完呈静止帧（「不支持播放」表象根因）；录制与进度条合成两处编码器都要写（`encoder_writes_netscape_loop_block` 单测锁定）；② 结果窗尺寸按 GIF 宽高比开窗（旧版高恒取 80% 屏高 → 矮 GIF 大片空白）：内容 = 图 CSS 像素 + 视口 padding 24 + 状态条 43，宽钳 [520s, 屏宽-32]、高钳 [160, 屏高-120]，钳小后靠前端初始缩放兜底；③ 预览播放控制 = `GifPlayer.tsx` Canvas 播放器（WebView2 内置 `ImageDecoder` 逐帧解码 + rAF 时间轴，零新依赖）：暂停停当前帧、恢复从当前帧继续不重头（空格/按钮），**逐帧解码不缓存**（千帧级长录制缓存位图上 GB；单帧 LZW 2-10ms，15fps 预算充裕）；`typeof ImageDecoder` 探测缺失回退 `<img>` 原生动画；首帧绘出才 `shotReady`（提前 show 闪黑屏同 img 口径）；初始缩放 GIF 分支整体适配（高也进视口），长图仍只适配宽（2026-10-29 定案不变）。比对基线与子帧状态内聚于 `DeltaEncoder`（基准测试复用同管线）。**帧间差异编码（2026-11-20 用户需求「帧间差异编码」= 空间维去重，gifsicle -O 同源思路）**：`DeltaEncoder` 维护观看画布（上一写入帧量化 RGB 3B/px = 解码呈现色）+ 画布索引 + 当前调色板 + 上次捕获 RGB（真静止快判定基线）；变化盒 = **双口径交集**「内容变化（raw vs 上次捕获，量化 ε 不算）∧ 观看变化（raw vs 画布量化色）」——只用观看口径会让高熵内容的 ε 误差铺满全幅（子帧退化为全帧，基准场景 B 实测暴露后修正）；盒 <70% 画幅且调色板不陈旧（真变像素平均平方距离 ≤1728 ≈ 每通道 24）→ 子矩形帧（disposal=Keep 保留画布，**盒内未变像素复用画布索引逐位零闪烁**、真变像素最近邻旧调色板、调色板按实际用索引压缩 768B→几十字节），否则全帧重建调色板；静止兜底帧/录制尾巴 = 1×1 画布同色帧（近零体积，替代全帧重量化）+ **静止段压缩收尾**（2026-11-20 用户三轮定案收敛为「**重复帧保留 1 帧 + 支持设置停顿几秒**」——初版每帧 1s 口径下 10s 静止拖 11s，第二轮段首单帧 ≤1s 压得太狠显快进，第三轮定稿）：收尾对临时盘文件做 GIF 块级字节重写（`scan_gif_frames` + `compress_keepalive_runs`，不解码像素零量化损失）——连续 keepalive 段（1×1 尺寸识别）**每段只留段首 1 帧、其 GCE 延迟原位改写为设置的停顿秒数**（字节级补丁不解码像素），内容帧与其余字节原样保留；顺序 = flush → 压缩 → 进度条合成（合成以压缩后文件为输入，帧数/进度语义自洽）；**合成速度与预估**（2026-11-20 用户需求「提高导出速度或给预估时间」）：合成变化被构造性限定在「输入帧矩形 ∪ 底条增量」内 → `DeltaEncoder.push_hint` 只扫描提示矩形（小子帧输入扫描成本从全画布降到盒级，录制路径传 None 全扫描），`shot-gif-synth` 事件逐帧（≥250ms 节流）下发 done/total/**ETA 预估**（已耗均速外推剩余帧耗时），浮条生成中态实时显示「合成中 N/M · 预计 Xs」；解析异常保守保留原文件（`compress_keepalive_runs_collapses_static_runs` 单测锁定）；保留秒数经 `GIF_STATIC_KEEP` 会话原子参数化（录制浮条可设，见参数定案）。**实测（480×300@12fps 10s，`dedup_size_benchmark` 基准）**：静止为主 -98%（11627→139KB）、局部动态（光标/拖选语义）-98%（11602→140KB）、全帧动态持平零劣化；CPU 同步受益（子帧免 NeuQuant 免全帧 LZW）。配套：进度条合成链路 = 组合画布（子帧按 left/top 叠画、disposal Background 兜底清矩形）逐帧喂**生产 DeltaEncoder**（2026-11-20 用户需求「进度条平滑度可设」：底条步进三态 `bar:on`=平滑 40 级 / `bar:low`=跳进 10 级 / `bar:off`=关闭，浮条进度条 chip 循环切换 + `GIF_BAR_STEPS` 原子随 boot 下发；**实测步进粗细对体积影响 ±0.4%**——拖拽成本由「变化盒垂直拖到画布底缘」支配、条宽非主导，档位价值 = 视觉平滑度选择）——旧合成把每帧重编码为全画布，录制期子帧/兜底帧全部膨胀回全帧（2026-11-20 用户反馈「一个 gif 5.9M」，1323×739 × 73 帧实测）；新合成首帧全帧、后续自动产出「内容变化盒 ∪ 填充增量条」子帧，底条按 BAR_QUANT_STEPS=40 级画增量（连续微增量会把每帧变化盒拖成全宽×到底），无增量帧保持纯内容子帧；用户同文件实测 6.19MB→1.27MB（-79%）；前端 GifPlayer 走 Chromium ImageDecoder（组合帧）+ 原生 img 回退（均支持 disposal=Keep 子帧，标准能力）。**底部进度条**（待命态开关，默认开）：完成开启后逐帧合成——画布向下扩 8px（护栏 = min(8, 帧高)），第 i 帧填充宽 = w×i/total（回放到末帧恰好满格），accent 填充 + 深色轨道；两遍扫描（skip_frame_decoding 计帧 → RGBA 解码合成流式重编码），失败保留原 GIF 出结果；合成期间浮条「生成中」禁操作（`append_progress_bar` + `encode_with_bar` 配单测：扩高/半填充→全填充/延迟保留）。**体积三旋钮（2026-11-21 用户选定市场调研项 1/2/3「色数/lossy/缩放」）**：待命态新增三 chip——① **色数 chip**（`{256}色` 循环 256/128/64，`colors:N` 动作 + `GIF_COLORS` 原子，**开始录制后生效**）：自定义色数量化镜像 from_rgba_speed 语义（alpha 归一 + 独特色计数，≤档位走**精确调色板零损失**，超出 color_quant NeuQuant（MIT）；encoder 自动补齐 2ⁿ 表宽、LZW 最小码长随档收窄；进度条合成链路同档收窄）——实测 128 色 -18%/64 色 -32%（合成高熵内容，纯色 UI 收益更高）；② **有损 chip**（`有损 关/低/中/高` 四态循环，`lossy:off|low|mid|high` 动作 + `GIF_LOSSY` 原子，下一帧起生效）：giflossy --lossy 同思路自研零 GPL 代码——DeltaEncoder 双口径扫描的距离比较收敛进 `dist2_beyond` 单路径（平方距阈 0/64/256/900，0=字节级精确与旧语义逐位等价），容差内帧间微变按未变处理（画布保持上一帧呈现）；ViewerIdentical 跳过累计 ≥1s 补兜底帧（「帧延迟全程 ≤1s」不变式与重复帧剔除同口径）——场景 D 亚像素抖动（±2/帧模拟 ClearType/抗锯齿闪烁）字节级 11.7MB → 有损低 138KB（**-98%**，dedup_size_benchmark）；③ **缩放 chip**（`缩放 100%` 循环 100/75/50，`scale:N` 动作 + `GIF_SCALE` 原子）：**待命设定、会话开始定档**（GIF 头尺寸场中固定不可中切）——捕获后 `downscale_rgba` 区域平均重采样（分区法 floor..floor 每源像素恰计一次亮度无漂移），光标位图 `nearest_downscale_rgba` 最近邻缩放保线条锐度（CursorCache 缓存键 = 句柄+档位）、落位坐标随档折算——缩放50%+128色+有损中组合实测 -60%；三参数 begin 复位默认（256 色/容差关/原尺寸），boot 事件全量随发对齐常驻窗复用；浮条宽 640→840（三 chip 入列）。**浮条图标化 + 设置收纳（2026-11-22 用户需求「gif/长截图工具栏样式与截图主区域工具栏一致；gif 设置项收纳进设置图标，每项带图标」）**：① 动作钮全量切主工具栏图标语言（`np-shot-tool`，iconLg=20 + 语义色 primary/danger/ok 同源）——GIF 待命 = Play 开始/X 取消、录制/暂停 = Pause|Play/Save/X，滚动控制条 = Check 完成（ok 绿）/X 取消（danger 红），标签全走 data-tip（遮罩窗外渲染通道不受影响）；② 七个设置项（帧率/进度条/色数/有损/缩放/停顿/指针）收纳进齿轮钮（lucide Settings，开态 = sel 淡染 `on`）展开的 `np-shot-gset` 面板：行 = 图标 + 名称 + 当前值（muted 右对齐 tabular），整行点击循环切档（复用原 chip 回调），相位门控随原 chip（录制态只剩 帧率/停顿/指针），Esc 优先收面板再取消会话、生成中自动收起；③ **面板朝远离选区一侧展开**：boot 初始载荷/换装事件随发 `flipped`（`bar_flips_above` 纯函数 = `bar_layout_sized` 上翻分支单源化 + cargo test 与布局函数互证），下方停靠面板向下（窗顶锚定长高）、上翻场 `.is-up` column-reverse 面板在上 + 发丝线换边（`shot_bar_resize` 增 `h`/`up` 参数：up = 底缘锚定、顶缘上移差值并钳屏，行面屏幕位置不变）——面板永不遮进录制选区（遮罩/面板若盖选区会被 capture_region 拍进帧）；④ 测量链路扩展：宽仍取行实宽 16px 档量化（同相位只增不减），高取容器实高逐值比对（面板开合即变、无抖动源），boot 换装与相位切换双基线重置；⑤ **`shot_bar_resize` 旧宽度上限 = 当前窗宽（只能缩）修复**：录制文本逐秒增长/面板展开均需涨宽，上限改显示器宽-16（防逐秒抖动仍由前端 sentW 基线把关）；行高 42 + 边框 = 窗高 44 不变，`np-shot-gbar-fps` chip 样式族随收纳退役删除。**同日复报「浮条要居中；四周圆角样式与主截图工具栏不一样」二轮修复**：① **居中根因 = ready 落位覆盖自适应缩窗**——launch 预置 x 按 840/310 全宽计算，前端缩窗先于 ready 执行（同 webview IPC 顺序 + 主线程串行），ready 原子落位把已缩窄的窗口按全宽基准摆放，浮条停在左缘（设置收纳后内容 ~840→~380，偏移 (840-宽)/2 从不可见变显著）；修复 = `SESSION_WINDOW_POS` 扩三元组 (x, y, 预置宽)，ready 落位时右移「预置宽 - 当前实宽」的一半回中（缩窗/落位全程罩内无可见跳动；缩窗未落地时差值 0、其后的缩窗自带居中重定位，两种顺序殊途同归；滚动控制条同款同修）。② **圆角阴影对齐主工具栏**：浮条窗与卡片完全贴合 → CSS 阴影整圈被窗缘裁掉呈硬边无晕开——卡片四周加透明环留（margin 顶4/侧16/底28，纵横和均为 32）+ 专属紧凑阴影 token `--np-shadow-float(-up)`（0 ±4px 16px，浅 rgba(20,28,40,.16)/深 rgba(0,0,0,.45)，2026-11-22 新增 token）；上翻场 `.is-up` 整环镜像（顶28/底4）+ 阴影向上背向选区——**环留恒在选区外**（贴选区侧仅 4px），绝不吞录制区域点击（2026-11-20 tooltip 带教训口径的分寸：环贴边不进选区 vs 带悬在录制区内）；前端测量随之 w+32（左右环）/h+32（上下环），Rust 窗高全链 44→76（`BAR_CARD_H`/`BAR_RING` 常量 + 预热占位 840×76 + bar_layout 系列单测 76 口径）。**同日三轮复报「还是没有居中，工具栏背景太大」**：① **复用场尺寸重设竞态（真根因，二轮居中补偿被它吞掉）**——预热使首场即走复用路径，launch 40ms 等待后 `show_gif_bar_window`/`show_bar_window` 无条件 `set_size(840/310 全宽)`，把前端在 boot 换装时刚缩好的窗口**弹回全宽**（缩窗先执行、重设后执行），随后 ready 读到的是被重置的全宽 → 居中补偿差值归零 → 浮条停左缘；修复 = 复用场**绝不重设尺寸**（窗口尺寸自 2026-11-21 起归前端自适应链路所有：boot 换装 → 重测 → shot_bar_resize 回传，全程罩内；冷建分支才设初始全宽占位），gif/scroll 两处同修。② **窗体大底色**：`shot.html` 内联透明背景被 index.css `body { background: var(--np-bg) }` 按注入顺序盖掉（ScrollFrame 早有运行时强制先例）——环留区域透出的是 --np-bg 实底呈「大背景」；GifBar/ScrollBar 挂载即置 html/body inline background transparent。③ 宽度测量改量卡 offsetWidth（含 1px 描边，旧量行宽差 2px 右缘裁边；设置面板更宽时随卡），GifBar rowRef 退役。**同日四轮实测定位真因（PowerShell 驱动 Ctrl+Alt+A→拖选区→点 GIF→CopyFromScreen 截屏 + logs/x-dir.log 诊断行取证，此后 `shot_bar_resize`/`shot_ready` 保留「浮条自适应/伴生窗落位」日志行）**：① **居中真因 = `bar_layout(_sized)` 返回元组解构错位**——launch 预置落位宽度传了第 4 元素（高 152）而非第 3 元素（宽 1680），ready 补偿算出 `(152-480)/2 = -164` 把浮条往**左**推；修正解构 `(bar_bx, bar_by, bar_bw, _)`（gif/scroll 两处），实测预置 1680 实宽 480 → 落位 2029，选区中心偏差收敛到 ±16px 量化档内（上翻/下方两场截屏复核）。② **长截图浮条消失回归（11-21 预热引入）**：预热 `__BOOT__` 固定 gifbar 占位，boot.tsx 按 `__BOOT__` 一次性挂载组件——预热后首场 scroll 会话发 `shot-bar-boot` 时 GifBar 不监听、ScrollBar 未挂载 → 浮条永远罩内 → 长截图没有工具栏也无法退出；修复 = boot.tsx 增 `BarHost` 宿主常驻监听 `shot-bar-boot`/`shot-gif-bar-boot` 两路事件按载荷切换组件（异类会话重挂=状态全量重置，同类换装仍由组件自身 boot 监听处理），实测 GIF→滚动跨类切换浮条正确换装且居中。**同日五轮「工具栏底部白色区域」**：环留区画的白不是页面 CSS——**shot-bar/shot-scroll 的 WebviewWindowBuilder 漏了 `.transparent(true)`**，WebView2 表面本体白色、页面再透明也透不出去（预热 + gif/scroll 冷建共 5 处 builder 补旗；贴图窗 11 月起就有先例，「四周余量区透出桌面承载阴影」注释即此意）；前端 html/body inline 透明强制保留（防 index.css body 规则回填）。裁剪放大实拍复核：GIF/滚动两浮条环留区桌面透出、圆角阴影正常悬浮。
- **十字辅助线开关** `shotCrosshair`（默认开，设置 → 截图区 Switch；关闭时两条 DOM 跟随线整体不渲染，零元素零合成层；放大镜/取色不受影响）。
- **WASD/方向键微调**：跟随态/拖拽中 = Rust `shot_nudge_cursor`（GetCursorPos+SetCursorPos 移动真实光标，生成的 WM_MOUSEMOVE 由覆盖窗 pointermove 自然接管，前端零手动重绘）；已确认选区 = 前端整体平移选区框；Shift=10 物理像素大步，带修饰键组合不劫持；清单入 shortcuts.ts（scope system）。

### 10.3 序号标记与滚轮编辑

**组件与模块**：`shot/annot.ts` 纯函数群（nextStepSeq/shapeAt/adjustShapeProp/shapeBounds/stepBadgeColor/stepBadgeSize 等配 vitest）。

- **序号标记 step**：选区内点按即落（无拖拽草稿，徽标尺寸由线宽档决定）；数字按 `nextStepSeq(shapes)` 同一会话自动递增，撤销摘掉后自动回退复用；徽标 = 实心圆（标注色）+ 反差描边与文字（`stepBadgeColor` 按 WCAG 相对亮度 <0.6 配白/近黑）+ 直径随线宽档**与位数无关**（多位数收缩字号入圈）。
- **滚轮编辑（悬停指哪调哪）**：`shapeAt` 命中测试（线形命中**描边带**而非包围盒——大包围盒整面命中会遮挡下层标记；椭圆沿射线取边界点；曲线箭头贝塞尔 8 段采样折线；文字按 CJK 全宽 bbox；序号圈按直径圆域）+ `adjustShapeProp` 逐档调节（线宽 1~30、字号 10~80、序号 1~20、马赛克格 2~20、模糊不透明度 15%~100% = `Shape.alpha`）；滚轮上 = 增大；HUD 900ms；原生 wheel 监听（passive:false）；带 Ctrl/Meta/Alt 的滚轮不劫持。
- **撤销模型 = 快照栈**（旧「摘最后一个图形」在滚轮编辑后语义错误）：每次变更前完整快照，600ms 内连滚合为一阵；重新框选/跟随态按下清栈。
- **悬停选中框 + HUD**：live 层画 accent 虚线包围盒（`shapeBounds` 描边感知：线形半线宽/马克笔 3.5 倍/箭头含翼展/序号圈直径/文字 bbox/面形不外扩）；HUD 锚定选区内部中上方（无选区回退窗顶）。
- **滚轮记忆持久化**：逐类型默认值会话内立即生效 + 按键防抖 400ms 持久化（`shotStrokeW`/`shotTextFont`/`shotStepW`/`shotMosaicW`/`shotBlurAlpha`，挂载读回并按量程钳制）；宽度模型从三档预设索引迁移为逐类型连续值；`shot_save_prefs` 签名 = 单 JSON 参数白名单键补丁合并（规避 clippy 参数上限）；finish() 收场前 flushPrefs 立即冲刷未落盘的防抖批量。
- **标记增强批（样式全量 + 交互九项 + 显隐）**：矩形/椭圆空心↔半透明实心（filled 30%）、虚线扩展、矩形圆角（radius 0~24css）、箭头双向（two）、文字高亮底色/粗体/斜体、序号徽标三形（badge circle/square/plain）、马赛克/模糊圆形区域（round 内切椭圆）；交互 = 拖动移位（`translateShape`）、Alt+拖动克隆、Del/Backspace 删除悬停标记、1~8 换色（同步为新图形默认色）、双击已落文字回编辑态、Shift 绘制约束（正方/正圆/45° 吸附）、拖拽实时尺寸 HUD、Z 序置前/置后、悬停右键菜单 np-shot-markmenu；**按住 Tab 隐/放显全部标注**（按住制防忘恢复；隐藏态禁交互；隐藏仅显示层，导出仍含标注）。

### 10.4 贴图（Pin 窗）

**组件与模块**：`shot/PinWindow.tsx` + `spawn_pin_zoomed` 共用核心 + `shot_pin_drag_start/stop`。

- **贴图内容 = cropCanvas 精确选区**（含标注），不用 exportCanvas（阴影/边框装饰外扩会让贴图大一圈且偏移；装饰只属于复制/保存导出）；img CSS 尺寸 ÷ boot.scale（物理像素直接当 CSS 宽在 150% 缩放下 1.5× 溢出）。
- **视觉定案**：无可见描边（仅近不可见淡边给浅色内容边缘定义）+ 8px 圆角 + 双层柔和阴影（近距贴附 + 远距空间感）；阴影扩散 ≈52px → `pin_shadow_pad` 余量（图像区落位不受影响）；贴图页挂载时把 html/body 背景置 transparent（阴影余量区透明）。
- **拖动终案 = Rust 线程 6ms 轮询 GetCursorPos 直接驱动 set_position**（125Hz、读 OS 权威光标、与 WebView 事件投递完全解耦；JS 侧逐 pointermove 发 setPosition 的坐标快照过期抖动不可避免）；JS 只发会话起止两条 IPC，左键松开 GetAsyncKeyState 自动收场；滚轮缩放（Alt+滚轮 = 不透明度）。
- 右上角悬停浮现单关闭钮（圆形 20px 半透明黑底白 X，离开 180ms 退场；按下 stopPropagation 不抢拖拽）+ 右键菜单 np-shot-pinmenu 并存；Ctrl+P = 贴图快捷键；右键菜单点击放行（closest 守卫，防根节点 onPointerDown 先吞导致按钮 click 落空）。

### 10.5 快捷键清单浮层

**组件与模块**：`keysSide` 纯函数（配 vitest 5 例）+ np-shot-keys 覆盖层。

- 选区确认后展示半透明黑底键帽两列（10 行 = Esc/Enter/Ctrl+P/Ctrl+Z·Y/Del/Tab/1-8/滚轮/Shift/WASD）；按右→左→上→下取第一个放得下的边（侧边垂直居中、上下边水平居中，均钳屏内；下方末选且左对齐避让工具栏），四边放不下（近乎全屏选区）不展示；面板先隐藏渲染量实测尺寸再定角；pointer-events:none 不挡画布。

## 11. 剪贴板历史

### 11.1 架构与选型

**组件与模块**：Rust `cliphist.rs`（SQLite 存取/ingest/清理/watcher 启停/浮窗管理/直接粘贴）+ `commands/cliphist.rs` 七命令薄封装 + `clip.rs` 扩展（set_text/get_text/get_dib/read_block/parse_dib 纯函数配 cargo test）+ 轻量入口 `clipboard.html`+`src/clip/boot.tsx`+`ClipHistWindow.tsx`（独立浮窗不加载主界面 bundle）+ `lib/cliphist.ts`（纯函数配 vitest）+ 设置「剪贴板」页（HotkeyRecorder 复用）。

- 选型定案见 REQUIREMENTS §3.7 与 opensource.md §2（Ditto/CopyQ/PasteBar 全打回；clipboard-rs MIT 只作监听信号，内容读写走自有 clip.rs 保 CF_HDROP DropEffect 与 CF_DIB 性能先例；rusqlite bundled SQLite = 项目首个数据库，config/clipboard.db WAL，磁盘库失败降级内存库）。
- 监听 = clipboard-rs `ClipboardWatcherContext`（AddClipboardFormatListener 真事件，watcher 专用线程 + WatcherShutdown.stop() + 代际号防旧线程误清登记）；回环 guard = sha256 内容 hash + 3 秒窗一次性消费；去重命中置顶（Ditto 行为）。
- 护栏 = 文本 1MiB / 位图 20MB / 文件 500 条 + 容量（默认 500 钳 50–10000）+ 保留天数（默认 30，0=永不清），置顶豁免清理；敏感内容高置信跳过（PEM/AWS/JWT/GH·Slack·Google 令牌，手写匹配器零依赖）；排除应用 `cliphistExcludeApps`（watcher 前台进程比对命中即不入库）。
- 图片条目存 PNG 原图 + 缩略（image crate thumbnail，THUMB_EDGE 320 只缩不放；**不透明图编 JPEG q80**——比 PNG 小一个量级，随分页 dataURL 下发不撑 IPC；任一像素带透明才编 PNG，按**实际像素**扫描判透明而非颜色通道——剪贴板位图恒为 RGBA 源，按通道判定永远走 PNG），dataURL mime 按实际编码标注；`parse_dib` 接受 32bpp BI_BITFIELDS 标准掩码（WinForms SetImage/GDI 合成 DIB 常态布局）。
- 文件条目入库细分 kind：全部为目录 → dirs（fs::metadata is_dir 判定，失败归 files；write_back files|dirs 同臂回写 CF_HDROP）；链接/路径细分（is_url/is_existing_path 纯函数配 cargo test，回写仍按纯文本）。
- FTS5 全文 = clip_fts trigram 分词优先（任意子串含中文，触发器同步；**计数漂移才 rebuild**——不每次启动全量重索引）；≥3 字符走索引，短查询/拼音/来源 LIKE 不回归；拼音首字母搜索（py 列复用 `fs::search::pinyin_initials` 惰性 ALTER+回填）；来源应用记录 source 列。
- 富文本保真 = html 列 + CF_HTML build/parse，回写双格式 CF_UNICODETEXT+HTML Format（`cliphistRichText` 默认开）；收藏分组 fav 列（豁免清理/排最前/「收藏」过滤档）；备份导入导出（Backup JSON，image base64 往返）；OCR 取字（Windows.Media.Ocr 零新依赖，识别文本写回剪贴板自然入库；2026-11-12 跑通修正——Buffer cast IDataWriter 必然 E_NOINTERFACE = OCR 此前从未真正出过结果，改 IBufferByteAccess 直写像素 + SetLength（直写不更新 Length，不设报 0xC00D7170）；blocking 裸线程补 CoInitializeEx(MTA)；引擎创建加已装语言包枚举兜底（statics 需 Globalization feature）；超 OcrEngine.MaxImageDimension 先等比缩到限内；真机单测 ocr_recognizes_rendered_text = PowerShell System.Drawing 渲染中文数字 → 真识别断言，无语言包机器经 create_ocr_engine 门闸自动跳过）；多选合并粘贴（merge_texts 按列表序连接，`ids IN` 精确取行）。

### 11.2 浮窗交互

- 常驻停靠屏幕外（-32700 防闪白；**伴生窗无感上屏体系（2026-11-21 用户报告「三入口黑屏闪烁，低配更明显」）**：截图主覆盖窗的「屏外停靠 + 首帧就绪才上屏」下沉到全部伴生窗——① 收场一律停靠不 hide（shot_gif `park_windows` / shot_scroll `park_session_windows`：SW_HIDE 令 WebView2 合成器离场，再 show 呈现旧白面 = 每场闪白的根因，GIF/长截图此前一直踩）；② 启动预热三伴生窗（`ensure_session_windows`：遮罩 shot-frame / 控制条 shot-bar / 长图预览 shot-scroll，占位 boot + 停靠 + 可见，首场即暖场）；③ 就绪门控（`shot_ready` 扩 shot-frame/shot-bar/shot-scroll 三标签 + `SESSION_WINDOW_POS` 落位目标在 launch 线程**换装事件前**预置防竞态；前端 ScrollFrame/ScrollBar/ScrollPreview/GifBar 首绘/换装双 rAF 回执 `api.shotReady()`；控制条焦点移入回执分支，预热首绘回执不抢焦点）；④ **主覆盖窗上屏反转**（低配黑屏实证修复）：「画好再长距离移动」在低配 DWM 有呈现间隙 → 移动/缩放前置到会话开场的透明空壳期（`begin_session` dispatch：set_ignore_cursor_events(true) + set_size + set_position，空壳期移动不可见），`shot_ready` 只恢复穿透 + 焦点；`SESSION_POS` 退役。取证：`flash_probe`（#[ignore] 手跑，30fps 区域连拍 + 亮度/帧差分析 + 异常帧落盘 %TEMP%/xdir-flash-probe/；本机实测上屏瞬间干净，UIA Invoke 截图按钮可做无接触触发）。**RDP 复测追加（同日用户远程实测仍一次黑闪，单帧级探针抓不到）**：上屏机制升级为 **DWM Cloak**（`set_cloak` = `DWMWA_CLOAK`，PowerToys 防闪同款）——窗口常驻罩内（DWM 持续合成不呈现），移动/缩放/换装全部罩内完成，`shot_ready` 只做一次「去罩」原子呈现：上屏瞬间零窗口系统调用、零移动、零 show/hide、不依赖 WebView2 透明（透明在部分远程会话渲染为黑）；`end_session` 与伴生窗收场（gif `park_windows` / scroll `park_session_windows`）改**原位罩住**不再位移，冷建回退亦然；90fps 探针（480×300 区域）复测触发→上屏→Esc 全程零暗帧，绝不用 hide()）；**长截图/GIF 启动提速 + 浮条样式统一（2026-11-21 用户需求「启动速度太慢；浮条与主截图工具栏统一规范」）**：启动慢双重根因 = ① 滚动/GIF launch 的「蒙层停靠确认」轮询仍查 outer_position ≤ -32000——Cloak 时代 end_session 原位罩住不再位移，条件永不成立，每场白等 500ms 超时；② begin 里「僵尸销毁」循环把预热窗每场全数销毁，迫使 launch 走 webview 冷建（300ms+/窗 + 120ms 冷建 sleep），预热体系形同虚设。修复 = 停靠确认改查 DWMWA_CLOAKED（`shot::is_cloaked`，原位罩住即摘离合成输出与「已离屏」同语义，10ms 轮询 500ms 兜底不变）、僵尸销毁循环删除（收场一律罩内待命无僵尸可言，复用 + 换装 + 回执门控旧内容零闪现），launch 开场对复用窗防御性罩住（收尾异常残留的可见窗先摘屏再回执上屏）——启动从 ~1.5s 级进入 ~100ms 级；浮条样式统一 = 值 chip（np-shot-gbar-fps）改主工具栏钮语言（透明底无边框 + 悬停 np-hover 浮现，min-width 56 防切档推挤保留）、状态 chip（np-shot-sbar-dir）去描边纯文字、动作钮（np-shot-btn）底色 np-hover→surface-2 悬停 sel→hover 对齐全局阶梯；**首帧确定性完整（同日用户复报「激活仍一次闪屏、然后才出十字线」，PixPin 观感定案）**：根因 = 首绘挂在 [ready] passive effect 上与去罩竞速——十字线/放大镜/胶囊 CSS 初始 opacity:0、由 redrawLive 尾部 updateFollowDom 点亮，去罩（双 rAF 后 shot_ready）先落地则窗口 surface 还是透明空壳，呈现次序 = 蒙版压暗先行、十字线晚 1-2 帧（用户感知的「闪一下再出十字线」两段观感）→ ShotOverlay 加载 effect 在 setReady 前**同步** redrawBase+redrawLive（comp 先压平定格帧，放大镜取像即有真像素；updateFollowDom 以 boot.cx/cy 点亮跟随层），蒙版与十字线同帧原子呈现；同轮就地重拍捕获余量 140ms→30ms（Cloak 原位摘离合成输出，不需要合成器追赶位移，旧余量纯叠加重拍感知延迟）；**预热首绘回执误去罩回归修复（同日用户报告「桌面左上角两块灰色区域」实绩）**：Cloak 重构把伴生窗预热从停靠屏外改为默认级联位+罩内隐匿，但 `shot_ready` 对伴生标签无条件去罩+show——预热首绘回执（`SESSION_WINDOW_POS` 无落位目标 = moved=None）也照去罩，三个预热窗（遮罩/控制条/长图预览）直接亮在主屏左上角，且会被后续截图捕获污染定格帧；修复 = 去罩/show/焦点全部收进 `moved.is_some()` 分支（moved=None 一律原位罩内待命），预热建窗补 `set_position(park_position())` 兜底（Cloak 万一失效也只落在屏外））；热键呼出 = 光标显示器居中上屏 + 抓取前台窗口为粘贴目标，失焦自动收（Ditto 惯例）；**置顶常驻态豁免失焦收窗**（np-clip-pinbtn，会话级不持久化；常驻态回写一律仅复制不关窗并页脚回执）。
- **直接粘贴**（默认开，可关）= 回写剪贴板 → SetForegroundWindow 恢复目标焦点（先转让再收窗）→ 60ms 后 SendInput Ctrl+V；恢复失败（管理员窗口/UAC）保持打开提示「已复制」降级。
- 键盘与搜索（2026-11-12 用户定案「折叠搜索」，取代早前焦点自卫方案）：**呼出默认折叠 = 顶栏右端一枚搜索图标（np-winbtn 基底 + np-clip-searchtoggle 右对齐与窗口钮成组）、不聚焦**——列表模式即刻全效（↑↓/WS 选择 · Enter 粘贴 · 1-9 取条 · Space 勾选 · Ctrl+P 置顶 · Del 删除 · Esc 关窗）；**键入任意字符或点图标展开**搜索框并聚焦（首字符经 pendingChar 补进搜索词；IME 组合首键 keyCode 229 = 仅展开承接组合文本、不插字符）；展开后 = 输入模式：可打印字符/空格/数字进搜索词，↑↓/Enter/Alt+1-9/Ctrl+P 仍作用列表；**Esc 收起并清词**（回列表模式），再按关窗；每次呼出复位折叠态并清词。**Tab/Shift+Tab 循环切换分类过滤**（2026-11-12 用户需求；全部/收藏/文本/链接/路径/图片/文件/文件夹八档循环，kind 变更经防抖效应自动重拉）。行内动作钮点击后持有的焦点由 keydown 路由回列表语义（Enter=合并/粘贴、Space=勾选，防二次触发按钮）。**全程不做焦点抢夺**——「快捷键与搜索框冲突」自折叠化起根除（焦点自卫宽限期方案整体退役）；页脚快捷键清单随状态切换（搜索聚焦中显示「输入即搜索 · Esc 收起搜索」）。
- **紧凑双行卡（2026-11-12 用户三方案比选选定方案二）**：卡片 padding 8/10→4/8、卡距 8→4（row shell padding-bottom）、body 行距 3→2，短文本卡 58→47px；动作钮 20→18px = meta min-height 同步 18px（gap×4.5，承袭 2026-11-07「display 切换不撑高卡片」口径）；缩略图上限 2.4→3 行高（fitThumb capH 与 CSS max-height 同步改）。**同日用户再定案「标签右上角、功能按钮右下角」**：类型 chip（紧凑 padding 2/5）+ 置顶/收藏标记在内容行右上角（np-clip-crow 行，chip 由预览 flex:1 顶到行右端），动作组独守 meta 行右下角（margin-left auto）；**挤压修正（用户报超宽缩略图裁掉悬停动作组）**：fitThumb 可用宽按 meta 行预算让位（现 180，chip 移回内容行后 meta 只剩 时间+动作组）；置顶/收藏标记悬停/选中态 display:none 退场（动作组含同款状态钮防双星并列，display 切换不占高）。
- 行 = 选中行对齐文件列表 np-row 口径（sel 淡染底 + accent 文字）；类型徽章 = 左缘 3px 类型色条（np-clip-kbar-*，透明占位统一缩进）+ 灰线性图标；序号列居中 + 斑马纹（`--np-stripe`，按数据序号挂 is-alt——虚拟列表 nth-child 随滚动翻转闪烁）；**图片行缩略图等比 + 尽可能大（fitThumb onLoad，2026-11-12 用户两次反馈定稿）**：在 行高 3（2026-11-12 紧凑双行卡定案 2.4→3）/ 卡片可用宽（卡片内容宽 − 序号列与间距 26 − meta 行预算 180（chip 移回内容行后 = 时间+动作组悬停态+间隙）− 卡片水平 padding 16，下限 120）上限内等比放大到最大，scale ≤ 1 保证**不超过图片本身尺寸**（自然 CSS 像素；早前 1:1 物理像素方案过保守——1068×197 只显示成小细条，弃）；旧版固定 95×67 盒 + object-fit cover 裁切变形亦弃；CSS 仅留 max-height 加载前兜底，宽度上限由 JS 权威——双重钳制会让 inline 尺寸失配变形；行高变化由虚拟列表 measureElement 自动重测；行悬停 = 主题蓝淡染；行内动作钮（置顶/删除）悬停与选中行常显。
- **自绘顶栏 np-cliptb** = 拖动区 + 双击最大化 + **条目计数徽标（np-cliptb-count，2026-11-12 自底栏移入：muted 小胶囊，多选时切换为「已勾选 N/total」）** + 置顶/最小化/最大化/关闭四钮（窗口钮 28px 密排成组，原生标题栏钮连排惯例）；最大化 = Rust MonitorFromWindow+GetMonitorInfoW rcWork 手动撑满工作区 + 记录恢复矩形（cliphist_set_maximized）；底栏 = **描边键帽快捷键说明（2026-11-12 用户三方案比选选定方案二：去外层 surface-2 胶囊容器、素底直接铺在页脚）**——每条快捷键 = np-kbd 键帽 + muted 动作词成组（np-clip-key，flex wrap 最多两行、column-gap 14），键帽经 `.np-clip-keys .np-kbd` scoped 覆盖为透明底 + `--np-border` 描边 + fg 字（编辑器提示风；设置页/全盘搜索等其余场景仍 surface-2 填充式 np-kbd 基方不变），**清单固定不随焦点态跳变（2026-11-12 用户反馈「快捷键又变化了」）**——常态清单（列表/搜索聚焦共用）键位一律取「任意状态都生效」口径：取条 = Alt+1-9（裸 1-9 仅列表模式生效，不作展示）、勾选 = Ctrl+点击（Space 列表模式同样生效）；仅勾选态与常驻态（Enter 语义不同）各自成清单，共三套；清空钮已退役（2026-11-12）——清空功能移至 设置 → 剪贴板「清理历史条目」：最近 N 天输入（默认 3，0 = 全部非置顶/收藏）+ danger 清空钮（confirmDialog 二次确认），Rust `clear_recent`（pinned/fav 豁免与容量清理同口径，`cliphist_clear_recent` 命令替换原 `cliphist_clear`）配 cargo test。
- **尺寸持久化** = 建窗 resizable(true)+min_inner_size(360×300)，页面 resize 防抖 600ms 经 cliphist_save_size 白名单补丁落盘（钳 360–1200×300–1500；最大化态跳过并锁 resizable）；上屏定位用实际窗口尺寸。
- **焦点链**：开窗**不聚焦任何控件**（折叠搜索定案，2026-11-12）——原生焦点留在浮窗自身，点击窗外 Focused(false) 即失焦停靠；键入/点图标才聚焦搜索框（focus 与渲染同 tick 落位）；收窗把焦点还给呼出前窗口；顶栏设置钮 = 唤主窗直达设置面板「剪贴板」页（**park_clip_window 不做焦点归还且置于聚焦主窗之前**——顺序颠倒会被归还抢走前台，面板压在别的窗口后面）。**焦点看门狗（2026-11-12 用户反馈「点顶栏空白后点外部不再自动收」兜底）**：顶栏拖拽区的原生拖拽会让 WebView2 焦点状态错乱——浮窗可见但前台已易主，Focused(false) 可能不触发 = 事件路径单点不可靠。Rust 侧 400ms 看门狗：**gating = 呼出时刻（CLIPHIST_SUMMONED_AT）+ 宽限 1.2s，不吃 Focused(true) 置位**——实测 set_focus 已使窗口持前台（GetForegroundWindow 命中）时无焦点切换发生、事件不回调，以事件置位 gating 会永久 disarm（首版 SEEN_FOCUS 方案即因此失效，已弃）→ 前台非本窗 → 光标不在窗内 → close_clip_window；光标悬窗内不收（交互中）。Focused(false) 事件路径保留并加**光标在窗内豁免**（拖拽中「伪失焦」不误收——点顶栏移动浮窗不再被关，真实点离窗外才收）。复现/回归脚本 verify-out/_e2e_clip_autohide.mjs（真实 OS 点击：PowerShell 须 SetProcessDPIAware——DPI 不感知进程的 SetCursorPos/GetWindowRect 坐标被系统虚拟化缩放，点击会落错位置）+ `cliphist_debug_state` 诊断命令（状态位/前台/矩形/光标 + v 二进制代际标记，防测到旧二进制）。
- 「粘贴到当前窗格」= cliphist_paste_to_pane 回写 CF_HDROP → 唤主窗 → 活动 FileList.onPaste 同 Ctrl+V 路由。
- **预热不预取**：armed 门闸——停靠态挂载不拉整页 50 条（含缩略图 base64 MB 级 IPC），首次获得焦点才放行数据通道。
- 设置五键 cliphistEnabled/Hotkey/DirectPaste/Capacity/KeepDays（settings.json + toPlain 白名单）；np-clip-* 类全部在 index.css 定义（cssClasses 审计）。

### 11.3 性能与回归批

- **watcher 两阶段入库**：短锁查重（命中即置顶）→ 锁外编码（encode_image_payload，4K PNG 数百 ms）→ 短锁复核+落库+清理——旧路径持 conn Mutex 编码会冻住全部 cliphist 命令乃至主线程。
- **重命令 async + spawn_blocking**：list/write_back/ocr/get_image/export/import/merge_paste 全部离开主线程与 runtime worker（JS 侧 API 签名不变）。
- 四列惰性迁移（py/source/html/fav）合并为一趟 pragma_table_info；capabilities windows 必须含 cliphist（漏列致浮窗页核心事件 API 被拒）。

## 12. 全局功能

### 12.1 设置面板

**组件与模块**：Dialog 浮窗（np-settingsdlg）+ `components/SettingsPanel.tsx`（左分类导航 + 内容页）。

- 九类 tab：外观/浏览/文件操作/全盘搜索/截图/剪贴板/着色规则/快捷键/配置（状态在 useUi.settingsTab，设置钮开「外观」页，开合与直达分类经同一状态驱动）。
- 行 = 标题+说明 ▸ 控件（`.np-set-row`）；分段选择走通用 np-seg；规则编辑区 = surface-2 凹陷面板；快捷键页数据源 = `lib/shortcuts.ts`（键帽 np-kbd）；配置导出/导入走原生保存框。
- 主题切换圆形扩散特效：View Transitions 从触发点 clip-path 圆形揭示新主题（`setThemeWithFx`），减少动效偏好/不支持时直切。
- 索引模式开关已移出设置（入全盘搜索面板状态条，见 4.3）。

### 12.2 顶栏灵动岛

**组件与模块**：`lib/island.ts`（通道仲裁纯函数 `resolveIsland`/`summarizeJobs` 配单测）+ `stores/island.ts` + `components/IslandPill.tsx`（TitleBar 挂载）。

- **顶栏布局 = grid 1fr auto 1fr 三段居中**：左 = 品牌 + 三组图标（2026-11-14 用户定案，每组三个、组分隔线分簇）：弹层组（浏览记录/收藏/布局预设）| 视图与捕获组（导航树/全盘搜索/截图）| 会话工具组（剪贴板/工作日历/定制）；中 = 岛严格水平居中；右 = 设置/关于 + 系统态（缩放/主题/语言）+ 窗口控制；段容器与段首/段尾弹性补白均带拖拽区（拖动窗口/双击最大化）。
- 空闲回落 = 活动窗格路径 pill（静态态 `pointer-events:none` 透传拖拽区，有选中带「已选 N 项」后缀）；**空闲态不做轮播**。
- 通道优先级（高→低）：任务 > 交换窗格模式 > 全盘搜索进行中 > 事件回执（全部 toast 路由至此，同文本去重，驻留 `DENSITY.islandReceiptMs`）> 剪贴板持有（纯指示不响应点击）> 路径；回执 1s 心跳驱动过期。

### 12.3 暂存区

**组件与模块**：Sidebar 下方 `.np-shelf` 卡（`data-shelf` 投放区）+ `settings.staging`（`lib/shelf.ts` 纯函数配 vitest）+ 菜单功能 shelfAdd。

- 边栏 = 透明沟槽容器：布局方案卡 `.np-side-card` 与暂存区卡两张独立卡片，中间 `.np-side-split` 横向把手上下拖动调比例（比例存 `settings.sideSplitRatio`，0.2–0.8 钳制）。
- `lib/shelf.ts`：路径大小写不敏感去重、上限 200 整条忽略、无扩展名≈文件夹的展示类型启发。
- 布局方案卡行操作 = 点击应用 / 拖动排序（workspaceOrder）/ 悬停重命名（`rename_workspace`：同名冲突拒绝不静默覆盖）/ 删除。
- 拖入 = `oleDispatch.handleDrop` 前置分流（命中 `[data-shelf]` 即入库返回，Explorer 拖入同管线）；OLE 悬停高亮 = 组件订阅 `useDnd` 坐标与自身矩形判定；拖出 = 行 mousedown 位移 ≥5px 触发 `api.startDrag`，落点语义由 `settings.stagingMode` 决定（移动=move+移出暂存【默认】/复制=copy+条目保留）；**暂存条目拖回暂存区 = 完全无操作**；`start_drag` Rust 端返回 `"drop"`（WebView2 网页落点不回写 effect 标志，据 hr 区分「已放置/取消」）。

### 12.4 界面语言

**组件与模块**：`lib/i18n.ts` 轻量 i18n。

- 中文源串为键、en 词典映射，未收录串回落中文（渐进接入）；语言存 `settings.lang`（zh/en），组件经 `useT()`/模块级 `t()` 取译文（支持 `{x}` 占位符）；切换钮 = 顶栏系统态区。
- 已覆盖：顶栏、边栏、内置功能标签（menuCommands label 走词典）、窗格工具提示复合串；列表状态栏/设置面板/各对话框按域补词典；按钮提示文本规范见 ui-standards §4.8（原生 title 已由自绘 np-tip 承载）。

### 12.5 应用内覆盖更新

**组件与模块**：Tauri 官方 `tauri-plugin-updater` + `tauri-plugin-process`（协议见 opensource.md）+ AboutDialog 一键更新钮 + build-release.ps1 latest.json 生成 + 重启看门狗。

- 流程 = 关于浮窗「发现新版本」区「一键更新（自动安装）」主操作：updater.check() 拉 `latest.json`（端点 = 仓库 raw 双源）→ 比对版本 → downloadAndInstall（进度事件 → 按钮内「下载中 N%」）→ 静默安装**同路径覆盖**（无卸载界面、settings.json/workspaces/clipboard.db 保留、任务栏固定图标存活）→ **自动重启**；latest.json 未发布时报错回落手动下载按钮（update.json 双源检查不变）。**Windows 重启口径（2026-11-15 排障定案）**：updater 插件 install 是「拉起安装器后 `std::process::exit(0)`」——应用当场退出，前端 `relaunch()` 与 `downloadAndInstall` 的 await 永远到不了；重启唯一正主 = NSIS 模板 `.onInstSuccess` 的 `/R` 自启（`nsis_tauri_utils::RunAsUser`），看门狗只是 /R 失败时的兜底。
- **签名链**：minisign 私钥 tools/keys/xdir_updater.key（gitignored 绝不入库；发布机经 build-release.ps1 注入 TAURI_SIGNING_PRIVATE_KEY）+ createUpdaterArtifacts=true（构建产出 `*-setup.exe.sig`）+ plugins.updater.pubkey 入库；**发布日动作**见 docs/release.md（latest.json 必须无 BOM——BOM 令 updater JSON 解析失败）。
- **安装包双击静默直通**：vendor NSIS 模板 `src-tauri/nsis/installer.nsi` 改动——① 升级/降级默认「不卸载直接安装」（覆盖）；② .onInit 升级检测 → 自重启 /S 静默实例（零界面，运行中旧版经 RestartManager 强制收尾）→ ExecWait 装完 → 自动启动 → 退出。**直通只许纯 GUI 运行触发**（2026-11-15 修正：旧条件只判 `${Silent}`，漏判了 updater 插件 Passive 模式 `/P /UPDATE /R /ARGS` 的调用——/R 被剥掉、注册表 InstallLocation 又带引号致 Exec 路径失效 → 曾致 v0.1.9→v0.2.0「更新成功但永不重开」；现条件 = 非静默且 `$PassiveMode != 1` 且 `$UpdateMode != 1`，读 InstallLocation 后剥引号再用）；**升级 tauri CLI 时需同步官方模板并保留这些改动**。
- **重启看门狗** `spawn_update_watchdog`：兜底路径——一键更新下载前由前端拉起分离 PowerShell（CREATE_NO_WINDOW，随父退出存活）：通配等安装器进程出现（钳 120s）→ 等退出（钳 240s）→ 落定后应用未运行则启动新版（插件 /R 自启成功时检测到实例即静默退出绝不多开）。**安装器进程名口径（2026-11-15 修正，旧口径从未命中过）**：插件把下载的安装器落 `%TEMP%\{产品名}-{版本}-updater-*\{产品名}-{版本}-installer.exe`（产品名 = tauri productName `X-Dir`），故匹配 `X-Dir-{版本}-installer*` + `X-Dir_{版本}_x64-setup*`（旧口径）+ `X-Dir-*-installer*`（通配）三重兜底；version 字段先过 ASCII 白名单防 PS 注入。全程写 `config/update-watchdog.log`（远程排障入口）。
- **全链路自测**：`tools/update-selftest.ps1`——本地 `--config` 覆盖构建旧版（0.2.1）/新版（0.2.2）双测试包 + `tools/selftest-update-server.mjs` 本地清单服务器（latest.json 指向 127.0.0.1）→ 静默装旧版 → `x-dir.exe --self-update-test` 走与一键更新完全相同的链路（`maybe_self_update_test`：check → 看门狗 → download_and_install）→ 断言旧进程退出、新版自动重启且 ProductVersion 正确；测毕静默恢复真机 v0.2.0。发版前回归「更新后自动重开」用。
- **更新完成感知**：`config/update-state.json` 记录上次运行版本（运行态，不随 export_config 导出），启动时变化即发 `app-updated` 事件 → 灵动岛回执「X-Dir 已更新到 vX（原 vY），配置全部保留」。

### 12.6 配置与工作区（持久化）

- 用户偏好统一存 `settings.json`（含侧边栏/列宽/导航树等 UI 偏好；**UI 偏好禁止再直写 localStorage**）；工作区 = `workspaces/*.json`。
- **是否展示文件夹的大小（2026-11-17 用户定案，两次迭代措辞+语义）**：设置 → 文件操作「是否展示文件夹的大小」（`settings.showFolderSize`，默认开；旧档 `folderSizePlaceholder` 由 load 同布尔迁移）。**开启 = 窗格列表异步计算并显示文件夹递归体积**：列表就绪后 `useDirSizes.request(parent)` 整批拉取直接子项体积（复用 `analyze::dir_sizes`，spawn_blocking + 单文件夹 20 万文件上限 best-effort），LRU 500 条缓存（`stores/dirSizes.ts`），到位前留空；导航/刷新（refreshTick）即重算，在飞去重防连发重复拉。**关闭 = 大小列留空**。全盘搜索/压缩包预览无逐项计算，开启显示「—」、关闭留空；FolderPreview 的「—」是递归体积未算出的槽位（不同语义，不受此开关管）。`lib/path.ts::normKey`（去尾反斜杠+小写，与 Rust norm_key 同语义）为缓存键单源。
- **导出** = 设置 →「配置」区：`export_config` 打包两者为单 JSON（version 字段供导入对齐）；**导入** = `import_config` 校验 app/version 后整体覆盖 settings.json 与 workspaces/*.json（前端热重载设置 + 事件刷新方案列表）；成功后广播 `config-imported` 事件——常驻剪贴板浮窗重读设置热同步主题/直接粘贴（浮窗是独立 WebView 不随主窗重载）。
- **不随导出**：剪贴板历史 = config/clipboard.db（SQLite 单独存储）、全盘索引 = config/index/（可重建缓存）、update-state.json（运行态）。
- **主窗 save_settings = 合并落盘并保留补丁键**：截图八键 + cliphistWinW/H 由轻量窗直写磁盘，主窗 store 启动后不重读——整对象覆盖会把它们回滚到启动旧值（settings 落盘另有 800ms 防抖 + pagehide 冲刷）。
- **开机自启（2026-11-15）**：设置 →「配置」页开关，`autostart_set` 命令经 tauri-plugin-autostart（MIT/Apache-2.0）写 Windows HKCU Run 键。**单一事实源 = settings.json `autostart` 字段**（随导出迁移），注册表是派生态：每次启动 `apply_autostart_pref` 幂等回放（手动删键/清理工具漂移自动拉齐），导入配置后前端显式重放；开关写注册表失败回滚 UI 并 toast。
- **打开配置保存位置（2026-11-15）**：设置 →「配置」页按钮，`open_config_folder` 命令 Rust 侧直调 opener 插件 `reveal_item_in_dir` 在资源管理器定位 settings.json（不经前端 JS 通道，无 ACL/权限面），返回路径供灵动岛回执。
- **选中布局方案持久化（2026-11-17 用户反馈「重启回到默认方案」定案）**：`settings.activeScheme`（string | null，null = 未选/显示回落内置默认方案）= 侧栏高亮与启动回退的单一事实源，Sidebar 不再有本地 `current` state（旧实现初始硬编码默认方案，重启永远高亮默认；且选中名悬空时「保存到当前方案」会把会话树误写进默认方案）。启动回退链定案：上次会话（restoreLastSession 开）→ 选中方案档 → 默认方案档 → 出厂 2×2——关闭「恢复上次会话」后重启回到用户选中的方案而非默认方案。方案列表刷新（含导入事件）时发现 activeScheme 指向的档已不存在即回落 null 防高亮悬空；Rust 侧 settings 为 Value 直通，新字段零后端改动。

### 12.7 工作日历

**组件与模块**：`components/CalendarPage.tsx`（整页 `np-menupage` 壳 + `np-cal-*` 类族）+ `components/WorklogExportDialog.tsx`（DialogSpec `worklogExport`）+ `lib/calendar.ts` 纯函数（月矩阵/副标题合并/导出构建/统计，配 vitest）+ `lib/holidays.ts`（班休数据）+ Rust `worklog.rs` + `commands/worklog_cmds.rs` 两命令。

- **定位与交互（2026-11-13 用户定案，design/calendar-plan.md）**：月视图工作日历——格子首行单行收纳 公历日（今日 accent 实心圆）+ 农历/节日副标题（法定与传统节日红 / 节气蓝 / 农历灰，`calendarShowLunar` 可关）+ 班休徽标（休红·班蓝）；其下条目摘要 ≤3 条，每条前置 3×11px 状态竖条（已完成 success 绿 / 执行中 accent 蓝 / 待办 muted 淡灰），已完成条目文字淡化（滴答清单惯例）。单击选中 → 右栏逐条编辑（三态 Seg + 自增高输入 + 悬停删除，输入自动保存 800ms 防抖 + 「已保存 HH:mm」）；**双击格子 / 悬停右下角 ＋ / Enter = 新增一条**；早于今天且未完成的条目右栏标红「已过期」（格子内不变色防泛红）。
- **状态模型**：一天多条 `{text, status: todo|doing|done}`，新建默认「已完成」；全部清空 = 删日（Rust 端空清单即删键 + status 白名单回落 done）。
- **数据链路**：`worklog_get_month(year, month)` 按月下发（铁律 3）/ `worklog_set_day(date, entries)` 单日 RMW（进程内互斥锁 + tmp+rename 原子写 + 坏档回落空档）；`config/worklog.json` 随 `export_config`/`import_config` 打包迁移（包内无 worklog 键则不动现有日志）；翻月/关页/卸载前冲刷未落盘修改。
- **数据源**：班休 = holiday-cn（MIT）2024–2027 打包 `lib/holidays.ts`（唯一事实源；次年安排 11 月发布后随发版刷新，papers 出处入文件头注释）；农历/节气/干支 = solarlunar（ISC，纯算法 1900–2100，ESM 仅默认导出 + 包缺 types 条件 → `src/solarlunar.d.ts` 收窄声明）；传统节日/公历纪念日常量表自算（不消费库节日字段，防双源冲突；闰月不庆、除夕按下一天为正月初一判定、初一显月名）。
- **导出**：三档范围（月度年月步进 / 年度 Seg / 自定义起止 `yyyy-MM-dd` 内联校验，倒置或非法禁主操作 + 红字）+ 统计面板五格（记录天数/条目数/已完成/执行中/待办，按需逐月拉取聚合）；`buildExport` 生成 Markdown（统计头 + 按日期升序逐日小节带节假日尾注 + 任务清单语法 `- [x]`/`- [ ]` + 状态词，无记录日不占篇幅）；原生保存框（默认名 `工作日志-{y}-{m}.md` 等）+ `save_text_file` 写出。
- **唤起与快捷键**：系统级热键（默认 Ctrl+Alt+D，`hotkeys_sync` 单点注册，回调 show+focus 主窗后 emit `calendar-open`，App.tsx 监听开页）；顶栏模式组日历钮（CalendarDays，开合态 + 键帽随设置）；设置「日历」分页（启用开关 + HotkeyRecorder + 农历开关 + 格子着色维度 + 数据说明）；整页互斥纳入 `openCalendar`/`exitPages`，Esc 关页（输入框先失焦）入 keyboard.ts 页面分支；页内键盘 ↑↓←→ 移格（跨月自动翻页）/ Enter 新增 / T 今天 / PgUp PgDn 翻月；shortcuts.ts「工作日历」组 + keyboard.test 覆盖对齐。
- **合规**：solarlunar 与 holiday-cn 已入 opensource.md §3.1 台账并随 `tools/gen-third-party-notices.mjs` 进 THIRD-PARTY-NOTICES（generator 的 BUNDLED_ASSETS 支持 licenseFile 缺省 = 许可证已收录附录）。

- **增强批（2026-11-13 用户「全做」定案）**：① **搜索**——页头搜索框（Rust `worklog_search`：大小写不敏感子串 + 纯 ASCII 查询走 `fs::search::pinyin_initials` 拼音首字母通道，可按分类过滤，命中上限 200），结果浮层列 日期+状态竖条+命中加粗，点击跳月选中，Esc 收起；② **任务分类**——`settings.calendarCategories`（id/名称/`--np-tag-*` 六色），条目挂可选 `category`（旧档缺字段自动未分类，零迁移），详情条目卡分类 NpSelect + 导出条目行 `[分类名] ` 前缀 + `calendarColorBy` 着色维度切换（按状态=绿蓝灰默认 / 按分类=tag 色，未分类回落灰）；③ **拖拽改期**——格子条目 HTML5 draggable（应用内不出窗），目标格 accent 描边高亮（is-drop），落格 = 源删目标加两条 `worklog_set_day`；④ **条目右键轻菜单**——三态标记 / 迁移到昨天·明天·下周同一天·指定日期（`useUi.openDialog` input + `parseKey` 校验）/ 删除，`useUi.openMenu` 基建；格子空白右键 = 添加工作 / 添加定期任务… / 粘贴；⑤ **键盘补全**——Ctrl-C 复制当日全部条目 / Ctrl-V 粘贴到选中日 / Delete 删除右栏选中条目（条目卡单击选中 is-sel 描边，输入控件聚焦时让位）；⑥ **本周小结一键复制**——导出对话框 footer ghost 钮，`weekRangeContaining` 周区间取数 → `buildExport` → `set_clipboard_text` 新命令进剪贴板；⑦ **定期任务（模板生成式）**——`settings.calendarRecurrence` 模板（weekly 多选星期 / workdays / monthly D 号月末钳制 / yearly M-D + `postponeHoliday` 命中法定休日顺延——班休数据驱动的中国日历正确性差异化），`dueDatesInRange` 纯函数配 vitest（闰年/钳制/顺延去重/倒置区间），保存即往后 90 天生成实例（`WorkEntry.gen` 模板溯源防重，删除即永久跳过，实例独立可改可删），规则引擎调用 `dayKind` work/on 实现工作日口径；模板管理驻日历页头部「定期任务」钮（2026-11-18 自设置「日历」分页迁入），格子右键「添加定期任务…」同入口（`recurrenceEdit` DialogSpec，编辑走 templateId 预载）；⑧ **导出 XLSX 档**——导出对话框格式 Seg（Markdown/Excel），`worklog_export_xlsx` 命令（rust_xlsxwriter 统计+明细两表，rows 为前端组装的中文展示串，路径校验同 save_text_file）；⑨ **年视图热力图**——页头 月/年 Seg，全年 12 月拉取，周列 × 7 行格密度五档（l0-l4 accent 派生 color-mix），悬停 N 条、点击跳月选中；⑩ **数据自动备份**——`rotate_if_changed`：内容变化落盘前 .bak.1←当前、逐级顺移保留 3 份（与 .bak.1 比对防重复 churn，cargo test 覆盖）。
- **连续滚动布局（2026-11-14 用户定案）**：月视图改月块纵向无限流——窗口（上限 15 块）随滚动双向扩展，头部 prepend 与裁剪经 `prevFirstRef`/`headCutRef` 在布局效应按块高补偿滚动位置（月块等高 = 栅格固定 84px 行高，是补偿的前提），焦点月（视口中心所在块）驱动页头标签；月份标题 sticky 吸顶（monthblock 禁 overflow:hidden——会破坏 sticky）；页头年月改按钮弹智能跳转面板（年份 ±4 网格 + 12 月网格 + 回到今天）， `jumpTo` 在窗内直接落位、窗外重置窗口经 `pendingScroll` 落位；选中日滚动 = 格子级可见性判断（centerDayCell：完整可见〔8px 内边距〕不动，不可见才居中滚入；依赖只挂 sel/view，扩窗不触发重判）——2026-11-14 用户反馈：点击日历底部的格子不得自动跳转置顶。落位统一矩形差值（getBoundingClientRect 相对滚动容器；offsetTop 在 offsetParent 非滚动容器时会随布局语境漂移 ~100px）。周末列收窄（工作日 1.25fr / 周末 0.75fr ≈ 62%，2026-11-14 用户定案：休息日任务少，宽度让给工作日）。分类即席创建（2026-11-14 用户反馈「分类支持自定义添加」）：条目卡与定期任务编辑的分类下拉末项「＋ 新建分类…」→ categoryNew 对话框（名称 + 六色点）→ 保存写入 settings.calendarCategories 并经 resolveDialog(新 id) 回传调用方直接选中（管理/改名/删除驻日历页头部「分类」钮弹窗，2026-11-18 自设置「日历」分页迁入）。
「今天」行为定案（2026-11-14，两次反馈收敛）：点击 = 滚到当前月块顶部（不做格子居中）；落位不依赖 sel 效应（sel 已是今天时 setSel 不变、效应不重跑 = 用户实测「点了没反应」），gotoToday/stepMonth 直接落位月块顶部；今天格子特殊样式已定案 = 方案 A「描边高亮」（整格 2px accent 描边 + 6% 底染，与选中态叠加时底染加深到 10%、描边保持 2px；周末 today 圆标白字显式规则；三方案对照预览 design/calendar-today-proposal.html 留档）。jumpTo 落位加固：目标月两侧余量不足（头 <2 / 尾 <3 块）时重置窗口 ±3 居中经 pendingScroll 落位，防落位后扩窗补偿打架。星期行吸顶（2026-11-14 用户定案）：紧贴月份标题下方（标题定高 28px、星期行 sticky top 28px 不透明底），滚动中星期对位始终可见。「月/年」Seg 保留：年 = 全年热力图。
- **增强批回归**：`verify-out/_e2e_calendar_enh.mjs`（本地件）——右键开定期对话框→保存→磁盘 gen 实例验证（每周一 90 天 13 天落位）、搜索命中跳月、右键迁移改期磁盘挪动，全通过；E2E 注意事项：React 受控输入须原型 setter 先清后设（value tracker 去重），ContextMenu 条目为 .np-ctx 叶子节点（非 button），外部改盘后须关-开页面强制重拉。
- **页头收纳梯度（2026-11-19 用户反馈「日历顶栏挤成两行」）**：头部内容总宽（~1100px：返回 95/标题 45/提示 284/导航簇 554）超容器时全体 flex 子项等比压窄 → 文本竖排（返回主界面/工作日历/今天/导出逐字换行）。根治 = `.np-menupage-head` 挂 `container-type: inline-size`（同顶栏 np-tb 范式）+ 四级 @container 收纳——**≤1200 收键盘提示文案**（np-cal-hint，tooltip 无损失）→ **≤1000 返回钮退化图标**（data-tip 保留；共用 menupage-head 的定制/全盘搜索页同享此退化）→ **≤860 搜索缩 190→130** → **≤760 收搜索**；导航簇（月/年·年月·今天·分类/定期图标·导出）任何宽度不收。配套全头部 `button { white-space: nowrap }` + 标题/年月钮 nowrap+flex:none 防竖排。⚠ 容器规则须带 `.np-menupage-head` 前缀压过文件后部基础规则（@container 块位置在前、同特异性时后者胜——首轮 860/760 两档因此未生效，CDP sweep 抓到）。CDP 六档宽度 sweep（1600/1280/1024/900/760 + 默认 1016）：全部零竖排。

### 12.8 性能模式（设置 → 性能，2026-11-17 用户定案）

**组件与模块**：`lib/perf.ts`（detectTier/integratedOnly/resolvePerf 纯函数 + PERF_PRESET/PERF_TABLE 配 vitest）+ `stores/settings.ts`（perfMode/perfTier/perfApplied/fxGlass/fxAnim 五字段 + applyPerfMode 预设应用 + applyPerfFx 根类切换）+ Rust `system_info.rs`（SystemInfo 增 cpu_threads + 新命令 is_remote_session）+ 设置新 tab「性能」。

- **低配置界定**：远程会话（`GetSystemMetrics(SM_REMOTESESSION)`）一票低配；否则硬件信号命中 ≥2 = 低配——CPU 逻辑线程 <4 / 物理内存 ≤8GB / 仅核显（独显关键词 NVIDIA·GeForce·RTX·GTX·Radeon RX·Pro·Arc 命中即非；空表 = 软件渲染已滤，保守按核显）。**判定只在首启做一次**（结果缓存 `perfTier`），模式解析 = perfMode 为 auto 取判定档否则显式档（`resolvePerf`）。
- **联动预设（切换模式真实写盘，高性能 = 出厂默认）**：真实图标 / 文件夹大小（递归计算 IO）/ 截图十字辅助线（全屏覆盖层）/ 剪贴板历史（常驻浮窗第二个 WebView 进程）/ 右键菜单毛玻璃 / 主题与浮层动画，六项低配全关。对比表在 性能 tab 以三列（设置项/高性能/低性能）呈现，表数据 = `PERF_TABLE` 单源。
- **应用机制**：App 启动检测（先于 hotkeys/cliphistConfigure，保证按应用后偏好配置服务）→ `applyPerfMode(resolved)` 与 `perfApplied` 不同才写预设（幂等，用户改回的项不会被启动循环改回去）；首次落低配发灵动岛回执提示可调整。毛玻璃/动效经 `applyPerfFx` 挂根类 `nofx-glass`/`nofx-anim`：玻璃实底脸与 @supports 兜底同款、主题揭示在 setThemeWithFx 直切（fxAnim 与 prefers-reduced-motion 同口径），功能性指示（进度扫动）保留。
- **检测失败的兜底**：system_info/is_remote_session 任一失败 = 保守按高性能档（默认值即高性能预设，不误降级）。

### 12.9 窗口毛玻璃（设置 → 外观，2026-11-17 用户定案 = 渐变底 + 窗格霜玻璃，纯 CSS）

- **背景图案：极光基座 + 自定义图片（2026-11-18 用户定案收敛；曾六案比选）**：设置 → 外观 →「背景图案」NpSelect——极光（默认基座）+ 自定义图片两项；云隙晨光 dawn / 几何构成 geo / 绸缎流波 silk / 点阵蓝图 blueprint / 暮山层影 mountain 五案同日删除（用户「颜色差异大」诉求下五案色相挤在蓝紫带内无辨识度；10 套高色差候选〔v5 现代精致版：低饱和灰调系中性锚底 + 水彩晕染随机碰撞，调色取代被否决的 v4 糖果高饱和，构图沿用 v4 不对称随机〕浅/深预览 design/glassbg-proposals-v5.html 待比选回灌，旧档值经 GLASS_BG_KEYS 守卫回落极光；曾为七选一，data-glassbg 切 `--np-bg` 图案块的机制不变）+ 自定义图片（`glassBgCustom` 存本机绝对路径，asset 协议 `convertFileSrc` 转 `--glassbg-img` 铺画布 + `glassBgVeil` 0-60 可调蒙版并入画布背景合成层〔浅白/深黑保可读性；body 与顶缘盖板成对规则，2026-11-19 根治重构见下〕；设置行行尾显示当前路径——`.np-set-path` 自动换行完整展示（word-break: break-all 适配无空格路径），未选择时灰字占位，2026-11-19 用户需求「自定义图片时在设置中显示路径」+ 同日两轮排版反馈定稿〔先省略号截断后改自动换行〕）；三字段 `settings.glassBg*` 经 `applyGlassBg` 统一下发（load/update 两挂载点）。2026-11-18 二次修订：删「极光绸带」（与基座极光/绸缎流波质感重叠，深色下尤甚）；深色画布浓度全员加强至与极光基座同级可见；每图案专属弹窗染色 `--np-dialog-glass`（消除深色下弹窗极光色相与主界面当前图案的不同调；新案回灌必须随案配置浅/深弹窗染色 + 深色卡片同 hue 霜面）。设计预览 design/glassbg-proposals-all.html（六案切换画廊 + 单案六文件，历史存档）。仅毛玻璃模式生效（rows 门禁 windowGlass === on）；图案为纯 CSS，无外部资源、离线可用。

**组件与模块**：`stores/settings.ts`（windowGlass off/on 字段 + `applyWindowGlass` 纯根类切换）+ `lib/ipc.ts`（Rust 侧 settings.json 为无类型 JSON blob，新字段免改 Rust）+ index.css `html.glasswin` 段（渐变画布 + backdrop-filter 卡片家族）。已试作并撤除 OS 路线（tauri windowEffects Mica/Acrylic + window-vibrancy 直连）：WebView2 子窗口合成下 DWM backdrop 不透出、调度层 `let _ =` 丢错误不可诊断、叠加能力权限门禁三重静默失效——用户真实设想是应用内渐变底 + 窗格模糊，纯 CSS 即可完整达成。

- **机制**：glasswin 根类下画布 `--np-bg` 换极光渐变（径向色斑 + 线性基底，深浅主题各一套），主卡片（顶栏 .np-titlebar / 窗格 .np-pane / 边栏三卡 .np-side-card·.np-navtree·.np-shelf）+ Dialog + 全部菜单（.bp6-menu）经 token 换 `--np-glass` 半透明底并挂 `backdrop-filter: blur(22px) saturate(1.4)` 实时模糊渐变底——backdrop-filter 只采样页内内容，渐变在页内所以有效，不依赖 OS 合成器；填充输入面 `--np-surface-2` 保持实底保证可读。
- **成本与兜底**：模糊对象 = 卡片背后的静态渐变，列表滚动不触发重模糊（合成层缓存，开销一次性）；性能 tab 低配预设强制 `windowGlass: "off"`（PERF_TABLE「窗口毛玻璃」行）；2026-11-18 用户定案「点击档位切换相应设置项」：两档对称切换——高性能档 `windowGlass: "on"`（背景图案为用户审美选择不随档重置），低性能档关，低配自动关对冲性能铁律。
- **细节坑**：`.np-winedge` 窗缘盖板原写法 `linear-gradient(var(--np-bg), var(--np-bg))` 在渐变值下非法（渐变不能作 color 停靠点），glasswin 下改涂渐变边缘近似实色（浅 #e8edf5 / 深 #14181f）。
- **二轮深度打磨（2026-11-17）**：画布换 Big Sur 风色板（浅：白云带/天空蓝/橙浪/珊瑚粉；深：navy/青蓝板岩/紫晕/绯红底，对照用户壁纸亮暗对应取色）；卡片玻璃配方升级（glass-ring 边 + glass-shadow 光晕投影、深色顶缘受光高光）；强霜层 Dialog 0.7（可读性优先）；门禁 = 仅高性能档可用（外观页低配档「开」钮禁用 + desc 提示，探测提为共享 usePerfDetect hook）；规范成文 ui-standards §4.10；窗缘盖板随新画布改 #f0e9ee/#1e2233。三轮（同日）：surface-2 玻璃子面化（地址 pill/缩放钮/chip/空态徽标，浅白 0.45/深白 0.07）+ .np-nav 玻璃条 + Popover 内容面/np-tip 入浮层强霜（修复自定义内容弹层半透明无模糊的文字穿透重叠）+ 地址双层面遮盖依赖修复（未聚焦输入文字转透明）。四轮（2026-11-18）：CDP 截图验收基建（WebView2 --remote-debugging-port + puppeteer-core --no-save 驱动真实窗口），定位并修复 Dialog 白板穿透（blur 下沉 body 滚动容器）；窗缘盖板改磨砂玻璃边框（blur 采样渐变边缘，消除实色条错色）；常驻卡片去外阴影（沟槽积灰）光晕只留浮层；**系统级窗口四角圆角**（DWMWCP_ROUND，主窗 + 剪贴板浮窗，shot 覆盖层排除，Win10 静默忽略）——修复四角直角不一致。
- **「顶栏白条」根治（2026-11-19 用户三度反馈后结构重构）**：顶缘盖板 `.np-winedge-top`（顶缘 ~2px 合成器毛刺覆盖物）与画布是两层独立绘制，靠克隆背景保像素一致——11-18 的 custom 模式独立克隆规则被 166aaeb 重写五案深色时连带删除（提交说明未提及），白条复发。根治 = custom 模式画布（蒙版 + 图片两层合成）改为 **body 与 `.np-winedge-top` 同一条规则逐字同源消费**（fixed 同视口坐标系 → 像素逐点一致，漂移结构性不可能），蒙版从 `body::before` 并入背景合成层；同批恢复 166aaeb 连带丢失的卡片 blur32 / 浅色白描边 / 中性弹窗染色，并把 ③④ 补上 body 直声明锚点（原版只挂 html，`--np-dialog-glass` 深色块挂 body 直声明压过继承，深色弹窗实际仍极光染色——双锚点陷阱又一实例）。新增审计测试 `winedgePair.test.ts`（第五条规范审计：glasswin 作用域 body 画布规则必须与盖板成对 + custom 克隆必须含图与蒙版浅深各一 + aurora 基座克隆在位；对修复前 HEAD 实测能抓 3 条违规）。

- **玻璃参数可调（2026-11-19 用户需求；同日追加二级弹层独立参数；再同日用户调定值固化为出厂默认）**：设置 → 外观新增**四滑条**（毛玻璃开启时显示，跟背景图案同组）——**模糊强度**（`glassBlur` 0-48px 默认 10）/ **霜面浓度**（`glassFrost` 20-80% 默认 40）作用主界面卡片家族；**弹层模糊**（`glassPopBlur` 0-64px 默认 20）/ **弹层浓度**（`glassPopFrost` 40-95% 默认 50）作用二级弹层（弹窗/菜单/气泡/下拉），与卡片解耦；蒙版默认同步 35→40。**默认口径**：参数化当日原档 22/55/40/78（菜单 blur 22/强霜 0.78），用户实机调轻透后（10/40/20/50 + veil 40）固化为 DEFAULT_SETTINGS 并四处同步 CSS 回落值（pre-load 首帧即用户定档）——`applyGlassParams` 四参内联下发 `--np-glass-blur`/`--np-glass-alpha`/`--np-glass-pop-blur`/`--np-glass-pop-alpha`，仅 glasswin 作用域消费：弹窗三载体模糊直接随、强霜浮层按 0.55 比例联动（默认档菜单 blur 11/强霜 0.5）；弹窗染色渐变各档 calc 系数缩放（rgba 斜杠语法，调回 0.78 即原档）；全部 backdrop-filter 8px 下限；surface-2/蒙版/窗缘盖板固定。custom 模式 blur32 定档退役（详见 ui-standards §4.10）；剪贴板浮窗 lastTune 四参同步（同 windowGlass 两取值路径模式）；load 钳制脏数据回落默认；性能预设不含（用户审美不随档重置，同 glassBg）。**功能库面板收编（同日用户反馈「右键菜单点击功能库以后的磨玻璃效果和二级弹窗不一致」）**：`np-palette` 旧版走 `--np-surface` 卡片霜面且无 blur——glasswin 下经 token 继承拿到半透明底即穿透病，且不带 glasswin 作用域的规则扫描抓不到此漏法；收编入强霜浮层家族随弹层两参数，家族成员资格由新增第六条规范审计 `frostFamily.test.ts` 锁定（AGENTS §6 五条→六条）。CDP 实机驱动真实滑条验证：弹层模糊 50%→32px（菜单 computed blur 17.6px = 32×0.55）、弹层浓度 60%→73%（菜单底 alpha 0.73、弹窗染色 0.796/0.67 = 0.73×custom 系数）、3px 时载体钳 8px 下限；功能库面板与右键菜单玻璃 computed 逐字段一致（blur(11px) + alpha 0.5，默认档）。

## 13. 横切改造记录（跨功能域批量改造，按时间倒序）

### 13.0 顶栏显示快捷面板（缩放/主题/语言/毛玻璃四钮合一）

**组件与模块**：`components/TitleBar.tsx`（合并钮 + PopoverNext 四行面板，交互完全复用弹层组 hoverEnter/hoverLeave/hoverProps 约定）+ `index.css` np-qs 面板族 + 设计预览 `design/quick-settings-popover-proposal.html`（图标选型交互稿，用户选定面具图标 lucide `VenetianMask`）。

- **三钮合一 + 新增项（2026-11-23 用户需求「缩放/主题/语言融合为一个功能图标，悬浮弹出界面直接设置，再增加磨玻璃开关」）**：顶栏右段退役 缩放胶囊(np-zoompill)/明暗切换钮(np-theme-btn)/语言钮(np-langbtn) 及其渐进收纳 CSS，改为单一「显示与外观」钮（data-tip 同名，np-pop-trigger 载体）+ 悬浮面板四行直设：① 界面缩放 = −/+ 步进（`zoomStep` 档位表与 Ctrl+滚轮同源）+ 点数值重置 100%；② 主题 = 浅色/深色/跟随系统三态 np-seg（`setThemeWithFx` 圆形揭示特效保留；比旧按钮多出显式「跟随系统」档）；③ 语言 = 中文/EN 二态 np-seg；④ **窗口毛玻璃 Switch**（新增直设入口）——回执与设置页逐字一致（镜像文案 §4.8）。全部控件与设置浮窗同一 store 双向同步（面板底 hint 注明）。
- **交互口径**：悬浮即开/离开宽限关闭/点击切换（与浏览记录/收藏夹/预设弹层完全同约定），`placement="bottom-end"` 右对齐防溢出；顶栏渐进收纳档随三钮退役更新（≤640 收关于钮、≤380 收快捷面板钮与 data-tb=sys）。
- **行为备注**：主题切换的 View Transition 圆形揭示期间指针边界事件可能令面板按宽限期自动收起——操作意图已完成，再悬停即重开，不做复杂化处理。

### 13.1 PDF/图片参数界面优化批

**组件与模块**：`pdf/mod.rs`（rotate_pdf_file + 六出口 available_name）+ `pdf/stamp.rs`（WmRange::Spec）+ `img/mod.rs`（WatermarkOpts rgb/pos + stamp_at_pos）+ 共享组件 `components/WmPosGrid.tsx`（位置九宫格双水印共用）+ `lib/dialogPrefs.ts`（sanitize/merge 纯函数配 vitest）。

- P1：PDF 旋转改旁写（原地覆盖退役）；旋转菜单三项收敛；水印对角线选中时字号/边距行禁用；Seg 支持逐项 disabled；旁写防覆盖统一 available_name (2) 递增（推广到全部 PDF 出口）；输出文案与模板对齐。
- P2：**对话框参数记忆** = `settings.dialogPrefs`（Record<对话框名, 参数子集>，确认时写回、打开时与内置默认浅合并，类型不符键回落默认防坏档；密码/路径类永不入存；**用户点名"某项为默认"的参数不持久化**）；水印页面范围加「自定义」档；压缩/转换质量加「自定义」档（滑杆 1–100）；图片水印补颜色 8 色板 + 九宫格位置 + 不透明度滑杆（IPC 双端同步）；字号/边距改自由输入 + 即时校验；工具对话框裸中文收编 t()。
- 未做（P3 待产品/依赖决策）：水印效果实时预览、PDF 重压缩档位、有损 WebP（需 webp crate）。

### 13.2 右键功能参数对话框规范全量对齐

**组件与模块**：共享组件 `components/FileQueue.tsx`（DragFileList + QueueSection，自 ToolsDialogs 抽出防循环依赖）+ ToolsDialogs/ImgDialogs + DialogSpec（xlsxMerge entries、filesMerge(flavor)、pdfPages(mode)）+ `lib/pdfOps.ts`（parsePageSpec/pagesToSpec 与 Rust parse_page_ranges 逐字对齐含错误文案）。

- 图片五件套/Excel 合并/通用合并（图片转 PDF、CSV、文本、zip 四口味）/PDF 提取删页全部对齐 ui-standards §4.9 三段式：清单置顶可拖动定序（处理顺序随清单）+ 内联校验（主操作 disabled + 红字，弃 alert）+ 输出预览；布局规范补三条定案入 ui-standards §4.9。

### 13.3 解除占用

**组件与模块**：Rust `locks.rs`（NtQuerySystemInformation 枚举全系统句柄表 + DuplicateHandle 远程关闭）+ `commands/locks_cmds.rs`（find/release async + spawn_blocking）+ `jobs/mod.rs` FailItem 增 `reason`（inUse/accessDenied/missing）+ 前端 `stores/jobs.ts` offerUnlock 收尾钩子 + UnlockDialog。

- 删除撞上占用：job-done 收尾发现 failed[].reason=inUse → 弹「解除占用」列出占用进程（Win32 无官方"谁开着这个文件"API，handle.exe 同款：句柄表枚举 + 按文件索引比对）；确认后远程关闭并按原语义（回收站/Shift+Del）重删。
- **弹窗覆盖主路径（2026-11-17 修复）**：offerUnlock 此前只挂在 register 的「done 先于 register 到达」补漏分支——小文件删除快于 invoke 往返才弹得出，大文件夹删除（done 晚到的主路径）永远不弹；job-done 监听器失败分支补挂 offerUnlock（info.mode=delete 时）。
- **实现坑**：探针句柄必须先于表快照开（借其在快照内自身条目取「文件」类型索引）；只碰 GetFileType=DISK 的句柄（"File" 类型涵盖命名管道/设备，挂未决读会永久阻塞）；病态句柄单次查询实测卡 33s——按 pid 分桶 + 并行 worker（≤8）+ 5s 预算截断，truncated 标记随结果下发、卡死线程不 join（有界泄漏，handle.exe 同款取舍）；本应用自身句柄排除；AppError 新运行时码 E_LOCKS。
- **权限类失败的人话归因 + 树内深探测（2026-11-17 用户反馈「需管理员权限才能删的文件夹提示不清晰」）**：① trash（IFileOperation + FOF_NO_UI）对顶层被拒回 Os 码可归因，但对**树内嵌套被拒**只回无语义 `Unknown{"Some operations were aborted"}`，顶层 DELETE 探测（句柄能开）随即失灵 → 用户直接看到英文调试串；永久删除 remove_dir_all 同场景虽归因正确却不知堵在哪个子项。② 定案 = `probe_delete_open`（探测泛化为返回原始 Win32 码）+ `probe_tree_denial` 树内深探测：顶层探测不出时逐项 DELETE 探测定位第一个被拒子项（深度优先、预算 500 条防超大树拖慢回执、跳过 reparse 防联接环），explain_trash/explain_permanent 双链路接入，回执形如「文件夹内的「sub\deeper\f.txt」需要管理员权限才能删除（拒绝访问），请以管理员身份重试或修改该项的安全权限」。③ 文案口径定案：Win32 5 = 「需要管理员权限才能删除」（不再说「没有删除权限」），32/33 = 占用、2/3 = 已消失保持不变；文案不带主语——顶层失败 toast 前缀自带文件名，树内失败由 explain_* 加「文件夹内的「子项」」前缀。④ 测试用 icacls `*S-1-1-0:(D)`（Everyone 拒绝删除，deny ACE 对含管理员的一切令牌生效 = allow-only 型 ACL 的同码模拟）真实落 ACL 锁行为：回收站嵌套被拒归因子项、永久删除归因子项、顶层被拒走无前缀管理员文案。

### 13.4 本体整体审查修复批（数据安全 / 性能 / 安全加固）

**范围**：`fs/*` / `jobs/mod.rs` / `commands/*` / `index/` / `stores/icons|settings|jobs` / FileList/Pane/NavTree。

- **数据安全批**（全部带回归测试）：7z zip-slip 修复（弃整包 decompress_file——sevenz-rust 内部裸 join 可被 `..\` 条目写穿，改逐条目落盘 + 同源净化）；解压总量硬闸 10GiB（条目尺寸可谎报，按实际解出字节计）；**复制引擎联接防护复活**（旧判定在 std 语义下恒 false 从未生效——junction 的 symlink_metadata().is_dir()=false，提升为共享工具 `fs::path::is_reparse_dir` 按原始属性 REPARSE_POINT+DIRECTORY 判定，复制/移动含联接树防无限递归；zip 打包对联接静默不入包）；同卷覆盖移动去预删（旧「先删目标再 rename」失败时文件凭空消失——std rename 自带原子替换）；PDF 旋转 temp+rename 原地保护；永久删除先清树内只读位；move 删源目录失败显式报出；内容搜索单文件根补 2MB 护栏。
- **性能批**：列目录热路径两阶段重构（needs_scan 判定 → 锁外 scan_dir → 锁内纯切片回调 + spawn_blocking——旧在全局缓存锁内做整目录扫描，所有窗格/任务排队等锁）；natural_cmp 栈缓冲（10 万条目录一次翻页 ≈340 万次堆分配 → 栈缓冲）+ 平局追加名称自然序；analyze 全域 N+1 消除（DirEntry 自带元数据，旧每文件开句柄）；任务线程 catch_unwind（panic 补发失败回执，防 job-done 永不发出）；cache 锁中毒归一（旧 14+ 处 .unwrap() 连环瘫痪）；前端：icons 负缓存投毒修复（成功路径也被拉黑成死局）+ flush 批次续排 + search-batch 引用守卫 + **Pane.tsx 条件 Hook 修复**（坏档 workspace 即 React 白屏）+ jobs lateDone 窗口收敛 + settings 落盘 800ms 防抖 + save_settings 合并落盘保留补丁键（见 12.6）。
- **安全加固批**：CSP 上线（script-src 'self' 关死 XSS 通道；worker-src blob 供 pdf.js；devCsp:null 保 HMR）；索引守护 UAC TOCTOU 收窄（副本与当前 exe SHA-256 比对不一致拒绝提权）；save_text_file 整路径逐段拒 `..`；AppError.code 补 E_TRASH/E_PDF/E_CANCELLED/E_JOB_FAILED 四个运行时码 + listDir extFilter 接线。
- **审查误报澄清**（实测证明）：junction 在 std 语义下 symlink_metadata().is_dir()=false——textops zip 打包与内容搜索两处「联接环」原判不成立（遍历从不进联接，仅复制引擎因 fs::metadata 跟随式才真实中招）。
