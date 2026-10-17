// 快速预览（V2 立项）：纯 Rust 口径 —— 文本编码探测直读 + OOXML/ODF 文本抽取。
// 全部抽取/解码逻辑拆为纯函数（§6 必须 cargo test），IO 只在 command 入口；
// 不依赖外部进程（LibreOffice/Office/WPS 转换链为 V2 备选，未启用）。

use std::io::{Cursor, Read};
use std::path::Path;

use serde::Serialize;

/// preview_read_text 返回：解码后的文本 + 截断/编码标记
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewText {
    pub content: String,
    pub truncated: bool,
    /// "UTF-8" | "UTF-16LE" | "UTF-16BE" | "GB18030" | "binary"
    pub encoding: String,
    /// 前 8KB 出现 NUL = 二进制文件，不作为文本预览
    pub binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeSection {
    /// docx = "正文"；pptx = "幻灯片 N"；表格 = 工作表名
    pub title: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeText {
    /// "docx" | "slides" | "sheet" | "epub"
    pub kind: String,
    pub sections: Vec<OfficeSection>,
    /// 任一 section 截断，或 section 数被裁剪
    pub truncated: bool,
}

const TEXT_SNIFF: usize = 8192;
const OFFICE_FILE_CAP: u64 = 100 * 1024 * 1024;
const TEXT_READ_CAP: u32 = 8 * 1024 * 1024;
const SECTION_CHAR_CAP: usize = 128 * 1024;
const SHEET_ROW_CAP: usize = 2000;
const SECTION_CAP: usize = 50;

// ────────────────────────── 文本直读 ──────────────────────────

/// 前 TEXT_SNIFF 字节出现 NUL 视为二进制（纯函数）
pub fn sniff_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(TEXT_SNIFF).any(|&b| b == 0)
}

/// 编码探测 + 解码（纯函数）：BOM（UTF-8/16LE/16BE）→ 严格 UTF-8 → GB18030（GBK 超集）。
/// 截断切在多字节字符中间时 encoding_rs 产生尾部 U+FFFD，裁掉以保证边界整洁。
pub fn decode_text(bytes: &[u8]) -> (&'static str, String) {
    let (cow, enc, had_errors) = encoding_rs::UTF_8.decode(bytes);
    if !had_errors {
        return (enc.name(), cow.into_owned());
    }
    let (cow, _, _) = encoding_rs::GB18030.decode(bytes);
    let mut s = cow.into_owned();
    if s.ends_with('\u{FFFD}') {
        s.pop();
    }
    ("GB18030", s)
}

/// 去掉解码尾部因字节截断产生的替换符（纯函数）
fn trim_trailing_replacement(mut s: String) -> String {
    while s.ends_with('\u{FFFD}') {
        s.pop();
    }
    s
}

// 预览命令一律 async：文本截读/OOXML 解压/tar.gz 流过/整档读入都是重 IO，
// 同步命令跑在主线程会直接冻结 UI（Tauri v2 非 async 命令在主线程执行）

#[tauri::command]
pub async fn preview_read_text(path: String, max_bytes: u32) -> Result<PreviewText, String> {
    let cap = max_bytes.min(TEXT_READ_CAP) as u64;
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let total = f.metadata().map_err(|e| e.to_string())?.len();
    let mut raw = Vec::with_capacity(cap.min(total) as usize);
    (&mut f)
        .take(cap)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    let truncated = total > raw.len() as u64;
    if sniff_binary(&raw) {
        return Ok(PreviewText {
            content: String::new(),
            truncated: false,
            encoding: "binary".into(),
            binary: true,
        });
    }
    let (enc, mut content) = decode_text(&raw);
    if truncated {
        content = trim_trailing_replacement(content);
    }
    Ok(PreviewText {
        content,
        truncated,
        encoding: enc.to_string(),
        binary: false,
    })
}

// ────────────────────────── OOXML/ODF 文本抽取 ──────────────────────────

#[tauri::command]
pub async fn preview_extract_office(path: String) -> Result<OfficeText, String> {
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > OFFICE_FILE_CAP {
        return Err("文件超过 100MB，不支持的预览体积".into());
    }
    match ext.as_str() {
        "docx" | "docm" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            let (text, truncated) = docx_text(&data)?;
            Ok(OfficeText {
                kind: "docx".into(),
                sections: vec![OfficeSection {
                    title: "正文".into(),
                    text,
                    truncated,
                }],
                truncated,
            })
        }
        "pptx" | "pptm" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            let (sections, truncated) = pptx_slides(&data)?;
            Ok(OfficeText {
                kind: "slides".into(),
                sections,
                truncated,
            })
        }
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => {
            let (mut sections, truncated) = sheet_sections(&path)?;
            if sections.is_empty() {
                sections.push(OfficeSection {
                    title: "（无工作表）".into(),
                    text: String::new(),
                    truncated: false,
                });
            }
            Ok(OfficeText {
                kind: "sheet".into(),
                sections,
                truncated,
            })
        }
        "epub" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            let (sections, truncated) = epub_chapters(&data)?;
            Ok(OfficeText {
                kind: "epub".into(),
                sections,
                truncated,
            })
        }
        other => Err(format!("不支持的预览格式：.{other}")),
    }
}

// ────────────────────────── TIFF → PNG data URL ──────────────────────────

const TIFF_PIXEL_CAP: u64 = 16_000_000;

