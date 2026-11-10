//! 文件清单导出（2026-11-10 增强）：行收集（选中项逐个 stat / 空白处整树递归，
//! 文件夹行含子树体积）+ 三格式构建（CSV 原始字节 / Markdown 人类可读体积 /
//! 纯文本相对路径）。列集 = 序号/名称/类型/大小/修改时间/创建时间/属性/相对路径。
//! 纯逻辑无 Tauri 依赖，配 cargo test（前端不再构建清单文本——列表分页下发，
//! 前端只持有当前页，整文件夹必须 Rust 端收集）。

use std::time::UNIX_EPOCH;

use super::entry::{
    FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM, FileAttrs,
    systemtime_to_unix_ms,
};
use super::path::{file_name_of, is_valid_name, to_extended};

/// 行数上限（防病态目录树拖死导出；analyze.rs MAX_FILES 同量级）。
/// 超限整体中止报错而非静默截断——清单用于留档核对，缺行即失真
pub const MAX_ROWS: usize = 200_000;

/// 导出文件基名 = 「文件夹名-文件清单」（2026-11-10 用户定案：如
/// 收益预算 → 收益预算-文件清单.csv）。尾反斜杠由 file_name_of 容忍；
/// 盘根（"D:"）/非法名/空名回落「文件清单」（无文件夹名可冠）
pub fn listing_base_name(dir: &str) -> String {
    let n = file_name_of(dir);
    if n.is_empty() || !is_valid_name(&n) {
        return "文件清单".to_string();
    }
    format!("{n}-文件清单")
}

/// 行收集失败两类（命令层映射 AppError）
#[derive(Debug)]
pub enum CollectError {
    /// 超 MAX_ROWS（携带上限值供报错文案）
    TooMany(usize),
    /// 选中项全部不可读（含空输入）
    Unreadable,
}

pub struct ListingRow {
    /// 完整路径（呈现列；txt 格式 = 本字段一行一个）
    pub path: String,
    pub name: String,
    /// 相对导出根的路径（根直属 = 名称；深层 = `子\孙\名.txt`）
    pub rel: String,
    pub is_dir: bool,
    /// 文件 = 自身字节；递归模式文件夹 = 子树合计；非递归文件夹 = 0（呈现留空）
    pub size: u64,
    pub mtime_ms: u64,
    /// 文件系统不支持创建时间时为 0（呈现 "—"）
    pub ctime_ms: u64,
    pub attrs: FileAttrs,
}

fn attrs_of(meta: &std::fs::Metadata) -> FileAttrs {
    #[cfg(windows)]
    let raw = std::os::windows::fs::MetadataExt::file_attributes(meta);
    #[cfg(not(windows))]
    let raw = 0u32;
    FileAttrs {
        hidden: raw & FILE_ATTRIBUTE_HIDDEN != 0,
        system: raw & FILE_ATTRIBUTE_SYSTEM != 0,
        readonly: raw & FILE_ATTRIBUTE_READONLY != 0,
    }
}

/// 选中项收集：保持选中顺序，单条失效（已删除/不可读）跳过不中断（§6.10），
/// 全部失效才报错。选中项恒为当前目录直属子项 → 相对路径 = 名称（防御性
/// 剥前缀兜底深层路径）。recursive = 穿透子文件夹：选中的文件夹行后紧跟其
/// 子树行（rel 前缀 = 文件夹名，与整树导出同构）
pub fn collect_selected(
    paths: &[String],
    base: &str,
    recursive: bool,
    cap: usize,
) -> Result<Vec<ListingRow>, CollectError> {
    let mut rows = Vec::new();
    for p in paths {
        let name = file_name_of(p);
        if name.is_empty() {
            continue;
        }
        let Ok(meta) = std::fs::metadata(to_extended(p)) else {
            continue;
        };
        let rel = p
            .strip_prefix(base)
            .map(|s| s.trim_start_matches('\\'))
            .filter(|s| !s.is_empty())
            .unwrap_or(&name)
            .to_string();
        rows.push(ListingRow {
            path: p.clone(),
            name,
            rel,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime_ms: systemtime_to_unix_ms(meta.modified().unwrap_or(UNIX_EPOCH)),
            ctime_ms: systemtime_to_unix_ms(meta.created().unwrap_or(UNIX_EPOCH)),
            attrs: attrs_of(&meta),
        });
        if recursive && meta.is_dir() {
            // 子树 rel 前缀 = 文件夹名；行自身体积由 walk_dir 回填口径一致——
            // 此处文件夹行恒 0（自身行不汇总子树，子树行就在旁边无需汇总）
            let rel_prefix = rows.last().map(|r| r.rel.clone()).unwrap_or_default();
            walk_dir(p, &rel_prefix, recursive, &mut rows, cap)?;
        }
    }
    if rows.is_empty() {
        return Err(CollectError::Unreadable);
    }
    Ok(rows)
}

