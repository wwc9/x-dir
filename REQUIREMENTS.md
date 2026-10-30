# X-Dir 文件管理器 · 需求与技术路线（v1.2）

> 2026-10 定稿 v1.0；v1.1 补全实现级技术细节（项目结构、IPC 协议、布局/焦点算法、长任务协议、配置便携化、交互规范、验收测量方法）；v1.2 按用户决策对齐 Q-Dir 布局：**导航/地址栏/视图切换/状态统计内嵌到每窗格**（v1.1 的"全局地址栏"方案废弃）。本文档是项目唯一需求源，可直接作为 AI 编码代理的输入。
> 建议同时维护一份 AGENTS.md（编码规范、目录约定），参考 Spacedrive 仓库的做法；应包含的要点见 §11.2。

## 1. 产品定位

- Windows 优先的轻量级文件管理器，产品形态对标并超越 Q-Dir（四窗格封顶）
- 核心差异点：**单窗口 + 不限数量窗格**（tmux 式自由分割）+ 现代化 UI
- 目标用户：普通办公/开发用户，包括配置较低的电脑（按 ≥4GB 内存设计）
- 绿色便携定位：不写注册表、免安装、配置随文件走

## 2. 产品形态（已定案的核心决策）

**单窗口 + N 窗格。** 不做多窗口模式。

理由（实测/估算依据）：
- WebView2 每个窗口需独立渲染进程（+40~70MB/窗口），10 窗口将达 500~900MB
- 单窗口内窗格成本仅 2~8MB/格，10 窗格总量控制在 200~350MB
- 窗格化同时是产品卖点（Q-Dir 哲学的延伸）

**修订（2026-10-24，随截图功能）：** 主界面保持单窗口不变；截图功能新增两类
**功能专用临时窗口**——全屏截图遮罩窗（label `shot`，会话结束即销毁）与贴图窗
（label `pin-*`，用户关闭即销毁，常驻数量由用户控制）。它们是系统级 UI（覆盖
屏幕 / 置顶悬浮），在主窗口内无法实现，且非文件浏览主链路，不计入多窗口内存
口径（按需创建、用完即毁）。

## 3. 功能需求

### 3.1 V1（MVP）

| 模块 | 需求 |
|---|---|
| 布局引擎 | 分割树数据结构（**行主序便签网格**：根 = 纵向分行，每行 = 横向分格，最多 3 行 × 每行 3 格）：任意窗格可横向/纵向分裂、可关闭（递归组合 = 任意混合布局）；分隔条宽 12px、悬停/拖拽以强调色轻染；**拖拽语义：行间分隔线调整相邻两行高度（全列共享同一行边界），列间分隔线仅调整本行内相邻两窗格宽度（每行列宽独立）**；网格与混合预设一键切换（1×1、2×1、1×2、3×1、1×3、1+2、2+1、2×2、2×3、3×3，可视化布局选择器）；切换预设按 DFS 顺序复用现有窗格路径 |
| 标签页 | 每窗格内多标签，新建/关闭/切换，标签记住路径；每标签独立前进/后退历史栈（运行时，不持久化） |
| 焦点模型 | 唯一活动窗格（导航栏染色高亮：accent 淡染 + 导航图标转 accent，窗格边框保持中性）；每窗格的导航栏/地址栏作用于自身；键盘快捷键、收藏夹与全局工具栏命令作用于活动窗格；Ctrl+数字 / Alt+方向键切换焦点（算法见 §6.3.3） |
| 文件操作 | 浏览、打开（默认程序）、复制、移动、重命名（就地编辑）、删除（进回收站，需确认）、新建文件夹/新建文本文件；长任务进度条 + 可取消；同名冲突处理（覆盖/跳过/保留两者，支持应用到全部） |
| 选择 | Ctrl 点选、Shift 范围选、Ctrl+A 全选；所有文件操作作用于选中集 |
| 文件列表 | 虚拟滚动（铁律 1）；排序（名称[自然排序]/大小/时间/类型，文件夹恒在前）；视图模式（列表/详细信息/图标）；扩展名过滤；隐藏文件开关 |
| 地址栏 | 每窗格一条（Q-Dir 式，§7.1）：上级/刷新 + 可编辑地址栏 + 视图切换下拉，均作用于本窗格（2026-10-11 精简：去掉后退/前进按钮，历史走地址栏右侧下拉，历史栈保留） |
| 收藏夹 | 全局工具栏"★收藏夹"下拉：已知文件夹 + 盘符 + 用户收藏，点击在活动窗格打开；布局方案（窗格组合）保存为"工作区"，一键恢复（§6.9） |
| 右键菜单 | 自定义菜单（复制/移动到其他窗格、重命名、删除、简版属性等），不做系统菜单；菜单项清单见 §7.3 |
| 拖拽 | 窗格间拖拽（高亮目标窗格）；暂不做拖出窗口到系统；语义见 §7.4 |
| 刷新 | F5 手动刷新活动窗格；文件操作完成后对涉及路径自动刷新；V1 无后台监控 |
| 状态条 | 每窗格底部一条：对象数、选中数/选中大小、本窗格所在卷可用空间（全局底部状态栏已移除，2026-10-11 用户决策；任务完成以 toast 提示；2026-10-13 补：左下角任务进度 pill `JobCenter`，可展开任务卡列表并逐任务取消） |

### 3.2 V2

- ~~文件夹缩略图（IShellItemImageFactory）+ 真实文件类型图标（SHGetFileInfo）~~（**已实现 2026-10-11**：32×32 PNG data URL 图标 + 96px 缩略图（仅图标视图），Rust 端 LRU 图标 512/缩略图 200，缩略图键含 mtime 自动失效；设置可关）
- ~~原生复制进度与冲突处理（IFileOperation）——替换 V1 自实现引擎~~（**已实现 2026-10-11**：`nativeFileOps` 开启时复制/移动走 IFileOperation（系统进度/冲突对话框，FOF_ALLOWUNDO），Perform 失败自动回退 V1 内置引擎；前端跳过自有冲突对话框）
- ~~目录监控自动刷新~~（**已实现 2026-10-10，提前落地**：notify + 路径引用计数 + 300ms 聚合/700ms 冷却，仅可见窗格挂 watcher，§6.8）
- ~~颜色标记、文件着色规则~~（**已实现 2026-10-11**：右键"颜色标记 ▸"六色手动标记（路径键控）+ 设置面板规则编辑器（`*.ext` 或名称子串 → 色），红橙黄绿蓝紫走 `--np-tag-*` token）
- ~~全局搜索（当前目录递归）~~（**已实现 2026-10-11**：`search_dir` Rust 端递归遍历（跳 reparse point，500 条封顶 + 30 万访问量截断），窗格导航栏搜索框 + Ctrl+F；结果列表含"位置"列）
- 全盘搜索（Everything 式，**已实现 2026-10-11**）：顶栏搜索按钮 / Ctrl+Shift+F 唤起居中搜索面板（虚拟列表，↑↓/Enter/右键），`search_all` 命令固定盘多线程并行遍历（每盘 4 worker 共享目录队列；结果 500 / 访问 400 万 / 15s 三重封顶 + 代际号取消过期扫描，跳 `$Recycle.Bin` 等）；名称匹配支持**拼音首字母与无声调全拼（含多音字 DP）**（Rust `pinyin` crate，纯 ASCII 字母查询才走拼音路径）；无索引轻量实现，真正的 Everything 级瞬时搜索需后续 NTFS MFT/USN 索引（另立条目）
- ~~标签跨窗格拖动、地址栏自动补全、文件系统系统剪贴板互通（CF_HDROP）~~（**已实现 2026-10-11**：标签可拖到其他窗格标签条/列表区（`moveTab` 纯函数）；地址栏聚焦时下拉文件系统子目录 + 历史/收藏前缀建议（↑↓ 选择、Tab 补全）；CF_HDROP 双向互通 + Preferred DropEffect（剪切语义），窗口聚焦时自动同步）
- 快速预览（Quick Look 式，**已实现 2026-10-13，M1 范围**）：选中条目按 **Space** 唤起非阻断式大浮层（`QuickPreviewHost`，np-dialog 承载），Esc/Space 关闭、↑↓ 在当前目录文件队列循环切换（选中态同步）、Enter 用默认程序打开；**文件夹 = 元信息卡（2026-10-15 补）**：直接子项数（list_dir total，快照缓存零额外 IO）+ 递归体积 best-effort（复用 dir_sizes 通道与护栏，异步补齐），Enter = 活动窗格进入该文件夹；支持图片（滚轮缩放/拖拽平移/双击复位）、视频音频（HTML5 media，asset protocol 直读）、文本/代码（Rust 端 BOM→UTF-8→GB18030 编码探测 + 2MB 截断）、Markdown（marked+DOMPurify）、字体（FontFace 字样）、**office 文本抽取**（docx/pptx 走 quick-xml 摘 `w:t`/`a:t`，xlsx/xls/xlsb/ods 走 calamine 读值，纯 Rust 零外部进程）；其余类型回落元信息卡。**PDF 已实现（2026-10-13，M2）**：pdf.js（Apache-2.0，`React.lazy` 独立分包 ~1.5MB）+ TanStack Virtual 虚拟化逐页 canvas 渲染（devicePixelRatio 高清，离屏任务 cancel，关闭即 destroy），asset protocol 直读；页数入 footer。类型路由纯函数 `lib/previewKind.ts`；`ListHandlers.getSnapshot()` 按需取列表快照（数据不留全局 store）；`assetProtocol` 启用（scope `**`）。**压缩包清单已实现（2026-10-13，M3）**：`preview_list_archive` 列取 zip/tar/tar.gz/tgz/7z 内容（不解压，500 条封顶 + total 全计；条目名解码 ASCII→UTF-8→GB18030，兜底国内 GBK 包），前端 `ArchivePreview` 虚拟行列表（条目类型图标 + 大小）；rar 不支持（unrar 许可证不合 §8）。**单文件压缩清单（gz/xz/bz2）**：gz 取 FNAME 头 + ISIZE 尾、xz 解析 Index varint 取解压后大小、bz2 仅内层名（格式不存大小）。**TIFF 已实现（2026-10-13）**：`preview_tiff_data_url` Rust `tiff` crate 解码（16MP 上限，RGB/Gray 转 RGBA）→ png 编码 data URL 走图片通道。**epub 已实现（2026-10-13）**：container.xml → OPF spine 逐章 XHTML 块级文本抽取（复用 zip + quick-xml 基建，200 章封顶）。avi 加入 video 试探（Chromium 部分编码可解，onError 兜底）。表格预览已升级虚拟网格（`SheetPreview`：CSS grid 列对齐 + 自适应列宽 + 行虚拟化 + 多 sheet 切换，`lib/sheetGrid.ts` 纯函数）。LibreOffice/Office/WPS→PDF 转换链为可选增强（未启用）