/// TIFF 解码为 PNG data URL（走图片预览通道；16MP 上限防超大扫描件撑爆内存）
pub fn tiff_to_png_data_url<R: std::io::Read + std::io::Seek>(reader: R) -> Result<String, String> {
    use tiff::decoder::DecodingResult;
    let mut dec = tiff::decoder::Decoder::new(reader).map_err(|e| format!("TIFF 解析失败：{e}"))?;
    let (w, h) = dec
        .dimensions()
        .map_err(|e| format!("TIFF 尺寸读取失败：{e}"))?;
    if w as u64 * h as u64 > TIFF_PIXEL_CAP || w == 0 || h == 0 {
        return Err("TIFF 尺寸过大（超 16MP），不支持预览".into());
    }
    let color = dec.colortype().map_err(|e| e.to_string())?;
    let rgba: Vec<u8> = match dec
        .read_image()
        .map_err(|e| format!("TIFF 解码失败：{e}"))?
    {
        DecodingResult::U8(v) => match color {
            tiff::ColorType::RGBA(8) => v,
            tiff::ColorType::RGB(8) => v
                .as_chunks::<3>()
                .0
                .iter()
                .flat_map(|px| [px[0], px[1], px[2], 255])
                .collect(),
            tiff::ColorType::Gray(8) => v.into_iter().flat_map(|g| [g, g, g, 255]).collect(),
            _ => return Err("不支持的 TIFF 色彩空间".into()),
        },
        _ => return Err("不支持的 TIFF 位深（仅 8bit）".into()),
    };
    let mut out = Cursor::new(Vec::new());
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().map_err(|e| e.to_string())?;
    writer
        .write_image_data(&rgba)
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    drop(writer); // 归还 &mut out 后才能取缓冲区
    Ok(crate::icons::png_data_url(&out.into_inner()))
}

#[tauri::command]
pub async fn preview_tiff_data_url(path: String) -> Result<String, String> {
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    tiff_to_png_data_url(file)
}

/// 读取 zip 内单个文本条目（OOXML 部件均为 UTF-8）
fn zip_read_entry(data: &[u8], name: &str) -> Result<String, String> {
    let mut z =
        zip::ZipArchive::new(Cursor::new(data)).map_err(|e| format!("容器解析失败：{e}"))?;
    let mut f = z
        .by_name(name)
        .map_err(|e| format!("缺少部件 {name}：{e}"))?;
    let mut s = String::new();
    f.read_to_string(&mut s).map_err(|e| e.to_string())?;
    Ok(s)
}

/// docx → 正文文本：word/document.xml，段落 = w:p，文本 = w:t，w:tab/w:br 保留
pub fn docx_text(data: &[u8]) -> Result<(String, bool), String> {
    let xml = zip_read_entry(data, "word/document.xml")?;
    Ok(xml_paragraphs(&xml, "p", "t", SECTION_CHAR_CAP))
}

/// pptx → 每页一节：ppt/slides/slideN.xml 按 N 排序，段落 = a:p，文本 = a:t
pub fn pptx_slides(data: &[u8]) -> Result<(Vec<OfficeSection>, bool), String> {
    let z = zip::ZipArchive::new(Cursor::new(data)).map_err(|e| format!("容器解析失败：{e}"))?;
    let mut nums: Vec<u32> = z
        .file_names()
        .filter_map(|n| {
            n.strip_prefix("ppt/slides/")?
                .strip_suffix(".xml")?
                .strip_prefix("slide")?
                .parse()
                .ok()
        })
        .collect();
    nums.sort_unstable();
    nums.truncate(SECTION_CAP);
    let mut sections = Vec::with_capacity(nums.len());
    for n in &nums {
        let xml = zip_read_entry(data, &format!("ppt/slides/slide{n}.xml"))?;
        let (text, truncated) = xml_paragraphs(&xml, "p", "t", SECTION_CHAR_CAP);
        sections.push(OfficeSection {
            title: format!("幻灯片 {n}"),
            text,
            truncated,
        });
    }
    let over = z
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/") && n.ends_with(".xml"))
        .count()
        > SECTION_CAP;
    Ok((sections, over))
}

/// 表格 → 每个工作表一节（xlsx/xlsm/xlsb/xls/ods 统一走 calamine）
fn sheet_sections(path: &str) -> Result<(Vec<OfficeSection>, bool), String> {
    use calamine::Reader as _;
    let mut wb = calamine::open_workbook_auto(path).map_err(|e| format!("表格解析失败：{e}"))?;
    let names = wb.sheet_names();
    let capped = names.len() > SECTION_CAP;
    let mut sections = Vec::new();
    for name in names.iter().take(SECTION_CAP) {
        let range = wb
            .worksheet_range(name)
            .map_err(|e| format!("读取工作表 {name} 失败：{e}"))?;
        let (text, truncated) = range_to_text(&range, SHEET_ROW_CAP, SECTION_CHAR_CAP);
        sections.push(OfficeSection {
            title: name.clone(),
            text,
            truncated,
        });
    }
    Ok((sections, capped))
}

/// 单元格 → 预览文本（纯函数）：整数去小数尾、布尔 TRUE/FALSE、ISO 日期原样
pub fn cell_display(d: &calamine::Data) -> String {
    use calamine::Data;
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => fmt_float(*f),
        Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Data::DateTime(dt) => fmt_float(dt.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => e.to_string(),
    }
}

