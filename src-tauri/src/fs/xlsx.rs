//! Excel 工作簿合并（2026-10-17）：calamine 读取（xlsx/xlsm/xls/xlsb/ods 通吃）
//! → rust_xlsxwriter 写出 .xlsx（MIT，表格写出唯一宽松协议方案）。两种模式：
//! sheets = 每源工作表一张目标表；rows = 纵向拼接一张表（重复表头自动去除，
//! 与 CSV 合并同语义）。核心读写抽成 run_merge_core（不依赖 AppHandle，可测），
//! merge_xlsx 包装进度上报供任务引擎调用；输出一律旁写不覆盖。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

use calamine::{Data, Reader, open_workbook_auto};

use crate::fs::path::to_extended;
use crate::jobs::FailItem;

/// Excel 单表行数上限（xlsx 规范 1,048,576）
pub const ROW_CAP: u32 = 1_048_576;
/// 总写入单元格护栏（防病态合并拖爆内存）
pub const CELL_CAP: usize = 5_000_000;

/// 合并模式（前端 np-seg 两档）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum XlsxMergeMode {
    /// 每源工作表一张目标表（表名 = 文件名，多表文件加「·表名」后缀）
    Sheets,
    /// 全部纵向拼接一张表，逐格保留数值类型
    Rows,
}

impl XlsxMergeMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "sheets" => Some(Self::Sheets),
            "rows" => Some(Self::Rows),
            _ => None,
        }
    }
}

fn stem_of(path: &str) -> String {
    let name = crate::fs::path::file_name_of(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name,
    }
}

/// 目标工作表名清洗（纯函数）：Excel 禁 []:*?/\（统一换成 ·）、截断 31 字符、
/// 空名兜底「表」。与 Excel 自身规则同口径。
pub fn sanitize_sheet_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '·',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return "表".into();
    }
    trimmed.chars().take(31).collect()
}

/// 在已用集合里分配不重复目标表名（纯函数）：name → name (2) → …；
/// 加后缀前先按剩余预算截断 stem，保证总长不超 31
pub fn allocate_sheet_name(raw: &str, used: &mut HashSet<String>) -> String {
    let base = sanitize_sheet_name(raw);
    if used.insert(base.clone()) {
        return base;
    }
    for n in 2..1000u32 {
        let suffix = format!(" ({n})");
        let keep = 31usize.saturating_sub(suffix.chars().count());
        let stem: String = base.chars().take(keep).collect();
        let cand = format!("{stem}{suffix}");
        if used.insert(cand.clone()) {
            return cand;
        }
    }
    unreachable!("999 张同名工作表已超出 Excel 实际可达范围")
}

/// 单元格显示文本（表头比对与错误格文案）
fn cell_text(v: &Data) -> String {
    match v {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => format!("{f}"),
        Data::Int(i) => format!("{i}"),
        Data::Bool(b) => format!("{b}"),
        Data::DateTime(dt) => format_datetime(dt),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#{e:?}"),
    }
}

/// calamine 日期 → 字符串（to_ymd_hms_milli 不依赖 chrono；时长按 h:mm:ss 展开）。
/// pub(crate)：快速预览 cell_display 复用（2026-10-18 修日期列显示成序列数）
pub(crate) fn format_datetime(dt: &calamine::ExcelDateTime) -> String {
    if dt.is_duration() {
        let total = dt.as_f64() * 86_400.0;
        let h = (total / 3600.0).floor() as i64;
        let m = ((total / 60.0).floor() as i64) % 60;
        let s = (total.floor() as i64) % 60;
        return format!("{h}:{m:02}:{s:02}");
    }
    let (y, mo, d, h, mi, s, milli) = dt.to_ymd_hms_milli();
    if milli > 0 {
        format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{milli:03}")
    } else {
        format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
    }
}

fn write_cell(ws: &mut rust_xlsxwriter::Worksheet, row: u32, col: u16, v: &Data) {
    let _ = match v {
        Data::Empty => return,
        Data::String(s) => ws.write(row, col, s.as_str()),
        Data::Float(f) => ws.write(row, col, *f),
        Data::Int(i) => ws.write(row, col, *i),
        Data::Bool(b) => ws.write(row, col, *b),
        Data::DateTime(dt) => ws.write(row, col, format_datetime(dt)),
        Data::DateTimeIso(s) | Data::DurationIso(s) => ws.write(row, col, s.as_str()),
        Data::Error(e) => ws.write(row, col, format!("#{e:?}")),
    };
}