### 3.3 V3

- ~~系统右键菜单（IContextMenu）~~（**已实现 2026-10-11，双轨方案**）：默认仍为自绘菜单（视觉一致），**Shift+右键**或自绘菜单末项"更多系统选项"弹出系统原生菜单——含"打开方式"与全部第三方扩展动词；多选限同目录（Shell 数组绑定惯例）；空白处原生菜单未做（自绘已覆盖）
- ~~拖拽出窗口（OLE 拖拽源）~~（**已实现 2026-10-11，统一 OLE 管线**）：行拖拽改为 mousedown 阈值触发 Rust 端 `DoDragDrop`（IDataObject = CF_HDROP + Preferred DropEffect + IDropSource，**主线程 STA 发起**——跨线程会因键状态取不到而卡死），可拖到资源管理器/桌面/外部程序；**拖入与窗格间落点走 Tauri `onDragDropEvent`**（WebView2 原生拖放目标携带完整路径），前端按窗格命中分发（标签条 = 新标签打开文件夹、列表区 = transfer），窗内高亮由 ole-drag 状态驱动；同目录守护防自复制
- 双栏/多窗格间的文件对比（未做）
- 主题系统扩展、多语言（未做）

### 3.5 搜索增强与全盘索引（2026-10-12 定案并实现）

> 目标用户背景：财务审计场景需要在大目录（客户资料常 30 万+ 文件）里反复按名找文件，
> Everything 式秒搜是核心效率杠杆。

**A 遍历搜索增强（兜底通道，无权限要求）：**

