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
use super::path::{file_name_of, to_extended};

/// 行数上限（防病态目录树拖死导出；analyze.rs MAX_FILES 同量级）。
/// 超限整体中止报错而非静默截断——清单用于留档核对，缺行即失真
pub const MAX_ROWS: usize = 200_000;

/// 行收集失败两类（命令层映射 AppError）
#[derive(Debug)]
pub enum CollectError {
    /// 超 MAX_ROWS（携带上限值供报错文案）
    TooMany(usize),
    /// 选中项全部不可读（含空输入）
    Unreadable,
}

pub struct ListingRow {
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
/// 剥前缀兜底深层路径）
pub fn collect_selected(paths: &[String], base: &str) -> Result<Vec<ListingRow>, CollectError> {
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
            name,
            rel,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime_ms: systemtime_to_unix_ms(meta.modified().unwrap_or(UNIX_EPOCH)),
            ctime_ms: systemtime_to_unix_ms(meta.created().unwrap_or(UNIX_EPOCH)),
            attrs: attrs_of(&meta),
        });
    }
    if rows.is_empty() {
        return Err(CollectError::Unreadable);
    }
    Ok(rows)
}

/// 整树递归收集：DFS 先序（子项目录/文件按名称不分大小写混排，Explorer
/// 同款；目录行紧跟其子树行），文件夹行 size 回填子树文件字节合计。不可读
/// 目录跳过；junction/符号链接一律跳过（analyze.rs 同款防环防重复计数）。
/// 返回根子树文件字节合计
pub fn collect_tree(root: &str, cap: usize) -> Result<Vec<ListingRow>, CollectError> {
    let mut rows = Vec::new();
    walk_dir(root, "", &mut rows, cap)?;
    Ok(rows)
}

fn walk_dir(
    dir: &str,
    rel_prefix: &str,
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
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            mtime_ms: systemtime_to_unix_ms(meta.modified().unwrap_or(UNIX_EPOCH)),
            ctime_ms: systemtime_to_unix_ms(meta.created().unwrap_or(UNIX_EPOCH)),
            attrs: attrs_of(&meta),
            name,
            rel,
        };
        let path = is_dir.then(|| entry.path().to_string_lossy().into_owned());
        items.push((row, path));
    }
    items.sort_by_key(|(r, _)| r.name.to_lowercase());
    let mut total: u64 = 0;
    for (row, path) in items {
        let idx = rows.len();
        rows.push(row);
        if let Some(path) = path {
            let rel = rows[idx].rel.clone();
            let sub = walk_dir(&path, &rel, rows, cap)?;
            rows[idx].size = sub;
            total += sub;
        } else {
            total += rows[idx].size;
        }
    }
    Ok(total)
}

// ── 三格式构建（列集 CSV/MD 一致；txt = 相对路径一行一个）──

const CSV_COLS: &str = "序号,名称,类型,大小(字节),修改时间,创建时间,属性,相对路径";
const MD_COLS: &str = "| 序号 | 名称 | 类型 | 大小 | 修改时间 | 创建时间 | 属性 | 相对路径 |";
const MD_RULE: &str = "| ---: | --- | --- | ---: | --- | --- | --- | --- |";

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