/// 合并核心（无进度/取消上报之外的引擎依赖）：读全部源 → 写 output。
/// 每处理完一个源文件回调 on_file(已完成数)；返回失败清单，输出写失败也在其中。
pub(crate) fn run_merge_core(
    paths: &[String],
    output: &str,
    mode: XlsxMergeMode,
    cancel: &AtomicBool,
    mut on_file: impl FnMut(usize),
) -> Vec<FailItem> {
    let mut failed: Vec<FailItem> = Vec::new();
    let mut done = 0usize;
    let mut wb = rust_xlsxwriter::Workbook::new();
    let mut used_names: HashSet<String> = HashSet::new();
    // rows 模式的单张目标表：懒建 + 按名复取（每次借用即取即还，规避自借冲突）
    const MERGED_SHEET: &str = "合并";
    let mut header: Option<Vec<String>> = None;
    let mut row_cursor: u32 = 0;
    let mut cells: usize = 0;

    for p in paths {
        if cancel.load(Ordering::Relaxed) {
            return failed;
        }
        let r = (|| -> Result<(), String> {
            let mut book = open_workbook_auto(to_extended(p)).map_err(|e| e.to_string())?;
            let names = book.sheet_names();
            if names.is_empty() {
                return Err("工作簿没有工作表".into());
            }
            let stem = stem_of(p);
            for sname in &names {
                if cells >= CELL_CAP {
                    return Err("超出合并单元格总量上限".into());
                }
                let range = book.worksheet_range(sname).map_err(|e| e.to_string())?;
                match mode {
                    XlsxMergeMode::Sheets => {
                        let label = if names.len() > 1 {
                            format!("{stem}·{sname}")
                        } else {
                            stem.clone()
                        };
                        let target = allocate_sheet_name(&label, &mut used_names);
                        let ws = wb.add_worksheet();
                        let _ = ws.set_name(&target);
                        let mut r: u32 = 0;
                        for row in range.rows() {
                            for (c, v) in row.iter().enumerate() {
                                write_cell(ws, r, c as u16, v);
                            }
                            cells += row.len();
                            r += 1;
                            if r >= ROW_CAP {
                                break;
                            }
                        }
                    }
                    XlsxMergeMode::Rows => {
                        let rows: Vec<&[Data]> = range.rows().collect();
                        // 重复表头去除：首个非空首行作表头快照，后续逐格相同才跳过
                        let mut skip_first = false;
                        if let Some(f) = rows.first() {
                            let texts: Vec<String> = f.iter().map(cell_text).collect();
                            match &header {
                                None => {
                                    if texts.iter().any(|t| !t.is_empty()) {
                                        header = Some(texts);
                                    }
                                }
                                Some(h) => {
                                    skip_first = h.len() == texts.len() && *h == texts;
                                }
                            }
                        }
                        if wb.worksheet_from_name(MERGED_SHEET).is_err() {
                            let ws = wb.add_worksheet();
                            let _ = ws.set_name(MERGED_SHEET);
                        }
                        let ws = wb
                            .worksheet_from_name(MERGED_SHEET)
                            .map_err(|e| e.to_string())?;
                        let mut r = row_cursor;
                        for (ri, row) in rows.iter().enumerate() {
                            if ri == 0 && skip_first {
                                continue;
                            }
                            for (c, v) in row.iter().enumerate() {
                                write_cell(ws, r, c as u16, v);
                            }
                            cells += row.len();
                            r += 1;
                            if r >= ROW_CAP {
                                break;
                            }
                        }
                        row_cursor = r;
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = r {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
            });
        }
        done += 1;
        on_file(done);
    }
    if cancel.load(Ordering::Relaxed) {
        return failed;
    }
    if let Err(e) = wb.save(to_extended(output)) {
        failed.push(FailItem {
            path: output.to_string(),
            message: e.to_string(),
        });
    }
    failed
}

/// 任务引擎入口：进度语义 = 已处理的源文件数
pub(crate) fn merge_xlsx(
    paths: &[String],
    output: &str,
    mode: XlsxMergeMode,
    cancel: &AtomicBool,
    prog: &mut crate::jobs::JobProgress,
    em: &mut crate::jobs::EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    *failed = run_merge_core(paths, output, mode, cancel, |done| {
        prog.done_files = done as u64;
        em.progress(prog);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    fn tempdir() -> String {
        let d = std::env::temp_dir().join(format!(
            "xdir-xlsx-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn sanitize_and_allocate_sheet_names() {
        // 禁字符统一换 ·，空名兜底
        assert_eq!(sanitize_sheet_name("a[b]:c"), "a·b··c");
        assert_eq!(sanitize_sheet_name("   "), "表");
        // 31 字符截断
        let long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十12345";
        assert_eq!(sanitize_sheet_name(long).chars().count(), 31);
        // 去重分配：同名加 (2)，且加后缀后总长仍 ≤31
        let mut used = HashSet::new();
        assert_eq!(allocate_sheet_name("表", &mut used), "表");
        assert_eq!(allocate_sheet_name("表", &mut used), "表 (2)");
        assert_eq!(allocate_sheet_name("表", &mut used), "表 (3)");
        let mut used2 = HashSet::new();
        let n1 = allocate_sheet_name(long, &mut used2);
        let n2 = allocate_sheet_name(long, &mut used2);
        assert!(n1.chars().count() <= 31 && n2.chars().count() <= 31);
        assert!(n2.ends_with(" (2)"));
    }

    fn write_book(path: &str, sheets: &[(&str, Vec<Vec<calamine::Data>>)]) {
        let mut wb = rust_xlsxwriter::Workbook::new();
        for (name, rows) in sheets {
            let ws = wb.add_worksheet();
            ws.set_name(*name).unwrap();
            for (r, row) in rows.iter().enumerate() {
                for (c, v) in row.iter().enumerate() {
                    match v {
                        Data::Int(i) => {
                            ws.write(r as u32, c as u16, *i).unwrap();
                        }
                        Data::String(s) => {
                            ws.write(r as u32, c as u16, s.as_str()).unwrap();
                        }
                        _ => unreachable!(),
                    }
                }
            }
        }
        wb.save(to_extended(path)).unwrap();
    }

    fn read_book(path: &str) -> Vec<(String, Vec<Vec<String>>)> {
        let mut book = open_workbook_auto(to_extended(path)).unwrap();
        let mut out = Vec::new();
        for name in book.sheet_names() {
            let range = book.worksheet_range(&name).unwrap();
            let rows = range
                .rows()
                .map(|r| r.iter().map(cell_text).collect::<Vec<_>>())
                .collect();
            out.push((name, rows));
        }
        out
    }

    #[test]
    fn merge_mode_rows_dedups_header_and_keeps_types() {
        let dir = tempdir();
        let a = crate::fs::path::join_name(&dir, "a.xlsx");
        let b = crate::fs::path::join_name(&dir, "b.xlsx");
        let out = crate::fs::path::join_name(&dir, "合并.xlsx");
        write_book(
            &a,
            &[(
                "Sheet1",
                vec![
                    vec![Data::String("名称".into()), Data::String("数量".into())],
                    vec![Data::String("甲".into()), Data::Int(1)],
                ],
            )],
        );
        write_book(
            &b,
            &[
                (
                    "Sheet1",
                    vec![
                        vec![Data::String("名称".into()), Data::String("数量".into())],
                        vec![Data::String("乙".into()), Data::Int(2)],
                    ],
                ),
                (
                    "附表",
                    vec![vec![Data::String("备注".into()), Data::Int(9)]],
                ),
            ],
        );
        let cancel = AtomicBool::new(false);
        let failed = run_merge_core(
            &[a.clone(), b.clone()],
            &out,
            XlsxMergeMode::Rows,
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let sheets = read_book(&out);
        assert_eq!(sheets.len(), 1);
        let rows = &sheets[0].1;
        // b 的重复表头被去掉，其余行（含 b 附表）全部保留
        let expect: Vec<Vec<String>> = vec![
            vec!["名称".into(), "数量".into()],
            vec!["甲".into(), "1".into()],
            vec!["乙".into(), "2".into()],
            vec!["备注".into(), "9".into()],
        ];
        assert_eq!(rows, &expect);
    }

    #[test]
    fn merge_mode_sheets_names_by_source_and_dedups() {
        let dir = tempdir();
        // 多表文件 = 文件名·表名；同名单表文件第二个起自动 (2)
        let d1 = crate::fs::path::join_name(&dir, "d1");
        let d2 = crate::fs::path::join_name(&dir, "d2");
        let d3 = crate::fs::path::join_name(&dir, "d3");
        std::fs::create_dir_all(&d1).unwrap();
        std::fs::create_dir_all(&d2).unwrap();
        std::fs::create_dir_all(&d3).unwrap();
        let a = crate::fs::path::join_name(&d1, "s.xlsx");
        let b = crate::fs::path::join_name(&d2, "s.xlsx");
        let c = crate::fs::path::join_name(&d3, "s.xlsx");
        write_book(
            &a,
            &[
                ("一月", vec![vec![Data::Int(1)]]),
                ("二月", vec![vec![Data::Int(2)]]),
            ],
        );
        write_book(&b, &[("一月", vec![vec![Data::Int(99)]])]);
        write_book(&c, &[("尾表", vec![vec![Data::Int(7)]])]);
        let out = crate::fs::path::join_name(&dir, "按表.xlsx");
        let cancel = AtomicBool::new(false);
        let failed = run_merge_core(
            &[a.clone(), b.clone(), c.clone()],
            &out,
            XlsxMergeMode::Sheets,
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let names: Vec<String> = read_book(&out).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec!["s·一月", "s·二月", "s", "s (2)"]);
    }
}