- 查询语法（两引擎统一，`fs/matcher.rs`）：空格分隔多词 = AND；词含 `*` `?` 按通配符
  （**全名匹配**语义）；词含 `\` 或 `/` 按完整路径子串匹配（`/` 归一 `\`）；其余为大小写
  不敏感子串；纯 ASCII 字母词对含汉字名称做无声调全拼 + 拼音首字母匹配（沿用）
- `typeFilter: all|files|dirs`（"只搜文件夹"）
- **流式结果**：遍历命中经 `search-batch` 事件 ~100ms/批回吐，前端边扫边渲染（reqId 守卫）
- **取消机制**：reqId（每次搜索唯一递增号）注册表 + `cancel_search` 命令；发起新搜索
  / Esc / 关闭面板显式取消旧扫描（修复旧版"窗格搜索连打残留旧扫描"缺口）
- 封顶放宽：窗格遍历 30 万→100 万条目；全盘 deadline 15s→30s；maxResults 可调 500/2000/5000
- 全盘搜索范围 chips：全部磁盘（默认）/ 当前盘 / 含 U 盘（REMOVABLE 并入 roots 下发）
- 结果排序（名称/路径/修改时间，客户端）、名称子串高亮（accent 色）、搜索历史
  （settings.recentSearches，上限 20）

**B NTFS 名称索引（秒搜通道，`src-tauri/src/index/`）：**

- **架构 = 提权守护 + mmap 只读共享**：`X-Dir.exe --index-daemon`（同一 exe，不建 WebView）
  以管理员运行（设置面板开启"索引模式"时 `ShellExecuteExW runas` 拉起，**一次 UAC**），
  负责 MFT 初建（`FSCTL_ENUM_USN_DATA`，秒级）+ USN 日志增量（`FSCTL_READ_USN_JOURNAL`，
  500ms 轮询，CREATE/RENAME_NEW→upsert、DELETE/RENAME_OLD→remove，journal id 变化→全量重建）；
  主程序全程普通权限（拖放/删除等无 UIPI 影响），mmap 只读打开索引文件查询（读侧
  FILE_SHARE_DELETE，与守护"tmp+rename 原子覆盖"共存）
- **纯文件通信**（免服务/免注册表/免端口）：`config/index/daemon.json`（启用卷清单）、
  `status.json`（卷级条目数/lastSyncMs 回执，主程序按 5 分钟新鲜窗判定引擎选择）、
  `daemon.heartbeat`（每秒心跳 = 存活信号）、`daemon.stop`（停止请求）。守护死亡/索引过期
  → `search_all` 自动回退遍历通道并如实返回 `engine: "scan"`
- **落盘格式**（`{letter}.idx`）：header（magic/version/卷序列/journal id/nextUsn/根 FRN/盘符）
  + 条目数组（repr(C) 定长 40B：frn/parent_frn/双 arena 偏移长/flags，**按 frn 升序**——
  路径重建沿父 FRN 链二分上溯，删除/搬移无需修子引用）+ 名称双 arena（原文 + 小写，
  扫描只走小写 arena；`İ` 等一对多折叠用独立偏移）
- **扫描**（`index/scan.rs`）：多线程分块（≤8 worker）扫小写 arena；子串走 UTF-16 快路径；
  拼音通道仅对"纯 ASCII 查询 + 含汉字条目"（flags 位预筛）解码执行；通配符先字面头预筛；
  命中护栏 2 万（防高频词+路径词组合饿死）；终态对 ≤maxResults 条 `GetFileAttributesExW`
  补 size/mtime 构造 FileEntry。纯路径词查询不走索引（回退遍历）
- **引擎选择**：设置 `nameIndex.enabled` + 守护心跳存活（<10s）+ 所请求盘均有新鲜索引
  → 索引通道（返回 `engine: "index"`，状态条显示"索引 · N ms"）；否则遍历
- **NTFS 限定**：exFAT/FAT（U 盘常见）、ReFS 无 USN 日志 → 该卷不支持索引，恒走遍历
- 内存口径：索引默认关闭，350MB 硬验收基线不变；开启后主程序走 mmap（文件映射页可回收，
  私有内存几乎不涨），守护进程独立进程持有内存表（约 75B/条目 + FRN 哈希表）

### 3.6 截图与贴图（2026-10-24 定案并实现一期；滚动长截图为二期）

对标 QQ 截图 / PixPin 的常用子集，替代独立截图工具（用户 2026-10-24 需求）。

**选型调研结论（2026-10-24）**：无宽松协议的开源截图应用可整体嵌入——
Flameshot / ShareX / Ksnip 均 GPL-3.0（AGPL 系硬红线，§8 打回）；Snipaste /
PixPin 闭源；electron-screenshots（MIT）深度绑定 Electron API 无法用于 Tauri，
仅作交互设计蓝本；tauri-plugin-screenshots（MIT）能力为 xcap 子集（仅整屏/
整窗截图，无选区/标注，项目年轻）不引入；tui-image-editor / filerobot-image-editor
（MIT）为照片编辑器交互，非截图标注范式。**定案：截屏引擎用 xcap
（Apache-2.0，Rust，活跃维护），交互层（覆盖窗选区/标注/马赛克/贴图）自研。**

- **会话流程**：全局热键（tauri-plugin-global-shortcut，MIT/Apache-2.0，默认
  `Ctrl+Alt+A`，设置 → 截图可换/可关）→ xcap 定格光标所在显示器为临时 PNG
  （`%TEMP%/xdir_shot/`，窗销毁即清、启动清残留）→ Rust 建全屏无边框置顶
  覆盖窗（label `shot`，initialization_script 注入 `window.__BOOT__` 携带截图
  路径/显示器参数/可截窗口矩形）→ 前端 `shot/ShotOverlay` 渲染
- **选区**：拖拽框选 + 8 手柄调整 + 整体移动 + 智能窗口识别（Rust EnumWindows
  过滤可见/未最小化/非 cloaked/非工具窗/根窗口，前端命中高亮、点击整窗选中，
  内层小窗优先）；WASD/方向键微调（十字准星/拖拽态 = 移动真实光标
  （`shot_nudge_cursor` SetCursorPos）；已确认选区 = 平移选区框，标注随动；
  Shift = 10px 大步，2026-10-30 定案）；全链路物理像素（×scale 与 CSS 像素
  换算，多显示器/DPI 对齐）
- **标注**：矩形/椭圆/箭头（点击弹面板选头部：单线/实心三角/空心三角 ×
  线条：直线/虚线/曲线，2026-10-30 定案，同日二次定案 = 点击即弹不二次
  点击）/画笔·马克笔（合并一钮，点击弹面板选笔型，图标固定不随动）/
  文字（就地 textarea，IME 组合键豁免）/序号标记（step：选区内点按即落
  数字圆徽，同一截图会话自动递增 1,2,3…；撤销后数字回退复用；徽标配
  标注色 + 亮度反差文字，尺寸随线宽档，2026-10-30 定案）+ 8 色板 + 3 档
  粗细/字号；**滚轮编辑标记（2026-10-30 定案：悬停指哪调哪）**= 悬停
  标记上滚轮逐档调：线形线宽 / 文字字号 / 序号圈尺寸 / 马赛克格 /
  模糊不透明度（新维度 alpha 15%~100%，部分透明毛玻璃弱化），HUD 显示
  当前值；**滚轮记忆（2026-10-30 二次定案）**= 调节值会话内立即成为该
  类型新图形默认并防抖持久化到 settings.json（shotStrokeW/shotTextFont/
  shotStepW/shotMosaicW/shotBlurAlpha 五键，下次会话沿用；宽度模型从
  三档索引改逐类型连续值，预设档不持久化、模糊半径仍走预设档）；**悬停标记显示 accent 虚线选中框**（包围盒随标记类型描边
  感知，调节后即时跟随新尺寸；落标即选中），**HUD 锚定选区内部中上方**
  （2026-10-30 二次定案）；撤销改快照栈模型（编辑回退不整删图形，
  连滚 600ms 合一阵）；撤销/重做（Ctrl+Z/Y 键盘保留；工具栏只留撤销
  钮，重做钮已去）；
  关闭钮红色常显；标注条按钮提示统一展示在按钮上方（data-tip-up）；
  马赛克/模糊 = 对合成画布
  （composite：底图+标注按序压平）区域像素化/ctx.filter blur，后画糊先画
- **完成动作**：复制（tauri-plugin-clipboard-manager 写位图）/ 保存（原生保存
  对话框，默认名 `截图_yyyymmdd_hhmmss.png`）/ 贴图（label `pin-*` 置顶无边框
  小窗：四周默认透明阴影（悬浮感，2026-10-30 定案；图像区仍与选区逐像素
  对齐，阴影在窗口外扩余量内渲染）、拖动移动、滚轮缩放、Alt+滚轮不透明度、
  双击/Esc 关、右键菜单可复制/保存/关闭（2026-10-30 修：右键关闭失效 =
  菜单内点击被 pointerdown 吞；贴图 = 精确选区内容与落位，阴影/边框装饰
  不进贴图）；
  Ctrl+P 快捷键同点贴图钮，2026-10-30 补；贴图建窗在专用线程执行——主循环
  路径上建窗与 WebView2 握手互等永挂的实机事故在案；**贴图时序定案
  （2026-10-30 闪动修复）= 蒙层在场盖住建窗期**：贴图窗 show 后发 pin-shown
  事件，前端收到（或 2.5s 兜底）才收蒙层——贴图原地顶替选区、遮罩随后
  退场，消除「整屏遮罩闪没 + 贴图迟到半秒」的双重闪动；蒙层在场与
  专用线程建窗无死锁冲突（E2E 复验））；
  贴图拖动定案（2026-10-30 三轮手感修复终案）= Rust 线程 6ms 轮询系统光标
  直接驱动窗口移动（与 WebView 事件/IPC 解耦，松开左键自动收场），JS 只发
  会话起止两条命令；贴图视觉定案（2026-10-30 参考图二次，覆盖初版 accent
  描边方案）= 无可见描边（1px 0.06 淡边）+ 8px 圆角 + 双层柔和阴影
  （0 2px 6px 10% + 0 12px 40px 14%，余量 pad 36css 承载）；贴图右上角关闭钮（三次定案，弃四钮条）= 悬停浮现
  圆形半透明黑底白 X 单钮（图像区右上角内侧 8px），离开退场，不抢拖拽
  **标记增强大批（2026-10-30 定案）**：样式 = 矩形/椭圆空心↔半透明
  实心 + 虚线扩展 + 矩形圆角（滑条/Shift+滚轮）+ 箭头双向 + 文字高亮
  底色/粗斜体 + 序号徽标三形（圆/方/纯数字）+ 马赛克·模糊圆形区域
  （样式会话级不持久化，各工具钮点击即弹样式面板）；交互 = 已落标记
  拖动移位 / Alt+拖动克隆 / Del 删除 / 1-8 换色 / 双击文字再编辑 /
  Shift 绘制约束（正方形·正圆·45°）/ 拖拽实时尺寸 HUD / Z 序置前
  置后 / 悬停标记右键菜单（右键空白仍立即退出）；按住 Tab = 隐藏全部标注看原图、
  松开恢复（仅显示层，导出仍含）；选区确认后在遮罩黑色区域四角避让展示
  快捷键清单浮层（半透明黑底 + 键帽两列；四角全被选区占住则不展示）；
  标注条行 2 行尾三钮定案（2026-10-30）= 保存 → 关闭 → 复制并关闭；
  Esc/右键逐层取消（文字→标注→拖拽→工具→选区→关闭）；Enter/双击=复制并关闭
- **设置**：`shotEnabled`（默认开）+ `shotHotkey`（预设 5 键位）；设置页「截图」
  分页含「立即试一次」入口（shot_begin 命令，即热键同款会话）
- **二期排期（2026-10-24 对标 Snow Shot 定案）**：Snow Shot（github.com/mg-chao/
  snow-shot，4.8k star，Tauri + React 同栈，Tauri 生态最成熟的完整截图应用）
  功能面 = 一期核心子集 + 滚动截图/延时/活动窗口/OCR/翻译/AI/录屏；其许可为
  GPL-3.0 +「非商业」Apache + 商业授权三层混合且无逐文件 SPDX 标注，代码不可
  移植（§8 红线），仅作功能与交互对标（看行为不读实现）。按价值/成本分三批：
  - **A 批（小项打包，一期架构内参数化，无新依赖，实现时同步 §6.9 schema
    `shotDelaySecs` / `shotHotkeyWindow`）**：
    ① 延时截图——`shot_begin` 加 `delaySecs`（设置页「截图」分页加「延时秒数」
    0/3/5/10 默认 0，Rust spawn 内 sleep 后定格，供截下拉菜单/悬停提示）
    ② 活动窗口模式——第二全局热键 `shotHotkeyWindow`（默认 `Ctrl+Alt+W`，预设
    可换、清空即停用，随 `shotEnabled` 总开关）：触发即定格前台窗口（
    GetForegroundWindow 匹配已枚举窗口），选区自动取该矩形免拖选，Esc 仍回
    自由框选
    ③ 贴图穿透——贴图窗 Alt+单击切换鼠标穿透（set_ignore_cursor_events），
    穿透态四边虚线提示
  - **B 批（主项，2026-10-24 实现；2026-10-28 改手动滚轮模式）滚动长截图**：
    用户滚轮下滚持续截图、上滚不动（交互参考 Snow Shot；竖向模板匹配拼接仍为
    ShareX 思路自研，不读 GPL 实现）。定案流程：框选滚动区 → 点工具栏「滚动
    截图」→ 覆盖窗隐藏、弹控制浮条窗（label `shot-scroll`）→ WH_MOUSE_LL 低级
    鼠标钩子监听用户滚轮（钩子回调只写静态标记即刻返回；只响应光标在选区内的
    滚轮——滚轮经 Win10+ 悬停滚动落到光标下目标窗）→ Rust 循环线程〔滚动进行中
    每 ≥150ms 流式增量捕获（帧间行程小必在匹配域内）+ 停歇 ≥240ms 收尾帧
    → capture_region 实时捕获 → prev 下部 1/3 高的双窄竖条
    （左右 1/4 处，规避开居中 sticky header）灰度 SAD 搜索求有符号位移 dy →
    dy≥2（下滚）追加 cur 底部新内容；dy≤-2（上滚回看）只重定基准不追加〕→
    下滚后 dy 连续 3 帧为 0（到底）/ 浮条「完成」/ 高度上限 20000px / 动态内容
    连续 2 帧匹配失败（诚实截断，结果窗顶部提示）收尾 → 长图存临时盘、开独立
    结果窗（label `shot-result`：等比显示区内滚动 + 复制/保存/贴图/关闭，不回
    覆盖窗标注流程——长图标注低频，与 PixPin 一致）；贴图 = 复制专属副本走
    pin 窗、初始按 80% 屏幅适配（PinBoot.zoom，ZOOM_MIN 放宽 0.02）。匹配/拼接
    纯逻辑带 cargo test（正/负位移求解/到底/动态拒绝/缓冲追加）。启动两段式
    （begin 校验装钩收场 / launch 延时建浮条）——蒙层未离屏即建窗实测卡死；
    收尾浮条用 destroy；5 分钟无活动自动收场。已知限制：依赖 Win10+ 悬停滚动
    默认开启；不含固定栏自动检测与视差修复
  - **C 批（中项，可与 B 并行）OCR 文字识别**：Windows.Media.Ocr（Win10+ 系统
    组件，零新依赖、无分发协议问题，windows crate 开 Media_Ocr feature）；
    shot 工具栏加「识别文字」→ 选区合成图喂 OcrEngine → 文本写剪贴板 + toast。
    中文识别质量以实测验收；不引入 Tesseract（GPL 红线）与 PaddleOCR（体积
    不可接受）
  - 不做：翻译 / AI 对话（偏离文件管理器定位且依赖在线服务）；GIF/录屏（xcap
    VideoRecorder 仅出帧，编码选型复杂，远期另议）；取色器、量尺（未在需求内）

### 3.4 V1 明确不做（防范围蔓延）

- 多窗口；拖出窗口到系统（OLE 拖拽源）
- 系统右键菜单、真实图标、缩略图（V1 用内置通用 SVG 图标，§7.5）
- 目录监控自动刷新、全局搜索
- 网络位置（UNC、映射盘）、FTP —— V1 仅本地 FIXED / REMOVABLE / CDROM 盘
- 压缩包浏览、回收站查看/还原、永久删除（Shift+Del）、文件预览面板
- 标签跨窗格拖动、窗格拖拽重排
- 多语言（文案集中在一个常量文件，为 V3 i18n 预留）
- 自动更新、代码签名

## 4. 非功能需求（验收标准）

### 4.1 验收标准与测量方法

| 指标 | 标准 | 测量方法 |
|---|---|---|
| 内存（硬性验收） | 10 窗格 × 每格 ≥1 万文件目录，空转 1 分钟总内存 < **350MB**；单窗格 < 250MB | 任务管理器"详细信息"页 **专用工作集** 列；测试目录由 `tools/gen-test-tree.ps1` 生成（10 × 1.2 万真实小文件）；静置 60s 读数，3 次取中位数 |
| 磁盘体积 | 发布产物 < 15MB（单 exe/单目录） | release 便携 zip 字节数 |
| 便携性 | 不写注册表；配置存 exe 旁 JSON；WebView2 用户数据目录指向程序本地目录 | 全功能回归前后对比注册表快照；ProcMon 确认 exe 目录（及降级目录）外无写入 |
| 冷启动 | < 2 秒（SSD） | 60fps 录屏逐帧计数（双击 exe → 首屏目录渲染完成）；Rust 侧启动各阶段时间戳写日志辅助定位 |
| 兼容性 | Windows 10 1607+（WebView2 依赖，目标机需已装或允许引导安装） | Win10 21H2 / Win11 各跑一轮冒烟；100%、150% DPI 下无错位 |

### 4.2 内存预算分解（350MB 的构成假设）

| 项 | 预算 |
|---|---|
| WebView2 进程组基础（浏览器进程组） | 90~140MB |
| 前端 JS 堆（React + Zustand + 可见行 DOM + 各窗格分页窗口） | ≤ 60MB |
| Rust 常驻（含 10 × 1 万条目录快照缓存，约 4MB/格） | ≤ 60MB |
| 其他（日志缓冲、分配碎片） | ≤ 20MB |

M0 原型必须逐项验证该分解；若 WebView2 基础 > 140MB 或总数超标，触发 §9 切换预案。

### 4.3 性能三条铁律（任何 PR 不得违反）

1. **文件列表必须虚拟滚动**：DOM 只保留可见行，禁止全量渲染
2. **缩略图缓存设上限**（约 200 张，LRU 淘汰），只对可见窗格生成，离屏即释放
3. **watcher 与数据只挂可见窗格**：前端不囤全量文件元数据，大目录分页向 Rust 查询

工程含义：目录扫描、排序、过滤、自然排序、冲突判定**全部在 Rust 端完成后分页下发**；前端 store 不持有整目录元数据，只持有当前分页窗口（§6.4）。

## 5. 技术栈（已定案）

| 层 | 选型 |
|---|---|
| 应用框架 | Tauri 2.x（WebView2 渲染，MSVC 工具链） |
| 前端 | React 18+（脚手架当前为 19）+ TypeScript + Vite + Tailwind CSS 4 |
| UI 组件库 | **Blueprint.js v6**（Apache-2.0，2026-10-10 定案）：Dialog/Menu/Popover/Toast/Button/InputGroup 等；虚拟列表与窗格分割仍自研（理由见 AGENTS.md §4.2） |
| 图标 | **lucide-react**（MIT，2026-10-10 定案）：经 `components/AppIcon.tsx` 统一封装，文件类型映射集中 `src/lib/fileIcons.ts`（规范见 AGENTS.md §4.5） |
| 设计 Token | `np-*` CSS 变量（src/index.css 唯一取值来源，对齐 Blueprint 色板）；组件禁止硬编码颜色/密度，规范见 AGENTS.md §4 |
| 状态管理 | Zustand（轻量） |
| 虚拟列表 | TanStack Virtual（固定行高模式） |
| 布局分割 | react-resizable-panels：`PanelGroup`/`Panel` 与 §6.3.1 分割树节点一一对应，只负责尺寸分配与拖动交互；数据源仍是自研 layoutTree.ts 纯函数；**禁用其 autoSaveId 持久化**（持久化走工作区 JSON，§6.9） |
| Rust 依赖 | serde / serde_json、trash（回收站）、notify（目录监控，V2）、windows（Win32 基础 API；COM 集成留 V2+）、tauri-plugin-opener（默认程序打开）、tauri-plugin-log |
| 可选 | tauri-specta：由 Rust 类型自动生成 TS 绑定，避免双端手写漂移（建议启用） |

## 6. 架构与技术设计

### 6.1 数据流

```
React UI ──invoke──▶ Rust command ──▶ 文件系统 / Win32 API
   ▲                                        │
   └──────────事件推送（进度/目录变更）────────┘