/// 整树收集：recursive = DFS 先序（子项目录/文件按名称不分大小写混排，
/// Explorer 同款；目录行紧跟其子树行），文件夹行 size 回填子树文件字节合计；
/// 非递归 = 仅直接子项（文件夹行 size 0 呈现留空）。不可读目录跳过；
/// junction/符号链接一律跳过（analyze.rs 同款防环防重复计数）
pub fn collect_tree(
    root: &str,
    recursive: bool,
    cap: usize,
) -> Result<Vec<ListingRow>, CollectError> {
    let mut rows = Vec::new();
    walk_dir(root, "", recursive, &mut rows, cap)?;
    Ok(rows)
}

fn walk_dir(
    dir: &str,
    rel_prefix: &str,
    recursive: bool,
    rows: &mut Vec<ListingRow>,
    cap: usize,
) -> Result<u64, CollectError> {
    let Ok(rd) = std::fs::read_dir(to_extended(dir)) else {
        return Ok(0); // 不可读目录跳过不中断（§6.10）
    };
    let mut items: Vec<(ListingRow, Option<String>)> = Vec::new(); // (行, 目录全路径)
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if rows.len() + items.len() >= cap {
            return Err(CollectError::TooMany(cap));
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}\\{name}")
        };
        let Ok(meta) = entry.metadata() else { continue };
        let is_dir = ft.is_dir();
        let row = ListingRow {
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            mtime_ms: systemtime_to_unix_ms(meta.modified().unwrap_or(UNIX_EPOCH)),
            ctime_ms: systemtime_to_unix_ms(meta.created().unwrap_or(UNIX_EPOCH)),
            attrs: attrs_of(&meta),
            name,
            rel,
        };
        let sub = is_dir.then(|| entry.path().to_string_lossy().into_owned());
        items.push((row, sub));
    }
    items.sort_by_key(|(r, _)| r.name.to_lowercase());
    let mut total: u64 = 0;
    for (row, path) in items {
        let idx = rows.len();
        rows.push(row);
        if let Some(path) = path {
            if !recursive {
                continue; // 非穿透：文件夹行保留（size 0 呈现留空）但不深入
            }
            let rel = rows[idx].rel.clone();
            let sub = walk_dir(&path, &rel, recursive, rows, cap)?;
            rows[idx].size = sub;
            total += sub;
        } else {
            total += rows[idx].size;
        }
    }
    Ok(total)
}

// ── 三格式构建（列集 CSV/MD 一致：序号/名称/扩展名/是否文件夹/大小/
//    修改时间/创建时间/属性/相对路径/完整路径；txt = 完整路径一行一个）──

const CSV_COLS: &str =
    "序号,名称,扩展名,是否文件夹,大小(字节),修改时间,创建时间,属性,相对路径,完整路径";
const MD_COLS: &str = "| 序号 | 名称 | 扩展名 | 是否文件夹 | 大小 | 修改时间 | 创建时间 | 属性 | 相对路径 | 完整路径 |";
const MD_RULE: &str = "| ---: | --- | --- | --- | ---: | --- | --- | --- | --- | --- |";

/// RFC 4180：含逗号/引号/换行的字段整段加引号、内部引号翻倍
fn esc(v: &str) -> String {
    if v.contains(',') || v.contains('"') || v.contains('\r') || v.contains('\n') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

/// Markdown 表格单元内的管道与换行会破坏列结构，替换为全角/空格
fn md_esc(v: &str) -> String {
    v.replace('|', "｜").replace(['\r', '\n'], " ")
}

/// 扩展名列：末点后段小写；点首隐藏文件/无扩展名/文件夹 = 空
fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// 是否文件夹列：是/否
fn is_dir_text(is_dir: bool) -> &'static str {
    if is_dir { "是" } else { "否" }
}