/// 类型列：文件夹 / 大写扩展名 / 无扩展名（含点首隐藏文件）→ "文件"。
/// 与前端旧口径的差异：TS split(".").pop() 会把无扩展名整名当类型（"报告"
/// → "报告"），此处修正为"文件"
fn type_name(r: &ListingRow) -> String {
    if r.is_dir {
        return "文件夹".to_string();
    }
    match r.name.rfind('.') {
        Some(i) if i > 0 && i + 1 < r.name.len() => r.name[i + 1..].to_uppercase(),
        _ => "文件".to_string(),
    }
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

/// 构建清单全文（行尾 CRLF；UTF-8 BOM 由命令层加——Excel 中文表头必需）
pub fn build_listing(rows: &[ListingRow], fmt: &str) -> String {
    match fmt {
        "md" => build_md(rows),
        "txt" => build_txt(rows),
        _ => build_csv(rows),
    }
}

fn build_txt(rows: &[ListingRow]) -> String {
    rows.iter()
        .map(|r| r.rel.as_str())
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
                esc(&type_name(r)),
                size_csv(r),
                fmt_ts(r.mtime_ms),
                fmt_ts(r.ctime_ms),
                esc(&attrs_text(r)),
                esc(&r.rel),
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
            "| {} | {} | {} | {} | {} | {} | {} | {} |",
            i + 1,
            md_esc(&r.name),
            md_esc(&type_name(r)),
            size_md(r),
            fmt_ts(r.mtime_ms),
            fmt_ts(r.ctime_ms),
            md_esc(&attrs_text(r)),
            md_esc(&r.rel),
        ));
    }
    out.join("\r\n")
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

    fn row(name: &str, rel: &str, is_dir: bool, size: u64, ro: bool, hid: bool) -> ListingRow {
        ListingRow {
            name: name.to_string(),
            rel: rel.to_string(),
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

    // ── CSV 构建 ──
    #[test]
    fn csv_columns_and_dir_size_blank() {
        let rows = [
            row("报告.docx", "报告.docx", false, 12345, false, false),
            row("子夹", "子夹", true, 0, false, false),
        ];
        let csv = build_csv(&rows);
        let lines: Vec<&str> = csv.split("\r\n").collect();
        assert_eq!(
            lines[0],
            "序号,名称,类型,大小(字节),修改时间,创建时间,属性,相对路径"
        );
        let c1 = lines[1];
        assert!(c1.starts_with("1,报告.docx,DOCX,12345,"), "{c1}");
        assert!(c1.ends_with(",报告.docx")); // 相对路径收尾
        assert!(c1.contains("2023-"), "{} 含非零修改时间", c1);
        assert!(c1.contains("—")); // 创建时间 0 → "—"
        let c2 = lines[2];
        assert!(c2.starts_with("2,子夹,文件夹,,"), "{c2}"); // 文件夹大小留空
    }

    #[test]
    fn csv_zero_byte_file_keeps_zero() {
        let rows = [row("空.bin", "空.bin", false, 0, false, false)];
        let line = build_csv(&rows).split("\r\n").nth(1).unwrap().to_string();
        assert!(line.starts_with("1,空.bin,BIN,0,"), "{line}");
    }

    #[test]
    fn csv_rfc4180_escaping_and_attrs() {
        let rows = [
            row("a\",b.csv", "x\\a\",b.csv", false, 1, true, true),
            row(".gitignore", ".gitignore", false, 2, false, false),
            row("noext", "noext", false, 3, false, false),
        ];
        let lines: Vec<String> = build_csv(&rows).split("\r\n").map(String::from).collect();
        assert!(lines[1].contains("\"a\"\",b.csv\""), "{:?}", lines[1]);
        assert!(lines[1].contains("只读/隐藏"));
        assert!(lines[2].contains(",文件,")); // 点首隐藏文件 → "文件"
        assert!(lines[3].contains(",文件,")); // 无扩展名 → "文件"
    }

    #[test]
    fn csv_serial_number_continuity() {
        let rows = [
            row("a", "a", false, 1, false, false),
            row("b", "b", false, 2, false, false),
            row("c", "c", false, 3, false, false),
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
            row("a|b.txt", "a|b.txt", false, 1536, false, false),
            row("子夹", "子夹", true, 0, false, false),
            row("满夹", "满夹", true, 2_500_000, false, false),
        ];
        let lines: Vec<String> = build_md(&rows).split("\r\n").map(String::from).collect();
        assert_eq!(
            lines[0],
            "| 序号 | 名称 | 类型 | 大小 | 修改时间 | 创建时间 | 属性 | 相对路径 |"
        );
        assert_eq!(
            lines[1],
            "| ---: | --- | --- | ---: | --- | --- | --- | --- |"
        );
        assert!(lines[2].contains("a｜b.txt"));
        assert!(lines[2].contains("1.5 KB"));
        assert!(lines[3].contains("| — |")); // 空文件夹 → "—"
        assert!(lines[4].contains("2.4 MB")); // 2500000/1024/1024 = 2.384 → 2.4
    }

    // ── 纯文本 ──
    #[test]
    fn txt_relative_paths_crlf() {
        let rows = [
            row("a.txt", "a.txt", false, 1, false, false),
            row("b.txt", "子\\b.txt", false, 2, false, false),
        ];
        assert_eq!(build_txt(&rows), "a.txt\r\n子\\b.txt");
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

    // ── 整树递归收集 ──
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

        let rows = collect_tree(&dir, MAX_ROWS).unwrap();
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
        cleanup(&dir);
    }

    #[test]
    fn tree_cap_exceeded_errors() {
        let dir = tempdir("cap");
        for i in 0..5 {
            std::fs::write(join_test(&dir, &format!("f{i}.txt")), b"x").unwrap();
        }
        assert!(matches!(
            collect_tree(&dir, 2),
            Err(CollectError::TooMany(2))
        ));
        cleanup(&dir);
    }

    #[test]
    fn tree_empty_dir_ok() {
        let dir = tempdir("empty");
        let rows = collect_tree(&dir, MAX_ROWS).unwrap();
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
        let rows = collect_selected(&paths, &dir).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "乙.txt"); // 保持选中顺序不重排
        assert_eq!(rows[0].rel, "乙.txt");
        assert_eq!(rows[0].size, 2);
        assert_eq!(rows[1].name, "甲.txt");
        cleanup(&dir);
    }

    #[test]
    fn selected_all_missing_errors() {
        let dir = tempdir("selmiss");
        let paths = vec![join_test(&dir, "没有.txt")];
        assert!(matches!(
            collect_selected(&paths, &dir),
            Err(CollectError::Unreadable)
        ));
        assert!(matches!(
            collect_selected(&[], &dir),
            Err(CollectError::Unreadable)
        ));
        cleanup(&dir);
    }

    fn join_test(dir: &str, name: &str) -> String {
        format!("{dir}\\{name}")
    }
}