```

原则：**计算尽量下沉 Rust**（扫描/排序/过滤/冲突判定），前端只做渲染与交互；Rust → 前端只有"查询应答 + 事件推送"两类通道。

### 6.2 项目结构

```
x-dir/
├─ src/                      # 前端（React + TS）
│  ├─ components/            # Pane / TabBar / AddressBar / FileList / Dialog / ContextMenu ...
│  ├─ stores/                # zustand：layout.ts / focus.ts / clipboard.ts / jobs.ts / settings.ts
│  ├─ lib/
│  │  ├─ ipc.ts              # invoke 封装 + 与 Rust 一一对应的类型（或 tauri-specta 生成）
│  │  ├─ layoutTree.ts       # 分割树纯函数操作（split/close/setRatio/预设/DFS 遍历）
│  │  └─ format.ts           # 大小/时间/类型描述格式化
│  └─ styles/
├─ src-tauri/
│  ├─ src/
│  │  ├─ main.rs             # 入口：先设 WEBVIEW2_USER_DATA_FOLDER，再构建 Builder
│  │  ├─ commands/           # 每个 command 一个模块（统一注册）
│  │  ├─ fs/                 # 目录快照缓存、分页、排序、路径规整、长路径
│  │  ├─ jobs/               # 任务队列、进度事件、取消
│  │  └─ watch/              # V2 目录监控
│  ├─ capabilities/default.json
│  ├─ tauri.conf.json
│  └─ icons/
├─ tools/gen-test-tree.ps1   # 生成压测目录（10 × 1.2 万真实小文件）
├─ AGENTS.md
└─ REQUIREMENTS.md
```

### 6.3 前端状态模型（布局 / 焦点 / 标签）

#### 6.3.1 分割树

```ts
// 分割树：叶节点=窗格，内部节点=分割
type LayoutNode =
  | { type: 'pane'; id: string; tabs: Tab[]; activeTab: number }
  | { type: 'split'; dir: 'horizontal' | 'vertical'; ratio: number;
      children: LayoutNode[] };

type Tab = { id: string; path: string };
```

- `split.dir` 为分割方向：`horizontal` = 左右两栏，`vertical` = 上下两栏；split 节点携带 `id`（渲染 key 与 sizes 写回目标），可选 `sizes: number[]` 记录各子项百分比（react-resizable-panels 的 Layout 回写）
- 全部操作实现为 `layoutTree.ts` **纯函数**（旧树入、新树出，可单测）：
  - `splitPane(tree, paneId, dir)`：叶节点原位替换为 `{type:'split', dir, ratio:0.5, children:[原窗格, 新窗格]}`；新窗格继承原窗格当前路径
  - `closePane(tree, paneId)`：从父 split 移除该叶；父仅剩 1 个 child 时用该 child 替换父节点（树折叠）；根为唯一窗格时禁止关闭
  - `setRatio(tree, splitPath, ratio)`：拖动分隔条按"位移像素 / 父容器尺寸"换算；钳制 0.15~0.85；双击分隔条复位 0.5
  - `applyPreset(tree, preset)`：预设集 = 行主序便签网格（`ROW_SPECS`：每行窗格数，最多 3 行 × 3 格，含混合行 "1+2" / "2+1"）；重建为"根纵向分行 + 每行横向分格"的分割树，行边界天然全列共享（无需对齐同步）；按 DFS 序收集切换前各叶首标签的路径依次填入新叶，不足补"此电脑"页，多余丢弃
  - 渲染顺序 = 树的 DFS 序；Ctrl+1..9 即 DFS 序编号；序列化即工作区格式（§6.9）
- 渲染映射（选型 react-resizable-panels，§5）：`split` → `PanelGroup direction`，`pane` → `Panel`（`minSize=15, maxSize=85` 即 0.15~0.85 钳制，分隔条 `onDoubleClick` 复位 50%）；`onLayout` 防抖回写 ratio 到树；预设切换重建整树并更换 `PanelGroup` key 强制重挂载（全格均分）；持久化不经过库，统一走工作区 JSON

#### 6.3.2 标签页与历史

- Tab 打开时 `history=[path], historyIndex=0`；前进/后退/路径跳转均入栈（跳转截断前进栈）；历史栈仅存运行时，不持久化
- 标签标题 = 路径末段（盘符根显示卷标）；工作区仅持久化 `tabs[].path` 与 `activeTab`

#### 6.3.3 焦点模型

- `activePaneId` 全局唯一；窗格内 mousedown 即聚焦；活动窗格导航栏染色（2026-10-11 定案，见 design/pane-active-preview.html 方案 2）
- Alt+方向键按**屏幕矩形最近邻**切换：列表组件挂载/布局变更时记录各窗格 `getBoundingClientRect()`。以 Alt+→ 为例：候选 = 左边缘 ≥ 当前右边缘的窗格，取（垂直中心距离 + 水平间距）最小者；其余方向对称；无候选则不动

### 6.4 IPC 协议与核心类型

约定：
- serde `rename_all = "camelCase"`；TS 类型集中在 `src/lib/ipc.ts` 手工镜像（启用 tauri-specta 则自动生成），**禁止只改一端**
- command 统一返回 `Result<T, AppError>`；批量操作不中断，失败项进 `failed[]`
- 事件名 kebab-case：`job-progress` / `job-done`（V2 增 `dir-changed`）

```ts
type FileEntry = {
  name: string;            // 含扩展名
  path: string;            // 绝对路径，不含 \\?\ 前缀
  isDir: boolean;
  size: number;            // 字节；目录恒 0（V1 不计算目录大小）
  mtimeMs: number;         // 修改时间，Unix 毫秒
  attrs: { hidden: boolean; system: boolean; readonly: boolean };
};

type Sort = { key: 'name' | 'size' | 'mtime' | 'type'; dir: 'asc' | 'desc' };

type AppError = { code:
    'E_IO' | 'E_PERM' | 'E_NOT_FOUND' | 'E_EXISTS' | 'E_BUSY'
  | 'E_INVALID_NAME' | 'E_CANCELLED' | 'E_UNSUPPORTED' | 'E_UNKNOWN';
  message: string };

type DriveInfo = { letter: string; label: string;
  driveType: 'fixed' | 'removable' | 'cdrom';
  totalBytes: number; freeBytes: number };
