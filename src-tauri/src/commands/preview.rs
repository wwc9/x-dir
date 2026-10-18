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

/// 结构化文档块（2026-10-18）：docx/pptx/odt/odp/rtf/eml/msg 的富预览单元。
/// kind = "heading" | "para" | "list" | "table" | "kv" | "note"；
/// level = 标题级别(1-6)/列表缩进层级；rows 仅 table 用；label 仅 kv 用。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfficeBlock {
    pub kind: String,
    pub level: u32,
    pub text: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub rows: Vec<Vec<String>>,
}

impl OfficeBlock {
    fn para(text: String) -> Self {
        Self {
            kind: "para".into(),
            level: 0,
            text,
            label: String::new(),
            rows: Vec::new(),
        }
    }
    fn heading(level: u32, text: String) -> Self {
        Self {
            kind: "heading".into(),
            level,
            text,
            label: String::new(),
            rows: Vec::new(),
        }
    }
    fn list(level: u32, text: String) -> Self {
        Self {
            kind: "list".into(),
            level,
            text,
            label: String::new(),
            rows: Vec::new(),
        }
    }
    fn kv(label: &str, text: String) -> Self {
        Self {
            kind: "kv".into(),
            level: 0,
            text,
            label: label.into(),
            rows: Vec::new(),
        }
    }
    fn table(rows: Vec<Vec<String>>) -> Self {
        Self {
            kind: "table".into(),
            level: 0,
            text: String::new(),
            label: String::new(),
            rows,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeSection {
    /// docx = "正文"；pptx = "幻灯片 N"；表格 = 工作表名
    pub title: String,
    pub text: String,
    pub truncated: bool,
    /// 表格合并单元格（仅 xlsx/xlsm/ods 解析；其余格式为空——calamine 不产合并信息）
    #[serde(default)]
    pub merges: Vec<SheetMerge>,
    /// 结构化块（blocks 非空时前端按块渲染；空则回退 <pre> 纯文本）
    #[serde(default)]
    pub blocks: Vec<OfficeBlock>,
}

impl OfficeSection {
    fn text_only(title: impl Into<String>, text: String, truncated: bool) -> Self {
        Self {
            title: title.into(),
            text,
            truncated,
            merges: Vec::new(),
            blocks: Vec::new(),
        }
    }
}

/// 合并单元格：0 基锚点 + 跨度（serde camelCase → rowSpan/colSpan）
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SheetMerge {
    pub row: u32,
    pub col: u32,
    pub row_span: u32,
    pub col_span: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeText {
    /// "docx" | "slides" | "sheet" | "epub" | "email"
    pub kind: String,
    pub sections: Vec<OfficeSection>,
    /// 任一 section 截断，或 section 数被裁剪
    pub truncated: bool,
    /// epub 封面（PNG data URL，缩到 ≤320×480；无封面/解码失败为 None）
    #[serde(default)]
    pub cover: Option<String>,
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
            let (mut sections, truncated) = docx_sections(&data)?;
            if sections.is_empty() {
                sections.push(OfficeSection::text_only("（空文档）", String::new(), false));
            }
            Ok(OfficeText {
                kind: "docx".into(),
                sections,
                truncated,
                cover: None,
            })
        }
        "pptx" | "pptm" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            let (sections, truncated) = pptx_slides(&data)?;
            Ok(OfficeText {
                kind: "slides".into(),
                sections,
                truncated,
                cover: None,
            })
        }
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => {
            let (mut sections, truncated) = sheet_sections(&path)?;
            if sections.is_empty() {
                sections.push(OfficeSection::text_only(
                    "（无工作表）",
                    String::new(),
                    false,
                ));
            }
            Ok(OfficeText {
                kind: "sheet".into(),
                sections,
                truncated,
                cover: None,
            })
        }
        "epub" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            let (sections, truncated) = epub_chapters(&data)?;
            let cover = epub_cover(&data);
            Ok(OfficeText {
                kind: "epub".into(),
                sections,
                truncated,
                cover,
            })
        }
        // ODF 文字/演示（2026-10-18 补齐；.ods 早已支持）
        "odt" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            odf_text_office(&data)
        }
        "odp" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            odp_slides_office(&data)
        }
        // RTF：控制字剥离的降级文本抽取
        "rtf" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            rtf_office(&data)
        }
        // 邮件原件（2026-10-18）
        "eml" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            eml_office(&data)
        }
        "msg" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            msg_office(&data)
        }
        // WPS 自有扩展名与 ppsx：容器嗅探分流（zip → 按 OOXML/ODF 部件路由；
        // OLE（旧版二进制）→ 明确报错并指引右键转 PDF）
        "et" | "wps" | "dps" | "ppsx" | "ppsm" => {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            sniff_extract(&data, &path)
        }
        // CSV/TSV → 表格网格预览（2026-10-17：原走纯文本，现与 office 表格同管线）
        "csv" | "tsv" => {
            let delim = if ext == "tsv" { '\t' } else { ',' };
            let section = csv_section(&path, delim)?;
            let truncated = section.truncated;
            Ok(OfficeText {
                kind: "sheet".into(),
                sections: vec![section],
                truncated,
                cover: None,
            })
        }
        other => Err(format!("不支持的预览格式：.{other}")),
    }
}

/// 容器嗅探分流（纯函数部分 sniff_container 另测）：zip 按 OOXML/ODF 特征部件路由，
/// OLE 复合文档报错（旧版 WPS/Office 二进制格式不做文本抽取，指引右键转 PDF）
pub(crate) fn sniff_extract(data: &[u8], path: &str) -> Result<OfficeText, String> {
    match sniff_container(data) {
        Sniffed::Docx => {
            let (mut sections, truncated) = docx_sections(data)?;
            if sections.is_empty() {
                sections.push(OfficeSection::text_only("（空文档）", String::new(), false));
            }
            Ok(OfficeText {
                kind: "docx".into(),
                sections,
                truncated,
                cover: None,
            })
        }
        Sniffed::Slides => {
            let (sections, truncated) = pptx_slides(data)?;
            Ok(OfficeText {
                kind: "slides".into(),
                sections,
                truncated,
                cover: None,
            })
        }
        Sniffed::Sheet => {
            let (mut sections, truncated) = sheet_sections(path)?;
            if sections.is_empty() {
                sections.push(OfficeSection::text_only(
                    "（无工作表）",
                    String::new(),
                    false,
                ));
            }
            Ok(OfficeText {
                kind: "sheet".into(),
                sections,
                truncated,
                cover: None,
            })
        }
        Sniffed::Odt => odf_text_office(data),
        Sniffed::Odp => odp_slides_office(data),
        Sniffed::Ods => {
            let (mut sections, truncated) = sheet_sections(path)?;
            if sections.is_empty() {
                sections.push(OfficeSection::text_only(
                    "（无工作表）",
                    String::new(),
                    false,
                ));
            }
            Ok(OfficeText {
                kind: "sheet".into(),
                sections,
                truncated,
                cover: None,
            })
        }
        Sniffed::Opaque => {
            Err("旧版二进制格式（OLE 容器）暂不支持文本预览，可右键「转 PDF」后预览".into())
        }
    }
}

/// 嗅探结果（纯函数，可测）
#[derive(Debug, PartialEq)]
pub(crate) enum Sniffed {
    Docx,
    Slides,
    Sheet,
    Odt,
    Odp,
    Ods,
    Opaque,
}

/// 文件头嗅探（纯函数）：PK = zip 容器按特征部件分流；D0CF11E0 = OLE 复合文档；
/// 其余未知。ODF 靠 mimetype 部件文案判定（读不到时按 Odt 兜底——content.xml
/// 存在但 mimetype 缺失的脏包多见于文字文档）。
pub fn sniff_container(data: &[u8]) -> Sniffed {
    if data.starts_with(b"PK") {
        let Ok(mut z) = zip::ZipArchive::new(Cursor::new(data)) else {
            return Sniffed::Opaque;
        };
        let mut has = |name: &str| z.by_name(name).is_ok();
        if has("word/document.xml") {
            return Sniffed::Docx;
        }
        if has("ppt/presentation.xml") {
            return Sniffed::Slides;
        }
        if has("xl/workbook.xml") {
            return Sniffed::Sheet;
        }
        if has("content.xml") {
            let mime = z
                .by_name("mimetype")
                .ok()
                .map(|mut f| {
                    let mut s = String::new();
                    let _ = f.read_to_string(&mut s);
                    s
                })
                .unwrap_or_default();
            return if mime.contains("spreadsheet") {
                Sniffed::Ods
            } else if mime.contains("presentation") {
                Sniffed::Odp
            } else {
                Sniffed::Odt
            };
        }
        return Sniffed::Opaque;
    }
    if data.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        return Sniffed::Opaque;
    }
    Sniffed::Opaque
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

/// docx 单页产物：blocks 供富渲染，text 为拍平文本（页脚/TXT 导出/搜索同源）
pub struct DocxPage {
    pub blocks: Vec<OfficeBlock>,
    pub text: String,
}

/// pStyle → 标题级别（纯函数）："Heading1"/"heading 2"、中文 Word 的 styleId
/// "1".."6"（标题 1..6）、"Title"/"标题" 视为一级；其余 None
fn heading_level_from_style(style: &str) -> Option<u32> {
    let s = style.trim();
    if s.is_empty() {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    if lower == "title" || s == "标题" {
        return Some(1);
    }
    if let Some(rest) = lower.strip_prefix("heading") {
        let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            return ((1..=9).contains(&n)).then_some(n.min(6));
        }
        return None;
    }
    if s.bytes().all(|b| b.is_ascii_digit()) {
        let n: u32 = s.parse().ok()?;
        return ((1..=6).contains(&n)).then_some(n);
    }
    None
}

