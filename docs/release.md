# X-Dir 发布流程 · Gitee/GitHub 双端 Release（2026-11-11 定案）

> v0.1.7 实发双端验证通过。触发规则见 `AGENTS.md` §9：用户说「发布新版本」即按本文档全自动执行。
> 双端分工：**Gitee 走浏览器自动化**（API v5 会被 WAF 拦截；浏览器同源会话不受影响），
> **GitHub 走 API**（直连无障碍，令牌已持久化）。

## 0. 前置条件（一次性，已就绪勿重复配置）

| 项 | 状态 | 说明 |
|---|---|---|
| GITHUB_TOKEN | ✅ setx 持久化于用户环境变量 | Fine-grained PAT：仅授权 `wwc9/x-dir`，`Contents: Read and write`；脚本运行时从注册表注入进程，不落盘不回显 |
| Gitee 登录态 | ✅ ZCode 内置浏览器已登录 | 登录态常驻；失效时在浏览器面板手动重登一次 |
| 更新签名私钥 | ✅ tools/keys/xdir_updater.key | gitignored，换机器发布须先恢复，否则 tauri build 签名失败 |

## 1. 版本与标签（先于一切产物）

1. `node tools/bump-version.mjs <新版本号>` 改五处版本号；`update.json` 填本次 notes（中文事实数据源）。
2. 全绿校验：`npx vitest run` + `cargo test` + `npm run build` + `cargo check`。
3. 提交 → `git push origin main`（双端）→ `git tag vX.Y.Z` → `git push origin vX.Y.Z`。
   **tag 必须先到远端**：Gitee 发行版页面的标签框按远端已有标签校验，GitHub API 也按已有 tag 挂接。

## 2. 构建产物：`tools/build-release.ps1`

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-release.ps1
```

产出四件到 `dist-release/v<版本>/`：`X-Dir_vX.Y.Z_x64-setup.exe`（+ `.sig`）、
`x-dir_vX.Y.Z_portable.zip`、`SHA256SUMS.txt`、`latest.json`（minisign 签名，url 指向 Gitee 附件直链）。
NSIS 首次打包需下载工具链，国内网络易超时——脚本会降级只出便携包并给出提示。

## 3. 发行说明 `release-notes.md`（双端同源，分类编号 + 双语）

写到 `dist-release/v<版本>/release-notes.md`，**格式硬性要求（2026-11-12 用户确认版式）**：
✨ 新增 New / ⚡ 改进 Improved / 🐛 修复 Fixed 三段分类编号，**段标题双语**；
编号全局连续（新增从 1、改进接续、修复接续）；内容简洁明了——每条 =
**加粗双语短标题（中文 + 英文同体）** + 中文一句话，下一行缩进 3 空格附英文描述行
（与条目同段渲染；英文行不机械直译，按凝练口径重写）。
定稿范本（v0.1.9，2026-11-12 用户确认）：

```markdown
## ✨ 新增 New

1. **更新完成自动重启 Auto-Relaunch** —— 一键更新装完新版后自动拉起应用，已在运行则不重复打开
   The app restarts itself once the update finishes installing, and never opens a second instance
2. **更新完成感知提示 Update Notice** —— 静默更新完成后灵动岛提示「已更新到新版本，配置全部保留」
   After a silent update, the island bubble confirms the new version with config fully kept

## ⚡ 改进 Improved

3. **开源文档体系整理 Docs Overhaul** —— 贡献者文档重构为分域结构，新增文档总索引与依赖合规清单
   Contributor docs are reorganized by domain, adding a docs index and a dependency compliance list

## 🐛 修复 Fixed

4. **剪贴板图片缩略图变形发糊 Thumbnail Sharpness** —— 缩略图改为等比缩放不裁切，高清源不再放大发虚
   Clipboard image thumbnails now keep their aspect ratio, without cropping or upscale blur
5. **剪贴板浮窗快捷键冲突 Hotkey Conflict** —— 搜索框不再吞掉 1-9 取条、空格勾选等列表快捷键，Esc 随时返回列表模式
   The clipboard search box no longer swallows list shortcuts like 1–9 and Space; Esc returns to list mode
```

内容取材 = `update.json` notes + 本轮提交记录，按上述口径精炼改写。
历史版本（v0.1.7/0.1.8：单语短标题，英文行带独立粗标题）不回溯改写。

> **update.json notes 前缀约定（2026-11-12）**：notes 每条以分类标签开头（`✨ 新增 ` /
> `⚡ 改进 ` / `🐛 修复 `，与三段同名），关于浮窗按前缀分组渲染出与发行说明同构的三段。
> notes 保持 string[] 不变——旧版应用的解析器是严格 Vec<String>，换结构会让旧版检查
> 更新解析失败；旧面板平铺显示前缀亦可读。条目正文 = 「双语短标题 —— 描述」，与发行
> 说明中文行逐字同源；面板按「——」前加粗，双语标题一体加粗。

## 4. Gitee 端：浏览器自动化（ZCode 内置浏览器，IAB）

已验证事实：API 直调（curl/node fetch）被 WAF 拦；页面内同源 XHR 与 DOM 操作完全正常；
上传控件是 **Dropzone.js**（`#releaseDropzone`），`autoProcessQueue=false`（注入后必须手动 `processQueue()`）；
IAB 不支持原生文件选择器 → **页面内分块注入**（512KB/块；单块 ≥2.6MB 的 base64 会打断桥接）。