```

**分页与快照协议**（铁律 1/3 的落地方式）：

1. `list_dir(path, sort, extFilter?, showHidden, offset, limit)` 首次调用触发 Rust 扫描，建立该路径**目录快照**（全量 `Vec<FileEntry>`），随即按参数排序，返回 `{ total, entries }`
2. 快照按 `path` 缓存复用：翻页、改排序、改过滤只对快照重排/切片，**不重扫盘**；1 万条排序 < 5ms（名称用 `StrCmpLogicalW` 自然排序，文件夹恒在前）
3. 快照容量上限 20 个，LRU 淘汰；F5、任务完成、（V2）watcher 事件使对应快照失效重扫
4. 前端每窗格仅保留已取回的分页窗口（TanStack Virtual 按需拉取，`limit = 500`）；固定行高（详细信息/列表 28px、图标单元 96px），不做动态测高

### 6.5 Command API 清单（V1 全量）

| Command | 签名要点 | 说明 |
|---|---|---|
| `list_dir` | `(path, sort, extFilter?, nameFilter?, showHidden, offset, limit)` | 分页列目录，返回 `{total, entries}`（§6.4）；nameFilter = 视图内过滤（名称/拼音首字母子串、多词 AND，2026-10-15） |
| `search_dir` | `(path, query, maxResults?, typeFilter?, reqId?)` | **V2 已实现 + 2026-10-12 增强**：递归搜索当前目录，多词 AND/通配符/路径词/类型过滤，`search-batch` 流式回吐，reqId 可取消；返回 `{entries, truncated, scanned}` |
| `search_all` | `(query, maxResults?, roots?, typeFilter?, reqId?)` | **已实现 + 增强**：索引模式可用走 NTFS 索引（`engine:"index"`，毫秒级），否则固定盘并行遍历（`engine:"scan"`，流式）；roots 省略 = 全部固定盘 |
| `cancel_search` | `(reqId)` | **2026-10-12 新增**：取消指定在途搜索 |
| `index_status` / `enable_index_mode` / `disable_index_mode` | — | **2026-10-12 新增**：索引守护状态 / UAC 拉起守护 / 写停止文件 |
| `suggest_paths` | `(input, limit?)` | **V2 已实现**：地址栏补全，父目录 + 末段前缀切分 |
| `check_conflicts` | `(sources[], destDir)` | 返回 `[{sourceName, existingEntry}]`，大小写折叠判定（§6.11），驱动冲突对话框 |
| `copy_items` / `move_items` | `(sources[], destDir, policy, native?)` | `policy: 'overwrite' \| 'skip' \| 'rename'`；`native=true` 走 IFileOperation（V2）；入队返回 `{jobId}` |
| `delete_items` | `(paths[])` | 逐项进回收站（trash crate），入队返回 `{jobId}`，进度按文件数 |
| `cancel_job` | `(jobId)` | 置取消标志（§6.7） |
| `rename_item` | `(path, newName)` | 非法名校验 + 大小写折叠冲突判定（§6.11），失败 `E_INVALID_NAME`/`E_EXISTS` |
| `create_dir` / `create_file` | `(parentDir, name)` | create_file 固定新建空文本文件 |
| `open_item` | `(path)` | tauri-plugin-opener；无关联程序 → `E_UNSUPPORTED` |
| `get_drives` | `()` | GetLogicalDrives + 卷标/类型/容量 |
| `get_volume` | `(path)` | 单卷 `freeBytes/totalBytes`（状态栏） |
| `get_known_folder` | `(id)` | `desktop\|documents\|downloads\|pictures\|music\|videos` |
| `set_clipboard_files` / `get_clipboard_files` / `clear_clipboard` | — | **V2 已实现**：CF_HDROP + Preferred DropEffect 互通（§3.2） |
| `get_file_icons` | `(paths[])` | **V2 已实现**：批量真实图标（PNG data URL，Rust 端 LRU 512）。`get_thumbnails` 已随图标视图删除（2026-10-13） |
| `preview_read_text` | `(path, maxBytes)` | **2026-10-13 新增（快速预览）**：编码探测（BOM→UTF-8→GB18030）读文本，前 8KB 含 NUL 判二进制；返回 `{content, truncated, encoding, binary}` |
| `preview_extract_office` | `(path)` | **2026-10-13 新增（快速预览）**：docx/pptx（quick-xml 摘文本）与 xlsx/xls/xlsb/ods（calamine 读值）文本抽取，分节返回 `{kind, sections, truncated}`；100MB 体积封顶 |
| `preview_list_archive` | `(path)` | **2026-10-13 新增（快速预览 M3）**：zip/tar/tar.gz/tgz/7z 内容清单（不解压），返回 `{total, entries[{name,size,isDir}], truncated}`；500 条封顶；条目名 ASCII→UTF-8→GB18030 解码 |
| `preview_tiff_data_url` | `(path)` | **2026-10-13 新增（快速预览）**：TIFF 解码（tiff crate，16MP 上限）转 PNG data URL，供图片预览通道直显 |
| `get_settings` / `save_settings` | `()` / `(json)` | settings.json 读写（§6.9） |
| `list_workspaces` / `load_workspace` / `save_workspace` / `delete_workspace` | `(name?, tree?)` | 工作区 JSON 文件管理（§6.9） |
| `watch_dir` / `unwatch_dir` | — | **已实现**（原计划 V2，2026-10-10 提前落地，见 §6.8） |

### 6.6 事件清单

| 事件 | payload | 节流 |
|---|---|---|
| `job-progress` | `{jobId, phase: 'preparing'\|'running', totalFiles, doneFiles, totalBytes, doneBytes, currentPath}` | 100ms 聚合一次 |
| `job-done` | `{jobId, ok, cancelled, failed: [{path, message}]}` | 终态必发 |
| `dir-changed`（V2） | `{path}` | 500ms 防抖聚合，仅作脏标记 |
| `search-batch`（2026-10-12） | `{reqId, entries: FileEntry[], scanned}` | ~100ms / 单批 256 条封顶，仅遍历通道 |

### 6.7 长任务（复制/移动/删除）协议

- **任务队列**：全局串行（1 个执行 + N 排队），避免 HDD 争用；排队中即可取消；执行体跑在 `spawn_blocking`，不阻塞 async runtime
- **取消**：`JobManager { map: HashMap<jobId, Arc<AtomicBool>> }`，逐文件粒度检查；已开始的单个文件不中断，取消最迟作用于下一文件；取消也是终态，发 `job-done { cancelled: true }`
- **复制**：`std::fs::copy`（内部 CopyFileExW）；**移动**：同卷 `fs::rename` 瞬时完成（`totalBytes=0`，进度直接 100%），跨卷 = 逐文件复制 + 删除源，失败项进 `failed[]`，不回滚已成功项；**删除**：逐项 `trash::delete`，按文件数报进度
- 完成后前端刷新目标窗格（移动/删除还需刷新源窗格），并使相关路径的快照失效
- **冲突流程**：粘贴/拖放 → `check_conflicts` → 有冲突弹对话框（列出冲突项；选项：覆盖 / 跳过 / 保留两者 `name (2).ext`，另有"应用到全部"）→ 带 policy 入队；V1 的 policy 作用于全部冲突项，逐项选择留 V2

### 6.8 目录监控（V2 接口预留）

- 仅可见窗格挂 watcher（铁律 3）：`watch_dir/unwatch_dir` 与窗格可见性生命周期绑定（标签切换/关闭即卸载）
- notify 事件 500ms 防抖聚合后推 `dir-changed { path }`；前端收到后使快照失效并重拉当前页
- 事件只作"脏标记"，不携带元数据；防抖窗口内多次变更合并为一次刷新

### 6.9 配置与工作区（便携化）

exe 旁目录布局（基于 `std::env::current_exe()` 解析）：

```
X-Dir.exe
config/
  settings.json
  workspaces/          # default.json、"上次会话.json"
logs/                  # tauri-plugin-log，滚动 5MB × 3
WebView2/              # WebView2 用户数据目录
```

- `main()` 第一行 `std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", <exe_dir>/WebView2)`，必须先于 WebView2 环境创建
- exe 目录不可写（如被放入只读位置）→ 整体降级 `%APPDATA%\x-dir\`，并 toast 提示一次；代码统一走"配置根目录"抽象，不散落判断
- `settings.json` schema：

```json
{
  "theme": "system",
  "showHidden": false,
  "defaultView": "details",
  "defaultSort": { "key": "name", "dir": "asc" },
  "confirmDelete": true,
  "restoreLastSession": true,
  "favorites": [ { "name": "项目", "path": "D:\\Code" } ],
  "realIcons": true,
  "thumbnails": true,
  "nativeFileOps": true,
  "colorTags": { "D:\\Code": "blue" },
  "colorRules": [ { "pattern": "*.zip", "color": "orange" } ],
  "recentSearches": [ "预算表", "凭证" ],
  "nameIndex": { "enabled": false },
  "shotEnabled": true,
  "shotHotkey": "Ctrl+Alt+A"
}
```

V2 项（2026-10-11，缩略图开关已随图标视图删除 2026-10-13）：真实图标/原生文件操作开关 + 颜色标记与着色规则（色键 = `--np-tag-*` token 六色）。`recentSearches` / `nameIndex` 为 2026-10-12 搜索增强新增（全盘搜索历史上限 20；索引模式默认关闭，不影响 350MB 验收基线）。

- 工作区文件 = `{ name, tree }`，`tree` 即分割树序列化（Tab 仅存 `path`）
- 退出时自动写"上次会话"（临时文件 + rename 原子替换）；启动且 `restoreLastSession` 为 true 时恢复
- 允许多开；配置最后写入者胜，不做实例锁

### 6.10 错误处理与日志

- `AppError.code` 由 `io::ErrorKind` 映射（NotFound→E_NOT_FOUND、PermissionDenied→E_PERM、AlreadyExists→E_EXISTS…），message 保留原始 OS 错误文本
- 前端统一 toast（右下角，5s 自动消失，同屏最多 3 条）；地址栏路径不存在时输入框同步标红
- 日志：tauri-plugin-log，release=info / dev=debug；自定义 panic hook 落盘（附版本号与 Windows 版本）

### 6.11 路径与兼容性边界

- 长路径：Rust 端统一入口对 >240 字符的路径自动加 `\\?\` 前缀（已有则跳过）；UI 显示与持久化一律不含前缀
- 非法名：`< > : " / \ | ? *`、结尾空格或点、保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）；新建/重命名前端预校验 + Rust 兜底 `E_INVALID_NAME`
- 大小写不敏感；同名冲突判定先做大小写折叠比较
- 符号链接/junction：作为普通条目展示，不跟随、不递归
- "此电脑"是前端虚拟页（渲染 `get_drives()` 结果），无对应真实路径；`C:\` 的上级仍是自身（工具栏"上级"按钮置灰）
- 盘符根规范为带反斜杠的 `C:\`；路径拼接统一走工具函数，防双反斜杠

### 6.12 打包与发布

- `tauri.conf.json` 要点：`productName: "X-Dir"`、`identifier: "com.xdir.app"`（发布后不可更改）、主窗口 1280×800 / 最小 800×500、`decorations: false`（自绘顶栏，§7.1；capabilities 需授予窗口控制权限）、`bundle.targets: ["nsis"]`（NSIS 仅备用分发，主推便携 zip）、`webviewInstallMode: "downloadBootstrapper"`（目标机缺 WebView2 时在线引导）
- 发布产物：`X-Dir_v{ver}_portable.zip`（内含单个 exe，前端资源已嵌入）；不做代码签名（V1），README 说明 SmartScreen 首次运行提示的放行方法
- 版本号 semver；不做自动更新

## 7. UI 与交互规范

> 样式实现受 AGENTS.md §4 组件标准规范约束：全部颜色/密度走 `np-*` 设计 token（src/index.css），弹层类组件用 Blueprint.js，禁止硬编码。本节只定义交互与布局语义，不定义取值。

### 7.1 窗口布局分区（2026-10-11 改版：自绘顶栏 + 左侧方案边栏）

参考 Q-Dir：**导航、地址栏、视图切换、状态统计全部内嵌到每窗格**，N 个窗格各自独立；全局只保留**一行自绘顶栏**、左侧布局方案边栏和一条状态栏，多窗格时顶部/底部不膨胀。去系统标题栏（`decorations: false`），顶栏 = 工具栏 + 拖拽区 + 窗口控制合为一行；顶栏/边栏/窗格统一为浮于画布的圆角卡片，沟槽分隔。

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏(自绘) ▣ X-Dir │ 布局▾ 新建▾ ★ ⚙ │ [ 活动路径 ]  [─][□][×]│
├─────────┬────────────────────────────────────────────────────┤
│ 布局方案 │ 窗格区（活动窗格导航栏染色；下为每个窗格的构成）      │
│ 边栏     │ ┌─ 窗格 ────────────────────────────────────────┐  │
│ [＋保存] │ │ 导航栏  ◀ ▶ ▲ ⟳ │ [▼ E:\Code______] │ 视图▾    │  │
│ 方案列表 │ │ 标签条  [Code ×][tmp ×][+]                      │  │
│ (点切)   │ │ 列表头/列表体/窗格状态条 ……                      │  │
│         │ └────────────────────────────────────────────────┘  │
└─────────┴────────────────────────────────────────────────────┘
```