/// document.xml → 分页结构化块（纯函数，2026-10-18 重构）：显式分页符
/// （w:br type="page"）与 lastRenderedPageBreak 为页边界；段落按 pStyle/numPr
/// 归类 heading/list/para；w:tbl 整表收集为 table 块（嵌套表拍平进外层）。
/// 段内 w:tab→\t、w:br→\n；实体由解析器解码；病态 XML 输出已收集部分而非
/// 整体失败（预览宽容原则）。行数/页数/块数三重上限，超限 truncated。
pub fn docx_page_blocks(xml: &str, cap_chars: usize, max_pages: usize) -> (Vec<DocxPage>, bool) {
    use quick_xml::events::Event;

    const BLOCK_CAP: usize = 2000;

    // 表格累积器：cell 内段落以空格连接；嵌套表（w:tbl 套 w:tbl）拍平进外层
    struct Tbl {
        rows: Vec<Vec<String>>,
        row: Vec<String>,
        cell: String,
        depth: u32,
    }

    let mut r = quick_xml::Reader::from_reader(xml.as_bytes());
    let mut pages: Vec<DocxPage> = vec![DocxPage {
        blocks: Vec::new(),
        text: String::new(),
    }];
    let mut p_text = String::new();
    let mut p_style = String::new();
    let mut p_list: Option<u32> = None;
    let mut in_text = false;
    let mut pending_break = false;
    let mut truncated = false;
    let mut buf = Vec::new();
    let mut tbl: Option<Tbl> = None;

    macro_rules! page {
        () => {
            pages.last_mut().unwrap()
        };
    }

    loop {
        if page!().text.len() >= cap_chars || page!().blocks.len() >= BLOCK_CAP {
            truncated = true;
            break;
        }
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = e.name().local_name();
                if is_local(local, "t") {
                    in_text = true;
                } else if is_local(local, "p") {
                    p_text.clear();
                    p_style.clear();
                    p_list = None;
                } else if is_local(local, "numPr") {
                    p_list = Some(0);
                } else if is_local(local, "tbl") {
                    match tbl.as_mut() {
                        None => {
                            tbl = Some(Tbl {
                                rows: Vec::new(),
                                row: Vec::new(),
                                cell: String::new(),
                                depth: 1,
                            })
                        }
                        Some(t) => t.depth += 1,
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.name().local_name();
                if is_local(name, "lastRenderedPageBreak") {
                    pending_break = true;
                } else if is_local(name, "br") {
                    let is_page_break = e.attributes().any(|a| {
                        a.as_ref().is_ok_and(|a| {
                            is_local(a.key.local_name(), "type") && a.value.as_ref() == b"page"
                        })
                    });
                    if is_page_break {
                        pending_break = true;
                    }
                    p_text.push('\n');
                } else if is_local(name, "tab") {
                    p_text.push('\t');
                } else if is_local(name, "pStyle") {
                    p_style = xml_attr_el(&e, "val").unwrap_or_default();
                } else if is_local(name, "ilvl")
                    && let Some(v) = xml_attr_el(&e, "val")
                {
                    p_list = Some(v.trim().parse().unwrap_or(0));
                }
            }
            Ok(Event::End(e)) => {
                let local = e.name().local_name();
                if is_local(local, "t") {
                    in_text = false;
                } else if is_local(local, "p") {
                    if let Some(t) = tbl.as_mut() {
                        // 表格单元格内的段落：以空格连接进当前格
                        let seg = p_text.trim();
                        if !seg.is_empty() {
                            if !t.cell.is_empty() {
                                t.cell.push(' ');
                            }
                            t.cell.push_str(seg);
                        }
                    } else {
                        page!().text.push_str(&p_text);
                        page!().text.push('\n');
                        if let Some(lvl) = heading_level_from_style(&p_style) {
                            page!()
                                .blocks
                                .push(OfficeBlock::heading(lvl, p_text.trim().to_string()));
                        } else if let Some(lvl) = p_list {
                            page!()
                                .blocks
                                .push(OfficeBlock::list(lvl, p_text.trim().to_string()));
                        } else {
                            page!()
                                .blocks
                                .push(OfficeBlock::para(p_text.trim().to_string()));
                        }
                        if pending_break {
                            pending_break = false;
                            if pages.len() >= max_pages {
                                truncated = true; // 后续内容并入末页，不再分
                            } else {
                                pages.push(DocxPage {
                                    blocks: Vec::new(),
                                    text: String::new(),
                                });
                            }
                        }
                    }
                } else if is_local(local, "tc") {
                    if let Some(t) = tbl.as_mut() {
                        t.row.push(clean_cell_text(std::mem::take(&mut t.cell)));
                    }
                } else if is_local(local, "tr") {
                    if let Some(t) = tbl.as_mut() {
                        t.rows.push(std::mem::take(&mut t.row));
                    }
                } else if is_local(local, "tbl")
                    && let Some(mut t) = tbl.take()
                {
                    t.depth -= 1;
                    if t.depth == 0 && !t.rows.is_empty() {
                        let mut lines = Vec::with_capacity(t.rows.len());
                        for row in &t.rows {
                            page!().text.push_str(&row.join("\t"));
                            page!().text.push('\n');
                            lines.push(row.clone());
                        }
                        page!().blocks.push(OfficeBlock::table(lines));
                    } else if t.depth > 0 {
                        tbl = Some(t); // 嵌套外层表继续
                    }
                }
            }
            Ok(Event::Text(t)) if in_text => {
                if let Ok(s) = t.unescape() {
                    p_text.push_str(&s);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    // 末页无内容（分页标记恰好收尾）丢弃；每页收敛空行 + 去首尾空白行
    if pages.len() > 1
        && pages
            .last()
            .is_some_and(|p| p.text.trim().is_empty() && p.blocks.is_empty())
    {
        pages.pop();
    }
    let pages = pages
        .into_iter()
        .map(|mut p| {
            let collapsed = collapse_blank_lines(&p.text);
            p.text = collapsed.trim_matches('\n').to_string();
            p.blocks
                .retain(|b| b.kind == "table" || b.kind == "kv" || !b.text.is_empty());
            p
        })
        .collect();
    (pages, truncated)
}

/// docx → 每页一节（2026-10-18 blocks 化）：分页感知抽取，多页时节标题 =「第 N 页」；
/// 无分页标记的文档退化为单节「正文」（与旧版一致）
pub fn docx_sections(data: &[u8]) -> Result<(Vec<OfficeSection>, bool), String> {
    let xml = zip_read_entry(data, "word/document.xml")?;
    let (pages, truncated) = docx_page_blocks(&xml, SECTION_CHAR_CAP, SECTION_CAP);
    let multi = pages.len() > 1;
    let sections = pages
        .into_iter()
        .enumerate()
        .map(|(i, p)| OfficeSection {
            merges: vec![],
            title: if multi {
                format!("第 {} 页", i + 1)
            } else {
                "正文".into()
            },
            text: p.text,
            truncated: false,
            blocks: p.blocks,
        })
        .collect();
    Ok((sections, truncated))
}

/// 3+ 连续换行收敛为空行（纯函数；xml_paragraphs 与 docx 分页共用）
fn collapse_blank_lines(s: &str) -> String {
    let mut collapsed = String::with_capacity(s.len());
    let mut run = 0usize;
    for ch in s.chars() {
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
    collapsed
}

/// slide XML → 标题 + 正文段落（纯函数）：ph type="title"/"ctrTitle" 的形状
/// 是标题，其余形状为正文；a:pPr@lvl 为缩进层级（>0 视为列表项）。
/// 返回 (标题, [(层级, 文本)])，段落文本已合并 run。
fn pptx_slide_parts(xml: &str, cap_chars: usize) -> (Option<String>, Vec<(u32, String)>, bool) {
    use quick_xml::events::Event;

    let mut r = quick_xml::Reader::from_reader(xml.as_bytes());
    let mut title: Option<String> = None;
    let mut body: Vec<(u32, String)> = Vec::new();
    // 当前形状是否标题占位符；当前段落文本与层级
    let mut in_title_sp = false;
    let mut cur = String::new();
    let mut cur_lvl = 0u32;
    let mut in_text = false;
    let mut truncated = false;
    let mut buf = Vec::new();
    let mut chars = 0usize;
    macro_rules! flush {
        () => {
            if !cur.trim().is_empty() {
                let text = cur.trim().to_string();
                chars += text.len();
                if in_title_sp && title.is_none() {
                    title = Some(text);
                } else {
                    body.push((cur_lvl, text));
                }
            }
            cur.clear();
            cur_lvl = 0;
        };
    }
    loop {
        if chars >= cap_chars {
            truncated = true;
            break;
        }
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = e.name().local_name();
                if is_local(local, "sp") {
                    in_title_sp = false;
                } else if is_local(local, "t") {
                    in_text = true;
                } else if is_local(local, "p") {
                    cur.clear();
                    cur_lvl = 0;
                } else if is_local(local, "pPr")
                    && let Some(v) = xml_attr_el(&e, "lvl")
                {
                    cur_lvl = v.trim().parse().unwrap_or(0);
                }
            }
            Ok(Event::Empty(e)) => {
                let local = e.name().local_name();
                if is_local(local, "ph") {
                    if let Some(t) = xml_attr_el(&e, "type") {
                        let t = t.to_ascii_lowercase();
                        if t == "title" || t == "ctrtitle" {
                            in_title_sp = true;
                        }
                    }
                } else if is_local(local, "br") {
                    cur.push('\n');
                } else if is_local(local, "tab") {
                    cur.push('\t');
                } else if is_local(local, "pPr") {
                    // 自闭合段落属性（<a:pPr lvl="2"/>）
                    if let Some(v) = xml_attr_el(&e, "lvl") {
                        cur_lvl = v.trim().parse().unwrap_or(0);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let local = e.name().local_name();
                if is_local(local, "t") {
                    in_text = false;
                } else if is_local(local, "p") {
                    flush!();
                }
            }
            Ok(Event::Text(t)) if in_text => {
                if let Ok(s) = t.unescape() {
                    cur.push_str(&s);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    (title, body, truncated)
}

/// pptx → 每页一节（2026-10-18 结构化）：标题→heading 块、正文段落→para/list 块
/// （lvl>0 为列表项）、备注（notesSlideN.xml）→ note 块；text 仍为全部段落拍平
/// 文本（TXT 导出/搜索同源）。slides 按编号数字排序，超 SECTION_CAP 截断。
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
        let (title, body, truncated) = pptx_slide_parts(&xml, SECTION_CHAR_CAP);
        let mut blocks: Vec<OfficeBlock> = Vec::new();
        let mut text = String::new();
        if let Some(t) = &title {
            blocks.push(OfficeBlock::heading(1, t.clone()));
            text.push_str(t);
            text.push('\n');
        }
        for (lvl, t) in &body {
            blocks.push(if *lvl > 0 {
                OfficeBlock::list(*lvl, t.clone())
            } else {
                OfficeBlock::para(t.clone())
            });
            text.push_str(t);
            text.push('\n');
        }
        // 备注（与幻灯片同号约定；缺件静默跳过）
        if let Ok(notes) = zip_read_entry(data, &format!("ppt/notesSlides/notesSlide{n}.xml")) {
            let (notes_text, _) = xml_paragraphs(&notes, "p", "t", SECTION_CHAR_CAP);
            let notes_text = notes_text.trim().to_string();
            if !notes_text.is_empty() {
                text.push_str("备注：");
                text.push_str(&notes_text);
                text.push('\n');
                blocks.push(OfficeBlock {
                    kind: "note".into(),
                    level: 0,
                    text: notes_text,
                    label: String::new(),
                    rows: Vec::new(),
                });
            }
        }
        sections.push(OfficeSection {
            merges: vec![],
            title: format!("幻灯片 {n}"),
            text: text.trim_matches('\n').to_string(),
            truncated,
            blocks,
        });
    }
    let over = z
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/") && n.ends_with(".xml"))
        .count()
        > SECTION_CAP;
    Ok((sections, over))
}

/// 表格 → 每个工作表一节（xlsx/xlsm/xlsb/xls/ods 统一走 calamine）。
/// 隐藏工作表不进预览（calamine metadata 全格式通用，2026-10-18）。
/// 合并单元格：xlsx/xlsm 从容器 XML 直读、ods 从 content.xml 直读
/// （calamine 不解析 mergeCells）；xls/xlsb 合并信息留在二进制结构里不解析
/// （merges 为空，展示退化为平铺网格）。
fn sheet_sections(path: &str) -> Result<(Vec<OfficeSection>, bool), String> {
    use calamine::{Reader as _, SheetVisible};
    let lower = path.to_ascii_lowercase();
    let has_merge = lower.ends_with(".xlsx") || lower.ends_with(".xlsm");
    let is_ods = lower.ends_with(".ods");
    let merge_sheets = if has_merge {
        sheet_merges_xlsx(path)
    } else if is_ods {
        sheet_merges_ods(path)
    } else {
        Vec::new()
    };
    let mut wb = calamine::open_workbook_auto(path).map_err(|e| format!("表格解析失败：{e}"))?;
    // 隐藏表过滤：sheets_metadata 与 workbook 顺序一致；全隐藏时回落全部表
    let mut names: Vec<String> = wb
        .sheets_metadata()
        .iter()
        .filter(|s| s.visible == SheetVisible::Visible)
        .map(|s| s.name.clone())
        .collect();
    if names.is_empty() {
        names = wb.sheet_names();
    }
    let capped = names.len() > SECTION_CAP;
    let mut sections = Vec::new();
    for (i, name) in names.iter().take(SECTION_CAP).enumerate() {
        let range = wb
            .worksheet_range(name)
            .map_err(|e| format!("读取工作表 {name} 失败：{e}"))?;
        let (text, truncated) = range_to_text(&range, SHEET_ROW_CAP, SECTION_CHAR_CAP);
        sections.push(OfficeSection {
            merges: merge_sheets.get(i).cloned().unwrap_or_default(),
            title: name.clone(),
            text,
            truncated,
            blocks: Vec::new(),
        });
    }
    Ok((sections, capped))
}

/// 单 sheet 的 mergeCells 护栏（病态表格防拖死解析）
const MERGE_CAP: usize = 4_000;

/// xlsx/xlsm → 每个工作表的合并单元格清单（顺序与 calamine sheet_names 对齐）。
/// 任一部件缺失/解析失败返回空（合并展示是增强项，不让预览失败）。
fn sheet_merges_xlsx(path: &str) -> Vec<Vec<SheetMerge>> {
    let Ok(data) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(wb_xml) = zip_read_entry(&data, "xl/workbook.xml") else {
        return Vec::new();
    };
    let Ok(rels_xml) = zip_read_entry(&data, "xl/_rels/workbook.xml.rels") else {
        return Vec::new();
    };
    let rids = sheet_rids(&wb_xml);
    let targets = rel_targets(&rels_xml);
    rids.iter()
        .map(|rid| {
            targets
                .get(rid)
                .map(|t| {
                    let entry = if t.starts_with('/') {
                        t.trim_start_matches('/').to_string()
                    } else {
                        format!("xl/{t}")
                    };
                    zip_read_entry(&data, &entry)
                        .map(|xml| worksheet_merges(&xml, MERGE_CAP))
                        .unwrap_or_default()
                })
                .unwrap_or_default()
        })
        .collect()
}

/// ODS 单表合并解析游标：row/col 游标 + 行重复待结算 + 已收锚点
#[derive(Default)]
struct OdsTableState {
    merges: Vec<SheetMerge>,
    row: u32,
    col: u32,
    row_rep: u32,
}

/// ODF 重复属性取值（number-*-repeated；缺省 1，护栏封顶防病态文件拖死解析）
fn ods_repeat(e: &quick_xml::events::BytesStart, name: &str) -> u32 {
    xml_attr_el(e, name)
        .and_then(|v| v.trim().parse::<u32>().ok())
        .map(|n| n.min(100_000))
        .unwrap_or(1)
}

/// cell/covered-table-cell 事件公共处理（Start 与 Empty 自闭合两形态共用）
fn ods_cell_event(e: &quick_xml::events::BytesStart, st: &mut OdsTableState, cap: usize) {
    let covered = is_local(e.name().local_name(), "covered-table-cell");
    let rep = ods_repeat(e, "number-columns-repeated");
    let cs = ods_repeat(e, "number-columns-spanned");
    let rs = ods_repeat(e, "number-rows-spanned");
    if !covered && (cs > 1 || rs > 1) && st.merges.len() < cap {
        st.merges.push(SheetMerge {
            row: st.row,
            col: st.col,
            row_span: rs,
            col_span: cs,
        });
    }
    st.col = st.col.saturating_add(rep);
}

/// ods → 每个工作表的合并单元格清单（纯函数；顺序 = content.xml 的 table:table
/// 文档顺序，与 calamine sheet_names 对齐）。covered-table-cell 占位只推进列游标。
pub fn ods_merges_xml(xml: &str, cap: usize) -> Vec<Vec<SheetMerge>> {
    use quick_xml::events::Event;
    let mut r = quick_xml::Reader::from_reader(xml.as_bytes());
    let mut tables: Vec<Vec<SheetMerge>> = Vec::new();
    let mut cur: Option<OdsTableState> = None;
    let mut depth = 0usize; // 嵌套表（表内表）只在最外层收集
    let mut buf = Vec::new();
    loop {
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = e.name().local_name();
                if is_local(local, "table") {
                    depth += 1;
                    if depth == 1 {
                        cur = Some(OdsTableState::default());
                    }
                } else if depth == 1 && is_local(local, "table-row") {
                    if let Some(c) = cur.as_mut() {
                        c.row_rep = ods_repeat(&e, "number-rows-repeated");
                        c.col = 0;
                    }
                } else if depth == 1
                    && (is_local(local, "table-cell") || is_local(local, "covered-table-cell"))
                    && let Some(c) = cur.as_mut()
                {
                    ods_cell_event(&e, c, cap);
                }
            }
            Ok(Event::Empty(e)) => {
                let local = e.name().local_name();
                if depth == 1
                    && (is_local(local, "table-cell") || is_local(local, "covered-table-cell"))
                    && let Some(c) = cur.as_mut()
                {
                    ods_cell_event(&e, c, cap);
                }
            }
            Ok(Event::End(e)) => {
                let local = e.name().local_name();
                if is_local(local, "table") {
                    depth = depth.saturating_sub(1);
                    if depth == 0
                        && let Some(c) = cur.take()
                    {
                        tables.push(c.merges);
                        if tables.len() > 64 {
                            break;
                        }
                    }
                } else if depth == 1
                    && is_local(local, "table-row")
                    && let Some(c) = cur.as_mut()
                {
                    c.row = c.row.saturating_add(c.row_rep.max(1));
                    c.row_rep = 1;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    tables
}

/// ods 文件 → 每表合并清单（IO 壳：读 content.xml；失败返回空不让预览失败）
fn sheet_merges_ods(path: &str) -> Vec<Vec<SheetMerge>> {
    let Ok(data) = std::fs::read(path) else {
        return Vec::new();
    };
    zip_read_entry(&data, "content.xml")
        .map(|xml| ods_merges_xml(&xml, MERGE_CAP))
        .unwrap_or_default()
}

/// workbook.xml → sheet 顺序的 r:id 清单（文档顺序 = 工作表顺序，与 calamine 对齐）
pub fn sheet_rids(wb_xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = wb_xml;
    while let Some(i) = rest.find("<sheet ") {
        rest = &rest[i + 7..];
        let end = match rest.find("/>") {
            Some(e) => e,
            None => break,
        };
        let tag = &rest[..end];
        if let Some(id) = tag_attr(tag, "r:id") {
            out.push(id);
        }
    }
    out
}

/// workbook.xml.rels → rId → Target（worksheet 部件，相对 xl/ 的路径）
pub fn rel_targets(rels_xml: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let mut rest = rels_xml;
    while let Some(i) = rest.find("<Relationship ") {
        rest = &rest[i + 14..];
        let end = match rest.find("/>") {
            Some(e) => e,
            None => break,
        };
        let tag = &rest[..end];
        // 只要 worksheet 类型的关系（Type 以 .../worksheet 结尾）
        if let (Some(id), Some(target)) = (tag_attr(tag, "Id"), tag_attr(tag, "Target"))
            && tag.contains("worksheet\"")
        {
            out.insert(id, target);
        }
    }
    out
}

/// XML 标签内取属性值（两端引号均可，值内不做实体反解码——r:id/Target/URL 安全字符）
fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let pat = format!("{name}=\"");
    let i = tag.find(&pat).or_else(|| tag.find(&format!("{name}='")))?;
    let after = &tag[i + pat.len()..];
    let close = after.find('"').or_else(|| after.find('\''))?;
    Some(after[..close].to_string())
}

/// worksheet xml → 合并单元格清单（mergeCell ref 如 "A1:B2"，锚点 0 基 + 跨度）
pub fn worksheet_merges(xml: &str, cap: usize) -> Vec<SheetMerge> {
    let mut out = Vec::new();
    let mut rest = xml;
    while out.len() < cap {
        let Some(i) = rest.find("<mergeCell ") else {
            break;
        };
        rest = &rest[i + 11..];
        let Some(end) = rest.find("/>") else {
            break;
        };
        let Some(r) = tag_attr(&rest[..end], "ref") else {
            continue;
        };
        if let Some(m) = parse_merge_ref(&r) {
            out.push(m);
        }
    }
    out
}

/// "A1:B2" → SheetMerge { row: 0, col: 0, rowSpan: 2, colSpan: 2 }（锚点 0 基；
/// 单格 ref 或越界列（> ZZ 之外即 3 字母列）返回 None 跳过）
pub fn parse_merge_ref(r: &str) -> Option<SheetMerge> {
    let (a, b) = r.split_once(':')?;
    let (ar, ac) = cell_addr(a)?;
    let (br, bc) = cell_addr(b)?;
    if br < ar || bc < ac {
        return None;
    }
    Some(SheetMerge {
        row: ar,
        col: ac,
        row_span: br - ar + 1,
        col_span: bc - ac + 1,
    })
}

/// "B3" → (row 2, col 1)；仅支持 A-ZZ 两字母内列（预览网格足够）
fn cell_addr(a: &str) -> Option<(u32, u32)> {
    let split = a.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = a.split_at(split);
    if letters.is_empty() || letters.len() > 2 || digits.is_empty() {
        return None;
    }
    let mut col = 0u32;
    for ch in letters.chars() {
        let v = ch.to_ascii_uppercase() as u32 - b'A' as u32;
        if v > 25 {
            return None;
        }
        col = col * 26 + v + 1;
    }
    let row: u32 = digits.parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, col - 1))
}

/// 单元格 → 预览文本（纯函数）：整数去小数尾、布尔 TRUE/FALSE；日期单元格
/// 转可读字符串（2026-10-18 修：原先直接 as_f64 显示成 Excel 序列数 45867）；
/// 单元格内换行/制表符替换为空格——制表符分隔文本化时它们会冲乱行列结构
/// （实测 WPS 合并格内的多行文本把整表行错位，2026-10-17）
pub fn cell_display(d: &calamine::Data) -> String {
    use calamine::Data;
    let raw = match d {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => fmt_float(*f),
        Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        // 与 Excel 合并管线同语义：日期/时长转可读字符串（免 chrono）
        Data::DateTime(dt) => crate::fs::xlsx::format_datetime(dt),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => e.to_string(),
    };
    clean_cell_text(raw)
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
    let rows: Vec<Vec<String>> = range
        .rows()
        .map(|row| row.iter().map(cell_display).collect())
        .collect();
    matrix_to_text(rows, max_rows, cap_chars)
}

/// 行列矩阵 → 制表符分隔文本（纯函数）：行数与字符数双上限（calamine 与 CSV 共用尾部）
pub fn matrix_to_text(rows: Vec<Vec<String>>, max_rows: usize, cap_chars: usize) -> (String, bool) {
    let mut out = String::new();
    let mut truncated = false;
    for (i, row) in rows.iter().enumerate() {
        if i >= max_rows || out.len() >= cap_chars {
            truncated = true;
            break;
        }
        out.push_str(&row.join("\t"));
        out.push('\n');
    }
    (out, truncated)
}

/// 制表符分隔文本化的单元格清洗：值内换行/制表符会冲乱行列结构，替换为空格
fn clean_cell_text(raw: String) -> String {
    // \r\n 先归一为单个换行，避免替换出双空格
    raw.replace("\r\n", "\n").replace(['\r', '\n', '\t'], " ")
}

/// CSV/TSV → 单节表格预览：编码探测（BOM → UTF-8 → GB18030，Excel 导出的 GBK 可读）
/// → RFC4180 解析（引号内逗号/换行/转义引号）→ 复用表格网格管线。csv 无合并概念。
fn csv_section(path: &str, delim: char) -> Result<OfficeSection, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    if sniff_binary(&data) {
        return Err("二进制文件不支持按表格预览".into());
    }
    let (_, text) = decode_text(&data);
    let rows = parse_csv_rows(&text, delim);
    let cells: Vec<Vec<String>> = rows
        .into_iter()
        .map(|row| row.into_iter().map(clean_cell_text).collect())
        .collect();
    let title = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("CSV")
        .to_string();
    let (text, truncated) = matrix_to_text(cells, SHEET_ROW_CAP, SECTION_CHAR_CAP);
    Ok(OfficeSection::text_only(title, text, truncated))
}

/// RFC4180 CSV 解析（纯函数）：字段首引号开启引用，"" 转义引号，引号内
/// 分隔符/换行皆为值的一部分；裸引号（非字段首）按普通字符容错处理
pub fn parse_csv_rows(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = vec![vec![String::new()]];
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let cell = rows.last_mut().unwrap().last_mut().unwrap();
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                cell.push(c);
            }
        } else {
            match c {
                '"' if cell.is_empty() => in_quotes = true,
                c if c == delim => rows.last_mut().unwrap().push(String::new()),
                '\n' => rows.push(vec![String::new()]),
                '\r' => {}
                _ => cell.push(c),
            }
        }
    }
    // 丢弃末尾空行（文件尾换行产生）
    while rows.len() > 1 && rows.last().is_some_and(|r| r.len() == 1 && r[0].is_empty()) {
        rows.pop();
    }
    rows
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
            merges: vec![],
            title: format!("第 {} 节", i + 1),
            text,
            truncated,
            blocks: Vec::new(),
        });
    }
    Ok((sections, any_truncated || capped))
}

