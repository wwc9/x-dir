# AGENTS.md · X-Dir 编码规范（主文档）

> 本文件是 AI 编码代理与人类贡献者的强制约定。需求源见 `REQUIREMENTS.md`；
> 两者冲突时以 REQUIREMENTS.md 的产品决策为准，以本文件的工程规范为准。
> UI 层统一基于 **Blueprint.js v6**（Apache-2.0），全部样式经 **np-* 设计 token**。
>
> **文档结构**：本文件只保留核心强制约定（≤100 行）；详版拆分见下方索引，
> 子文档规则效力等同主文档，**触及相关改动时必须先读对应子文档**。

## 0. 详版文档索引（按需阅读，必读）

| 文档 | 内容 | 何时必读 |
|---|---|---|
| [docs/agents/ui-standards.md](docs/agents/ui-standards.md) | §4 详版：设计 token（--np-* 唯一取值来源）、组件选用优先级、密度规范、图标规范（Lucide/AppIcon 四档）、新增 UI 流程、二级页面统一规范 | 新增或修改任何 UI、引入任何颜色/字号/间距/图标 |
| [docs/agents/features.md](docs/agents/features.md) | §4.3 已采用清单：全部功能域的组件选型、模块归属、实现定案与注意事项（预览/搜索/任务引擎/右键菜单/PDF/图片/办公批处理等） | 改造既有功能、新增功能、动后端命令前查现状 |

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


## 4. 组件标准（速览，详版见 docs/agents/ui-standards.md）

- 所有颜色、字号、行高、间距、圆角、阴影只允许定义在 `src/index.css` 的 `--np-*` CSS 变量里；组件样式禁止裸值
- Blueprint 内置优先，没有的 token 化自研（np-* 前缀）；图标唯一来源 lucide-react，唯一渲染入口 `components/AppIcon.tsx`（四档尺寸，按钮里 sm/文件 md）
- 全局密度 small：列表行高 28、控件高 24、正文 13px、辅助 11px；二级页面（Dialog/浮层）按 §4.7 统一规范
- 新增/修改 UI 的流程与验收：先查 features.md 现状 → 再查 ui-standards.md；PR 中出现裸色值/裸像素即打回

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



## 7. 提交与自动同步规范（2026-10-18 定案）

- Conventional Commits：`feat: / fix: / refactor: / docs: / test: / chore:`
- 涉及 UI 的提交必须说明是否新增 token、是否新增依赖
- **自动双端同步**：每次代码修改完成且构建/测试全绿后，AI 代理须自动提交并
  `git push origin <branch>` 同步至 GitHub 与 Gitee 双云端（origin 已配置双 push
  地址），**无需等待用户指示**；提交信息遵循上条规范
- 未全绿（测试/构建失败）或半成品代码**不得推送**；禁用 force push 等破坏性操作；
  推送失败（网络等）须如实告知用户


## 8. 开源合规

- **本项目将开源（2026-10-13 定案；开源许可证选型待定，定案后同步 LICENSE/README 与本条）**：
  一切依赖与资产按"将随本项目一并再分发"口径评估——
  **AGPL 系依赖是硬红线**（传染整个作品 + 网络条款要求向使用者提供源码，如 MuPDF、
  Ghostscript），任何引入建议直接打回；宽松协议白名单见下条
- 依赖只允许宽松协议（MIT/Apache-2.0/BSD/0BSD）；引入任何 GPL 系依赖需在 REQUIREMENTS.md 层面重新决策
- 新增（2026-10-24 截图功能）：xcap/Apache-2.0（截屏引擎）、tauri-plugin-global-shortcut/(MIT OR Apache-2.0)（系统级截图热键）、tauri-plugin-clipboard-manager/(MIT OR Apache-2.0)（位图剪贴板）、base64/(MIT OR Apache-2.0)（前端 PNG dataURL 解码）
- 发布前生成 `THIRD-PARTY-NOTICES.txt`（cargo-about / license-checker），当前已知：Tauri MIT-Apache、React/MIT、Blueprint Apache-2.0、TanStack MIT、react-resizable-panels MIT、png/MIT（V2 图标 PNG 编码）、notify/MIT、trash/(MIT OR Apache-2.0)、pinyin/MIT、lopdf/MIT（PDF 合并/拆分/水印/页级编辑）、flate2/(MIT OR Apache-2.0)（流压缩）、ab_glyph/Apache-2.0（水印文字光栅化，运行时读系统字体不打包）、jpeg-decoder/(MIT OR Apache-2.0)（图片合并转 PDF 的 JPEG 解码）、zip/MIT（OOXML 隐私清理重打包 + 压缩为 zip）、quick-xml/MIT/Apache-2.0（OOXML/ODF 抽取）、calamine/MIT（xlsx/xls 预览读取 + Excel 合并读取）、rust_xlsxwriter/MIT（Excel 合并写出，唯一宽松协议的 xlsx 写库）、encoding_rs/(MIT OR Apache-2.0)（编码探测/转换）、tiff/MIT-Apache（预览）、sevenz-rust/Apache-2.0（7z 清单）、image/(MIT OR Apache-2.0)（图片批处理解码/编码/缩放/合成）、oxipng/MIT（PNG 无损优化）、color_quant/(MIT OR Apache-2.0)（PNG8 调色板量化）、kamadak-exif/(MIT OR Apache-2.0)（EXIF 方向读取）（全盘搜索拼音首字母匹配）、memmap2/MIT（全盘索引 mmap 只读查询）、sha2/(MIT OR Apache-2.0)（重复文件查找内容指纹）、tauri-plugin-dialog/Apache-2.0（配置导出/导入与清单导出的原生保存对话框）、webview2-com/(MIT OR Apache-2.0)（关闭 WebView2 浏览器加速键 F5/Ctrl+R/Ctrl+F/Ctrl+P，快捷键由前端 lib/keyboard.ts 全权路由）、highlight.js/BSD-3（预览代码语法高亮，懒加载 core+单语言）、mailparse/0BSD（eml 邮件预览 MIME 解析）、cfb/MIT（msg 邮件预览 OLE 容器读流）
- 配置集中化（2026-10-12）：用户偏好统一存 settings.json（含侧边栏/列宽/导航树等 UI 偏好，原 localStorage 已迁移）；工作区=workspaces/*.json；导出=设置 → "配置"区（`export_config` 打包两者为单 JSON，version 字段供导入对齐）；导入（2026-10-14）= `import_config` 校验 app/version 后整体覆盖 settings.json 与 workspaces/*.json（前端热重载设置 + 事件刷新方案列表）。UI 偏好禁止再直写 localStorage