- 自绘顶栏（TitleBar.tsx）：左端 logo + 产品名 + 全局命令（导航树开关/浏览记录/收藏夹/全盘搜索/设置）；中部为拖拽区（显示活动窗格路径 pill，双击最大化/还原，空隙可拖动窗口）；右端缩放 pill（点击重置 100%）+ 布局预设 + 明暗切换 + 最小化/最大化/关闭（关闭悬停转 danger 色）。窗口控制走 `@tauri-apps/api/window`（capabilities 已授权 minimize/toggle-maximize/close/start-dragging）
- 左侧边栏（Sidebar.tsx）：布局方案列表，**首项为内置"默认方案"**（回到出厂 2×2 此电脑布局，不可删除、名字不可覆盖）；其余为用户保存的工作区，每卡片两行：第一行方案名，左侧 28×28 正方形"田字式"线性缩略图——按分割树递归渲染（accent 底从缝隙透出作线，格面实色），忠实还原任意布局（均匀网格/混合行/奇数格/深嵌套），名称在缩略图右侧，点击即整体切换，悬停 × 删除；"上次会话"为自动保存的会话，**不显示**在列表。边栏宽 140~340px 可拖拽（右缘手柄骑沟槽，悬停/拖拽浮现强调色分隔线，2026-10-12 修复把手被 overflow 裁切而不可用的问题），可折叠成 52px 窄条（宽度/折叠状态存 settings.json）；标题行 = "布局方案" + 右端保存/另存/折叠三钮（2026-10-12 自独立按钮行并入，与导航树标题行同构对齐）。原全局工具栏的"工作区▾"菜单由边栏取代
- 每窗格导航栏仅作用于本窗格：后退/前进/上级/刷新；地址栏为可编辑 combobox（Enter 前往、Esc 还原、▼ 下拉本标签历史；"此电脑"页显示中文名而非哨兵串；自动补全 V2）；右端为视图切换单按钮（显示当前模式图标，点击循环 列表→详细信息→图标）与"在终端打开"按钮（SquareTerminal 图标；shell 由设置项 `terminal` 决定 = powershell（默认）| cmd，2026-10-12：Rust 优先 `wt -d`（cmd 档追加 `cmd` 命令行），未装 Windows Terminal 回退 conhost 经典控制台并按档起 `powershell -NoExit` / `cmd`；此电脑页禁用）
- 窗格无独立标题栏（Q-Dir 式）：窗格身份 = 导航栏地址 + 标签条；分裂/关闭窗格按钮放导航栏最右端，悬停窗格时显示
- 顶栏全局命令（2026-10-12 定稿）：设置（2026-10-14 起为整页视图：占满顶栏以下区域替换侧栏+窗格区，`useUi.settingsTab` 驱动，头部左侧「← 返回主界面」钮、Esc 关闭——输入框内先失焦；原居中 Dialog 弹窗废除）、布局预设（右端缩放 pill 旁，弹层为 16 宫格预设选择器，自边栏移入）与明暗切换（按当前生效主题在浅/深间二态翻转，"跟随系统"档仍从设置面板选）为全局命令；收藏夹等点击作用于**活动窗格**（收藏夹收进"★"下拉：已知文件夹 + 盘符 + 用户收藏）
- 列表头常驻每窗格列表顶部，即排序入口（§7.5）；窗格状态条常驻每窗格底部，左端为窗格序号（2026-10-14 改纯文本井号编号「#N ·」——布局树 DFS 序、1 起、随分裂/关闭重排，活动窗格数字转强调色；原数字牌徽标因行内对齐残差废除）；窗口无全局底栏（2026-10-11 移除，任务完成以 toast 提示）
- 交换窗格（2026-10-12）：导航栏 ArrowLeftRight 钮，点击进入选择模式（其余窗格显强调色虚线环 + toast 提示），点目标窗格后互换两窗格内容（lib/layoutTree.swapPanes 纯函数：仅互换 tabs/activeTab，id 与几何不动，焦点留在发起方）；Esc / 再点源窗格取消；窄档收进"更多"菜单
- 效率增强（2026-10-15）：**地址栏面包屑**——非聚焦态为可点击层级段（超 5 段中段省略保留盘符+末 3 段，点层级段跳转、点空白进入编辑，:focus-within 隐藏覆盖层）；**标签右键菜单**——复制标签（同路径原位插入并激活）/ 关闭标签 / 关闭其他 / 关闭右侧；**中键新标签**——列表行与导航树节点中键 = 文件夹在活动窗格新标签打开（顺带拦中键自动滚动）；**新标签继承路径**——Ctrl+T / 标签条 + 缺省打开本窗格当前路径（无标签回落此电脑），分裂窗格同语义；**视图过滤条**——标签条与列表之间的窄带（仅过滤态渲染，Rust 端 nameFilter 收窄 + 实时匹配数 + 退出钮），递归搜索打开期间让位；**选择记忆**——导航离开目录时快照选中集与锚点，回到该目录自动恢复（设置 → 浏览"记忆目录选中集"开关，默认开；显式清空后离开 = 记忆一并清除；单标签上限 50 目录，selMemory 不持久化）；**type-ahead 回显**——输入缓冲与命中条目在列表右上角 pill 展示（Esc/停顿超时消失）；**目标窗格**——`layout.paneTargets` 会话级记忆（源窗格 → 上次传输对侧），Ctrl+Shift+C/X 直达

### 7.2 快捷键总表（2026-10-13 与实现全量对齐）

> 快捷键的展示清单单一来源 = `src/lib/shortcuts.ts`（设置面板「快捷键」页渲染），
> 与 `lib/__tests__/keyboard.test.ts` 双向对齐（清单漏测/孤儿覆盖均判失败）。

| 键 | 作用 |
|---|---|
| Ctrl+1..9 | 聚焦第 N 窗格（DFS 序） |
| Alt+↑↓←→ | 焦点移至该方向最近窗格 |
| Ctrl+Shift+H / Ctrl+Shift+V | 活动窗格横向 / 纵向分裂 |
| Ctrl+Shift+W | 关闭活动窗格（经关闭确认） |
| Ctrl+T / Ctrl+W | 新建 / 关闭当前标签 |
| Ctrl+Tab / Ctrl+Shift+Tab | 标签右移 / 左移（活动窗格内） |
| F5 | 刷新活动窗格 |
| F3 | 循环切换视图（详细信息 ↔ 列表） |
| Alt+D | 聚焦活动窗格的地址栏 |
| Ctrl+F | 搜索当前文件夹（递归；Esc 关闭） |
| Ctrl+E | 视图内过滤当前文件夹（名称/拼音首字母子串、多词 AND，Rust 端 nameFilter；Esc 退出还原；导航进新目录自动还原；"此电脑"页不响应） |
| Ctrl+Shift+F | 全盘搜索（地址栏等输入状态下也可唤起） |
| ↑↓←→ / PgUp PgDn / Home End | 移动选择 / 翻页 / 首尾（配合 Shift 为范围选） |
| Enter | 打开（文件夹进入 / 文件默认程序打开） |
| Backspace | 上级目录 |
| F2 | 就地重命名 |
| Delete | 删除到回收站（`confirmDelete` 时弹确认） |
| Ctrl+Z | 撤销上一步操作：回收站删除还原 / 重命名改回 / 应用内移动移回 / 新建移入回收站（2026-10-13 补，lib/undo 栈式 LIFO，上限 50） |
| Ctrl+Y / Ctrl+Shift+Z | 重做：按原方向再执行刚撤销的操作并压回撤销栈（可往复；新操作入撤销栈即清空重做分支，2026-10-15 补） |
| Ctrl+Alt+A | 截图（2026-10-24 新增，**系统级**热键 = Rust global-shortcut 路由，不经 onGlobalKeyDown；设置 → 截图可换键位/关闭；键位见上） |
| Shift+Delete | 永久删除（绕过回收站，强制 danger 确认；2026-10-13 补） |
| Alt+Enter | 属性（2026-10-13 补） |
| Shift+F10 / Menu 键 | 键盘呼出选中项右键菜单（2026-10-13 补） |
| Ctrl+C / Ctrl+X / Ctrl+V | 应用内剪贴板：复制 / 剪切 / 粘贴到活动窗格 |
| Ctrl+Shift+C / Ctrl+Shift+X | 复制 / 移动选中项到"目标窗格"（每窗格记忆上次选过的对侧，未记忆 = DFS 序首个其他窗格；右键"复制/移动到窗格 ▸"点选即记忆；目标在"此电脑"页提示无效） |
| Ctrl+A | 全选 |
| A-Z / 0-9 直接输入 | 首字母跳转：按文件名前缀选中下一项（循环），连续输入累积缓冲，停顿 1s 重置（2026-10-13 补）；中文文件名按**拼音首字母**匹配——Rust 随列表条目下发 `py` 匹配串（名称小写、汉字取首选读音首字母，多音字取第一读音，如「forge请下这个txt文件」敲 `qxzg` 命中；不含汉字不下发，前端回落名称前缀，2026-10-15 补） |
| Ctrl+Shift+N | 新建文件夹 |
| Ctrl+=/−/0 | 界面缩放：放大 / 缩小 / 重置 100%（Ctrl+滚轮同效） |
| Esc | 分层取消：右键菜单 → （对话框/全盘搜索由面板自理）→ 快速预览 → 交换窗格模式 → 窗格内搜索 → 视图过滤 → 清空选择（任何 Esc 路径顺带清 type-ahead 缓冲与回显 pill） |
| Space | 快速预览开关（Quick Look 式浮层；开着时 ↑↓ 切换文件、Enter 默认程序打开、Esc/Space 关闭） |
| Enter(地址栏) / Esc(地址栏) | 前往 / 还原并失焦 |
| 鼠标 X1 / X2 侧键 | 活动标签历史后退 / 前进（尽力捕获：WebView2 在个别版本先行吞键则无操作；2026-10-15 补） |