/// 属性列：只读/隐藏/系统，无则空
fn attrs_text(r: &ListingRow) -> String {
    let mut v: Vec<&str> = Vec::new();
    if r.attrs.readonly {
        v.push("只读");
    }
    if r.attrs.hidden {
        v.push("隐藏");
    }
    if r.attrs.system {
        v.push("系统");
    }
    v.join("/")
}

/// 文件夹无体积语义（非递归 0 / 空子树）：CSV 留空、MD 显示 "—"；
/// 0 字节文件是真实数据，不受此规则影响（CSV "0"）
fn size_csv(r: &ListingRow) -> String {
    if r.is_dir && r.size == 0 {
        String::new()
    } else {
        r.size.to_string()
    }
}

fn size_md(r: &ListingRow) -> String {
    if r.is_dir && r.size == 0 {
        "—".to_string()
    } else {
        format_bytes(r.size)
    }
}

/// 裸字节数 → 人类可读（与前端 formatBytes 同口径：1024 进制一位小数）
fn format_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0usize;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

/// 构建清单内容（2026-11-10 增 XLSX）：文本三格式为 UTF-8 文本（BOM 由命令
/// 层加——Excel 中文表头必需），xlsx 为二进制容器直出
pub fn build_listing(rows: &[ListingRow], fmt: &str) -> ListingPayload {
    match fmt {
        "md" => ListingPayload::Text(build_md(rows)),
        "txt" => ListingPayload::Text(build_txt(rows)),
        "xlsx" => ListingPayload::Xlsx(build_xlsx(rows)),
        _ => ListingPayload::Text(build_csv(rows)),
    }
}

/// 清单载荷：Text = csv/md/txt 文本；Xlsx = 工作簿字节
pub enum ListingPayload {
    Text(String),
    Xlsx(Vec<u8>),
}

/// XLSX 工作簿（rust_xlsxwriter 0.99，树内 Excel 合并同款依赖）：表头行 +
/// 数据行，体积列为真数字（审计可直接求和/筛选），首行冻结、列宽自适应后
/// 对名称/路径三列封顶。默认工作表名「文件清单」
fn build_xlsx(rows: &[ListingRow]) -> Vec<u8> {
    let mut wb = rust_xlsxwriter::Workbook::new();
    let ws = wb.add_worksheet();
    let _ = ws.set_name("文件清单");
    const HEADERS: [&str; 10] = [
        "序号",
        "名称",
        "扩展名",
        "是否文件夹",
        "大小(字节)",
        "修改时间",
        "创建时间",
        "属性",
        "相对路径",
        "完整路径",
    ];
    for (c, h) in HEADERS.iter().enumerate() {
        let _ = ws.write_string(0, c as u16, *h);
    }
    for (i, r) in rows.iter().enumerate() {
        let row = (i + 1) as u32;
        let _ = ws.write_number(row, 0, (i + 1) as f64);
        let _ = ws.write_string(row, 1, &r.name);
        let _ = ws.write_string(row, 2, ext_of(&r.name));
        let _ = ws.write_string(row, 3, is_dir_text(r.is_dir));
        // 文件夹无体积语义（非递归 0 / 空子树）留空；0 字节文件写真 0
        if !(r.is_dir && r.size == 0) {
            let _ = ws.write_number(row, 4, r.size as f64);
        }
        let _ = ws.write_string(row, 5, fmt_ts(r.mtime_ms));
        let _ = ws.write_string(row, 6, fmt_ts(r.ctime_ms));
        let _ = ws.write_string(row, 7, attrs_text(r));
        let _ = ws.write_string(row, 8, &r.rel);
        let _ = ws.write_string(row, 9, &r.path);
    }
    let _ = ws.autofit();
    // 自适应后对长文本三列封顶（超长路径不把工作表撑成 read 时横向爆宽）
    let _ = ws.set_column_width(1, 30);
    let _ = ws.set_column_width(8, 40);
    let _ = ws.set_column_width(9, 70);
    let _ = ws.set_freeze_panes(1, 0);
    wb.save_to_buffer().unwrap_or_default()
}

fn build_txt(rows: &[ListingRow]) -> String {
    rows.iter()
        .map(|r| r.path.as_str())
        .collect::<Vec<_>>()
        .join("\r\n")
}