fn fmt_float(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// 工作表范围 → 制表符分隔文本（纯函数）：行数与字符数双上限
pub fn range_to_text(
    range: &calamine::Range<calamine::Data>,
    max_rows: usize,
    cap_chars: usize,
) -> (String, bool) {
    let mut out = String::new();
    let mut truncated = false;
    for (rows, row) in range.rows().enumerate() {
        if rows >= max_rows || out.len() >= cap_chars {
            truncated = true;
            break;
        }
        let cells: Vec<String> = row.iter().map(cell_display).collect();
        out.push_str(&cells.join("\t"));
        out.push('\n');
    }
    (out, truncated)
}

/// OOXML 标签的本地名比对（LocalName 是 &[u8] 包装；want 为 ASCII 本地名）
fn is_local(name: quick_xml::name::LocalName, want: &str) -> bool {
    name.as_ref() == want.as_bytes()
}

/// OOXML 段落文本抽取（纯函数）：docx(w:p/w:t) 与 pptx(a:p/a:t) 共用。
/// 段落边界 = 标签结束/自闭合；w:tab→\t、w:br→\n；实体由解析器解码；
/// 病态 XML 输出已收集部分而非整体失败（预览宽容原则）。
pub fn xml_paragraphs(
    xml: &str,
    para_local: &str,
    text_local: &str,
    cap_chars: usize,
) -> (String, bool) {
    use quick_xml::events::Event;

    let mut r = quick_xml::Reader::from_reader(xml.as_bytes());
    let mut out = String::new();
    let mut in_text = false;
    let mut buf = Vec::new();
    let mut truncated = false;
    loop {
        if out.len() >= cap_chars {
            truncated = true;
            break;
        }
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                if is_local(e.name().local_name(), text_local) {
                    in_text = true;
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.name().local_name();
                if is_local(name, para_local) {
                    out.push('\n');
                } else if is_local(name, "tab") {
                    out.push('\t');
                } else if is_local(name, "br") {
                    out.push('\n');
                }
            }
            Ok(Event::End(e)) => {
                let local = e.name().local_name();
                if is_local(local, text_local) {
                    in_text = false;
                } else if is_local(local, para_local) {
                    out.push('\n');
                }
            }
            Ok(Event::Text(t)) if in_text => {
                if let Ok(s) = t.unescape() {
                    out.push_str(&s);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    // 3+ 连续换行收敛为空行，去掉首尾空白行
    let mut collapsed = String::with_capacity(out.len());
    let mut run = 0usize;
    for ch in out.chars() {
        if ch == '\n' {
            run += 1;
            if run <= 2 {
                collapsed.push(ch);
            }
        } else {
            run = 0;
            collapsed.push(ch);
        }
    }
    (collapsed.trim_matches('\n').to_string(), truncated)
}

/// epub → 章节文本：container.xml → OPF → spine 顺序逐章抽取 XHTML 块级文本
pub fn epub_chapters(data: &[u8]) -> Result<(Vec<OfficeSection>, bool), String> {
    const CHAPTER_CAP: usize = 200;
    let container = zip_read_entry(data, "META-INF/container.xml")?;
    let opf_path =
        xml_attr(&container, "rootfile", "full-path").ok_or("epub 缺少 container.xml rootfile")?;
    let opf = zip_read_entry(data, &opf_path)?;
    // manifest: id → href（仅 xhtml/html）；spine: idref 顺序
    use quick_xml::events::Event;
    let mut id_to_href: std::collections::HashMap<String, String> = Default::default();
    let mut spine: Vec<String> = Vec::new();
    let mut scope = ""; // "manifest" | "spine"
    let mut r = quick_xml::Reader::from_reader(opf.as_bytes());
    let mut buf = Vec::new();
    loop {
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                let local = e.name().local_name();
                if is_local(local, "manifest") {
                    scope = "manifest";
                } else if is_local(local, "spine") {
                    scope = "spine";
                } else if scope == "manifest" && is_local(local, "item") {
                    let (id, href, mt) = (
                        xml_attr_el(&e, "id"),
                        xml_attr_el(&e, "href"),
                        xml_attr_el(&e, "media-type").unwrap_or_default(),
                    );
                    if let (Some(id), Some(href)) = (id, href)
                        && (mt.contains("html")
                            || href.to_lowercase().ends_with(".xhtml")
                            || href.to_lowercase().ends_with(".html"))
                    {
                        id_to_href.insert(id, href);
                    }
                } else if scope == "spine"
                    && is_local(local, "itemref")
                    && let Some(idref) = xml_attr_el(&e, "idref")
                    && let Some(href) = id_to_href.get(&idref)
                {
                    spine.push(href.clone());
                }
            }
            Ok(Event::End(e)) => {
                let local = e.name().local_name();
                if is_local(local, "manifest") || is_local(local, "spine") {
                    scope = "";
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    if spine.is_empty() {
        return Err("epub 缺少有效章节（spine 为空）".into());
    }
    let capped = spine.len() > CHAPTER_CAP;
    let (opf_dir, _) = match opf_path.rsplit_once('/') {
        Some((d, _)) => (d, true),
        None => ("", false),
    };
    let mut sections = Vec::new();
    let mut any_truncated = false;
    for (i, href) in spine.iter().take(CHAPTER_CAP).enumerate() {
        let full = if opf_dir.is_empty() {
            href.clone()
        } else {
            format!("{opf_dir}/{href}")
        };
        // 单章缺失不整体失败（预览宽容原则）
        let Ok(xml) = zip_read_entry(data, &full) else {
            continue;
        };
        let (text, truncated) = xml_blocks_text(
            &xml,
            &[
                "p",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "li",
                "blockquote",
                "dd",
                "dt",
            ],
            &["script", "style"],
            SECTION_CHAR_CAP,
        );
        any_truncated |= truncated;
        sections.push(OfficeSection {
            title: format!("第 {} 节", i + 1),
            text,
            truncated,
        });
    }
    Ok((sections, any_truncated || capped))
}

/// 提取 XML 元素属性值（OPF/容器等简单 XML；实体不常见，按 UTF-8 直取）
fn xml_attr_el(e: &quick_xml::events::BytesStart, name: &str) -> Option<String> {
    for a in e.attributes() {
        let a = a.ok()?;
        if a.key.local_name().as_ref() == name.as_bytes() {
            return Some(String::from_utf8_lossy(&a.value).into_owned());
        }
    }
    None
}

/// 从 XML 文本中提取指定元素名的属性值（首个命中）
fn xml_attr(xml: &str, tag_local: &str, attr_name: &str) -> Option<String> {
    use quick_xml::events::Event;
    let mut r = quick_xml::Reader::from_reader(xml.as_bytes());
    let mut buf = Vec::new();
    loop {
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                if is_local(e.name().local_name(), tag_local)
                    && let Some(v) = xml_attr_el(&e, attr_name)
                {
                    return Some(v);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

/// XHTML 块级文本抽取（epub 章节用，纯函数）：para_tags 任意命中 = 段落边界；
/// skip_tags 内文本丢弃（script/style）；裸 Text 非空白即收集
pub fn xml_blocks_text(
    xml: &str,
    para_tags: &[&str],
    skip_tags: &[&str],
    cap_chars: usize,
) -> (String, bool) {
    use quick_xml::events::Event;

    let is_para = |n: quick_xml::name::LocalName| para_tags.iter().any(|t| is_local(n, t));
    let is_skip = |n: quick_xml::name::LocalName| skip_tags.iter().any(|t| is_local(n, t));
    let mut r = quick_xml::Reader::from_reader(xml.as_bytes());
    let mut out = String::new();
    let mut skip_depth = 0usize;
    let mut buf = Vec::new();
    let mut truncated = false;
    loop {
        if out.len() >= cap_chars {
            truncated = true;
            break;
        }
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = e.name().local_name();
                if is_skip(local) {
                    skip_depth += 1;
                } else if is_para(local) && !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            Ok(Event::End(e)) => {
                let local = e.name().local_name();
                if is_skip(local) {
                    skip_depth = skip_depth.saturating_sub(1);
                } else if is_para(local) {
                    out.push('\n');
                }
            }
            Ok(Event::Text(t)) if skip_depth == 0 => {
                if let Ok(s) = t.unescape()
                    && !s.trim().is_empty()
                {
                    out.push_str(s.trim());
                    out.push(' ');
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    let mut collapsed = String::with_capacity(out.len());
    let mut run = 0usize;
    for ch in out.trim().chars() {
        if ch == '\n' {
            run += 1;
            if run <= 2 {
                collapsed.push(ch);
            }
        } else {
            run = 0;
            collapsed.push(ch);
        }
    }
    (collapsed, truncated)
}

// ────────────────────────── 压缩包清单（不解压） ──────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    pub total: usize,
    pub entries: Vec<ArchiveEntry>,
    pub truncated: bool,
}

const ARCHIVE_CAP: usize = 500;
const ARCHIVE_SCAN_HARD_CAP: usize = 20000;

/// 条目名规范化：去开头斜杠、反斜杠统一为正斜杠（zip 规范要求 '/'，脏包兜底）
fn sanitize_entry_name(s: &str) -> String {
    s.trim_start_matches('/').replace('\\', "/")
}

/// 压缩包条目名解码（纯函数）：ASCII 直取 → UTF-8 → GB18030（国内 WinRAR/好压
/// 打的包常以 GBK 存名且不设 UTF-8 标志，zip crate 默认按 CP437 解会乱码）
pub(crate) fn decode_entry_name(raw: &[u8]) -> String {
    if raw.is_ascii() {
        return String::from_utf8_lossy(raw).into_owned();
    }
    if std::str::from_utf8(raw).is_ok() {
        return String::from_utf8_lossy(raw).into_owned();
    }
    let (cow, _, _) = encoding_rs::GB18030.decode(raw);
    cow.into_owned()
}

#[tauri::command]
pub async fn preview_list_archive(path: String) -> Result<ArchiveListing, String> {
    let lower = path.to_ascii_lowercase();
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    if lower.ends_with(".zip") {
        list_zip(file)
    } else if lower.ends_with(".tar") {
        list_tar(file)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        list_tar(std::io::BufReader::new(flate2::read::GzDecoder::new(file)))
    } else if lower.ends_with(".7z") {
        list_7z(&path)
    } else if lower.ends_with(".gz") {
        list_gz(&path, &lower)
    } else if lower.ends_with(".xz") {
        list_xz(&path, &lower)
    } else if lower.ends_with(".bz2") {
        // bz2 格式不存储解压后大小，只给内层名（不引解码依赖）
        let name = lower.strip_suffix(".bz2").unwrap_or("data").to_string();
        Ok(single_archive(&name, 0))
    } else {
        Err("不支持的压缩包格式（支持 zip/tar/tar.gz/7z）".into())
    }
}

fn push_entry(entries: &mut Vec<ArchiveEntry>, name: String, size: u64, is_dir: bool) -> bool {
    if entries.len() >= ARCHIVE_CAP {
        return false;
    }
    if !name.is_empty() {
        entries.push(ArchiveEntry {
            name: sanitize_entry_name(&name),
            size,
            is_dir,
        });
    }
    true
}

fn list_zip<R: std::io::Read + std::io::Seek>(reader: R) -> Result<ArchiveListing, String> {
    let mut z = zip::ZipArchive::new(reader).map_err(|e| format!("zip 解析失败：{e}"))?;
    let total = z.len();
    let mut entries = Vec::new();
    for i in 0..total {
        let f = z
            .by_index_raw(i)
            .map_err(|e| format!("zip 条目读取失败：{e}"))?;
        if !push_entry(
            &mut entries,
            decode_entry_name(f.name_raw()),
            f.size(),
            f.is_dir(),
        ) {
            break;
        }
    }
    Ok(ArchiveListing {
        total,
        entries,
        truncated: total > ARCHIVE_CAP,
    })
}

fn list_tar<R: std::io::Read>(reader: R) -> Result<ArchiveListing, String> {
    let mut ar = tar::Archive::new(reader);
    let mut entries = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    let iter = ar.entries().map_err(|e| format!("tar 解析失败：{e}"))?;
    for e in iter {
        let e = e.map_err(|e| format!("tar 条目读取失败：{e}"))?;
        total += 1;
        if total > ARCHIVE_SCAN_HARD_CAP {
            truncated = true;
            break;
        }
        let name = e.path().map_err(|e| e.to_string())?.display().to_string();
        let size = e.size();
        let is_dir = e.header().entry_type().is_dir();
        if !push_entry(&mut entries, name, size, is_dir) {
            truncated = true;
        }
    }
    Ok(ArchiveListing {
        total,
        entries,
        truncated,
    })
}

fn list_7z(path: &str) -> Result<ArchiveListing, String> {
    let ar = sevenz_rust::Archive::open(path).map_err(|e| format!("7z 解析失败：{e}"))?;
    let files = &ar.files;
    let total = files.len();
    let mut entries = Vec::new();
    for f in files.iter().take(ARCHIVE_CAP) {
        entries.push(ArchiveEntry {
            name: sanitize_entry_name(f.name()),
            size: f.size(),
            is_dir: f.is_directory(),
        });
    }
    Ok(ArchiveListing {
        total,
        entries,
        truncated: total > ARCHIVE_CAP,
    })
}

fn single_archive(name: &str, size: u64) -> ArchiveListing {
    ArchiveListing {
        total: 1,
        entries: vec![ArchiveEntry {
            name: name.to_string(),
            size,
            is_dir: false,
        }],
        truncated: false,
    }
}

/// gzip 单文件：内层名取 FNAME 头字段（无则去 .gz 后缀），大小取尾部 ISIZE（mod 2^32）
fn gz_probe(
    header: &[u8],
    isize_tail: [u8; 4],
    fallback_name: &str,
) -> Result<(String, u64), String> {
    if header.len() < 10 || header[0] != 0x1f || header[1] != 0x8b || header[2] != 8 {
        return Err("非 gzip 文件".into());
    }
    let flags = header[3];
    let mut pos = 10usize;
    let mut name = String::new();
    if flags & 4 != 0 {
        // FEXTRA
        if pos + 2 > header.len() {
            return Err("gzip 头损坏".into());
        }
        let xlen = u16::from_le_bytes([header[pos], header[pos + 1]]) as usize;
        pos += 2 + xlen;
    }
    if flags & 8 != 0 && pos < header.len() {
        // FNAME（null 结尾）
        let start = pos;
        while pos < header.len() && header[pos] != 0 {
            pos += 1;
        }
        name = String::from_utf8_lossy(&header[start..pos]).into_owned();
    }
    if name.is_empty() {
        name = fallback_name
            .strip_suffix(".gz")
            .unwrap_or(fallback_name)
            .to_string();
    }
    Ok((name, u32::from_le_bytes(isize_tail) as u64))
}

fn list_gz(path: &str, _lower: &str) -> Result<ArchiveListing, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < 18 {
        return Err("gzip 文件过小".into());
    }
    let mut header = [0u8; 1024];
    let n = f.read(&mut header).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::End(-4)).map_err(|e| e.to_string())?;
    let mut tail = [0u8; 4];
    f.read_exact(&mut tail).map_err(|e| e.to_string())?;
    let fallback = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "data".into());
    let (name, size) = gz_probe(&header[..n], tail, &fallback)?;
    Ok(single_archive(&sanitize_entry_name(&name), size))
}

/// xz：从 Stream Footer 的 Backward Size 定位 Index，取末条记录的解压后大小（varint）
fn xz_index_size(footer: &[u8; 12], index: &[u8]) -> Result<u64, String> {
    if &footer[10..12] != b"YZ" {
        return Err("非 xz 文件".into());
    }
    let backward = (u32::from_le_bytes(footer[4..8].try_into().unwrap()) as usize + 1) * 4;
    if index.len() < backward || backward < 4 {
        return Err("xz 索引损坏".into());
    }
    let idx = &index[..backward];
    if idx.first() != Some(&0) {
        return Err("xz 索引指示符异常".into());
    }
    let mut pos = 1usize;
    let read_varint = |pos: &mut usize| -> Result<u64, String> {
        let mut v = 0u64;
        let mut shift = 0u32;
        loop {
            let b = *idx.get(*pos).ok_or("xz 索引越界")?;
            *pos += 1;
            v |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
            shift += 7;
            if shift > 63 {
                return Err("xz varint 越界".into());
            }
        }
    };
    let count = read_varint(&mut pos)?;
    if count == 0 || count > 4096 {
        return Err("xz 索引记录数异常".into());
    }
    let mut size = 0u64;
    for _ in 0..count {
        let _padded = read_varint(&mut pos)?;
        size = read_varint(&mut pos)?;
    }
    Ok(size)
}

fn list_xz(path: &str, lower: &str) -> Result<ArchiveListing, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < 32 {
        return Err("xz 文件过小".into());
    }
    f.seek(SeekFrom::End(-12)).map_err(|e| e.to_string())?;
    let mut footer = [0u8; 12];
    f.read_exact(&mut footer).map_err(|e| e.to_string())?;
    if &footer[10..12] != b"YZ" {
        return Err("非 xz 文件".into());
    }
    let backward = (u32::from_le_bytes(footer[4..8].try_into().unwrap()) as usize + 1) * 4;
    let index_end = len as usize - 12;
    if index_end < backward {
        return Err("xz 索引损坏".into());
    }
    f.seek(SeekFrom::Start((index_end - backward) as u64))
        .map_err(|e| e.to_string())?;
    let mut index = vec![0u8; backward];
    f.read_exact(&mut index).map_err(|e| e.to_string())?;
    let size = xz_index_size(&footer, &index)?;
    let name = lower.strip_suffix(".xz").unwrap_or("data").to_string();
    Ok(single_archive(&name, size))
}

// ────────────────────────── 测试（§6 纯逻辑必须带用例） ──────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn mkzip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut cur = Cursor::new(Vec::new());
        let mut z = zip::ZipWriter::new(&mut cur);
        for (name, content) in entries {
            z.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(content.as_bytes()).unwrap();
        }
        z.finish().unwrap();
        cur.into_inner()
    }

    #[test]
    fn decode_utf8_and_bom() {
        let (enc, s) = decode_text("hello 中文".as_bytes());
        assert_eq!(enc, "UTF-8");
        assert_eq!(s, "hello 中文");
        let mut with_bom = vec![0xEF_u8, 0xBB, 0xBF];
        with_bom.extend_from_slice("中文".as_bytes());
        let (enc, s) = decode_text(&with_bom);
        assert_eq!(enc, "UTF-8");
        assert_eq!(s, "中文");
    }

    #[test]
    fn decode_utf16le() {
        // BOM FF FE + "A中"（LE）
        let bytes: &[u8] = &[0xFF, 0xFE, 0x41, 0x00, 0x2D, 0x4E];
        let (enc, s) = decode_text(bytes);
        assert_eq!(enc, "UTF-16LE");
        assert_eq!(s, "A中");
    }

    #[test]
    fn decode_gb18030() {
        // "中文test" 的 GBK 编码
        let bytes: &[u8] = &[0xD6, 0xD0, 0xCE, 0xC4, 0x74, 0x65, 0x73, 0x74];
        let (enc, s) = decode_text(bytes);
        assert_eq!(enc, "GB18030");
        assert_eq!(s, "中文test");
    }

    #[test]
    fn truncation_cuts_clean_char_boundary() {
        // UTF-16LE "A中" 截掉半个字符 → 尾部替换符应被裁掉，保留 "A"
        let bytes: &[u8] = &[0xFF, 0xFE, 0x41, 0x00, 0x2D];
        let (_, s) = decode_text(bytes);
        assert_eq!(s, "A");
        assert!(!s.contains('\u{FFFD}'));
    }

    #[test]
    fn binary_sniff() {
        assert!(sniff_binary(b"MZ\x00\x90"));
        assert!(!sniff_binary("纯文本 no nul".as_bytes()));
    }

    #[test]
    fn docx_paragraphs_and_entities() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> &amp; &lt;world&gt;</w:t></w:r></w:p>
<w:p><w:r><w:t>A<w:tab/>B</w:t></w:r></w:p>
<w:p/>
<w:p><w:r><w:br/><w:t>after</w:t></w:r></w:p>
</w:body></w:document>"#;
        let (text, truncated) = xml_paragraphs(xml, "p", "t", SECTION_CHAR_CAP);
        assert!(!truncated);
        assert_eq!(text, "Hello & <world>\nA\tB\n\nafter");
    }

    #[test]
    fn docx_extraction_from_zip() {
        let data = mkzip(&[
            ("[Content_Types].xml", "<Types/>"),
            (
                "word/document.xml",
                r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>段落一</w:t></w:r></w:p><w:p><w:r><w:t>段落二</w:t></w:r></w:p></w:body></w:document>"#,
            ),
        ]);
        let (text, truncated) = docx_text(&data).unwrap();
        assert!(!truncated);
        assert_eq!(text, "段落一\n段落二");
    }

    #[test]
    fn pptx_slides_sorted_numerically() {
        let data = mkzip(&[
            (
                "ppt/slides/slide10.xml",
                "<p:sld xmlns:p=\"p\" xmlns:a=\"a\"><p:txBody><a:p><a:r><a:t>S10</a:t></a:r></a:p></p:txBody></p:sld>",
            ),
            (
                "ppt/slides/slide2.xml",
                "<p:sld xmlns:p=\"p\" xmlns:a=\"a\"><p:txBody><a:p><a:r><a:t>S2</a:t></a:r></a:p></p:txBody></p:sld>",
            ),
            (
                "ppt/slides/slide1.xml",
                "<p:sld xmlns:p=\"p\" xmlns:a=\"a\"><p:txBody><a:p><a:r><a:t>S1</a:t></a:r></a:p></p:txBody></p:sld>",
            ),
            ("ppt/media/img1.png", "png-bytes"),
        ]);
        let (sections, truncated) = pptx_slides(&data).unwrap();
        assert!(!truncated);
        let titles: Vec<&str> = sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["幻灯片 1", "幻灯片 2", "幻灯片 10"]);
        assert_eq!(sections[2].text, "S10");
    }

    #[test]
    fn paragraphs_cap_marks_truncated() {
        let xml = "<d><p><t>abcdef</t></p><p><t>ghijkl</t></p></d>";
        // 上限检查在事件间进行，多带出一段属预期；关键是 truncated 标记 + 前缀保留
        let (text, truncated) = xml_paragraphs(xml, "p", "t", 8);
        assert!(truncated);
        assert!(text.starts_with("abcdef"));
        assert!(text.len() < 30);
    }

    #[test]
    fn malformed_xml_returns_partial() {
        let (text, _) = xml_paragraphs("<p><t>ok</t></p><p><t>broken", "p", "t", 1024);
        assert!(text.contains("ok"));
    }

    #[test]
    fn range_to_text_formats_cells() {
        use calamine::Data;
        let range = calamine::Range::from_sparse(vec![
            calamine::Cell::new((0, 0), Data::String("名称".into())),
            calamine::Cell::new((0, 1), Data::Float(3.0)),
            calamine::Cell::new((0, 2), Data::Bool(true)),
            calamine::Cell::new((1, 0), Data::Float(2.5)),
            calamine::Cell::new((1, 1), Data::Empty),
        ]);
        let (text, truncated) = range_to_text(&range, 100, 1 << 20);
        assert!(!truncated);
        // 稀疏范围按最宽行补齐空单元格
        assert_eq!(text, "名称\t3\tTRUE\n2.5\t\t\n");
    }

    #[test]
    fn entry_name_sanitized() {
        assert_eq!(sanitize_entry_name("/a/b.txt"), "a/b.txt");
        assert_eq!(sanitize_entry_name("a\\b\\c"), "a/b/c");
        assert_eq!(sanitize_entry_name(""), "");
    }

    #[test]
    fn entry_name_decode_gbk_and_utf8() {
        // ASCII 直取
        assert_eq!(decode_entry_name(b"a/b.txt"), "a/b.txt");
        // 合法 UTF-8 的 CJK 名
        assert_eq!(decode_entry_name("报告.xlsx".as_bytes()), "报告.xlsx");
        // GBK 编码的"报告.xlsx"（无 UTF-8 标志位的国内常见 zip）
        assert_eq!(
            decode_entry_name(&[0xB1, 0xA8, 0xB8, 0xE6, b'.', b'x', b'l', b's', b'x']),
            "报告.xlsx"
        );
    }

    #[test]
    fn tiff_roundtrip_to_png() -> Result<(), Box<dyn std::error::Error>> {
        // tiff crate 编码端生成 2×3 RGBA TIFF，再走解码 → PNG data URL
        let mut tif = Cursor::new(Vec::new());
        {
            let mut enc = tiff::encoder::TiffEncoder::new(&mut tif)?;
            let img = enc.new_image::<tiff::encoder::colortype::RGBA8>(2, 3)?;
            img.write_data(&[
                1u8, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255, 13, 14, 15, 255, 16,
                17, 18, 255,
            ])?;
        }
        let url = tiff_to_png_data_url(Cursor::new(tif.into_inner()))?;
        assert!(url.starts_with("data:image/png;base64,"));
        // PNG 头魔数（base64 of \x89PNG\r\n\x1a）
        assert_eq!(&url[22..30], "iVBORw0K");
        Ok(())
    }

    #[test]
    fn gz_probe_parses_fname_and_isize() {
        // flate2 GzBuilder 带 filename 生成含 FNAME 的真实头
        let mut out = Vec::new();
        {
            let mut w = flate2::GzBuilder::new()
                .filename("日志.txt")
                .write(&mut out, flate2::Compression::fast());
            std::io::Write::write_all(&mut w, b"payload").unwrap();
            w.finish().unwrap();
        }
        let n = out.len();
        let (name, size) = gz_probe(
            &out[..1024.min(n)],
            out[n - 4..].try_into().unwrap(),
            "fallback",
        )
        .unwrap();
        assert_eq!(name, "日志.txt");
        assert_eq!(size, 7);
        // 无 FNAME（flags=0）：回退去 .gz 后缀
        let (name, size) = gz_probe(
            b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03",
            [7, 0, 0, 0],
            "data.gz",
        )
        .unwrap();
        assert_eq!(name, "data");
        assert_eq!(size, 7);
    }

    #[test]
    fn xz_index_size_parses_varint() {
        // 构造 footer + index：backward=12（3 字），1 条记录：unpadded=0x10、uncompressed=0x4000
        let mut index = vec![0u8]; // indicator
        index.push(0x01); // count=1
        index.push(0x10); // unpadded size varint = 16
        index.push(0x40); // uncompressed = 64
        while index.len() % 4 != 0 {
            index.push(0); // padding
        }
        index.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]); // CRC32 占位
        let backward = (index.len() / 4 - 1) as u32;
        let mut footer = [0u8; 12];
        footer[4..8].copy_from_slice(&backward.to_le_bytes());
        footer[10..12].copy_from_slice(b"YZ");
        let size = xz_index_size(&footer, &index).unwrap();
        assert_eq!(size, 64);
        // 非 xz footer
        let mut bad = footer;
        bad[10..12].copy_from_slice(b"NO");
        assert!(xz_index_size(&bad, &index).is_err());
    }

    #[test]
    fn epub_chapters_extracted_in_spine_order() -> Result<(), Box<dyn std::error::Error>> {
        let container = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
        let opf = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<manifest>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="s.css" media-type="text/css"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"#;
        let ch1 = r#"<html><head><style>p{}</style></head><body><h1>第一章</h1><p>你好 &amp; 欢迎阅读</p><script>bad()</script></body></html>"#;
        let ch2 =
            r#"<html><body><p>第二节内容</p><ul><li>条目甲</li><li>条目乙</li></ul></body></html>"#;
        let data = mkzip(&[
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", container),
            ("OEBPS/content.opf", opf),
            ("OEBPS/ch1.xhtml", ch1),
            ("OEBPS/ch2.xhtml", ch2),
        ]);
        let (sections, truncated) = epub_chapters(&data)?;
        assert!(!truncated);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].title, "第 1 节");
        // 实体解码 + style/script 内容被丢弃
        assert!(sections[0].text.contains("你好 & 欢迎阅读"));
        assert!(!sections[0].text.contains("bad()"));
        assert!(!sections[0].text.contains("p{}"));
        assert!(sections[1].text.contains("条目甲"));
        Ok(())
    }

    #[test]
    fn zip_listing_with_dir() -> Result<(), Box<dyn std::error::Error>> {
        let mut cur = Cursor::new(Vec::new());
        let mut z = zip::ZipWriter::new(&mut cur);
        z.add_directory("docs/", zip::write::SimpleFileOptions::default())?;
        z.start_file("docs/a.txt", zip::write::SimpleFileOptions::default())?;
        z.write_all(b"hello")?;
        z.start_file("b.log", zip::write::SimpleFileOptions::default())?;
        z.write_all(b"x")?;
        z.finish()?;
        let listing = list_zip(Cursor::new(cur.into_inner()))?;
        assert!(!listing.truncated);
        assert_eq!(listing.total, 3);
        assert_eq!(listing.entries[0].name, "docs/");
        assert!(listing.entries[0].is_dir);
        assert_eq!(listing.entries[1].name, "docs/a.txt");
        assert_eq!(listing.entries[1].size, 5);
        assert!(!listing.entries[1].is_dir);
        Ok(())
    }

    #[test]
    fn tar_gz_listing() -> Result<(), Box<dyn std::error::Error>> {
        let mut buf = Vec::new();
        let enc = flate2::write::GzEncoder::new(&mut buf, flate2::Compression::fast());
        {
            let mut b = tar::Builder::new(enc);
            let mut h = tar::Header::new_gnu();
            h.set_size(3);
            h.set_entry_type(tar::EntryType::Regular);
            h.set_cksum();
            b.append_data(&mut h, "dir/a.txt", b"abc".as_slice())?;
            let mut h2 = tar::Header::new_gnu();
            h2.set_size(0);
            h2.set_entry_type(tar::EntryType::Directory);
            h2.set_cksum();
            b.append_data(&mut h2, "empty/", std::io::empty())?;
            b.into_inner()?;
        }
        let listing = list_tar(flate2::read::GzDecoder::new(Cursor::new(buf)))?;
        assert!(!listing.truncated);
        assert_eq!(listing.total, 2);
        assert_eq!(listing.entries[0].name, "dir/a.txt");
        assert_eq!(listing.entries[0].size, 3);
        assert!(listing.entries[1].is_dir);
        Ok(())
    }

    #[test]
    fn archive_listing_caps_at_500() -> Result<(), Box<dyn std::error::Error>> {
        let mut cur = Cursor::new(Vec::new());
        let mut z = zip::ZipWriter::new(&mut cur);
        for i in 0..(ARCHIVE_CAP + 50) {
            z.start_file(
                format!("f{i}.txt"),
                zip::write::SimpleFileOptions::default(),
            )?;
            z.write_all(b"x")?;
        }
        z.finish()?;
        let listing = list_zip(Cursor::new(cur.into_inner()))?;
        assert!(listing.truncated);
        assert_eq!(listing.entries.len(), ARCHIVE_CAP);
        assert_eq!(listing.total, ARCHIVE_CAP + 50);
        Ok(())
    }

    #[test]
    fn sevenz_roundtrip_listing() -> Result<(), Box<dyn std::error::Error>> {
        // 借助 sevenz-rust 的压缩端生成真实 7z 再走清单通道
        let dir = std::env::temp_dir().join("xdir-7z-test");
        std::fs::create_dir_all(&dir)?;
        let src = dir.join("src.txt");
        std::fs::write(&src, b"7z probe")?;
        let dest = dir.join("probe.7z");
        sevenz_rust::compress_to_path(&src, &dest)?;
        let listing = list_7z(dest.to_str().ok_or("路径非 UTF-8")?)?;
        assert_eq!(listing.total, 1);
        assert_eq!(listing.entries[0].name, "src.txt");
        assert_eq!(listing.entries[0].size, 8);
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