> 有意不做：Alt+↑ 上级（与"焦点移至上方窗格"冲突，Backspace 已覆盖）；Ctrl+D 删除
> （Delete 已覆盖，避免书签类语义混淆）；Ctrl+Y/Ctrl+Shift+Z 重做（撤销已覆盖四类可逆
> 操作，重做待真实需求再排期）。待排期：导航树方向键巡航。

### 7.3 右键菜单（V1 全部项）

- **右键菜单可编辑（2026-10-13 重构，对齐 Commander One 交互；2026-10-14 起在「定制」页整页编辑）**：
  菜单 = settings.menuEntries 有序条目清单（内置功能 / 分割线），顶栏拼图钮或菜单尾项
  「编辑菜单…」打开双栏编辑器——左栏启用列表（拖拽排序、× 移除、条目展开条件编辑）、
  右栏功能库（内置功能分组 + 分割线，搜索过滤，仅拖拽添加——点击不入场）、清空 +
  **重置为预设**（2026-10-14 补：MENU_PRESETS 五套预设——出厂默认 / 精简 / 双窗格协作 /
  开发者 / PDF 处理；确认后覆盖当前布局；同一内置功能全布局唯一，
  id = `builtin:<key>`）。
  每个条目可自定义出现条件（2026-10-14 定案与工具栏统一「启用时机」三档语义，
  np-seg 分段快选编辑）：**启用时机 = 总是 / 选中时 / 未选中时**（总是 = 两语境都
  出现，仍受功能能力位 supportsSel/supportsBlank 收窄；未选中时 = 仅空白处右键；
  选中时 = 仅选中条目右键）、
  对象类型（全部 / 仅文件 / 仅文件夹）、选中数量（预设：任意 / 恰好 1 项 / 多选 ≥2 /
  自定义——自定义才露出上下限两个下拉）、扩展名白名单（非空时选中须为匹配扩展名的文件，
  **不区分大小写**，失焦自动归一小写；仅对象类型 =「仅文件」时可配置）。条件编辑
  均为锚定条目的浮层分段快选，不推移布局；编辑器底部以 condSentence 纯函数实时回显条件含义（「右键选中条目或空白处
  显示 · 仅文件 · 至少 2 项 · 类型 pdf（不区分大小写）」）。
  旧档自动迁移：出厂布局；自定义命令条目随命令模板下线一并剔除（2026-10-14 定案）。

- **PDF 处理区（2026-10-13 补，lopdf/MIT 纯 Rust）**：选中集全为 PDF 文件时渲染——
  "PDF 合并（N 项）…"（≥2，按选中顺序合成一份，输入对话框命名、同名覆盖）、
  "PDF 拆分为单页…"（恰 1 个，确认页数后每页一个 PDF 存入 `<名称>_分页` 子文件夹）、
  "PDF 加水印…"（≥1，文字深灰 45° 半透明居中，运行时读系统字体栅格化后以带 SMask 的
  Image XObject 叠加，旁写 `<名称>_水印.pdf` 不覆盖原文件）、
  **页级编辑（2026-10-14 补）**："PDF 提取页/删除页…"（页码范围表达式 `1-3,5,8-`，
  均旁写新文件 `<名称>_提取/_删页.pdf`）、"PDF 旋转 ▸"（±90/180/270 全部页相对旋转，
  原地保存可逆向还原）、"PDF 轻压缩"（对象去重 + 对象流化重存，旁写 `*_压缩.pdf`）；
  "图片合并为 PDF…"（PNG/JPEG 按选中序每图一页，RGB8 FlateDecode，输入对话框命名）。
  全部入任务引擎（逐文件/逐页进度 + 取消），页码解析/页选择纯函数带 cargo test

- **办公批处理区（2026-10-14 补）**：
  **转为 PDF**——doc/docx/xls/xlsx/ppt/pptx/rtf 选中时渲染，PowerShell 派发 COM 转换
  （Microsoft Office 优先、WPS ProgID 回退；转换引擎不打包——AGPL 系硬红线），
  逐文件进度、旁写 `<stem>.pdf`，未装 Office/WPS 时任务失败项给出明确提示；
  **清理隐私属性**——OOXML 容器重打包抹除 docProps（作者/最后修改者/标题/主题/关键词/
  描述/修订号/创建修改时间/公司/管理器），旁写 `*_清洁.ext`；**导出文本 TXT**——复用
  预览抽取管线（docx/pptx/xlsx/xls/ods/epub），旁写 `<stem>.txt`（已存在自动改名）；
  **编码转换**——csv/tsv/txt/md/log 旁写 `_<后缀>.ext`（UTF-8 BOM/UTF-8/GBK，探测复用
  预览管线）；**CSV 合并**——同表头自动去重（表头不同的整文件按数据行保留，交用户
  审核）、输出 UTF-8 BOM；**文本合并**——按选中序全文拼接空行分隔；**压缩为 zip**——
  文件平铺、文件夹含顶层目录递归；**按规则归类**——选中文件按扩展名 / 修改年月
  （yyyy-MM）建子文件夹并移入（走既有冲突流程与撤销栈）；**批量重命名**——对话框
  （查找替换 + 前后缀 + 可选序号，扩展名保护，实时预览 + 目标重名/非法名检测，
  `lib/batchRename.ts` 纯函数配单测），逐项 rename 可逆（每条入撤销栈）。
  以上全部入任务引擎，输出一律旁写不覆盖原文件

- **自定义命令区（2026-10-13 补；2026-10-14 定案下线）**：命令模板功能整体移除——
  「定制」页不再提供模板配置入口与功能库分组，右键菜单不再渲染 custom 条目；
  旧档 settings.customCommands 数据留档但不再使用，Rust `run_custom_command`
  端点暂保留（前端已无调用方）

- 文件/文件夹：打开；*文件夹追加*：在新标签打开；剪切；复制；复制到窗格 ▸（其余窗格列表）；移动到窗格 ▸；重命名 F2；删除 Del；属性；更多系统选项（= Shift+右键，V3 双轨）
- 空白处：新建文件夹；新建文本文件；粘贴；刷新 F5；全选
- 功能库扩充（2026-10-14，进库不进出厂布局，可经预设/编辑器启用）：复制路径（选中项多行；空白处 = 当前目录路径）、复制名称、在终端打开（shell 随设置；选中 = 其所在目录 / 空白 = 当前目录；此电脑页禁用）、永久删除（danger 二次确认，不入撤销栈）、添加到收藏夹（仅文件夹）、反向选择、切换隐藏文件（空白处，即改即生效）
- 属性 = 只读对话框：名称/路径/类型/大小/创建与修改时间/属性位

### 7.4 拖拽语义（V3 起为 OLE 统一管线；标签拖动仍为 HTML5）

- 从列表拖起 ≥1 选中项（mousedown 位移 ≥5px 触发）：Rust 端 `DoDragDrop`（CF_HDROP 数据源），系统级拖拽
- 落到目标窗格列表区 = 移动（Ctrl = 复制，由 OLE 修饰键协商）；与剪贴板粘贴共用同一冲突流程与任务队列；同目录守护 = 无操作
- 落到目标窗格标签条 = 在该窗格新标签打开（仅单个文件夹）
- **可拖出窗口**到资源管理器/桌面/外部程序（移动/复制语义由目标与修饰键决定）
- 外部（资源管理器等）拖入 = Tauri `onDragDropEvent` 接收完整路径，同套命中分发
- 悬停期间目标窗格列表区 accent 高亮（ole-drag 状态驱动）
- 拖动分隔条不属于 DnD 体系（§6.3.1）；标签跨窗格拖动为 HTML5（仅窗内）

### 7.5 视图与显示细节

- 详细信息列：名称 | 修改时间 | 类型 | 大小；列宽可拖动并记忆（settings）；点击列头切换排序
- "此电脑"虚拟页专用列组：名称 | 类型 | 总大小 | 可用空间（对齐 Q-Dir 驱动器视图，行 = 盘符）
- 列表 = 名称多列平铺（列数随宽度自适应）；图标 = 96px 单元网格（图标 + 名称，超长省略号）
- 大小：1024 进制 B/KB/MB/GB、1 位小数，目录显示 `—`；时间：`yyyy-MM-dd HH:mm`
- 类型：前端内置扩展名→描述映射（常见约 50 种），未知显示 `XXX 文件`
- 图标：内置单色 SVG 集（文件夹/图片/音视频/文本/表格/PDF/压缩包/代码/EXE/通用 10 类）按扩展名映射，随主题着色；真实图标为 V2

## 8. 里程碑

> **进度（2026-10-10）**：V1 主体全部落地并通过部分硬性验收——
> - ✅ **内存硬验收 PASS**：--bench 基准模式（2×5 十窗格 × 1.2 万真实文件）实测私有提交内存中位数 **225.7MB < 350MB**（tools/measure-memory.ps1 自动采样，3 次取中位数；该口径 ≥ 专用工作集，偏严格）
> - ✅ 目录监控自动刷新提前从 V2 落地（notify，仅可见窗格）
> - 布局引擎（10 预设 + 可视化选择器 + 递归混合分裂）、真实文件系统、Blueprint 极简 UI 均已完成
> - 自动化测试：vitest 25 例 + cargo test 17 例全绿
> - 待办：万级目录滚动帧率人工核验、U 盘便携包实机验证

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **M0 环境与内存原型（半天）** | ① create-tauri-app（React-TS 模板）跑通 ② 前端 2×5 十窗格 + TanStack Virtual 假列表 ③ Rust `fake_list_dir(path, offset, limit)` 现生成 1 万条结构化假数据（含 String 路径字段，模拟真实负载），走完整 IPC 链路 ④ 按 §4.1 方法实测内存并逐项对照 §4.2 分解 | 实测内存达标 → GO；超标 → 切 WPF 预案（见 §9） |
| **M1 布局引擎（1~2 天）** | §6.3 全部：分割树纯函数 + 单测、分裂/关闭/拖动调宽、预设、焦点模型、标签页（假数据） | 布局操作全部流畅，键盘焦点切换可用 |
| **M2 真实文件系统（3~5 天）** | 接入 §6.5 全部 command；任务队列与取消；地址栏；收藏夹；工作区保存/恢复 | 大目录（1 万文件）滚动 60fps；复制/移动/删除可靠（覆盖冲突、取消、跨卷移动用例全过） |
| **M3 打磨与打包（2~3 天）** | 过滤/排序/视图模式；便携化配置；右键菜单；打包发布 | 非功能验收（§4.1）全过；单目录便携包可 U 盘运行 |
| V2 / V3 | 见 §3 | 按需排期 |

