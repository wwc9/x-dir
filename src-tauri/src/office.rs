//! Office 文档处理：转 PDF（PowerShell + COM，调用用户已装的 Office/WPS，不打包
//! 任何转换引擎——AGPL 系（MuPDF/Ghostscript/LibreOffice 本体）是开源硬红线）、
//! OOXML 隐私属性清理（zip 重打包，旁写 *_清洁.<ext>）、导出文本 TXT
//! （复用快速预览的 OOXML/ODF 抽取）。
//! 全部经任务引擎执行：逐文件进度 + 取消检查。

use std::io::{Cursor, Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;

use zip::ZipArchive;
use zip::write::SimpleFileOptions;

use crate::fs::path::{file_name_of, join_name, parent_of, to_extended};
use crate::jobs::{EmitterState, FailItem, JobProgress, is_cancelled};

fn stem_of(path: &str) -> String {
    let name = file_name_of(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name,
    }
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

// ────────────────────────── Office → PDF（PowerShell COM） ──────────────────────────

/// Office 文档类型（决定 COM ProgID 与导出脚本）
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum OfficeKind {
    Word,
    Excel,
    PowerPnt,
}

pub(crate) fn office_kind(path: &str) -> Option<OfficeKind> {
    match ext_of(path).as_str() {
        // 2026-10-18 起 .wps/.et/.dps（WPS 自有格式）与 .pps 一并纳入：
        // COM 双引擎（Office 优先 / KWPS 系回退）可直接打开转换
        "doc" | "docx" | "docm" | "rtf" | "wps" => Some(OfficeKind::Word),
        "xls" | "xlsx" | "xlsm" | "xlsb" | "et" => Some(OfficeKind::Excel),
        "ppt" | "pptx" | "pptm" | "pps" | "dps" => Some(OfficeKind::PowerPnt),
        _ => None,
    }
}

/// PowerShell 单引号字符串转义（'' = 字面 '）
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 生成单文件转换脚本：优先 Microsoft Office COM，ProgID 探测失败回退 WPS
/// （KWPS/KET/KWPP）。dst 须为绝对路径；脚本内任何错误都终止（ErrorActionPreference）。
pub(crate) fn ps_convert_script(src: &str, dst: &str, kind: OfficeKind) -> String {
    let s = ps_quote(src);
    let d = ps_quote(dst);
    let (progids, body) = match kind {
        OfficeKind::Word => (
            vec!["Word.Application", "KWPS.Application"],
            // ExportAsFixedFormat 17 = wdExportFormatPDF；只读打开防改源
            format!(
                "$doc=$app.Documents.Open({s},$false,$true);$doc.ExportAsFixedFormat({d},17);$doc.Close($false)"
            ),
        ),
        OfficeKind::Excel => (
            vec!["Excel.Application", "KET.Application"],
            // 0 = xlTypePDF
            format!(
                "$wb=$app.Workbooks.Open({s},0,$true);$wb.ExportAsFixedFormat(0,{d});$wb.Close($false)"
            ),
        ),
        OfficeKind::PowerPnt => (
            // PowerPoint 无 Visible=$false 用法；WithWindow=$false 后台打开
            vec!["PowerPoint.Application", "KWPP.Application"],
            format!(
                "$p=$app.Presentations.Open({s},$true,$false,$false);$p.SaveAs({d},32);$p.Close()"
            ),
        ),
    };
    let ids = progids
        .iter()
        .map(|id| format!("'{}'", id))
        .collect::<Vec<_>>()
        .join(",");
    let quit = "$app.Quit()";
    format!(
        "$ErrorActionPreference='Stop'; $app=$null; foreach ($id in @({ids})) {{ \
         if (-not $app) {{ try {{ $app=New-Object -ComObject $id }} catch {{}} }} }}; \
         if ($app) {{ {body}; {quit} }} else {{ throw 'no-office' }}"
    )
}

fn spawn_powershell(script: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("无法启动 PowerShell：{e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = stderr.lines().last().unwrap_or("PowerShell 转换失败");
    if msg.contains("no-office") {
        return Err("未检测到 Microsoft Office 或 WPS（需已安装其一）".into());
    }
    Err(msg.to_string())
}

/// 单文件 → PDF（可复用核心：快速预览的 doc/ppt 转 PDF 通道同用，2026-10-18）。
/// dst 须为绝对路径；只读打开防改源。
pub(crate) fn convert_to_pdf_file(src: &str, dst: &str, kind: OfficeKind) -> Result<(), String> {
    if !Path::new(&to_extended(src)).is_file() {
        return Err("文件不存在".into());
    }
    let script = ps_convert_script(
        &to_extended(src).to_string_lossy(),
        &to_extended(dst).to_string_lossy(),
        kind,
    );
    spawn_powershell(&script)?;
    if !Path::new(&to_extended(dst)).is_file() {
        return Err("转换未产出文件".into());
    }
    Ok(())
}

/// Office → PDF：每文件旁写 "<stem>.pdf"（同目录）；逐文件进度 + 取消。
/// 注意：COM 转换不可强杀，取消在文件边界生效（当前文件会转完）。
pub(crate) fn run_office_to_pdf(
    paths: &[String],
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        let result = (|| -> Result<(), String> {
            let kind = office_kind(p).ok_or("不支持的 Office 格式")?;
            let dst = format!(
                "{}\\{}.pdf",
                parent_of(p).unwrap_or_else(|| ".".into()),
                stem_of(p)
            );
            convert_to_pdf_file(p, &dst, kind)
        })();
        if let Err(e) = result {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

// ────────────────────────── OOXML 隐私属性清理 ──────────────────────────

/// 抹掉 XML 中指定标签的内部文本（保留元素结构，Word/Excel 重开自动补默认值）。
/// 只处理简单情形：`<tag ...>text</tag>`；自闭合/缺失标签原样保留。
fn blank_xml_tags(xml: &str, tags: &[&str]) -> String {
    let mut s = xml.to_string();
    for tag in tags {
        let open_prefix = format!("<{tag}");
        let close = format!("</{tag}>");
        let mut pos = 0;
        while let Some(found) = s[pos..].find(&open_prefix) {
            let start = pos + found;
            // 确认是元素开头（后随空格/'>'/'/'），避免误命中 <tagX
            let after = s[start + open_prefix.len()..].chars().next();
            if !matches!(after, Some(' ') | Some('>') | Some('/')) {
                pos = start + open_prefix.len();
                continue;
            }
            let Some(gt) = s[start..].find('>') else {
                break;
            };
            let content_start = start + gt + 1;
            let Some(rel_end) = s[content_start..].find(&close) else {
                break;
            };
            let content_end = content_start + rel_end;
            s.replace_range(content_start..content_end, "");
            pos = content_start;
        }
    }
    s
}

/// docProps/core.xml：作者/最后修改者/标题/主题/关键词/描述/修订号/创建与修改时间
fn clean_core_xml(xml: &str) -> String {
    blank_xml_tags(
        xml,
        &[
            "dc:creator",
            "cp:lastModifiedBy",
            "dc:title",
            "dc:subject",
            "cp:keywords",
            "dc:description",
            "cp:revision",
            "dcterms:created",
            "dcterms:modified",
        ],
    )
}

/// docProps/app.xml：公司/管理器（程序名、模板等结构性信息保留）
fn clean_app_xml(xml: &str) -> String {
    blank_xml_tags(xml, &["Company", "Manager"])
}

/// OOXML（zip 容器）清理：重写 docProps/core.xml 与 app.xml，其余成员原样复制
pub(crate) fn clean_ooxml_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut src = ZipArchive::new(Cursor::new(data)).map_err(|e| format!("OOXML 解析失败：{e}"))?;
    let mut buf = Cursor::new(Vec::new());
    {
        let mut out = zip::ZipWriter::new(&mut buf);
        for i in 0..src.len() {
            let mut file = src.by_index(i).map_err(|e| e.to_string())?;
            let name = file.name().to_string();
            if file.is_dir() {
                continue;
            }
            let mut bytes = Vec::with_capacity(file.size() as usize);
            file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            let cleaned = match name.as_str() {
                "docProps/core.xml" => {
                    clean_core_xml(&String::from_utf8_lossy(&bytes)).into_bytes()
                }
                "docProps/app.xml" => clean_app_xml(&String::from_utf8_lossy(&bytes)).into_bytes(),
                _ => bytes,
            };
            out.start_file(
                name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(|e| format!("zip 写入失败：{e}"))?;
            out.write_all(&cleaned).map_err(|e| e.to_string())?;
        }
        out.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

/// 隐私属性清理：OOXML 旁写 "<stem>_清洁.<ext>"，其余格式报失败
pub(crate) fn run_clean_meta(
    paths: &[String],
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    const OOXML_EXTS: [&str; 9] = [
        "docx", "docm", "xlsx", "xlsm", "xlsb", "pptx", "pptm", "odt", "ods",
    ];
    prog.total_files = paths.len() as u64;
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        let result = (|| -> Result<(), String> {
            let ext = ext_of(p);
            if !OOXML_EXTS.contains(&ext.as_str()) {
                return Err("仅支持 OOXML 容器（docx/xlsx/pptx 等）".into());
            }
            let data = std::fs::read(to_extended(p)).map_err(|e| e.to_string())?;
            let cleaned = clean_ooxml_bytes(&data)?;
            let out = format!(
                "{}\\{}_清洁.{}",
                parent_of(p).unwrap_or_else(|| ".".into()),
                stem_of(p),
                ext
            );
            std::fs::write(to_extended(&out), cleaned).map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

// ────────────────────────── 导出文本 TXT ──────────────────────────

/// 抽取一份文档的纯文本（复用快速预览的抽取管线；阻塞包装 async 命令实现）
fn extract_text(path: &str) -> Result<String, String> {
    let office = tauri::async_runtime::block_on(crate::commands::preview::preview_extract_office(
        path.to_string(),
    ))?;
    let mut s = String::new();
    for sec in &office.sections {
        if !sec.title.is_empty() {
            s.push_str(&format!("【{}】\r\n", sec.title));
        }
        s.push_str(&sec.text);
        s.push_str("\r\n\r\n");
    }
    Ok(s)
}

/// 导出文本：每份文档旁写 "<stem>.txt"（已存在则自动改名，不覆盖）
pub(crate) fn run_extract_text(
    paths: &[String],
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        let result = (|| -> Result<(), String> {
            let text = extract_text(p)?;
            if text.trim().is_empty() {
                return Err("未抽取到文本（扫描件或空文档）".into());
            }
            let dir = parent_of(p).unwrap_or_else(|| ".".into());
            let target = join_name(&dir, &format!("{}.txt", stem_of(p)));
            let target = crate::jobs::pick::available_name(&target);
            std::fs::write(to_extended(&target), text).map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn office_kind_maps_extensions() {
        assert_eq!(office_kind("a.DOCX"), Some(OfficeKind::Word));
        assert_eq!(office_kind("b.xls"), Some(OfficeKind::Excel));
        assert_eq!(office_kind("c.ppt"), Some(OfficeKind::PowerPnt));
        assert_eq!(office_kind("d.pdf"), None);
        assert_eq!(office_kind("e.txt"), None);
    }

    #[test]
    fn ps_script_escapes_quotes_and_selects_engine() {
        let script = ps_convert_script("C:\\a b'c.docx", "C:\\out.pdf", OfficeKind::Word);
        // 单引号转义
        assert!(script.contains("a b''c.docx"));
        // 双引擎回退结构：Word 失败试 KWPS
        assert!(script.contains("Word.Application"));
        assert!(script.contains("KWPS.Application"));
        let ppt = ps_convert_script("C:\\x.pptx", "C:\\y.pdf", OfficeKind::PowerPnt);
        assert!(ppt.contains("PowerPoint.Application"));
        assert!(ppt.contains("KWPP.Application"));
    }

    #[test]
    fn blank_xml_tags_strips_content_keeps_structure() {
        let xml = r#"<cp:coreProperties><dc:creator>张三</dc:creator><cp:lastModifiedBy>李四</cp:lastModifiedBy><dc:title>底稿</dc:title></cp:coreProperties>"#;
        let out = blank_xml_tags(xml, &["dc:creator", "cp:lastModifiedBy", "dc:title"]);
        assert!(out.contains("<dc:creator></dc:creator>"));
        assert!(out.contains("<cp:lastModifiedBy></cp:lastModifiedBy>"));
        assert!(out.contains("<dc:title></dc:title>"));
        assert!(!out.contains("张三"));
        // 带属性与缺失标签：原样保留
        let xml2 = r#"<dcterms:created xsi:type="dcterms:W3CDTF">2024-01-01</dcterms:created><dc:foo>keep</dc:foo>"#;
        let out2 = blank_xml_tags(xml2, &["dcterms:created", "dc:bar"]);
        assert!(out2.contains("<dcterms:created xsi:type=\"dcterms:W3CDTF\"></dcterms:created>"));
        assert!(out2.contains("keep"));
    }

    #[test]
    fn clean_ooxml_rewrites_props_and_keeps_other_members() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            w.start_file("docProps/core.xml", SimpleFileOptions::default())
                .unwrap();
            w.write_all("<x><dc:creator>张三</dc:creator></x>".as_bytes())
                .unwrap();
            w.start_file("docProps/app.xml", SimpleFileOptions::default())
                .unwrap();
            w.write_all(b"<x><Company>ACME</Company><Manager>B</Manager></x>")
                .unwrap();
            w.start_file("word/document.xml", SimpleFileOptions::default())
                .unwrap();
            w.write_all(b"<w:document/>").unwrap();
            w.finish().unwrap();
        }
        let data = buf.into_inner();
        let cleaned = clean_ooxml_bytes(&data).unwrap();
        let mut arc = ZipArchive::new(Cursor::new(cleaned)).unwrap();
        let core = String::from_utf8({
            let mut f = arc.by_name("docProps/core.xml").unwrap();
            let mut v = Vec::new();
            f.read_to_end(&mut v).unwrap();
            v
        })
        .unwrap();
        assert!(!core.contains("张三"));
        assert!(core.contains("<dc:creator></dc:creator>"));
        let app = String::from_utf8({
            let mut f = arc.by_name("docProps/app.xml").unwrap();
            let mut v = Vec::new();
            f.read_to_end(&mut v).unwrap();
            v
        })
        .unwrap();
        assert!(!app.contains("ACME"));
        let doc = String::from_utf8({
            let mut f = arc.by_name("word/document.xml").unwrap();
            let mut v = Vec::new();
            f.read_to_end(&mut v).unwrap();
            v
        })
        .unwrap();
        assert_eq!(doc, "<w:document/>");
    }
}
