# X-Dir 使用手册

> 本手册面向日常使用者，从安装启动一路讲到功能库里每一个工具。全部截图均取自自建的演示文件
> （`X:\xdir-demo` 式的虚构目录，公司、人名、数据皆为占位内容），不含任何真实文件。
> 截图与实际界面 1:1 对应（无窗口边框裁切）。

## 目录

### 基础使用

| 章节 | 内容 |
|---|---|
| [01 安装与启动](basics/01-install.md) | 下载、绿色便携、首次启动、应用内一键更新 |
| [02 界面总览](basics/02-interface.md) | 顶栏、窗格、边栏、状态条、灵动岛一次看懂 |
| [03 窗格与布局](basics/03-panes-layout.md) | 任意分裂、布局预设、布局方案 |
| [04 标签页与导航](basics/04-tabs-nav.md) | 标签页、地址栏补全、面包屑、历史、type-ahead |
| [05 文件操作](basics/05-file-ops.md) | 选择、复制/移动/删除、冲突处理、任务进度、撤销 |
| [06 边栏与暂存区](basics/06-sidebar.md) | 导航树、布局方案卡、暂存区、收藏夹 |
| [07 视图与过滤](basics/07-view.md) | 视图模式、排序、视图内过滤、颜色标记 |
| [08 右键菜单与定制](basics/08-customize.md) | 菜单编辑器、功能库（83 项）、条件可见性、工具栏编辑 |
| [09 全盘搜索](basics/09-search.md) | Everything 式秒搜、查询语法、拼音检索、内嵌预览 |
| [10 快速预览](basics/10-preview.md) | Space 预览：PDF/Office/图片/表格/代码/压缩包 |
| [11 剪贴板历史](basics/11-clipboard.md) | 常驻浮窗、直接粘贴、搜索分类、收藏置顶 |
| [12 截图与贴图](basics/12-screenshot.md) | 截图热键、标注工具、序号标记、贴图、滚动长图 |
| [13 设置与配置](basics/13-settings.md) | 九类设置、主题/语言/缩放、配置导入导出 |
| [14 快捷键速查](basics/14-shortcuts.md) | 完整快捷键清单与自定义 |

### 功能库（右键即达的工具箱）

功能库共 83 项内置功能，按分组收录；每个工具一篇，含入口、参数、步骤、输出与注意事项。

| 分组 | 工具 |
|---|---|
| [PDF 处理](tools/pdf/) | [合并为 PDF](tools/pdf/merge.md) · [按文件夹合并](tools/pdf/merge-folders.md) · [拆分](tools/pdf/split.md) · [提取页](tools/pdf/extract.md) · [删除页](tools/pdf/remove.md) · [旋转](tools/pdf/rotate.md) · [轻压缩](tools/pdf/compress.md) · [加水印](tools/pdf/watermark.md) · [插入空白页](tools/pdf/insert-blank.md) · [转图片](tools/pdf/to-png.md) · [加密](tools/pdf/encrypt.md) · [解密](tools/pdf/decrypt.md) |
| [图片处理](tools/images/) | [压缩](tools/images/compress.md) · [加水印](tools/images/watermark.md) · [格式转换](tools/images/convert.md) · [尺寸调整](tools/images/resize.md) · [宫格拼图](tools/images/montage.md) |
| [办公与表格](tools/office/) | [转为 PDF](tools/office/to-pdf.md) · [清理隐私属性](tools/office/clean.md) · [导出文本 TXT](tools/office/to-txt.md) · [编码转换](tools/office/csv-convert.md) · [行尾转换](tools/office/eol-convert.md) · [CSV 合并](tools/office/csv-merge.md) · [Excel 合并](tools/office/xlsx-merge.md) · [Excel 拆分](tools/office/xlsx-split.md) · [文本合并](tools/office/text-merge.md) · [导出文件清单](tools/office/export-list.md) · [批量重命名](tools/office/batch-rename.md) · [批量新建文件夹](tools/office/new-folders.md) · [压缩](tools/office/archive.md) · [按规则归类](tools/office/organize.md) |
| [磁盘工具](tools/disk/) | [解压到此处 / 解压到…](tools/disk/extract.md) · [查找重复文件](tools/disk/duplicates.md) · [清理空文件/空文件夹](tools/disk/find-empty.md) · [空间分析](tools/disk/dir-sizes.md) · [文件夹比较](tools/disk/compare-folders.md) |
| [工具箱](tools/kit/) | [计算校验值](tools/kit/hash-calc.md) · [校验核对](tools/kit/hash-verify.md) · [修改时间与属性](tools/kit/file-touch.md) · [创建链接](tools/kit/create-link.md) · [文件分割](tools/kit/file-split.md) · [文件合并](tools/kit/file-combine.md) |
| [文件与标记](tools/files/) | [复制路径与名称](tools/files/copy-path.md) · [颜色标记 / 收藏夹 / 暂存区 / 终端](tools/files/tags.md) |

## 如何使用手册

- 所有路径示例均基于手册自带的演示目录（含 `01 项目资料`、`02 财务报表`、`03 图片素材` 等虚构文件夹）。
- 快捷键默认值如 `Space`（预览）、`Ctrl+Shift+F`（全盘搜索）等均可在 **设置 → 快捷键** 中自定义。
- 工具对选中项有**条件可见性**（对象类型 / 数量 / 扩展名），右键菜单里看不到某个工具时，先检查选中的文件是否符合条件；也可以在**功能库**里修改这些条件。

## 约定

- 「旁写」指输出为新文件、绝不覆盖原件（如 `报告_压缩.pdf`）。
- 「灵动岛」指顶栏中央的胶囊条，承载任务进度与操作回执。
- 「窗格」指主界面里的每个文件浏览区，可无限分裂。