fn build_csv(rows: &[ListingRow]) -> String {
    let mut out = vec![CSV_COLS.to_string()];
    for (i, r) in rows.iter().enumerate() {
        out.push(
            [
                (i + 1).to_string(),
                esc(&r.name),
                esc(&ext_of(&r.name)),
                is_dir_text(r.is_dir).to_string(),
                size_csv(r),
                fmt_ts(r.mtime_ms),
                fmt_ts(r.ctime_ms),
                esc(&attrs_text(r)),
                esc(&r.rel),
                esc(&r.path),
            ]
            .join(","),
        );
    }
    out.join("\r\n")
}

fn build_md(rows: &[ListingRow]) -> String {
    let mut out = vec![MD_COLS.to_string(), MD_RULE.to_string()];
    for (i, r) in rows.iter().enumerate() {
        out.push(format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            i + 1,
            md_esc(&r.name),
            md_esc(&ext_of(&r.name)),
            is_dir_text(r.is_dir),
            size_md(r),
            fmt_ts(r.mtime_ms),
            fmt_ts(r.ctime_ms),
            md_esc(&attrs_text(r)),
            md_esc(&r.rel),
            md_esc(&r.path),
        ));
    }
    out.join("\r\n")
}

/// 内容筛选（2026-11-10 参数面板「导出内容」）：None = 全部；Some(d) = 仅
/// 文件夹(d=true)/仅文件(d=false)
pub fn retain_content(rows: &mut Vec<ListingRow>, keep_dirs: Option<bool>) {
    if let Some(d) = keep_dirs {
        rows.retain(|r| r.is_dir == d);
    }
}

/// Unix ms → 本地 "YYYY-MM-DD HH:mm"（分钟精度，与前端 formatTime 同口径；
/// 0 = "—"）。Windows 主路径 FileTimeToSystemTime → SystemTimeToTzSpecific
/// LocalTime 按文件自身时刻的 DST 规则换算（现偏移近似会跨夏令时错 1 小时）；
/// API 失败回落 matcher 同款当前偏移
pub fn fmt_ts(ms: u64) -> String {
    if ms == 0 {
        return "—".to_string();
    }
    if let Some(s) = fmt_ts_local_api(ms) {
        return s;
    }
    let local = (ms as i64).saturating_add(super::matcher::local_utc_offset_ms(ms));
    let (y, m, d) = super::matcher::civil_from_days(local.div_euclid(86_400_000));
    let rem = local.rem_euclid(86_400_000);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        y,
        m,
        d,
        rem / 3_600_000,
        (rem % 3_600_000) / 60_000
    )
}

#[cfg(windows)]
fn fmt_ts_local_api(ms: u64) -> Option<String> {
    use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
    // FILETIME = 1601-01-01 起的 100ns 刻度
    let ticks = ms
        .checked_mul(10_000)?
        .checked_add(116_444_736_000_000_000)?;
    let ft = windows::Win32::Foundation::FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    let mut utc = windows::Win32::Foundation::SYSTEMTIME::default();
    unsafe { FileTimeToSystemTime(&ft, &mut utc) }.ok()?;
    let mut loc = windows::Win32::Foundation::SYSTEMTIME::default();
    unsafe { SystemTimeToTzSpecificLocalTime(None, &utc, &mut loc) }.ok()?;
    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        loc.wYear, loc.wMonth, loc.wDay, loc.wHour, loc.wMinute
    ))
}