1. 校验登录态：开 `https://gitee.com/wwc9/x-dir`，banner 出现头像/「管理」即已登录（未登录 → 打开 `/login` 请用户手动登录）。
2. 打开 `https://gitee.com/wwc9/x-dir/releases/new`；标签框输入 `vX.Y.Z`，出现「验证正确，选择了一个非发行版的标签」即通过。
3. 标题填 `X-Dir vX.Y.Z`；描述框填 `release-notes.md` 全文（`getByRole("textbox", { name: "描述此发行版" }).fill()`，回读校验）。
4. 附件注入（每件文件）：
   - 页面初始化缓冲 `window.__upFiles.<key> = { name, type, chunks: [] }`；
   - node 侧读文件按 512KB 切块 base64，逐块 `evaluate` 推入并校验序号回执；
   - 页面内 `atob` 还原拼接为 `Uint8Array` → `new File(...)` → `Dropzone.forElement("#releaseDropzone").addFile(file)`；
   - 全部 `addFile` 后 `dz.processQueue()`，轮询 `dz.files` 直到 4 件全 `success`。
   顺序建议：先传 `SHA256SUMS.txt` + `latest.json`（小件验证管线），再传 exe、zip。
5. 点「创建发行版」→ 落地 `releases/tag/vX.Y.Z` → 页面快照校验四条 `releases/download/vX.Y.Z/...` 直链 + 描述三段齐全；
   页面内 `fetch(直链, {method:"HEAD"})` 验 200 且 `content-length` 与本地产物一致。

## 5. GitHub 端：API（脚本 `tools/publish-release.ps1`）

```powershell
powershell -ExecutionPolicy Bypass -Command "$env:GITHUB_TOKEN=[Environment]::GetEnvironmentVariable('GITHUB_TOKEN','User'); & 'E:\Code\AIProject\x-dir\tools\publish-release.ps1'"
```

- `GITEE_TOKEN` 未设置 → 自动跳过 Gitee 段只跑 GitHub（REST 建 Release + `uploads.github.com` 传 assets）。
- 发行说明自动读 `dist-release/v<版本>/release-notes.md`（§3 的文件，双端同款）；缺省回退 `update.json` notes 平铺列表。
- 上传 3 件 assets：setup.exe / zip / SHA256SUMS.txt（**latest.json 不上传 GitHub**——更新清单走仓库 raw 端点，下载直链指向 Gitee）。
- 已挂 tag 时 Release 直接挂到该 tag；`target_commitish` 仅在 tag 不存在时生效。
- 验收：`GET /repos/wwc9/x-dir/releases/tags/vX.Y.Z`（匿名即可）校验 body 三段 + assets state=uploaded、size 与本地一致。

## 6. 收尾：更新清单入库

1. `cp dist-release/v<版本>/latest.json latest.json`（新签名 + 新 pub_date，url 与 Gitee 直链一致）。
2. 提交推送双端 → updater 端点（`raw.giteeusercontent.com`/`raw.githubusercontent.com` 的 `main/latest.json`）即刻生效。
3. 终验：两个 raw 端点 curl 出的 `pub_date`/`signature` 与 `dist-release` 内文件一致。

## 7. 已知坑速查（全部实战踩过）

| 坑 | 结论 |
|---|---|
| Gitee API v5 被 WAF 拦 | 弃用 API，走浏览器同源会话（本文 §4） |
| IAB 单块 evaluate 载荷过大 | 512KB/块安全；≥2.6MB base64 报 "broker response id mismatch" |
| Dropzone 卡 queued | `autoProcessQueue=false`，注入后手动 `dz.processQueue()` |
| PS5.1 `Get-Content -Raw` 污染 JSON | 返回值带 PSPath 等注解属性被 `ConvertTo-Json` 序列化 → GitHub 422；必须 `[IO.File]::ReadAllText` |
| PS5.1 读中文文件 | 一律 `-Encoding UTF8`；写 curl 直读的临时文件用无 BOM UTF-8（BOM 令 updater JSON 解析失败） |
| updater notes 类型 | latest.json 的 `notes` 必须是字符串（数组会 `invalid type: sequence` 检查即败） |
| exe 未签名 | Release 说明提醒 SmartScreen 弹「未知发布者」选「仍要运行」 |
| 安装版与 dev 版同时运行 | 全局热键（截图/剪贴板）RegisterHotKey 先到先得——热键召唤的是**先启动实例**的浮窗（可能是旧版），表现与最新代码不符时先查是否双实例（`tasklist | findstr x-dir`），开发验证/冒烟前先退出另一实例 |