> **进度（2026-10-11，V1 收官 + V2 全量落地）**：
> - ✅ **V1 收尾**：PgUp/PgDn/Home/End 选择移动（§7.2 补齐）；属性对话框补创建时间（FileEntry 增 `ctimeMs`，双端同步）；地址栏路径无效标红（intent danger）；设置面板补 defaultView/defaultSort 编辑；大小写折叠冲突判定（check_conflicts 一次读目录建折叠索引 + rename 仅改大小写放行）；jobs/watch 命令统一 `Result<_, AppError>`；tauri.conf.json 显式 `bundle.windows.webviewInstallMode=downloadBootstrapper`；补齐 tauri-plugin-log（exe 旁 logs/，5MB 滚动 + panic hook 落盘）；Cargo.toml 增 `custom-protocol` feature（直编 release 也嵌入前端资源）
> - ✅ **V2 全量**（§3.2 全部划线）：递归搜索（Rust 端遍历 + 窗格搜索框 + Ctrl+F + "位置"列）、CF_HDROP 剪贴板双向互通（含 Preferred DropEffect 剪切语义、窗口聚焦自动同步）、真实图标 SHGetFileInfo（32×32 PNG data URL、按扩展名/路径 LRU 512 + 前端 miss 负缓存防请求风暴）、缩略图 IShellItemImageFactory（96px、LRU 200、mtime 失效、仅图标视图）、IFileOperation 原生复制/移动（FOF_ALLOWUNDO，失败回退内置引擎）、颜色标记 + 着色规则（--np-tag-* 六色 token）、地址栏自动补全（文件系统子目录 + 历史/收藏）、标签跨窗格拖动（moveTab 纯函数 + 单测）
> - ✅ **验收全过**：内存（tools/measure-memory.ps1 复测中位数 **309.7MB < 350MB** PASS；注：采样前须清扫孤儿 webview 进程，否则统计被污染虚高至 360~410；构成 = 渲染进程 160MB（JS 堆仅 16MB）+ WebView2 基础 ~110MB + Rust 38MB）；帧率（tools/verify-framerate.ps1：10 窗格 × 1.2 万文件滚动 min=60 avg=60 FPS ≥55，窗口标题 FPS/JS堆遥测）；便携（tools/verify-portable.ps1：config//WebView2//logs/ 全落 exe 旁、%APPDATA% 无降级、注册表零应用自有写入，仅 OS MuiCache/WebView2 运行时簿记）；实机 UI（tools/verify-ui.ps1：UIA 驱动 **30/30** 断言全过——顶栏/导航栏/地址键入导航/递归搜索计数（含子目录）/表头/Home 选择/设置面板全项/布局预设/收藏夹）；便携包 2.29MB < 15MB（dist-release/x-dir_v0.1.0_portable.zip）
> - ✅ 自动化测试：cargo test 30 例 + vitest 29 例全绿；cargo clippy -D warnings 零告警；tsc --strict 零错误
> - 工程注记：Computer Use SDK 在 CLI 会话不可用（需桌面端 CUA broker），实机验证以 UIAutomation + 真实输入注入等价完成（verify-*.ps1 三件套可重复执行）；--bench 附带 `--bench-single`/`--bench-3` 窗格数诊断开关（内存构成 A/B：1/3/10 窗格 → 渲染进程 127/155/206MB，每窗格 ~7-9MB 为合成器光栅固有成本）
> - ✅ **V3 双轨落地（2026-10-11 晚）**：① 双轨右键菜单——默认自绘 + Shift+右键/菜单末项弹出系统原生 IContextMenu（`show_context_menu`，主线程 STA，多选限同目录）；② OLE 拖拽统一管线——拖出 = Rust `DoDragDrop`（自实现 IDataObject/IDropSource，主线程 STA 发起是硬约束，跨线程会卡死在无键状态）；拖入/窗内落点 = Tauri `onDragDropEvent`（WebView2 原生拖放目标自带完整路径；自建 IDropTarget 注册会被 WebView2 抢先，已验证不可行并移除）；行拖拽从 HTML5 改为 mousedown≥5px 阈值触发；命中分发纯函数 `hitTest.ts` + 单测。实机验证 `tools/verify-native.ps1` **6/6**（导航/Shift 原生菜单弹窗/普通右键仍自绘/窗格导航/OLE 拖拽落盘/反向拖回），`tools/verify-ui.ps1` 回归 **30/30**；cargo test 32 + vitest 36 全绿，clippy/tsc 零告警，便携包 2.30MB。**注**：合成输入无法驱动"Explorer 作为落点"的跨进程 OLE 放下（Explorer→Explorer 注入亦失败，属自动化工具限制），跨进程落点列入人工清单；窗格间拖拽已端到端验证同一管线
> - 待办：V3 余项（窗格间文件对比、主题扩展/i18n）按需排期

> **进度（2026-10-12，搜索增强 + 全盘索引）**：
> - ✅ **A 遍历搜索增强**：查询语法升级（多词 AND / `*` `?` 通配符全名匹配 / 路径词 / 类型过滤，两引擎统一 `fs/matcher.rs`）；窗格与全盘搜索全部流式化（`search-batch` 事件 ~100ms/批 + 前端 reqId 守卫累积渲染）；补齐取消机制（`cancel_search` + 唯一递增 reqId，修复窗格搜索连打残留旧扫描的缺口）；封顶放宽（窗格遍历 100 万条目、全盘 deadline 30s、结果上限 500/2000/5000 可选）；全盘搜索范围 chips（全部/当前盘/含 U 盘）、结果排序（名称/路径/修改时间）、名称子串高亮、搜索历史（settings.recentSearches）
> - ✅ **B NTFS 名称索引（Everything 式秒搜）**：`src-tauri/src/index/`（volume MFT/USN + table 名表 + store 落盘/mmap + scan 并行扫描 + daemon 守护）；提权守护 `--index-daemon`（设置面板开启索引模式时 UAC 拉起一次，心跳/stop/status.json 纯文件通信）；主程序普通权限 mmap 只读查询（读侧 FILE_SHARE_DELETE 与 tmp+rename 覆盖共存）；引擎自动选择（索引新鲜→索引，否则遍历兜底，`engine` 字段 + 状态条徽标如实标注）；NTFS 限定（exFAT/ReFS 回退遍历）
> - ✅ 回归：cargo test 64 例 + vitest 85 例全绿；clippy -D warnings / tsc --strict / build 零告警
> - ✅ 实机验证（verify-ui.ps1 更新至 2026-10-12 UI 事实后）**30/30**：窗格递归搜索流式（状态行含"已扫描"）、导航、设置面板全项；守护进程非提权冒烟过（卷路径 `\\.\C:` 修复、错误回执 status.json、优雅退出回退遍历）；全盘搜索面板渲染确认（过滤行/排序/上限/历史 chips）
> - 待办：索引模式提权全链路人工验证（设置 → UAC 一次 → MFT 建索引 → 秒搜 → 改名/新建实时同步 → 停止退出）；默认（索引关）内存复测

## 9. 风险与预案

| 风险 | 应对 |
|---|---|
| M0 内存实测超标（>350MB） | 切换预案：C# + WPF + ModernWpf，.NET Framework 4.8（OneCommander 已验证的零安装路线）；需求文档仅换 §5 技术栈，产品需求不变 |
| 目标机存在 Win7 | Tauri 出局（WebView2 不支持），直接走 WPF 预案 |
| COM 集成调试耗时（缩略图/右键菜单） | V1 用替代方案（通用图标/自定义菜单），不阻塞主线 |
| AI 生成 windows-rs 代码卡在 COM 生命周期 | 用官方 examples 仓库对照；问题最小化复现后再喂回 |

## 10. 开发环境准备清单（当前机器状态）

- [x] Node.js v22.20.0（已装）
- [x] Rust 工具链：rustup + stable-x86_64-pc-windows-msvc（2026-10-10 已装）；VS 2022 Build Tools "使用 C++ 的桌面开发"已确认存在
- [x] @tauri-apps/cli 作为 devDependency 随项目安装（版本随项目锁定；不必 `cargo install tauri-cli`）
- [x] WebView2 运行时确认（本机 154.0.4258.62 已预装；缺失时由 downloadBootstrapper 引导安装）
- [x] tools/gen-test-tree.ps1 压测目录生成脚本（已运行，test-data/ 10 × 1.2 万真实文件）
- [x] tools/measure-memory.ps1 内存验收自动化（--bench 模式 + 自动采样出报告，2026-10-10 首测 PASS 225.7MB）
- [x] 项目骨架已创建并上提至仓库根目录（Tauri 2 官方 react-ts 模板 + MVP 代码 + Blueprint UI）

## 11. 参考

### 11.1 外部参考

- Spacedrive（Tauri 文件管理器架构参考）：github.com/spacedriveapp/spacedrive
- conaticus/FileExplorer（入门级代码通读）：github.com/conaticus/fileexplorer
- windows-rs 官方示例：github.com/microsoft/windows-rs（examples 目录）
- Q-Dir（产品对标）：softwareok.com；实测内存 17.9MB，本产品以 350MB 内做到其 N 窗格超集为目标
- Tauri 2 文档：v2.tauri.app（config、capabilities、plugin 机制）
- TanStack Virtual：tanstack.com/virtual（固定尺寸模式）

### 11.2 AGENTS.md（已建立：仓库根目录 AGENTS.md）

- 工具链强制：`cargo fmt`、`cargo clippy -D warnings`、`tsc --strict`、vitest 全绿
- 性能三条铁律写入 code review checklist（§4.3）
- IPC 类型改动必须双端同步（或经 tauri-specta 生成，禁止只改一边）
- **组件标准规范（AGENTS.md §4）**：np-\* token 唯一取值、禁硬编码、Blueprint 优先清单、密度标准、图标映射集中
- 提交信息遵循 Conventional Commits
