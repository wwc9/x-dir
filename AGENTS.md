# AGENTS.md · X-Dir 编码规范（主文档）

> 本文件是 AI 编码代理与人类贡献者的强制约定，只保留核心规范（≤100 行）；详版拆分见 §0 索引，
> 子文档规则效力等同主文档，触及相关改动时必须先读对应子文档。
> 需求与产品决策源见 `REQUIREMENTS.md`；两者冲突时以 REQUIREMENTS.md 的产品决策为准，工程规范以本文件为准。
> UI 层统一基于 **Blueprint.js v6**（Apache-2.0），全部样式经 **np-\* 设计 token**。
> 文档总索引见 [docs/README.md](docs/README.md)。

## 0. 详版文档索引（触及相关改动时必读）

| 文档 | 内容 | 何时必读 |
|---|---|---|
| [docs/agents/ui-standards.md](docs/agents/ui-standards.md) | UI 标准规范详版：设计 token（`--np-*` 唯一取值来源）、组件选用优先级、密度规范、图标规范、二级页面统一规范、参数面板对齐细则与验收自查清单 | **绘制或更新任何 UI 前硬性必读**：新功能、改样式、调布局、新增/修改对话框、引入任何颜色/字号/间距/图标 |
| [docs/agents/features.md](docs/agents/features.md) | 功能定案清单：全部功能域的组件选型、模块归属、实现定案与注意事项 | 改造既有功能、新增功能、动后端命令前必查现状 |
| [docs/agents/opensource.md](docs/agents/opensource.md) | 开源合规详版：协议红线、依赖白名单与选型台账、THIRD-PARTY-NOTICES 生成 | **引入或升级任何依赖前必读** |
| [docs/release.md](docs/release.md) | 双端 Release 发布全流程：构建产物、发行说明双语模板、Gitee/GitHub 发布步骤、坑速查表 | **用户说「发布新版本」时执行发布前必读** |

## 1. 工具链强制

- 前端：`tsc --strict`（build 内置）、`npx vitest run` 必须全绿
- Rust：`cargo fmt`、`cargo clippy -- -D warnings`、`cargo test` 必须全绿
- 构建验证：`npm run build`（前端）+ `cargo check`（后端）零 error、零 warning

## 2. 性能三铁律（code review checklist，REQUIREMENTS.md §4.3）

- 文件列表只做虚拟滚动，DOM 只有可见行
- 图标/缓存有上限（LRU），只对可见窗格生效
- 前端 store 不囤整目录元数据；扫描/排序/过滤全部在 Rust 端分页下发
- 另加：布局树操作只允许写 `lib/layoutTree.ts` 纯函数并配单测

## 3. IPC 与类型

- IPC 类型唯一来源是 Rust 结构体；TS 侧手工镜像于 `src/lib/ipc.ts`（serde `rename_all = "camelCase"`），**禁止只改一端**
- 改命令签名必须双端同步：`src-tauri/src/commands/*` + `src/lib/ipc.ts`

## 4. 组件标准（速览，详版见 docs/agents/ui-standards.md）

- **绘制或更新任何 UI 前必须先通读 ui-standards.md**，完成后按其验收清单自查；规范未覆盖的视觉偏差修完后把结论补回该文档条款
- 所有颜色、字号、行高、间距、圆角、阴影只允许定义在 `src/index.css` 的 `--np-*` CSS 变量里，组件样式禁止裸值
- Blueprint 内置优先，没有的 token 化自研（np-* 前缀）；图标唯一来源 lucide-react，唯一渲染入口 `components/AppIcon.tsx`
- 全局密度 small：列表行高 28、控件高 24、正文 13px、辅助 11px；Blueprint 自带默认样式必须显式覆盖（覆盖/规避清单见 ui-standards §4.7/§4.9）
- 流程：先查 features.md 现状 → 再查 ui-standards.md；PR 中出现裸色值/裸像素即打回

## 5. 目录约定（结构总表见 REQUIREMENTS.md §6.2）

- `src/index.css` = token + 全局/组件样式（唯一样式文件）；`src/lib/tokens.ts` = JS 侧密度常量（与 CSS token 同名同值，改一处必须改另一处）
- `src/lib/fileIcons.ts` = 图标/类型映射；`src/lib/shortcuts.ts` = 快捷键清单单一来源（设置「快捷键」页渲染，与 `keyboard.test.ts` 双向对齐；新增快捷键 = 先改清单再实现）
- `design/preview.html` = 独立静态 UI 预览（不参与构建）；`tools/gen-file-icon-preview.mjs` 生成全量图标预览页
- 用户偏好统一存 `settings.json`、工作区 = `workspaces/*.json`，UI 偏好禁止直写 localStorage（完整口径见 features.md §12.6）

## 6. 测试要求

- `lib/layoutTree.ts` 改动必须带 vitest 用例；`lib/path.ts` 行为由 `path.test.ts` 锁定，改行为先改用例
- 全局快捷键（`lib/keyboard.ts`）新增/改动必须同步 `lib/shortcuts.ts` 清单，且 `keyboard.test.ts` 覆盖对齐用例保持全绿
- Rust `fs`/`jobs` 纯逻辑（排序/路径/冲突/分页）必须带 cargo test；图标映射（`lib/fileIcons.ts`）扩展时补映射断言
- 三条规范审计测试（新代码违反即 CI 失败）：
  - `iconRule.test.ts` = lucide 图标只许经 `AppIcon`/`ic()` 渲染（除 AppIcon.tsx 本体）
  - `apiBinding.test.ts` = `lib/ipc.ts` 的 api 方法必须有 UI 调用点（防死绑定滞留）
  - `cssClasses.test.ts` = TSX 引用的 `np-*` 类必须在 index.css 有定义或入白名单（白名单仅收 JS 查询钩子/语义标记类，新成员必须注释理由）

## 7. 提交与自动同步

- Conventional Commits：`feat: / fix: / refactor: / docs: / test: / chore:`；涉及 UI 的提交必须说明是否新增 token、是否新增依赖
- **自动双端同步**：每次代码修改完成且构建/测试全绿后，AI 代理须自动提交并 `git push origin <branch>` 同步 GitHub 与 Gitee 双端（origin 已配置双 push 地址），无需等待用户指示
- 未全绿（测试/构建失败）或半成品代码**不得推送**；禁用 force push 等破坏性操作；推送失败（网络等）须如实告知用户

## 8. 开源合规（速览，详版见 docs/agents/opensource.md）

- 本项目以 MIT 许可开源；一切依赖与资产按「将随本项目一并再分发」口径评估
- **AGPL 系依赖是硬红线**（传染整个作品 + 网络条款，如 MuPDF、Ghostscript），任何引入建议直接打回
- 依赖只允许宽松协议（MIT/Apache-2.0/BSD/0BSD）；引入任何 GPL 系依赖需在 REQUIREMENTS.md 层面重新决策

## 9. 发布（双端 Release，全流程见 docs/release.md）

- **触发规则：用户说「发布新版本」即无需再确认，全自动执行 Gitee + GitHub 双端 Release**
- 固定流水线：bump 五处版本 + update.json notes → 全绿 → 提交推送打 tag（**tag 必须先到远端**）→ `tools/build-release.ps1` 出四件产物 → 写 `dist-release/v<版本>/release-notes.md` → Gitee 浏览器自动化 + GitHub `tools/publish-release.ps1` → `latest.json` 复制仓库根提交推送（双端 raw 端点即 updater 端点）
- 发行说明硬性格式（✨新增/⚡改进/🐛修复 三段分类编号 + 每条中英双语）见 docs/release.md §3
