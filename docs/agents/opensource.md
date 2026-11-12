# 开源合规与依赖选型（AGENTS.md 详版拆分）

> 本文档是 AGENTS.md「开源合规」一节的详版，规则效力等同主文档。
> **引入或升级任何依赖前必读**；新增依赖后必须回写 §3 选型台账。

## 1. 合规规则

- 本项目以 **MIT** 许可开源（`LICENSE` 已落地）。一切依赖与资产按「将随本项目一并再分发」口径评估。
- **AGPL 系依赖是硬红线**：传染整个作品 + 网络条款要求向使用者提供源码。任何引入建议直接打回。
- 依赖只允许宽松协议：**MIT / Apache-2.0 / BSD / 0BSD**（含 `X OR Y` 双许可组合）。
- 引入任何 GPL 系依赖需在 REQUIREMENTS.md 层面重新决策，不得由工程侧自行拍板。
- **例外资产须备案**：随 resources 分发的外部可执行/资产，其许可与限制声明必须随
  THIRD-PARTY-NOTICES.txt 一并分发（当前唯一备案 = 内嵌 7-Zip，见 §4）。

## 2. 红线打回台账（选型排除记录）

| 需求 | 被排除方案 | 原因 | 实际采用 |
|---|---|---|---|
| PDF 渲染 | MuPDF / Ghostscript / pdfium / poppler | AGPL/GPL 红线 | pdf.js（Apache-2.0，前端渲染，宽松协议唯一可行渲染器） |
| PNG 调色板量化 | libimagequant | GPL 系 | color_quant（MIT OR Apache-2.0） |
| 剪贴板历史 | Ditto / CopyQ | GPL-3.0 | 自研（clipboard-rs 监听 + clip.rs 读写 + rusqlite 存储） |
| 剪贴板历史 | PasteBar | CC BY-NC（非宽松） | 同上 |
| 截图 | GPL 系截图应用（Flameshot / ShareX 等） | GPL 红线 | xcap 截屏引擎 + 交互自研 |
| Office 转 PDF | 打包转换引擎 | AGPL 系 | PowerShell COM 派发本机已装 Office/WPS（引擎不打包） |

## 3. 依赖选型台账（宽松协议白名单）

> 收录直接引入的主要依赖；全量清单以发布物 `THIRD-PARTY-NOTICES.txt` 为准。

### 3.1 前端

| 依赖 | 协议 | 用途 |
|---|---|---|
| Tauri（tauri / @tauri-apps/api 等） | MIT OR Apache-2.0 | 应用框架 |
| React | MIT | UI 库 |
| Blueprint.js v6 | Apache-2.0 | UI 组件库（唯一 UI 基座） |
| TanStack Virtual | MIT | 虚拟滚动（性能铁律核心） |
| react-resizable-panels | MIT | 窗格分割 |
| lucide-react | ISC | 图标库（唯一图标来源，经 AppIcon 渲染） |
| pdf.js | Apache-2.0 | PDF 渲染 / 文本层 / 预览内查找 |
| highlight.js | BSD-3 | 代码语法高亮（懒加载 core + 单语言 ≤200KB） |
| opencc-js | MIT AND Apache-2.0 | 批量重命名简繁转换（cn2t/t2cn 子路径按方向只带所需词典） |
| pinyin-pro | MIT | 批量重命名转拼音 |
| @tauri-apps/plugin-updater / plugin-process | MIT OR Apache-2.0 | 应用内覆盖更新与重启 |
| base64 | MIT OR Apache-2.0 | PNG dataURL 解码（截图位图剪贴板链路） |

### 3.2 Rust 后端

| 依赖 | 协议 | 用途 |
|---|---|---|
| notify | MIT | 目录监控 |
| trash | MIT OR Apache-2.0 | 回收站删除/还原 |
| pinyin | MIT | 拼音首字母匹配（全盘搜索/type-ahead） |
| memmap2 | MIT | 全盘索引 mmap 只读查询 |
| sha2 / md-5 / sha1 | MIT OR Apache-2.0 | 重复文件指纹、校验值/校验核对工具 |
| filetime | MIT OR Apache-2.0 | 修改时间与属性工具 |
| lopdf | MIT | PDF 合并/拆分/水印/页级编辑/加密解密 |
| ab_glyph | Apache-2.0 | 水印文字光栅化（运行时读系统字体，不打包字体） |
| png | MIT | V2 图标 PNG 编码 |
| jpeg-decoder | MIT OR Apache-2.0 | 图片合并转 PDF 的 JPEG 解码 |
| image | MIT OR Apache-2.0 | 图片批处理解码/编码/缩放/合成 |
| oxipng | MIT | PNG 无损优化 |
| color_quant | MIT OR Apache-2.0 | PNG8 调色板量化 |
| kamadak-exif | MIT OR Apache-2.0 | EXIF 方向读取（图片转换烘焙） |
| tiff | MIT OR Apache-2.0 | TIFF 预览 |
| flate2 | MIT OR Apache-2.0 | 流压缩（tar.gz、PDF 图片流） |
| zip | MIT | OOXML 隐私清理重打包 + zip 压缩（含 AES-256 密码） |
| sevenz-rust | Apache-2.0 | 7z 清单/解压 |
| quick-xml | MIT OR Apache-2.0 | OOXML/ODF 文本抽取 |
| calamine | MIT | xlsx/xlsm/xls/xlsb/ods 预览读取 + Excel 合并/拆分数据通道读取 |
| rust_xlsxwriter | MIT | Excel 合并/拆分数据通道写出（唯一宽松协议的 xlsx 写库） |
| umya-spreadsheet | MIT | Excel 合并/拆分保真通道（xlsx/xlsm 整档建模读写，样式/合并格/列宽/冻结/图表 roundtrip；2026-11-12 核验，zip 8.6 已在依赖树零新增版本） |
| encoding_rs | MIT OR Apache-2.0 | 编码探测/转换 |
| mailparse | 0BSD | eml 邮件预览 MIME 解析 |
| cfb | MIT | msg 邮件预览 OLE 容器读流（旧版 doc/ppt 抽取同用） |
| xcap | Apache-2.0 | 截屏引擎（DXGI 失败回落） |
| tauri-plugin-global-shortcut | MIT OR Apache-2.0 | 系统级截图热键 |
| tauri-plugin-clipboard-manager | MIT OR Apache-2.0 | 位图剪贴板写入 |
| tauri-plugin-dialog | Apache-2.0 | 配置导出/导入与清单导出的原生保存对话框 |
| webview2-com | MIT OR Apache-2.0 | 关闭 WebView2 浏览器加速键（快捷键由前端全权路由） |
| clipboard-rs | MIT | 剪贴板变化监听信号源（Windows 内部走 AddClipboardFormatListener 真事件） |
| rusqlite | MIT | 剪贴板历史 SQLite 存储（bundled，项目首个数据库） |

## 4. 例外资产备案

| 资产 | 许可 | 分发方式与合规口径 |
|---|---|---|
| 内嵌 7-Zip 25.01（7z.exe / 7z.dll） | LGPL-2.1 + unRAR 限制声明 | 随 resources 分发，命令行调用（arm's length）；`tools/get-7zip.ps1` 三重哈希锁定下载；许可与限制声明随 THIRD-PARTY-NOTICES.txt 分发 |

## 5. THIRD-PARTY-NOTICES.txt 生成

- `node tools/gen-third-party-notices.mjs`：cargo metadata 按 Windows 目标过滤 + 依赖自带 LICENSE 按签名提取全文。
- `tools/build-release.ps1` 打包时自动重生成并随发布物分发。