#[cfg(not(windows))]
fn fmt_ts_local_api(_ms: u64) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn tempdir(tag: &str) -> String {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "xdir-listing-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    fn cleanup(dir: &str) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn row(name: &str, dir: &str, is_dir: bool, size: u64, ro: bool, hid: bool) -> ListingRow {
        ListingRow {
            path: format!("{dir}\\{name}"),
            name: name.to_string(),
            rel: name.to_string(),
            is_dir,
            size,
            mtime_ms: if is_dir { 0 } else { 1_700_000_000_000 },
            ctime_ms: 0,
            attrs: FileAttrs {
                hidden: hid,
                system: false,
                readonly: ro,
            },
        }
    }

    // ── CSV 构建（十列）──
    #[test]
    fn csv_columns_and_dir_size_blank() {
        let d = "E:\\d";
        let rows = [
            row("报告.docx", d, false, 12345, false, false),
            row("子夹", d, true, 0, false, false),
        ];
        let csv = build_csv(&rows);
        let lines: Vec<&str> = csv.split("\r\n").collect();
        assert_eq!(
            lines[0],
            "序号,名称,扩展名,是否文件夹,大小(字节),修改时间,创建时间,属性,相对路径,完整路径"
        );
        let c1 = lines[1];
        assert!(c1.starts_with("1,报告.docx,docx,否,12345,"), "{c1}");
        assert!(c1.contains("2023-"), "{c1} 含非零修改时间");
        assert!(c1.contains("—")); // 创建时间 0 → "—"
        assert!(c1.ends_with(",报告.docx,E:\\d\\报告.docx")); // 相对路径+完整路径收尾
        let c2 = lines[2];
        // 文件夹：扩展名空、是否文件夹=是、大小留空
        assert!(c2.starts_with("2,子夹,,是,,"), "{c2}");
    }

    #[test]
    fn csv_zero_byte_file_keeps_zero() {
        let rows = [row("空.bin", "E:\\d", false, 0, false, false)];
        let line = build_csv(&rows).split("\r\n").nth(1).unwrap().to_string();
        assert!(line.starts_with("1,空.bin,bin,否,0,"), "{line}");
    }

    #[test]
    fn csv_rfc4180_escaping_and_attrs() {
        let rows = [
            row("a\",b.csv", "E:\\d", false, 1, true, true),
            row(".gitignore", "E:\\d", false, 2, false, false),
            row("noext", "E:\\d", false, 3, false, false),
        ];
        let lines: Vec<String> = build_csv(&rows).split("\r\n").map(String::from).collect();
        assert!(lines[1].contains("\"a\"\",b.csv\""), "{:?}", lines[1]);
        assert!(lines[1].contains("只读/隐藏"));
        assert!(lines[2].contains("2,.gitignore,,否,")); // 点首隐藏文件扩展名空
        assert!(lines[3].contains("3,noext,,否,")); // 无扩展名扩展名空
    }

    #[test]
    fn csv_serial_number_continuity() {
        let rows = [
            row("a", "E:\\d", false, 1, false, false),
            row("b", "E:\\d", false, 2, false, false),
            row("c", "E:\\d", false, 3, false, false),
        ];
        let lines: Vec<String> = build_csv(&rows).split("\r\n").map(String::from).collect();
        assert_eq!(lines.len(), 4);
        for (i, l) in lines[1..].iter().enumerate() {
            assert!(l.starts_with(&format!("{}", i + 1)), "{l}");
        }
    }

    // ── Markdown 构建 ──
    #[test]
    fn md_header_rule_human_size_pipe_escape() {
        let rows = [
            row("a|b.txt", "E:\\d", false, 1536, false, false),
            row("子夹", "E:\\d", true, 0, false, false),
            row("满夹", "E:\\d", true, 2_500_000, false, false),
        ];
        let lines: Vec<String> = build_md(&rows).split("\r\n").map(String::from).collect();
        assert_eq!(
            lines[0],
            "| 序号 | 名称 | 扩展名 | 是否文件夹 | 大小 | 修改时间 | 创建时间 | 属性 | 相对路径 | 完整路径 |"
        );
        assert_eq!(
            lines[1],
            "| ---: | --- | --- | --- | ---: | --- | --- | --- | --- | --- |"
        );
        assert!(lines[2].contains("a｜b.txt"));
        assert!(lines[2].contains("1.5 KB"));
        assert!(lines[3].contains("| — |")); // 空文件夹体积 → "—"
        assert!(lines[3].contains("| 是 |")); // 是否文件夹
        assert!(lines[4].contains("2.4 MB")); // 2500000/1024/1024 = 2.384 → 2.4
    }

    // ── 纯文本（完整路径一行一个）──
    #[test]
    fn txt_full_paths_crlf() {
        let rows = [
            row("a.txt", "E:\\d", false, 1, false, false),
            row("b.txt", "E:\\d", false, 2, false, false),
        ];
        assert_eq!(build_txt(&rows), "E:\\d\\a.txt\r\nE:\\d\\b.txt");
    }

    // ── XLSX 构建 ──
    #[test]
    fn xlsx_readback_header_and_rows() {
        let rows = [
            row("报告.docx", "E:\\d", false, 12345, false, false),
            row("子夹", "E:\\d", true, 0, false, false),
            row("空.bin", "E:\\d", false, 0, false, false),
        ];
        let bytes = build_xlsx(&rows);
        assert!(bytes.starts_with(b"PK"), "xlsx 为 zip 容器");
        let path = std::env::temp_dir().join(format!(
            "xdir-listing-xlsx-{}-readback.xlsx",
            std::process::id()
        ));
        std::fs::write(&path, &bytes).unwrap();
        let mut book = calamine::open_workbook_auto(&path).expect("calamine 可读回");
        use calamine::Reader;
        let range = book
            .worksheet_range("文件清单")
            .expect("默认工作表名 = 文件清单");
        let cell = |r: u32, c: u32| range.get_value((r, c)).map(|v| v.to_string());
        assert_eq!(cell(0, 0).as_deref(), Some("序号"));
        assert_eq!(cell(0, 4).as_deref(), Some("大小(字节)"));
        assert_eq!(cell(1, 1).as_deref(), Some("报告.docx"));
        assert_eq!(cell(1, 2).as_deref(), Some("docx"));
        assert_eq!(cell(1, 3).as_deref(), Some("否"));
        assert_eq!(cell(1, 4).as_deref(), Some("12345")); // 数值列
        assert_eq!(cell(2, 3).as_deref(), Some("是"));
        assert_eq!(
            cell(2, 4).as_deref(),
            Some(""),
            "文件夹体积留空（空单元格）"
        );
        assert_eq!(cell(3, 4).as_deref(), Some("0"), "0 字节文件写真 0");
        assert_eq!(range.height(), 4); // 表头 + 3 行
        let _ = std::fs::remove_file(&path);
    }

    // ── 内容筛选 ──
    #[test]
    fn retain_content_filter() {
        let mut rows = vec![
            row("a.txt", "E:\\d", false, 1, false, false),
            row("子夹", "E:\\d", true, 0, false, false),
            row("b.txt", "E:\\d", false, 2, false, false),
        ];
        retain_content(&mut rows, Some(false)); // 仅文件
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| !r.is_dir));
        retain_content(&mut rows, Some(true)); // 仅文件夹
        assert!(rows.is_empty());
        let mut rows2 = vec![row("a.txt", "E:\\d", false, 1, false, false)];
        retain_content(&mut rows2, None); // 全部不动
        assert_eq!(rows2.len(), 1);
    }

    // ── 时间格式 ──
    #[test]
    fn fmt_ts_zero_and_shape() {
        assert_eq!(fmt_ts(0), "—");
        let s = fmt_ts(1_700_000_000_000);
        assert_eq!(s.len(), 16, "{s}");
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
        assert_eq!(&s[10..11], " ");
        assert_eq!(&s[13..14], ":");
    }

    // ── 导出基名 ──
    #[test]
    fn base_name_follows_folder() {
        assert_eq!(listing_base_name("D:\\工作\\收益预算"), "收益预算-文件清单");
        assert_eq!(
            listing_base_name("D:\\工作\\收益预算\\"),
            "收益预算-文件清单"
        ); // 尾反斜杠
        assert_eq!(listing_base_name("D:\\"), "文件清单"); // 盘根 "D:" 非法名回落
        assert_eq!(listing_base_name(""), "文件清单");
    }

    // ── 整树收集 ──
    #[test]
    fn tree_dfs_order_and_subtree_sizes() {
        let dir = tempdir("tree");
        // root/甲.txt(10) root/乙.log(20) root/子A/a.txt(100) root/子A/孙B/b.bin(1000)
        std::fs::write(join_test(&dir, "甲.txt"), vec![0u8; 10]).unwrap();
        std::fs::write(join_test(&dir, "乙.log"), vec![0u8; 20]).unwrap();
        let a = join_test(&dir, "子A");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(join_test(&a, "a.txt"), vec![0u8; 100]).unwrap();
        let b = join_test(&a, "孙B");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(join_test(&b, "b.bin"), vec![0u8; 1000]).unwrap();

        let rows = collect_tree(&dir, true, MAX_ROWS).unwrap();
        let rels: Vec<&str> = rows.iter().map(|r| r.rel.as_str()).collect();
        // 子项按名称混排（不分大小写字节序："乙" U+4E59 < "子" U+5B50 <
        // "甲" U+7532；ASCII "a.txt" 在 孙B 前），目录行紧跟其子树
        assert_eq!(
            rels,
            [
                "乙.log",
                "子A",
                "子A\\a.txt",
                "子A\\孙B",
                "子A\\孙B\\b.bin",
                "甲.txt"
            ],
            "{rels:?}"
        );
        let by_rel = |s: &str| rows.iter().find(|r| r.rel == s).unwrap();
        assert_eq!(by_rel("子A").size, 1100); // 子树合计 = 100 + 1000
        assert_eq!(by_rel("子A\\孙B").size, 1000);
        assert!(by_rel("子A").is_dir);
        assert_eq!(rows.len(), 6);
        // 完整路径列 = 根 + rel
        assert_eq!(by_rel("子A\\a.txt").path, format!("{dir}\\子A\\a.txt"));
        cleanup(&dir);
    }

    #[test]
    fn tree_flat_mode_skips_subtree() {
        let dir = tempdir("flat");
        std::fs::write(join_test(&dir, "甲.txt"), vec![0u8; 10]).unwrap();
        let a = join_test(&dir, "子A");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(join_test(&a, "a.txt"), vec![0u8; 100]).unwrap();

        let rows = collect_tree(&dir, false, MAX_ROWS).unwrap();
        assert_eq!(rows.len(), 2, "非穿透 = 仅直接子项");
        let sub = rows.iter().find(|r| r.name == "子A").unwrap();
        assert!(sub.is_dir);
        assert_eq!(sub.size, 0, "非穿透文件夹行无子树体积");
        assert!(!rows.iter().any(|r| r.name == "a.txt"));
        cleanup(&dir);
    }

    #[test]
    fn tree_cap_exceeded_errors() {
        let dir = tempdir("cap");
        for i in 0..5 {
            std::fs::write(join_test(&dir, &format!("f{i}.txt")), b"x").unwrap();
        }
        assert!(matches!(
            collect_tree(&dir, true, 2),
            Err(CollectError::TooMany(2))
        ));
        cleanup(&dir);
    }

    #[test]
    fn tree_empty_dir_ok() {
        let dir = tempdir("empty");
        let rows = collect_tree(&dir, true, MAX_ROWS).unwrap();
        assert!(rows.is_empty());
        cleanup(&dir);
    }

    // ── 选中项收集 ──
    #[test]
    fn selected_order_preserved_and_missing_skipped() {
        let dir = tempdir("sel");
        std::fs::write(join_test(&dir, "乙.txt"), b"bb").unwrap();
        std::fs::write(join_test(&dir, "甲.txt"), b"aa").unwrap();
        let paths = vec![
            join_test(&dir, "乙.txt"),
            join_test(&dir, "没有.txt"), // 已失效 → 跳过
            join_test(&dir, "甲.txt"),
        ];
        let rows = collect_selected(&paths, &dir, false, MAX_ROWS).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "乙.txt"); // 保持选中顺序不重排
        assert_eq!(rows[0].rel, "乙.txt");
        assert_eq!(rows[0].size, 2);
        assert_eq!(rows[1].name, "甲.txt");
        cleanup(&dir);
    }

    #[test]
    fn selected_recursive_walks_selected_dirs() {
        let dir = tempdir("selrec");
        std::fs::write(join_test(&dir, "根文件.txt"), b"x").unwrap();
        let sub = join_test(&dir, "选中夹");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(join_test(&sub, "内层.txt"), vec![0u8; 50]).unwrap();
        let inner = join_test(&sub, "更深");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(join_test(&inner, "深.txt"), vec![0u8; 5]).unwrap();

        // 非穿透：仅选中项本身
        let rows = collect_selected(&[join_test(&dir, "选中夹")], &dir, false, MAX_ROWS).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_dir);
        // 穿透：文件夹行 + 子树（rel 前缀 = 文件夹名，子项混排序）
        let rows = collect_selected(&[join_test(&dir, "选中夹")], &dir, true, MAX_ROWS).unwrap();
        let rels: Vec<&str> = rows.iter().map(|r| r.rel.as_str()).collect();
        assert_eq!(
            rels,
            [
                "选中夹",
                "选中夹\\内层.txt",
                "选中夹\\更深",
                "选中夹\\更深\\深.txt"
            ],
            "{rels:?}"
        );
        assert_eq!(rows[0].size, 0, "选中文件夹自身行不汇总子树");
        cleanup(&dir);
    }

    #[test]
    fn selected_all_missing_errors() {
        let dir = tempdir("selmiss");
        let paths = vec![join_test(&dir, "没有.txt")];
        assert!(matches!(
            collect_selected(&paths, &dir, false, MAX_ROWS),
            Err(CollectError::Unreadable)
        ));
        assert!(matches!(
            collect_selected(&[], &dir, false, MAX_ROWS),
            Err(CollectError::Unreadable)
        ));
        cleanup(&dir);
    }

    fn join_test(dir: &str, name: &str) -> String {
        format!("{dir}\\{name}")
    }
}
