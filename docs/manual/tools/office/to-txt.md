# 办公 · 导出文本 TXT

抽取文档纯文本，复用快速预览的抽取管线（纯 Rust，零外部依赖）。

## 入口

选中 **文档**（docx/docm/pptx/pptm/xlsx/xlsm/xlsb/xls/ods/epub，可多选批量）→ 右键 →「导出文本 TXT」。

## 步骤

1. 选中文档 →「导出文本 TXT」；
2. 直接执行；
3. 输出旁写 `<同名>.txt`。

## 输出与注意

- Word 抽正文段落，Excel 抽各工作表单元格文本，PPT 抽各页文本框，epub 抽章节文本；
- 不需要安装 Office/WPS——抽取与预览共用同一套纯 Rust 管线；
- 输出 UTF-8 编码；想要带格式对照的转换（保版式）请用[转为 PDF](to-pdf.md)。