/// epub 封面（2026-10-18）：OPF cover-image 属性 / meta name="cover" / 文件名含
/// cover 的图片，三路兜底；解码缩到 ≤320×480 转 PNG data URL，失败一律 None
pub fn epub_cover(data: &[u8]) -> Option<String> {
    let container = zip_read_entry(data, "META-INF/container.xml").ok()?;
    let opf_path = xml_attr(&container, "rootfile", "full-path")?;
    let opf = zip_read_entry(data, &opf_path).ok()?;
    // manifest: id → (href, media-type, properties)；meta name="cover" → content id
    use quick_xml::events::Event;
    let mut items: std::collections::HashMap<String, (String, String, String)> = Default::default();
    let mut cover_meta_id: Option<String> = None;
    let mut r = quick_xml::Reader::from_reader(opf.as_bytes());
    let mut buf = Vec::new();
    loop {
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                let local = e.name().local_name();
                if is_local(local, "item") {
                    let id = xml_attr_el(&e, "id").unwrap_or_default();
                    let href = xml_attr_el(&e, "href").unwrap_or_default();
                    let mt = xml_attr_el(&e, "media-type").unwrap_or_default();
                    let props = xml_attr_el(&e, "properties").unwrap_or_default();
                    if !id.is_empty() {
                        items.insert(id, (href, mt, props));
                    }
                } else if is_local(local, "meta")
                    && xml_attr_el(&e, "name").is_some_and(|n| n == "cover")
                {
                    cover_meta_id = xml_attr_el(&e, "content");
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    // 三路兜底取 href
    let mut href: Option<String> = None;
    for (h, _, props) in items.values() {
        if props.split_whitespace().any(|p| p == "cover-image") {
            href = Some(h.clone());
            break;
        }
    }
    if href.is_none()
        && let Some(id) = cover_meta_id
        && let Some((h, _, _)) = items.get(&id)
    {
        href = Some(h.clone());
    }
    if href.is_none() {
        for (h, mt, _) in items.values() {
            if mt.starts_with("image/") && h.to_lowercase().contains("cover") {
                href = Some(h.clone());
                break;
            }
        }
    }
    let href = href?;
    let (opf_dir, _) = opf_path.rsplit_once('/')?;
    let full = if opf_dir.is_empty() {
        href
    } else {
        format!("{opf_dir}/{href}")
    };
    let mut z = zip::ZipArchive::new(Cursor::new(data)).ok()?;
    let mut f = z.by_name(&full).ok()?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    let thumb = img.thumbnail(320, 480);
    let mut out = Cursor::new(Vec::new());
    thumb.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(crate::icons::png_data_url(&out.into_inner()))
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

// ────────────────────────── ODF 文字/演示（odt/odp） ──────────────────────────

/// content.xml → 结构化块（odt 用，纯函数）：text:h（outline-level）→ heading、
/// text:p → para、table:table → table 块（行×格；spanned/repeated 拍平为普通格）。
/// 行内标记：text:s（c 空格）/text:tab/text:line-break。上限同 OOXML 管线。
pub fn odf_text_blocks(xml: &str, cap_chars: usize) -> (Vec<OfficeBlock>, String, bool) {
    use quick_xml::events::Event;

    const BLOCK_CAP: usize = 2000;

    struct Tbl {
        rows: Vec<Vec<String>>,
        row: Vec<String>,
        cell: String,
        depth: u32,
    }

    let mut r = quick_xml::Reader::from_reader(xml.as_bytes());
    let mut blocks: Vec<OfficeBlock> = Vec::new();
    let mut text = String::new();
    let mut cur = String::new();
    let mut h_lvl: Option<u32> = None; // Some = 当前在 text:h
    let mut in_p = false;
    let mut truncated = false;
    let mut buf = Vec::new();
    let mut tbl: Option<Tbl> = None;

    macro_rules! flush_para {
        () => {
            let seg = cur.trim().to_string();
            cur.clear();
            if let Some(t) = tbl.as_mut() {
                if !seg.is_empty() {
                    if !t.cell.is_empty() {
                        t.cell.push(' ');
                    }
                    t.cell.push_str(&seg);
                }
            } else if let Some(lvl) = h_lvl.take() {
                if !seg.is_empty() {
                    blocks.push(OfficeBlock::heading(lvl, seg.clone()));
                    text.push_str(&seg);
                    text.push('\n');
                }
            } else if !seg.is_empty() {
                blocks.push(OfficeBlock::para(seg.clone()));
                text.push_str(&seg);
                text.push('\n');
            }
        };
    }

    loop {
        if text.len() >= cap_chars || blocks.len() >= BLOCK_CAP {
            truncated = true;
            break;
        }
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = e.name().local_name();
                if is_local(local, "h") {
                    in_p = true;
                    h_lvl = Some(
                        xml_attr_el(&e, "outline-level")
                            .and_then(|v| v.trim().parse().ok())
                            .unwrap_or(1),
                    );
                    cur.clear();
                } else if is_local(local, "p") {
                    in_p = true;
                    cur.clear();
                } else if is_local(local, "table") {
                    match tbl.as_mut() {
                        None => {
                            tbl = Some(Tbl {
                                rows: Vec::new(),
                                row: Vec::new(),
                                cell: String::new(),
                                depth: 1,
                            })
                        }
                        Some(t) => t.depth += 1,
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                let local = e.name().local_name();
                if is_local(local, "s") {
                    let n: usize = xml_attr_el(&e, "c")
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(1);
                    cur.push_str(&" ".repeat(n.min(64)));
                } else if is_local(local, "tab") {
                    cur.push('\t');
                } else if is_local(local, "line-break") {
                    cur.push('\n');
                } else if is_local(local, "table-cell") || is_local(local, "covered-table-cell") {
                    // 自闭合空格（无 End 事件）：即时落格
                    if let Some(t) = tbl.as_mut() {
                        t.row.push(String::new());
                    }
                }
            }
            Ok(Event::End(e)) => {
                let local = e.name().local_name();
                if (is_local(local, "p") || is_local(local, "h")) && in_p {
                    in_p = false;
                    flush_para!();
                } else if is_local(local, "table-cell") || is_local(local, "covered-table-cell") {
                    if let Some(t) = tbl.as_mut() {
                        t.row.push(clean_cell_text(std::mem::take(&mut t.cell)));
                    }
                } else if is_local(local, "table-row") {
                    if let Some(t) = tbl.as_mut() {
                        t.rows.push(std::mem::take(&mut t.row));
                    }
                } else if is_local(local, "table")
                    && let Some(mut t) = tbl.take()
                {
                    t.depth -= 1;
                    if t.depth == 0 && !t.rows.is_empty() {
                        let mut lines = Vec::with_capacity(t.rows.len());
                        for row in &t.rows {
                            text.push_str(&row.join("\t"));
                            text.push('\n');
                            lines.push(row.clone());
                        }
                        blocks.push(OfficeBlock::table(lines));
                    } else if t.depth > 0 {
                        tbl = Some(t);
                    }
                }
            }
            Ok(Event::Text(t)) if in_p => {
                if let Ok(s) = t.unescape() {
                    cur.push_str(&s);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    (blocks, text.trim_matches('\n').to_string(), truncated)
}

/// odt → 单节「正文」（结构化块）
fn odf_text_office(data: &[u8]) -> Result<OfficeText, String> {
    let xml = zip_read_entry(data, "content.xml")?;
    let (blocks, text, truncated) = odf_text_blocks(&xml, SECTION_CHAR_CAP);
    Ok(OfficeText {
        kind: "docx".into(),
        sections: vec![OfficeSection {
            merges: vec![],
            title: "正文".into(),
            text,
            truncated,
            blocks,
        }],
        truncated,
        cover: None,
    })
}

/// content.xml → 每页一节（odp 用，纯函数）：draw:page 一页；页内
/// presentation:class="title" 的 draw:frame 段落 = 标题（heading 1），其余段落
/// → para；text:h → heading（outline-level）。返回 (页名, blocks, 拍平文本)。
pub fn odp_page_blocks(
    xml: &str,
    cap_chars: usize,
) -> (Vec<(String, Vec<OfficeBlock>, String)>, bool) {
    use quick_xml::events::Event;

    let mut r = quick_xml::Reader::from_reader(xml.as_bytes());
    let mut pages: Vec<(String, Vec<OfficeBlock>, String)> = Vec::new();
    let mut page_name = String::new();
    let mut blocks: Vec<OfficeBlock> = Vec::new();
    let mut text = String::new();
    let mut cur = String::new();
    let mut in_p = false;
    let mut h_lvl: Option<u32> = None;
    let mut in_title_frame = false;
    let mut title_taken = false;
    let mut truncated = false;
    let mut buf = Vec::new();

    macro_rules! flush_para {
        () => {
            let seg = cur.trim().to_string();
            cur.clear();
            if seg.is_empty() {
                continue;
            }
            text.push_str(&seg);
            text.push('\n');
            let as_title = in_title_frame && !title_taken;
            if as_title {
                title_taken = true;
                blocks.push(OfficeBlock::heading(1, seg));
            } else if let Some(lvl) = h_lvl.take() {
                blocks.push(OfficeBlock::heading(lvl, seg));
            } else {
                blocks.push(OfficeBlock::para(seg));
            }
        };
    }

    loop {
        if text.len() >= cap_chars || blocks.len() >= 2000 {
            truncated = true;
            break;
        }
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = e.name().local_name();
                if is_local(local, "page") {
                    pages.push((
                        std::mem::take(&mut page_name),
                        std::mem::take(&mut blocks),
                        std::mem::take(&mut text),
                    ));
                    title_taken = false;
                    in_title_frame = false;
                    page_name = xml_attr_el(&e, "name").unwrap_or_default();
                } else if is_local(local, "frame") {
                    in_title_frame = xml_attr_el(&e, "class").is_some_and(|c| c == "title");
                } else if is_local(local, "h") {
                    in_p = true;
                    h_lvl = Some(
                        xml_attr_el(&e, "outline-level")
                            .and_then(|v| v.trim().parse().ok())
                            .unwrap_or(1),
                    );
                    cur.clear();
                } else if is_local(local, "p") {
                    in_p = true;
                    cur.clear();
                }
            }
            Ok(Event::Empty(e)) => {
                let local = e.name().local_name();
                if is_local(local, "s") {
                    let n: usize = xml_attr_el(&e, "c")
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(1);
                    cur.push_str(&" ".repeat(n.min(64)));
                } else if is_local(local, "tab") {
                    cur.push('\t');
                } else if is_local(local, "line-break") {
                    cur.push('\n');
                }
            }
            Ok(Event::End(e)) => {
                let local = e.name().local_name();
                if (is_local(local, "p") || is_local(local, "h")) && in_p {
                    in_p = false;
                    flush_para!();
                } else if is_local(local, "frame") {
                    in_title_frame = false;
                } else if is_local(local, "page") {
                    let name = if page_name.trim().is_empty() {
                        format!("第 {} 页", pages.len() + 1)
                    } else {
                        page_name.clone()
                    };
                    pages.push((name, std::mem::take(&mut blocks), std::mem::take(&mut text)));
                    title_taken = false;
                    in_title_frame = false;
                    page_name.clear();
                }
            }
            Ok(Event::Text(t)) if in_p => {
                if let Ok(s) = t.unescape() {
                    cur.push_str(&s);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    // 首个哨兵（page Start 时 push 的空页）剔除
    if pages
        .first()
        .is_some_and(|(n, b, t)| n.is_empty() && b.is_empty() && t.is_empty())
    {
        pages.remove(0);
    }
    (pages, truncated)
}

/// odp → 每页一节（结构化块）
fn odp_slides_office(data: &[u8]) -> Result<OfficeText, String> {
    let xml = zip_read_entry(data, "content.xml")?;
    let (pages, truncated) = odp_page_blocks(&xml, SECTION_CHAR_CAP);
    let mut sections: Vec<OfficeSection> = pages
        .into_iter()
        .map(|(name, blocks, text)| OfficeSection {
            merges: vec![],
            title: name,
            text,
            truncated: false,
            blocks,
        })
        .collect();
    if sections.is_empty() {
        sections.push(OfficeSection::text_only(
            "（空演示文稿）",
            String::new(),
            false,
        ));
    }
    Ok(OfficeText {
        kind: "slides".into(),
        sections,
        truncated,
        cover: None,
    })
}

// ────────────────────────── RTF（控制字剥离的降级文本抽取） ──────────────────────────

/// RTF 字节按 \ansicpg 解码（纯函数）：国内场景缺省 GB18030
fn decode_rtf_bytes(bytes: &[u8], codepage: u32) -> String {
    let enc = match codepage {
        65001 => encoding_rs::UTF_8,
        932 => encoding_rs::SHIFT_JIS,
        950 => encoding_rs::BIG5,
        1250 => encoding_rs::WINDOWS_1250,
        1251 => encoding_rs::WINDOWS_1251,
        1252 => encoding_rs::WINDOWS_1252,
        _ => encoding_rs::GB18030, // 936 及未声明
    };
    let (cow, _, _) = enc.decode(bytes);
    cow.into_owned()
}

/// RTF 目的地控制字：这些组内不含正文，整组跳过
fn rtf_skip_destination(word: &str) -> bool {
    matches!(
        word,
        "fonttbl"
            | "colortbl"
            | "stylesheet"
            | "info"
            | "pict"
            | "object"
            | "themedata"
            | "datastore"
            | "latentstyles"
            | "listtable"
            | "listoverridetable"
            | "rsidtbl"
            | "generator"
            | "xmlnstbl"
            | "header"
            | "footer"
            | "headerl"
            | "headerr"
            | "footerl"
            | "footerr"
            | "ftnsep"
            | "ftnsepc"
            | "aftnsep"
            | "aftnsepc"
            | "field"
    )
}

/// RTF → 结构化段落（纯函数）：\par/\line 为段边界；\'hh 十六进制字节按
/// \ansicpg 解码；\uN Unicode 直转（随后按 \ucN 跳过等量回退字节）；字表/
/// 样式表/图片等目的地组与 \* 扩展目的地组整组跳过。返回 (blocks, text, truncated)。
pub fn rtf_blocks(data: &[u8], cap_chars: usize) -> (Vec<OfficeBlock>, String, bool) {
    let mut blocks: Vec<OfficeBlock> = Vec::new();
    let mut text = String::new();
    let mut cur = String::new();
    let mut cur_bytes: Vec<u8> = Vec::new();
    // 组栈：每项 = 该组是否 skip 组；skip_count = 栈内 true 数（>0 即处于跳过区）
    let mut group_skip: Vec<bool> = vec![false];
    let mut skip_count = 0usize;
    let mut pending_skip = false; // \* 或目的地控制字后的下一个组为 skip 组
    let mut codepage: u32 = 936;
    let mut uc_default = 1usize;
    let mut uc_pending = 0usize;
    let mut truncated = false;
    let mut i = 0usize;

    macro_rules! flush_bytes {
        () => {
            if !cur_bytes.is_empty() {
                cur.push_str(&decode_rtf_bytes(&cur_bytes, codepage));
                cur_bytes.clear();
            }
        };
    }
    macro_rules! flush_para {
        () => {
            flush_bytes!();
            let seg = cur.trim().to_string();
            cur.clear();
            if !seg.is_empty() {
                blocks.push(OfficeBlock::para(seg.clone()));
                text.push_str(&seg);
                text.push('\n');
            }
        };
    }

    while i < data.len() {
        if text.len() >= cap_chars || blocks.len() >= 2000 {
            truncated = true;
            break;
        }
        let b = data[i];
        // \uN 之后的回退字符跳过：{...} 整组、\控制字、或单个普通字节
        if uc_pending > 0 {
            match b {
                b'{' => {
                    let mut depth = 0usize;
                    while i < data.len() {
                        match data[i] {
                            b'{' => depth += 1,
                            b'}' => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                        i += 1;
                    }
                }
                b'\\' => {
                    i += 1;
                    if i < data.len() && data[i] == b'\'' {
                        i += 2;
                    } else {
                        while i < data.len() && data[i].is_ascii_alphabetic() {
                            i += 1;
                        }
                        while i < data.len() && data[i].is_ascii_digit() {
                            i += 1;
                        }
                    }
                }
                _ => {}
            }
            uc_pending -= 1;
            i += 1;
            continue;
        }
        match b {
            b'{' => {
                group_skip.push(pending_skip);
                if pending_skip {
                    skip_count += 1;
                }
                pending_skip = false;
                i += 1;
            }
            b'}' => {
                if group_skip.pop() == Some(true) {
                    skip_count -= 1;
                }
                i += 1;
            }
            b'\\' => {
                i += 1;
                if i >= data.len() {
                    break;
                }
                let nb = data[i];
                if nb == b'\'' {
                    // 十六进制字节 \'hh
                    if i + 2 < data.len()
                        && let Some(hi) = (data[i + 1] as char).to_digit(16)
                        && let Some(lo) = (data[i + 2] as char).to_digit(16)
                        && skip_count == 0
                    {
                        cur_bytes.push((hi * 16 + lo) as u8);
                    }
                    i += 3;
                } else if nb == b'*' {
                    pending_skip = true;
                    i += 1;
                } else if nb.is_ascii_alphabetic() {
                    let start = i;
                    while i < data.len() && data[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    let word = std::str::from_utf8(&data[start..i]).unwrap_or("");
                    // 可选数字参数（可带负号）
                    let mut param: Option<i64> = None;
                    let pstart = i;
                    if i < data.len() && data[i] == b'-' {
                        i += 1;
                    }
                    let ds = i;
                    while i < data.len() && data[i].is_ascii_digit() {
                        i += 1;
                    }
                    if i > ds {
                        param = std::str::from_utf8(&data[pstart..i])
                            .ok()
                            .and_then(|s| s.parse().ok());
                    }
                    // 单个空格定界符（控制字后第一个空格属于语法）
                    if i < data.len() && data[i] == b' ' {
                        i += 1;
                    }
                    if skip_count == 0 {
                        match word {
                            "par" | "line" => {
                                flush_para!();
                            }
                            "tab" => {
                                flush_bytes!();
                                cur.push('\t');
                            }
                            "uc" => uc_default = param.unwrap_or(1).max(0) as usize,
                            "u" => {
                                flush_bytes!();
                                let n = param.unwrap_or(63);
                                let cp = if n < 0 { 65536 + n } else { n } as u32;
                                if let Some(c) = char::from_u32(cp) {
                                    cur.push(c);
                                }
                                uc_pending = uc_default.max(1);
                            }
                            "ansicpg" => codepage = param.unwrap_or(936) as u32,
                            "emdash" => cur.push('\u{2014}'),
                            "endash" => cur.push('\u{2013}'),
                            "bullet" => cur.push('\u{2022}'),
                            "lquote" => cur.push('\u{2018}'),
                            "rquote" => cur.push('\u{2019}'),
                            "ldblquote" => cur.push('\u{201C}'),
                            "rdblquote" => cur.push('\u{201D}'),
                            _ => {
                                if rtf_skip_destination(word) {
                                    pending_skip = true;
                                }
                            }
                        }
                    } else if rtf_skip_destination(word) {
                        pending_skip = true; // 跳过区内再开目的地组：仍整组跳
                    }
                } else {
                    // 转义符号 \\ { }：按字面收进正文
                    if (nb == b'\\' || nb == b'{' || nb == b'}') && skip_count == 0 {
                        cur_bytes.push(nb);
                    }
                    i += 1;
                }
            }
            b'\r' | b'\n' => {
                i += 1; // RTF 换行仅为排版噪音
            }
            _ => {
                if skip_count == 0 {
                    cur_bytes.push(b);
                }
                i += 1;
            }
        }
    }
    flush_bytes!();
    let seg = cur.trim().to_string();
    if !seg.is_empty() {
        blocks.push(OfficeBlock::para(seg.clone()));
        text.push_str(&seg);
        text.push('\n');
    }
    (blocks, text.trim_matches('\n').to_string(), truncated)
}

/// rtf → 单节「正文」（结构化块）
fn rtf_office(data: &[u8]) -> Result<OfficeText, String> {
    let _ = data; // 头部校验由扩展名门控承担
    let (blocks, text, truncated) = rtf_blocks(data, SECTION_CHAR_CAP);
    Ok(OfficeText {
        kind: "docx".into(),
        sections: vec![OfficeSection {
            merges: vec![],
            title: "正文".into(),
            text,
            truncated,
            blocks,
        }],
        truncated,
        cover: None,
    })
}

// ────────────────────────── 邮件（eml / msg） ──────────────────────────

/// eml → 「信息」+「正文」两节（mailparse 0BSD：RFC2047 编码头/字符集/QP/Base64
/// 全托管）。正文优先 text/plain，缺失回落 text/html 标签剥离；附件名单进信息节。
fn eml_office(data: &[u8]) -> Result<OfficeText, String> {
    let mail = mailparse::parse_mail(data).map_err(|e| format!("邮件解析失败：{e}"))?;
    let header = |name: &str| {
        mail.headers
            .iter()
            .find(|h| h.get_key_ref().eq_ignore_ascii_case(name))
            .map(|h| h.get_value())
    };
    let mut info: Vec<OfficeBlock> = Vec::new();
    for (label, name) in [
        ("主题", "Subject"),
        ("发件人", "From"),
        ("收件人", "To"),
        ("抄送", "Cc"),
        ("日期", "Date"),
    ] {
        if let Some(v) = header(name)
            && !v.trim().is_empty()
        {
            info.push(OfficeBlock::kv(label, v.trim().to_string()));
        }
    }

    // 深度优先收集附件名与正文候选（alternative 组 plain 优先）
    fn walk(
        m: &mailparse::ParsedMail,
        plain: &mut Option<String>,
        html: &mut Option<String>,
        atts: &mut Vec<String>,
    ) {
        let cd = m.get_content_disposition();
        if cd.disposition == mailparse::DispositionType::Attachment
            && let Some(name) = cd
                .params
                .get("filename")
                .or_else(|| m.ctype.params.get("name"))
        {
            atts.push(name.clone());
        }
        if m.subparts.is_empty() {
            let mt = m.ctype.mimetype.as_str();
            if mt == "text/plain" && plain.is_none() {
                *plain = m.get_body().ok();
            } else if mt == "text/html" && html.is_none() {
                *html = m.get_body().ok();
            }
            return;
        }
        for sp in &m.subparts {
            walk(sp, plain, html, atts);
        }
    }
    let mut plain = None;
    let mut html = None;
    let mut atts = Vec::new();
    walk(&mail, &mut plain, &mut html, &mut atts);
    if !atts.is_empty() {
        info.push(OfficeBlock::kv("附件", atts.join("、")));
    }

    let (body, body_truncated) = if let Some(p) = plain {
        (p.replace("\r\n", "\n"), false)
    } else if let Some(h) = html {
        xml_blocks_text(
            &h,
            &[
                "p",
                "div",
                "br",
                "li",
                "tr",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "blockquote",
            ],
            &["script", "style"],
            SECTION_CHAR_CAP,
        )
    } else {
        (String::new(), false)
    };
    let truncated = body_truncated;
    let blocks = body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| OfficeBlock::para(l.trim().to_string()))
        .take(2000)
        .collect();
    Ok(OfficeText {
        kind: "email".into(),
        sections: vec![
            OfficeSection {
                merges: vec![],
                title: "信息".into(),
                text: String::new(),
                truncated: false,
                blocks: info,
            },
            OfficeSection {
                merges: vec![],
                title: "正文".into(),
                text: body,
                truncated,
                blocks,
            },
        ],
        truncated,
        cover: None,
    })
}

/// UTF-16LE 字节 → 字符串（msg 的 001F 类型属性流）
fn utf16le_to_string(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    String::from_utf16_lossy(&units)
}

/// 天数（1970-01-01 起）→ (年, 月, 日)（civil_from_days 算法，免 chrono 依赖）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Windows FILETIME（100ns since 1601-01-01，LE 8 字节）→ "YYYY-MM-DD"（纯函数）
pub fn filetime_to_date(b: &[u8]) -> Option<String> {
    if b.len() < 8 {
        return None;
    }
    let ticks = u64::from_le_bytes(b[..8].try_into().ok()?);
    const EPOCH_DIFF: u64 = 11_644_473_600;
    let secs = (ticks / 10_000_000).checked_sub(EPOCH_DIFF)?;
    let (y, m, d) = civil_from_days(secs as i64 / 86_400);
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// msg（OLE 复合文档）→ 「信息」+「正文」两节：属性存为 __substg1.0_<TAG><TYPE>
/// 命名流（001F = UTF-16LE、001E = ANSI、0040 = FILETIME），按已知 TAG 直读。
fn msg_office(data: &[u8]) -> Result<OfficeText, String> {
    let mut c =
        cfb::CompoundFile::open(Cursor::new(data)).map_err(|e| format!("MSG 容器解析失败：{e}"))?;
    fn stream(c: &mut cfb::CompoundFile<Cursor<&[u8]>>, name: String) -> Option<Vec<u8>> {
        let mut s = c.open_stream(&name).ok()?;
        let mut v = Vec::new();
        s.read_to_end(&mut v).ok()?;
        Some(v)
    }
    // 属性流直读：优先 Unicode（001F），回落 ANSI（001E）
    fn prop(c: &mut cfb::CompoundFile<Cursor<&[u8]>>, tag: &str) -> Option<String> {
        if let Some(b) = stream(c, format!("__substg1.0_{tag}001F")) {
            return Some(utf16le_to_string(&b));
        }
        stream(c, format!("__substg1.0_{tag}001E")).map(|b| decode_text(&b).1)
    }
    let mut info: Vec<OfficeBlock> = Vec::new();
    for (label, tag) in [
        ("主题", "0037"),
        ("发件人", "0C1A"),
        ("收件人", "0E04"),
        ("抄送", "0E03"),
    ] {
        if let Some(v) = prop(&mut c, tag)
            && !v.trim().is_empty()
        {
            info.push(OfficeBlock::kv(
                label,
                v.trim().replace('\r', "").replace('\n', " "),
            ));
        }
    }
    if let Some(b) = stream(&mut c, "__substg1.0_00390040".into())
        && let Some(d) = filetime_to_date(&b)
    {
        info.push(OfficeBlock::kv("日期", d));
    }
    let body = prop(&mut c, "1000")
        .map(|s| s.replace("\r\n", "\n"))
        .unwrap_or_default();
    let blocks: Vec<OfficeBlock> = body
        .lines()
        .map(|l| OfficeBlock::para(l.trim().to_string()))
        .filter(|b| !b.text.is_empty())
        .take(2000)
        .collect();
    Ok(OfficeText {
        kind: "email".into(),
        sections: vec![
            OfficeSection {
                merges: vec![],
                title: "信息".into(),
                text: String::new(),
                truncated: false,
                blocks: info,
            },
            OfficeSection {
                merges: vec![],
                title: "正文".into(),
                text: body.clone(),
                truncated: false,
                blocks,
            },
        ],
        truncated: false,
        cover: None,
    })
}

// ────────────────────────── doc/ppt COM 转 PDF 预览通道 ──────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPdfPreview {
    pub pdf_path: String,
    pub cached: bool,
}

/// 转换全局串行闸（COM 派发是重操作，避免并发多开 Office 进程拖垮机器）
static DOC_PDF_SEM: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 缓存目录：%TEMP%/xdir_preview
pub fn preview_cache_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("xdir_preview")
}

/// 缓存键（纯函数）：小写路径 + mtime + size 的 SHA-256——源文件一变即自动失效
pub fn doc_pdf_cache_key(path_lower: &str, mtime_ms: u64, size: u64) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(path_lower.as_bytes());
    h.update([0]);
    h.update(mtime_ms.to_le_bytes());
    h.update([0]);
    h.update(size.to_le_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 缓存目录清扫（best-effort）：>24h 的旧转换产物删除，>100 个全删（防膨胀）
fn prune_preview_cache(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    for e in rd.flatten() {
        if let Ok(meta) = e.metadata()
            && meta.is_file()
        {
            files.push((e.path(), meta.modified().unwrap_or(now)));
        }
    }
    let stale_cutoff = now - std::time::Duration::from_secs(24 * 3600);
    files.sort_by_key(|(_, t)| *t); // 旧者先删
    let overflow = files.len().saturating_sub(100);
    for (i, (p, t)) in files.iter().enumerate() {
        if *t < stale_cutoff || i < overflow {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// doc/ppt/pps（及 WPS 旧格式）→ PDF 预览：PowerShell COM 派发（Office 优先 /
/// WPS 回退，需已装其一），结果缓存 %TEMP%/xdir_preview/<sha>.pdf，同源同版本
/// 秒开；全局串行防多开。需已装 Microsoft Office 或 WPS。
#[tauri::command]
pub async fn preview_doc_pdf(path: String) -> Result<DocPdfPreview, String> {
    let kind = crate::office::office_kind(&path)
        .ok_or_else(|| format!("不支持的转换格式：{}", crate::fs::path::file_name_of(&path)))?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let key = doc_pdf_cache_key(&path.to_ascii_lowercase(), mtime_ms, meta.len());
    let dir = preview_cache_dir();
    let dst = dir.join(format!("{key}.pdf"));
    let src = path;
    tauri::async_runtime::spawn_blocking(move || -> Result<DocPdfPreview, String> {
        let _guard = DOC_PDF_SEM.lock().map_err(|_| "转换串行锁不可用")?;
        if dst.is_file() {
            return Ok(DocPdfPreview {
                pdf_path: dst.to_string_lossy().into_owned(),
                cached: true,
            });
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        prune_preview_cache(&dir);
        crate::office::convert_to_pdf_file(&src, &dst.to_string_lossy(), kind)?;
        Ok(DocPdfPreview {
            pdf_path: dst.to_string_lossy().into_owned(),
            cached: false,
        })
    })
    .await
    .map_err(|e| format!("转换任务失败：{e}"))?
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

    pub(super) fn mkzip(entries: &[(&str, &str)]) -> Vec<u8> {
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
        let (sections, truncated) = docx_sections(&data).unwrap();
        assert!(!truncated);
        // 无分页标记 → 单节「正文」
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].title, "正文");
        assert_eq!(sections[0].text, "段落一\n段落二");
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

    // ── 合并单元格（2026-10-17）──

    #[test]
    fn docx_page_texts_splits_on_breaks() {
        use super::docx_page_blocks;
        // 无分页标记 → 单页
        let xml = r#"<w:document><w:body>
            <w:p><w:r><w:t>第一段</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let (pages, truncated) = docx_page_blocks(xml, 1 << 20, 50);
        assert_eq!(pages.len(), 1);
        assert!(pages[0].text.contains("第一段"));
        assert!(!truncated);
        // lastRenderedPageBreak + 显式分页符混合 → 三页
        let xml = r#"<w:document><w:body>
            <w:p><w:r><w:t>首页内容</w:t><w:lastRenderedPageBreak/></w:r></w:p>
            <w:p><w:r><w:t>第二页</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>
            <w:p><w:r><w:t>第三页</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let (pages, truncated) = docx_page_blocks(xml, 1 << 20, 50);
        assert_eq!(pages.len(), 3);
        assert!(pages[0].text.contains("首页内容"));
        assert!(pages[1].text.contains("第二页"));
        assert!(pages[2].text.contains("第三页"));
        assert!(!truncated);
        // 页数超限：内容并入末页并标记截断
        let xml = r#"<w:document><w:body>
            <w:p><w:r><w:t>A</w:t><w:lastRenderedPageBreak/></w:r></w:p>
            <w:p><w:r><w:t>B</w:t><w:lastRenderedPageBreak/></w:r></w:p>
            <w:p><w:r><w:t>C</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let (pages, truncated) = docx_page_blocks(xml, 1 << 20, 2);
        assert_eq!(pages.len(), 2);
        assert!(pages[1].text.contains("B") && pages[1].text.contains("C"));
        assert!(truncated);
    }

    #[test]
    fn docx_sections_titles_by_page() {
        use super::docx_sections;
        // 手写最小 docx：document.xml 含一个 lastRenderedPageBreak
        let dir = std::env::temp_dir().join(format!("xdir-docx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.docx");
        let xml = r#"<?xml version="1.0"?><w:document xmlns:w="http://x"><w:body>
            <w:p><w:r><w:t>第一页内容</w:t><w:lastRenderedPageBreak/></w:r></w:p>
            <w:p><w:r><w:t>第二页内容</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let mut zip_bytes = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut zip_bytes);
            let mut z = zip::ZipWriter::new(cursor);
            z.start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            std::io::Write::write_all(&mut z, xml.as_bytes()).unwrap();
            z.finish().unwrap();
        }
        std::fs::write(&path, zip_bytes).unwrap();
        let (sections, _) = docx_sections(std::fs::read(&path).unwrap().as_slice()).unwrap();
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].title, "第 1 页");
        assert!(sections[0].text.contains("第一页内容"));
        assert_eq!(sections[1].title, "第 2 页");
        assert!(sections[1].text.contains("第二页内容"));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_csv_rows_handles_quotes() {
        use super::parse_csv_rows;
        // 基础 + 尾换行
        assert_eq!(
            parse_csv_rows(
                "a,b
c,d
", ','
            ),
            vec![vec!["a", "b"], vec!["c", "d"]]
        );
        // 引号内逗号 / 转义引号 / 引号内换行
        assert_eq!(
            parse_csv_rows("\"x,y\",z\n\"他说\"\"好\"\"\",1", ','),
            vec![vec!["x,y", "z"], vec!["他说\"好\"", "1"]]
        );
        // 引号内换行保留为值的一部分
        assert_eq!(
            parse_csv_rows(
                "a,\"b
2\"
",
                ','
            ),
            vec![vec![
                "a", "b
2"
            ]]
        );
        // TSV 分隔符 + 无尾换行
        assert_eq!(parse_csv_rows("a\tb", '\t'), vec![vec!["a", "b"]]);
    }

    #[test]
    fn csv_section_reads_gbk_and_utf8() {
        use super::csv_section;
        let dir = std::env::temp_dir().join(format!("xdir-csv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // UTF-8
        let u = dir.join("u.csv");
        std::fs::write(
            &u,
            "名称,数量
甲,1
乙,2",
        )
        .unwrap();
        let s = csv_section(u.to_str().unwrap(), ',').unwrap();
        assert_eq!(s.title, "u");
        assert!(s.merges.is_empty());
        assert_eq!(
            s.text,
            "名称	数量
甲	1
乙	2
"
        );
        // GBK（Excel 导出常见编码）：名称,数量 / 甲,1
        let g = dir.join("g.csv");
        let (enc_bytes, _, _) = encoding_rs::GBK.encode(
            "名称,数量
甲,1",
        );
        std::fs::write(&g, enc_bytes.as_ref()).unwrap();
        let s = csv_section(g.to_str().unwrap(), ',').unwrap();
        assert_eq!(
            s.text,
            "名称	数量
甲	1
"
        );
        // 引号内逗号不切列
        let q = dir.join("q.csv");
        std::fs::write(
            &q,
            "a,\"b,c\"
",
        )
        .unwrap();
        let s = csv_section(q.to_str().unwrap(), ',').unwrap();
        assert_eq!(
            s.text,
            "a	b,c
"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cell_display_flattens_embedded_breaks() {
        use super::cell_display;
        use calamine::Data;
        // WPS 合并格内的多行文本：换行/制表符替换为空格，不冲乱行列分隔结构
        assert_eq!(cell_display(&Data::String("1\n2\n3".into())), "1 2 3");
        assert_eq!(cell_display(&Data::String("a\tb".into())), "a b");
        assert_eq!(cell_display(&Data::String("x\r\ny".into())), "x y");
    }

    #[test]
    fn parse_merge_ref_spans_and_guards() {
        use super::parse_merge_ref;
        let m = parse_merge_ref("A1:B2").unwrap();
        assert_eq!((m.row, m.col, m.row_span, m.col_span), (0, 0, 2, 2));
        let m = parse_merge_ref("C3:D5").unwrap();
        assert_eq!((m.row, m.col, m.row_span, m.col_span), (2, 2, 3, 2));
        // 无冒号（单格）/ 倒置范围 / 非法列 → None
        assert!(parse_merge_ref("A1").is_none());
        assert!(parse_merge_ref("B2:A1").is_none());
        assert!(parse_merge_ref("AAA1:B2").is_none());
    }

    #[test]
    fn sheet_rids_and_rels() {
        use super::{rel_targets, sheet_rids};
        let wb = r#"<workbook><sheets>
            <sheet name="甲" sheetId="1" r:id="rId3"/>
            <sheet name="乙" sheetId="2" r:id="rId7"/>
        </sheets></workbook>"#;
        assert_eq!(sheet_rids(wb), vec!["rId3", "rId7"]);
        let rels = r#"<Relationships>
            <Relationship Id="rId3" Type="http://x/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
            <Relationship Id="rId7" Type="http://x/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet7.xml"/>
            <Relationship Id="rId9" Type="http://x/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        </Relationships>"#;
        let t = rel_targets(rels);
        assert_eq!(t.get("rId3").unwrap(), "worksheets/sheet3.xml");
        assert_eq!(t.get("rId7").unwrap(), "/xl/worksheets/sheet7.xml");
        assert!(!t.contains_key("rId9")); // styles 不是 worksheet，不入表
    }

    #[test]
    fn worksheet_merges_reads_refs() {
        use super::worksheet_merges;
        let xml = r#"<worksheet><sheetData/></worksheet>"#;
        assert!(worksheet_merges(xml, 10).is_empty());
        let xml = r#"<worksheet><sheetData/><mergeCells count="2">
            <mergeCell ref="A1:B2"/><mergeCell ref="C5:C9"/>
        </mergeCells></worksheet>"#;
        let ms = worksheet_merges(xml, 10);
        assert_eq!(ms.len(), 2);
        assert_eq!(
            (ms[0].row, ms[0].col, ms[0].row_span, ms[0].col_span),
            (0, 0, 2, 2)
        );
        assert_eq!(
            (ms[1].row, ms[1].col, ms[1].row_span, ms[1].col_span),
            (4, 2, 5, 1)
        );
    }

    #[test]
    fn sheet_sections_reads_merges_end_to_end() {
        use super::sheet_sections;
        use rust_xlsxwriter::Format;
        let dir = std::env::temp_dir().join(format!("xdir-merge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("m.xlsx");
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("报表").unwrap();
        // 标题横向合并 A1:C1，纵向合并 A2:A4
        ws.merge_range(0, 0, 0, 2, "标题", &Format::new()).unwrap();
        ws.merge_range(1, 0, 3, 0, "纵向", &Format::new()).unwrap();
        ws.write(1, 1, "x").unwrap();
        wb.save(&path).unwrap();
        let (sections, _) = sheet_sections(path.to_str().unwrap()).unwrap();
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].title, "报表");
        let ms = &sections[0].merges;
        assert_eq!(ms.len(), 2, "{ms:?}");
        assert_eq!(
            (ms[0].row, ms[0].col, ms[0].row_span, ms[0].col_span),
            (0, 0, 1, 3)
        );
        assert_eq!(
            (ms[1].row, ms[1].col, ms[1].row_span, ms[1].col_span),
            (1, 0, 3, 1)
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ────────────────────────── 新格式抽取测试（2026-10-18） ──────────────────────────

#[cfg(test)]
mod office_tests {
    use super::tests::mkzip;
    use super::*;

    #[test]
    fn sniff_container_routes_by_parts() {
        let docx = mkzip(&[("word/document.xml", "<w:document/>")]);
        assert_eq!(sniff_container(&docx), Sniffed::Docx);
        let pptx = mkzip(&[("ppt/presentation.xml", "<p/>")]);
        assert_eq!(sniff_container(&pptx), Sniffed::Slides);
        let xlsx = mkzip(&[("xl/workbook.xml", "<w/>")]);
        assert_eq!(sniff_container(&xlsx), Sniffed::Sheet);
        let ods = mkzip(&[
            ("mimetype", "application/vnd.oasis.opendocument.spreadsheet"),
            ("content.xml", "<x/>"),
        ]);
        assert_eq!(sniff_container(&ods), Sniffed::Ods);
        let odp = mkzip(&[
            (
                "mimetype",
                "application/vnd.oasis.opendocument.presentation",
            ),
            ("content.xml", "<x/>"),
        ]);
        assert_eq!(sniff_container(&odp), Sniffed::Odp);
        let odt = mkzip(&[("content.xml", "<x/>")]);
        assert_eq!(sniff_container(&odt), Sniffed::Odt);
        // OLE 复合文档头（旧版二进制）
        assert_eq!(
            sniff_container(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1]),
            Sniffed::Opaque
        );
        assert_eq!(sniff_container(b"not a container"), Sniffed::Opaque);
    }

    #[test]
    fn heading_levels_from_styles() {
        assert_eq!(heading_level_from_style("Heading1"), Some(1));
        assert_eq!(heading_level_from_style("heading 2"), Some(2));
        assert_eq!(heading_level_from_style("3"), Some(3));
        assert_eq!(heading_level_from_style("Title"), Some(1));
        assert_eq!(heading_level_from_style("标题"), Some(1));
        assert_eq!(heading_level_from_style("Normal"), None);
        assert_eq!(heading_level_from_style(""), None);
        assert_eq!(heading_level_from_style("a3"), None);
    }

    #[test]
    fn docx_blocks_heading_list_table_pagebreak() {
        let xml = concat!(
            r#"<w:document xmlns:w="x"><w:body>"#,
            r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>"#,
            r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>列表项</w:t></w:r></w:p>"#,
            r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc>"#,
            r#"<w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#,
            r#"<w:p><w:r><w:t>第一页尾</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>第二页</w:t></w:r></w:p>"#,
            r#"</w:body></w:document>"#
        );
        let (pages, truncated) = docx_page_blocks(xml, SECTION_CHAR_CAP, SECTION_CAP);
        assert!(!truncated);
        assert_eq!(pages.len(), 2);
        let b = &pages[0].blocks;
        assert_eq!(b[0].kind, "heading");
        assert_eq!(b[0].level, 1);
        assert_eq!(b[0].text, "标题");
        assert_eq!(b[1].kind, "list");
        assert_eq!(b[1].level, 1);
        assert_eq!(b[2].kind, "table");
        assert_eq!(b[2].rows, vec![vec!["甲".to_string(), "乙".to_string()]]);
        assert_eq!(b[3].kind, "para");
        assert_eq!(pages[0].text, "标题\n列表项\n甲\t乙\n第一页尾");
        assert_eq!(pages[1].blocks.len(), 1);
        assert_eq!(pages[1].blocks[0].text, "第二页");
    }

    #[test]
    fn pptx_parts_title_body_notes() {
        let slide = concat!(
            r#"<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>"#,
            r#"<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>"#,
            r#"<p:txBody><a:p><a:r><a:t>大标题</a:t></a:r></a:p></p:txBody></p:sp>"#,
            r#"<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>"#,
            r#"<a:p><a:r><a:t>要点一</a:t></a:r></a:p>"#,
            r#"<a:p><a:pPr lvl="2"/><a:r><a:t>子要点</a:t></a:r></a:p>"#,
            r#"</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
        );
        let (title, body, truncated) = pptx_slide_parts(slide, SECTION_CHAR_CAP);
        assert!(!truncated);
        assert_eq!(title.as_deref(), Some("大标题"));
        assert_eq!(
            body,
            vec![(0, "要点一".to_string()), (2, "子要点".to_string())]
        );
        // 整文件管线：标题 heading 块 + 备注 note 块
        let data = mkzip(&[
            ("ppt/slides/slide1.xml", slide),
            (
                "ppt/notesSlides/notesSlide1.xml",
                "<p:notes xmlns:p=\"p\" xmlns:a=\"a\"><a:p><a:r><a:t>备注内容</a:t></a:r></a:p></p:notes>",
            ),
        ]);
        let (sections, _) = pptx_slides(&data).unwrap();
        assert_eq!(sections.len(), 1);
        let blocks = &sections[0].blocks;
        assert_eq!(blocks[0].kind, "heading");
        assert_eq!(blocks.last().unwrap().kind, "note");
        assert_eq!(blocks.last().unwrap().text, "备注内容");
        assert!(sections[0].text.contains("备注：备注内容"));
    }

    #[test]
    fn odf_text_h_p_table() {
        let xml = concat!(
            "<office:text>",
            "<text:h text:outline-level=\"2\">二级标题</text:h>",
            "<text:p>正文<text:s text:c=\"2\"/>带空格</text:p>",
            "<table:table><table:table-row>",
            "<table:table-cell><text:p>单元格A</text:p></table:table-cell>",
            "<table:table-cell/>",
            "</table:table-row></table:table>",
            "</office:text>"
        );
        let (blocks, text, truncated) = odf_text_blocks(xml, SECTION_CHAR_CAP);
        assert!(!truncated);
        assert_eq!(blocks[0].kind, "heading");
        assert_eq!(blocks[0].level, 2);
        assert_eq!(blocks[1].text, "正文  带空格");
        assert_eq!(blocks[2].kind, "table");
        assert_eq!(
            blocks[2].rows,
            vec![vec!["单元格A".to_string(), String::new()]]
        );
        assert!(text.contains("二级标题"));
    }

    #[test]
    fn odp_pages_title_frame() {
        let xml = concat!(
            "<office:presentation>",
            "<draw:page draw:name=\"封面\">",
            "<draw:frame presentation:class=\"title\"><draw:text-box>",
            "<text:p>季度汇报</text:p></draw:text-box></draw:frame>",
            "<draw:frame><draw:text-box>",
            "<text:p>要点甲</text:p><text:p>要点乙</text:p>",
            "</draw:text-box></draw:frame>",
            "</draw:page>",
            "</office:presentation>"
        );
        let (pages, truncated) = odp_page_blocks(xml, SECTION_CHAR_CAP);
        assert!(!truncated);
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].0, "封面");
        let blocks = &pages[0].1;
        assert_eq!(blocks[0].kind, "heading");
        assert_eq!(blocks[0].text, "季度汇报");
        assert_eq!(blocks[1].kind, "para");
        assert_eq!(blocks[2].kind, "para");
    }

    #[test]
    fn ods_merges_from_content_xml() {
        let xml = concat!(
            "<office:spreadsheet>",
            "<table:table table:name=\"S1\"><table:table-row>",
            "<table:table-cell table:number-columns-spanned=\"2\" table:number-rows-spanned=\"2\"/>",
            "<table:covered-table-cell/>",
            "<table:table-cell/>",
            "</table:table-row>",
            "<table:table-row>",
            "<table:covered-table-cell table:number-columns-repeated=\"2\"/>",
            "<table:table-cell/>",
            "</table:table-row></table:table>",
            "<table:table table:name=\"S2\"><table:table-row><table:table-cell/></table:table-row></table:table>",
            "</office:spreadsheet>"
        );
        let tables = ods_merges_xml(xml, MERGE_CAP);
        assert_eq!(tables.len(), 2);
        assert_eq!(
            tables[0],
            vec![SheetMerge {
                row: 0,
                col: 0,
                row_span: 2,
                col_span: 2
            }]
        );
        assert!(tables[1].is_empty());
    }

    #[test]
    fn rtf_gbk_unicode_and_skip_destinations() {
        // fonttbl 整组跳过；\'hh 按 ansicpg936 解 GBK；\u20320 后跟 "?" 回退字符
        let rtf: &str = "{\\rtf1\\ansi\\ansicpg936{\\fonttbl{\\f0\\fswiss SimSun;}}\\f0 Hello \\'c4\\'e3\\'ba\\'c3\\par\\u20320?\\par}";
        let (blocks, text, truncated) = rtf_blocks(rtf.as_bytes(), SECTION_CHAR_CAP);
        assert!(!truncated);
        assert!(!text.contains("SimSun"));
        assert!(text.contains("Hello 你好"));
        assert!(text.contains("你"));
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn utf16le_and_filetime_conversion() {
        // "AB" UTF-16LE
        assert_eq!(utf16le_to_string(&[0x41, 0x00, 0x42, 0x00]), "AB");
        // civil_from_days 锚点
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        // 2020-01-01 UTC 的 FILETIME ticks
        let ticks: u64 = (1_577_836_800u64 + 11_644_473_600) * 10_000_000;
        assert_eq!(
            filetime_to_date(&ticks.to_le_bytes()).as_deref(),
            Some("2020-01-01")
        );
        assert_eq!(filetime_to_date(&[1, 2, 3]), None);
    }

    fn build_msg(subject: &str, from: &str, body: &str) -> Vec<u8> {
        use std::io::Write as _;
        let utf16 =
            |s: &str| -> Vec<u8> { s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect() };
        let mut c = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
        let mut put = |name: &str, bytes: Vec<u8>| {
            let mut s = c.create_new_stream(name).unwrap();
            s.write_all(&bytes).unwrap();
        };
        put("__substg1.0_0037001F", utf16(subject));
        put("__substg1.0_0C1A001F", utf16(from));
        put("__substg1.0_1000001F", utf16(body));
        c.into_inner().into_inner()
    }

    #[test]
    fn msg_streams_to_info_and_body() {
        let data = build_msg("季度对账", "张三", "第一行\r\n第二行");
        let office = msg_office(&data).unwrap();
        assert_eq!(office.kind, "email");
        assert_eq!(office.sections.len(), 2);
        let info = &office.sections[0].blocks;
        assert_eq!(info[0].kind, "kv");
        assert_eq!(info[0].label, "主题");
        assert_eq!(info[0].text, "季度对账");
        assert_eq!(info[1].label, "发件人");
        assert_eq!(office.sections[1].text, "第一行\n第二行");
    }

    #[test]
    fn eml_headers_body_attachments() {
        let raw = concat!(
            "From: Alice <alice@example.com>\r\n",
            "To: bob@example.com\r\n",
            "Subject: =?UTF-8?B?5L2g5aW9?=\r\n",
            "Date: Fri, 18 Oct 2026 10:00:00 +0800\r\n",
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/mixed; boundary=\"BOUND\"\r\n\r\n",
            "--BOUND\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n\r\n",
            "正文内容第一行\r\n--BOUND\r\n",
            "Content-Type: application/pdf; name=\"a.pdf\"\r\n",
            "Content-Disposition: attachment; filename=\"a.pdf\"\r\n\r\n",
            "JVBERi0=\r\n--BOUND--\r\n"
        );
        let office = eml_office(raw.as_bytes()).unwrap();
        assert_eq!(office.kind, "email");
        let info = &office.sections[0].blocks;
        let subject = info.iter().find(|b| b.label == "主题").unwrap();
        assert_eq!(subject.text, "你好"); // RFC2047 解码
        let att = info.iter().find(|b| b.label == "附件").unwrap();
        assert_eq!(att.text, "a.pdf");
        assert!(office.sections[1].text.contains("正文内容第一行"));
    }

    #[test]
    fn doc_pdf_cache_key_stable_and_mtime_sensitive() {
        let k1 = doc_pdf_cache_key("c:\\a\\b.doc", 1000, 42);
        let k2 = doc_pdf_cache_key("c:\\a\\b.doc", 1000, 42);
        let k3 = doc_pdf_cache_key("c:\\a\\b.doc", 2000, 42);
        assert_eq!(k1, k2);
        assert_ne!(k1, k3);
        assert_eq!(k1.len(), 64);
    }

    #[test]
    fn cell_display_renders_dates_not_serials() {
        use calamine::{ExcelDateTime, ExcelDateTimeType};
        let dt = ExcelDateTime::new(1.0, ExcelDateTimeType::DateTime, false);
        assert_eq!(
            cell_display(&calamine::Data::DateTime(dt)),
            "1900-01-01 00:00:00"
        );
        let dur = ExcelDateTime::new(0.5, ExcelDateTimeType::TimeDelta, false);
        assert_eq!(cell_display(&calamine::Data::DateTime(dur)), "12:00:00");
    }
}
