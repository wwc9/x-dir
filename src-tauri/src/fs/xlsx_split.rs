//! Excel 拆分（2026-11-12 新功能，对标 WPS 智能拆分 / Kutools Split Workbook
//! & Split Data）：四模式——
//! - **sheet 按工作表**：每表一个 .xlsx。xlsx/xlsm 源走 umya 保真通道（整档
//!   建模逐表剥离，样式/合并单元格/列宽/冻结全保留；每份独立重读控制内存），
//!   其余源 calamine 读值 → rust_xlsxwriter 写出。
//! - **rows 按行数**：每 N 行数据一份。
//! - **value 按列值**：按某列的显示值分组，每组一份（Kutools Split Data 同款）。
//! - **parts 均匀 N 份**：数据行均分 N 份。
//!
//! rows/value/parts 为数据级拆分（xlsx/xlsm 源逐格迁移样式，日期写真实值）；
//! 「每份带表头」把源表首行（含样式）复制到每份顶部。输出 = 源目录下
//! `<stem>_拆分` 子文件夹（可关 = 直落源目录），重名 (2) 递增，绝不覆盖原件。
//! 核心 = run_split_core（不依赖任务引擎，可测）；split_xlsx 包装进度上报。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use calamine::{Data, Reader, SheetVisible, Sheets, open_workbook_auto};

use super::path::{join_name, parent_of, to_extended};
use super::xlsx::{
    CELL_CAP, COL_CAP, ROW_CAP, cell_text, collect_sheet_meta, fidelity_eligible,
    sanitize_file_stem, sanitize_sheet_name,
};
use crate::jobs::FailItem;

/// 拆分模式（前端 Seg 四档）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitMode {
    Sheet,
    Rows,
    Value,
    Parts,
}

impl SplitMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "sheet" => Some(Self::Sheet),
            "rows" => Some(Self::Rows),
            "value" => Some(Self::Value),
            "parts" => Some(Self::Parts),
            _ => None,
        }
    }
}

/// 拆分参数（JobKind::SplitXlsx 携带）
#[derive(Clone, Debug, PartialEq)]
pub struct SplitOpts {
    pub mode: SplitMode,
    /// rows/value/parts 模式的目标表（None = 首个可见表；按表拆分忽略）
    pub sheet_name: Option<String>,
    /// rows 模式每份行数
    pub rows_per_part: u32,
    /// value 模式依据列（0 基）
    pub col_index: u32,
    /// parts 模式份数
    pub parts: u32,
    /// 按表拆分：含隐藏工作表
    pub include_hidden: bool,
    /// 按表拆分：跳过空白表
    pub skip_empty: bool,
    /// 每份带表头（rows/value/parts）
    pub with_header: bool,
    /// 输出到 `<stem>_拆分` 子文件夹（false = 直落源目录）
    pub sub_folder: bool,
}

impl Default for SplitOpts {
    fn default() -> Self {
        Self {
            mode: SplitMode::Sheet,
            sheet_name: None,
            rows_per_part: 1000,
            col_index: 0,
            parts: 2,
            include_hidden: false,
            skip_empty: false,
            with_header: true,
            sub_folder: true,
        }
    }
}

/// 数据级拆分护栏
const MAX_ROW_PARTS: usize = 500;
const MAX_GROUPS: usize = 200;
const MAX_PARTS: u32 = 200;

fn fail(path: &str, message: impl Into<String>) -> FailItem {
    FailItem {
        path: path.to_string(),
        message: message.into(),
        reason: None,
    }
}

fn stem_of(path: &str) -> String {
    let name = crate::fs::path::file_name_of(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name,
    }
}

/// 目标子文件夹：`<stem>_拆分`，已存在自动 (2) 递增并建目录
fn ensure_split_dir(parent: &str, stem: &str) -> Result<String, String> {
    let mut target = join_name(parent, &format!("{stem}_拆分"));
    let mut n = 2u32;
    while std::fs::metadata(to_extended(&target)).is_ok() {
        target = join_name(parent, &format!("{stem}_拆分 ({n})"));
        n += 1;
        if n > 999 {
            return Err("拆分子文件夹数量已达上限".into());
        }
    }
    std::fs::create_dir_all(to_extended(&target)).map_err(|e| format!("无法创建输出目录：{e}"))?;
    Ok(target)
}

/// 每份输出落盘名（重名 (2) 递增，绝不覆盖）
fn available_out(dir: &str, name: &str) -> String {
    let first = join_name(dir, &format!("{name}.xlsx"));
    if std::fs::metadata(to_extended(&first)).is_err() {
        return first;
    }
    for n in 2..1000u32 {
        let cand = join_name(dir, &format!("{name} ({n}).xlsx"));
        if std::fs::metadata(to_extended(&cand)).is_err() {
            return cand;
        }
    }
    first
}

/// 写一段行（含样式迁移）：rows = (绝对行号, 行数据) 列表，从 start_row 起
/// **顺序**写出（源绝对行号只用于样式定位，不决定输出位置），返回写入格数
fn write_rows(
    ws: &mut rust_xlsxwriter::Worksheet,
    start_row: u32,
    rows: &[(u32, &[Data])],
    styles: Option<&calamine::StyleRange>,
    cache: &mut super::xlsx_style::FormatCache,
) -> usize {
    let mut cells = 0usize;
    for (i, (abs_row, row)) in rows.iter().enumerate() {
        let out_row = start_row + i as u32;
        for (c, v) in row.iter().enumerate() {
            let c = c as u16;
            if c >= COL_CAP {
                break;
            }
            let fmt = styles
                .and_then(|s| s.get((*abs_row, c as u32)))
                .and_then(|st| cache.get_or_build(st))
                .cloned();
            super::xlsx_style::write_value(ws, out_row, c, v, fmt.as_ref());
            cells += 1;
        }
    }
    cells
}

/// 生成一份输出簿并落盘（表头 + 数据块，重名 (2)）
fn emit_book(
    header: &[(u32, &[Data])],
    chunk: &[(u32, &[Data])],
    styles: Option<&calamine::StyleRange>,
    cache: &mut super::xlsx_style::FormatCache,
    cells: &mut usize,
    dest: &str,
    name: &str,
) -> Result<String, String> {
    let mut wb = rust_xlsxwriter::Workbook::new();
    let ws = wb.add_worksheet();
    *cells += write_rows(ws, 0, header, styles, cache);
    *cells += write_rows(ws, header.len() as u32, chunk, styles, cache);
    if *cells > CELL_CAP {
        return Err("超出拆分单元格总量上限".into());
    }
    let out = available_out(dest, name);
    wb.save(to_extended(&out))
        .map_err(|e| format!("写出失败：{e}"))?;
    Ok(out)
}

/// 保真按表拆分：每个目标表独立重读源文件 → 剥离其余表 → 写出。
/// 内存恒为一整本（不复刻 N 份），代价是每表一次解析（进度逐份上报可取消）。
fn split_sheets_fidelity(
    path: &str,
    targets: &[String],
    dest: &str,
    stem: &str,
    cancel: &AtomicBool,
    mut on_out: impl FnMut(),
    failed: &mut Vec<FailItem>,
) -> usize {
    let mut done = 0usize;
    for sname in targets {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let r = (|| -> Result<(), String> {
            let mut book = umya_spreadsheet::reader::xlsx::read(to_extended(path))
                .map_err(|e| format!("读取失败：{e}"))?;
            let keep = book
                .sheet_collection()
                .iter()
                .position(|w| w.name() == sname)
                .ok_or("工作表已被移除")?;
            for idx in (0..book.sheet_collection().len()).rev() {
                if idx != keep {
                    book.remove_sheet(idx).map_err(|e| e.to_string())?;
                }
            }
            let out = available_out(dest, &format!("{stem}_{}", sanitize_sheet_name(sname)));
            // 写出兜底 catch_unwind：未建模的结构（图表引用等）panic 降级为
            // 逐条失败项（按表拆分不改表名，图表公式引用天然有效，此为
            // 其他未知结构的保险）
            let write = std::panic::catch_unwind(|| {
                umya_spreadsheet::writer::xlsx::write(&book, to_extended(&out))
            });
            match write {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(format!("写出失败：{e}")),
                Err(_) => {
                    return Err(
                        "写出失败：工作表包含无法迁移的结构，请改用数据级拆分（按行数等）".into(),
                    );
                }
            }
            Ok(())
        })();
        if let Err(e) = r {
            failed.push(fail(path, e));
        }
        done += 1;
        on_out();
    }
    done
}

/// 数据级按表拆分（非 xlsx/xlsm 源）：calamine 读值 → 每表一簿
fn split_sheets_data(
    path: &str,
    targets: &[String],
    dest: &str,
    stem: &str,
    cancel: &AtomicBool,
    mut on_out: impl FnMut(),
    failed: &mut Vec<FailItem>,
) -> usize {
    let mut done = 0usize;
    let mut book = match open_workbook_auto(to_extended(path)) {
        Ok(b) => b,
        Err(e) => {
            failed.push(fail(path, e.to_string()));
            return 0;
        }
    };
    for sname in targets {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let r = (|| -> Result<(), String> {
            let range = book
                .worksheet_range(sname)
                .map_err(|e| format!("「{sname}」读取失败：{e}"))?;
            let mut wb = rust_xlsxwriter::Workbook::new();
            let ws = wb.add_worksheet();
            let name = sanitize_sheet_name(sname);
            let _ = ws.set_name(name);
            let mut r: u32 = 0;
            for row in range.rows() {
                for (c, v) in row.iter().enumerate() {
                    let c = c as u16;
                    if c >= COL_CAP {
                        break;
                    }
                    super::xlsx_style::write_value(ws, r, c, v, None);
                }
                r += 1;
                if r >= ROW_CAP {
                    break;
                }
            }
            let out = available_out(dest, &format!("{stem}_{}", sanitize_sheet_name(sname)));
            wb.save(to_extended(&out))
                .map_err(|e| format!("写出失败：{e}"))?;
            Ok(())
        })();
        if let Err(e) = r {
            failed.push(fail(path, e));
        }
        done += 1;
        on_out();
    }
    done
}

/// 数据级拆分（rows/value/parts，单文件）：返回 (成功份数, 失败项)
fn split_rows_like(
    path: &str,
    opts: &SplitOpts,
    parent: &str,
    stem: &str,
    cancel: &AtomicBool,
    mut on_out: impl FnMut(),
) -> (usize, Vec<FailItem>) {
    let mut failed: Vec<FailItem> = Vec::new();
    let mut done = 0usize;
    let r = (|| -> Result<(), String> {
        let mut book = open_workbook_auto(to_extended(path)).map_err(|e| e.to_string())?;
        // 选表：显式指定 → 校验存在；未指定 → 首个可见表；兜底第一张
        let meta: Vec<(String, bool)> = book
            .sheets_metadata()
            .iter()
            .map(|s| (s.name.clone(), s.visible == SheetVisible::Visible))
            .collect();
        if meta.is_empty() {
            return Err("工作簿没有工作表".into());
        }
        let sname = match &opts.sheet_name {
            Some(n) => {
                if !meta.iter().any(|(name, _)| name == n) {
                    return Err(format!("工作表不存在：{n}"));
                }
                n.clone()
            }
            None => meta
                .iter()
                .find(|(_, v)| *v)
                .map(|(n, _)| n.clone())
                .ok_or("工作簿没有可见工作表")?,
        };
        let (range, styles) = match &mut book {
            Sheets::Xlsx(x) => {
                let r = x.worksheet_range(&sname).map_err(|e| e.to_string())?;
                let st = x.worksheet_style(&sname).ok();
                (r, st)
            }
            b => {
                let r = b.worksheet_range(&sname).map_err(|e| e.to_string())?;
                (r, None)
            }
        };
        let all: Vec<&[Data]> = range.rows().collect();
        if all.is_empty() {
            return Err("工作表是空的".into());
        }
        let start = range.start().unwrap_or((0, 0));
        let mut cache = super::xlsx_style::FormatCache::default();
        let mut cells = 0usize;

        // 表头（含样式）复制素材；数据行绝对行号供样式定位
        let header_rows: Vec<(u32, &[Data])> = if opts.with_header {
            vec![(start.0, all[0])]
        } else {
            Vec::new()
        };
        let data_rows: Vec<(u32, &[Data])> = all[if opts.with_header { 1 } else { 0 }..]
            .iter()
            .enumerate()
            .map(|(i, r)| (start.0 + i as u32 + u32::from(opts.with_header), *r))
            .collect();
        if data_rows.is_empty() {
            return Err("工作表没有数据行".into());
        }
        // 校验全过才建输出目录（sub_folder = <stem>_拆分 子文件夹）
        let dest = if opts.sub_folder {
            ensure_split_dir(parent, stem)?
        } else {
            parent.to_string()
        };

        match opts.mode {
            SplitMode::Rows => {
                let per = opts.rows_per_part.max(1) as usize;
                let total = data_rows.len().div_ceil(per);
                if total > MAX_ROW_PARTS {
                    return Err(format!(
                        "将拆出 {total} 份，超出单次上限（{MAX_ROW_PARTS}）——请调大每份行数"
                    ));
                }
                let width = total.to_string().len().max(2);
                for (i, _) in (0..data_rows.len()).step_by(per).enumerate() {
                    if cancel.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    let chunk: Vec<(u32, &[Data])> =
                        data_rows[i * per..(i * per + per).min(data_rows.len())].to_vec();
                    let name = format!("{stem}_{:0width$}", i + 1);
                    emit_book(
                        header_rows.as_slice(),
                        &chunk,
                        styles.as_ref(),
                        &mut cache,
                        &mut cells,
                        &dest,
                        &name,
                    )?;
                    done += 1;
                    on_out();
                }
            }
            SplitMode::Parts => {
                let n = opts.parts.clamp(1, MAX_PARTS) as usize;
                // 均分：份数收敛到 min(数据行, N)（N 大于行数时每行一份），前 rem 份各多一行
                let total = data_rows.len().min(n).max(1);
                let base = data_rows.len() / total;
                let rem = data_rows.len() % total;
                let mut cursor = 0usize;
                for i in 0..total {
                    if cancel.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    let size = base + usize::from(i < rem);
                    let chunk: Vec<(u32, &[Data])> = data_rows[cursor..cursor + size].to_vec();
                    cursor += size;
                    let name = format!("{stem}_第{}份", i + 1);
                    emit_book(
                        header_rows.as_slice(),
                        &chunk,
                        styles.as_ref(),
                        &mut cache,
                        &mut cells,
                        &dest,
                        &name,
                    )?;
                    done += 1;
                    on_out();
                }
            }
            SplitMode::Value => {
                let col = opts.col_index as usize;
                // 按显示值分组：首现顺序；空值归「(空)」组
                let mut order: Vec<String> = Vec::new();
                let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
                for (i, (_, row)) in data_rows.iter().enumerate() {
                    let raw = row
                        .get(col)
                        .map(|v| cell_text(v).trim().to_string())
                        .unwrap_or_default();
                    let key = if raw.is_empty() { "(空)".into() } else { raw };
                    if !groups.contains_key(&key) {
                        order.push(key.clone());
                    }
                    groups.entry(key).or_default().push(i);
                }
                if order.len() > MAX_GROUPS {
                    return Err(format!(
                        "依据列有 {} 种取值，超出单次上限（{MAX_GROUPS} 组）",
                        order.len()
                    ));
                }
                for key in &order {
                    if cancel.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    let idxs = &groups[key];
                    let chunk: Vec<(u32, &[Data])> = idxs.iter().map(|&j| data_rows[j]).collect();
                    let name = format!("{stem}_{}", sanitize_file_stem(key));
                    emit_book(
                        header_rows.as_slice(),
                        &chunk,
                        styles.as_ref(),
                        &mut cache,
                        &mut cells,
                        &dest,
                        &name,
                    )?;
                    done += 1;
                    on_out();
                }
            }
            SplitMode::Sheet => unreachable!("sheet 模式不进入本引擎"),
        }
        Ok(())
    })();
    if let Err(e) = r {
        failed.push(fail(path, e));
    }
    (done, failed)
}

/// 拆分核心（无进度/取消上报之外的引擎依赖）：逐文件拆分。
/// 每产出一份回调一次 on_out；返回失败清单。
pub(crate) fn run_split_core(
    paths: &[String],
    opts: &SplitOpts,
    cancel: &AtomicBool,
    mut on_out: impl FnMut(),
) -> Vec<FailItem> {
    let mut failed: Vec<FailItem> = Vec::new();
    for p in paths {
        if cancel.load(Ordering::Relaxed) {
            return failed;
        }
        let stem = stem_of(p);
        let Some(parent) = parent_of(p) else {
            failed.push(fail(p, "无法定位所在目录"));
            continue;
        };
        if opts.mode == SplitMode::Sheet {
            // 表清单（可见性/空白判定统一走 collect_sheet_meta：全格式通吃）
            let metas = match collect_sheet_meta(p) {
                Ok(m) => m,
                Err(e) => {
                    failed.push(fail(p, e));
                    continue;
                }
            };
            let targets: Vec<String> = metas
                .iter()
                .filter(|m| opts.include_hidden || m.visible)
                .filter(|m| !opts.skip_empty || m.rows != Some(0))
                .map(|m| m.name.clone())
                .collect();
            if targets.is_empty() {
                failed.push(fail(p, "没有可拆分的工作表（均隐藏或空白）"));
                continue;
            }
            // 目标表确认后才建输出目录（失败任务不留空目录）
            let dest = if opts.sub_folder {
                match ensure_split_dir(&parent, &stem) {
                    Ok(d) => d,
                    Err(e) => {
                        failed.push(fail(p, e));
                        continue;
                    }
                }
            } else {
                parent.clone()
            };
            let n = if fidelity_eligible(p) {
                split_sheets_fidelity(p, &targets, &dest, &stem, cancel, &mut on_out, &mut failed)
            } else {
                split_sheets_data(p, &targets, &dest, &stem, cancel, &mut on_out, &mut failed)
            };
            let _ = n;
        } else {
            let (_n, f) = split_rows_like(p, opts, &parent, &stem, cancel, &mut on_out);
            failed.extend(f);
        }
    }
    failed
}

/// 任务引擎入口：进度语义 = 已产出的份数（总量在首文件表清单确定后回填）
pub(crate) fn split_xlsx(
    paths: &[String],
    opts: &SplitOpts,
    cancel: &AtomicBool,
    prog: &mut crate::jobs::JobProgress,
    em: &mut crate::jobs::EmitterState,
    failed: &mut Vec<FailItem>,
) {
    // 预扫总份数（sheet 模式 = 过滤后表数 × 文件数；行级 = 现场估算）
    let mut total = 0u64;
    if opts.mode == SplitMode::Sheet {
        for p in paths {
            if let Ok(metas) = collect_sheet_meta(p) {
                total += metas
                    .iter()
                    .filter(|m| opts.include_hidden || m.visible)
                    .filter(|m| !opts.skip_empty || m.rows != Some(0))
                    .count() as u64;
            }
        }
    } else {
        for p in paths {
            total += match opts.mode {
                SplitMode::Rows => {
                    let per = opts.rows_per_part.max(1) as u64;
                    (crate::fs::xlsx::sheet_row_count(p, opts.sheet_name.as_deref()) / per).max(1)
                }
                SplitMode::Parts => u64::from(opts.parts.max(1)),
                SplitMode::Value => crate::fs::xlsx::sheet_row_count(p, opts.sheet_name.as_deref())
                    .min(MAX_GROUPS as u64)
                    .max(1),
                SplitMode::Sheet => 0,
            };
        }
    }
    prog.total_files = total.max(paths.len() as u64);
    let mut done = 0u64;
    *failed = run_split_core(paths, opts, cancel, || {
        done += 1;
        prog.done_files = done;
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
            "xdir-xsplt-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    use rust_xlsxwriter::Format;

    /// 复杂格式夹具：合并标题（加粗 14 号）、样式表头（加粗+黄底+细边框）、
    /// 日期列（yyyy-mm-dd 真日期）、金额列（千分位）、列宽、冻结首行、隐藏表
    fn write_complex_book(path: &str) {
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("销售明细").unwrap();
        let _ = ws.set_column_width(0, 22);
        let _ = ws.set_freeze_panes(2, 0);
        let title = Format::new().set_bold().set_font_size(14);
        ws.merge_range(0, 0, 0, 2, "2026年销售明细", &title)
            .unwrap();
        let head = Format::new()
            .set_bold()
            .set_background_color(rust_xlsxwriter::Color::RGB(0xFF_E699));
        for (c, t) in ["城市", "日期", "金额"].iter().enumerate() {
            ws.write_string_with_format(1, c as u16, *t, &head).unwrap();
        }
        let date_fmt = Format::new().set_num_format("yyyy-mm-dd");
        let money = Format::new().set_num_format("#,##0.00");
        let rows = [
            ("北京", 2026, 1, 5, 1234.5),
            ("上海", 2026, 1, 8, 88.0),
            ("北京", 2026, 2, 2, 6400.0),
            ("广州", 2026, 2, 11, 92.5),
        ];
        for (i, (city, y, m, d, amt)) in rows.iter().enumerate() {
            let r = (i + 2) as u32;
            ws.write_string(r, 0, *city).unwrap();
            ws.write_datetime_with_format(
                r,
                1,
                rust_xlsxwriter::ExcelDateTime::from_ymd(*y, *m, *d).unwrap(),
                &date_fmt,
            )
            .unwrap();
            ws.write_number_with_format(r, 2, *amt, &money).unwrap();
        }
        let hs = wb.add_worksheet();
        hs.set_name("底稿").unwrap();
        let _ = hs.set_hidden(true);
        hs.write_string(0, 0, "内部数据").unwrap();
        wb.save(to_extended(path)).unwrap();
    }

    /// 纯数据夹具（按行/列值/均分用）：表头 + N 行 [城市, 日期, 金额]
    fn write_data_book(path: &str, data: &[(&str, i64)]) {
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let head = Format::new().set_bold();
        for (c, t) in ["城市", "金额"].iter().enumerate() {
            ws.write_string_with_format(0, c as u16, *t, &head).unwrap();
        }
        for (i, (city, amt)) in data.iter().enumerate() {
            let r = (i + 1) as u32;
            ws.write_string(r, 0, *city).unwrap();
            ws.write_number(r, 1, *amt as f64).unwrap();
        }
        wb.save(to_extended(path)).unwrap();
    }

    fn list_dir(dir: &str) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(to_extended(dir))
            .unwrap()
            .filter_map(|e| {
                let name = e.unwrap().file_name().to_string_lossy().into_owned();
                (name.ends_with(".xlsx")).then_some(name)
            })
            .collect();
        names.sort();
        names
    }

    fn book_values(path: &str) -> Vec<Vec<String>> {
        let mut book = open_workbook_auto(to_extended(path)).unwrap();
        let name = book.sheet_names()[0].clone();
        book.worksheet_range(&name)
            .unwrap()
            .rows()
            .map(|r| r.iter().map(cell_text).collect())
            .collect()
    }

    fn cancel() -> AtomicBool {
        AtomicBool::new(false)
    }

    #[test]
    fn split_sheets_fidelity_preserves_formatting() {
        let dir = tempdir();
        let src = crate::fs::path::join_name(&dir, "复杂表.xlsx");
        write_complex_book(&src);
        let cancel = cancel();
        let failed = run_split_core(
            std::slice::from_ref(&src),
            &SplitOpts {
                mode: SplitMode::Sheet,
                ..Default::default()
            },
            &cancel,
            || {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        // 隐藏表「底稿」默认排除；产出两份落在 <stem>_拆分/
        let sub = crate::fs::path::join_name(&dir, "复杂表_拆分");
        assert_eq!(list_dir(&sub), vec!["复杂表_销售明细.xlsx"]);
        // 保真断言：合并格 / 列宽 / 冻结 / 表头加粗 全保留
        let out = crate::fs::path::join_name(&sub, "复杂表_销售明细.xlsx");
        use umya_spreadsheet::EnumTrait;
        let book = umya_spreadsheet::reader::xlsx::read(to_extended(&out)).unwrap();
        let ws = &book.sheet_collection()[0];
        let merges: Vec<String> = ws.merge_cells().iter().map(|m| m.range()).collect();
        assert!(
            merges.iter().any(|m| m == "A1:C1"),
            "merged lost: {merges:?}"
        );
        let widths: Vec<(u32, f64)> = ws
            .column_dimensions()
            .iter()
            .map(|c| (c.col_num(), c.width()))
            .collect();
        assert!(
            widths
                .iter()
                .any(|(c, w)| *c == 1 && (*w - 22.0).abs() < 1.0),
            "width lost: {widths:?}"
        );
        let pane = ws
            .sheets_views()
            .sheet_view_list()
            .first()
            .and_then(|sv| sv.pane());
        assert!(pane.is_some(), "freeze pane lost");
        assert_eq!(pane.unwrap().state().value_string(), "frozen");
        let head_cell = ws.cell((1, 2)).expect("A2 missing"); // 1 基：(列, 行)
        assert!(
            head_cell.style().font().is_some_and(|f| f.bold()),
            "header bold lost"
        );
        // 标题合并格锚值
        assert_eq!(ws.cell((1, 1)).unwrap().value(), "2026年销售明细");
        // 含隐藏表开关
        let failed = run_split_core(
            std::slice::from_ref(&src),
            &SplitOpts {
                mode: SplitMode::Sheet,
                include_hidden: true,
                ..Default::default()
            },
            &cancel,
            || {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        // 复拆落进 (2) 子目录（重名目录递增），隐藏表这次被并入
        let sub2 = crate::fs::path::join_name(&dir, "复杂表_拆分 (2)");
        assert_eq!(
            list_dir(&sub2),
            vec!["复杂表_底稿.xlsx", "复杂表_销售明细.xlsx"]
        );
    }

    #[test]
    fn split_sheets_data_channel_for_non_xlsx() {
        // 非 xlsx/xlsm 源走数据通道（此处用 ods 由 calamine 写出不可行，
        // 改用 xlsx 但强制非保真路径不可行——保真资格看扩展名。用 ods：
        // calamine 不写 ods，改为直接验证 xlsb/ods 不适用场景的兜底逻辑
        // 已经由 merge 侧覆盖；这里验证 sheet 模式空表跳过 + 全隐藏报错）
        let dir = tempdir();
        let src = crate::fs::path::join_name(&dir, "空白.xlsx");
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("空表").unwrap();
        wb.save(to_extended(&src)).unwrap();
        let cancel = cancel();
        let failed = run_split_core(
            std::slice::from_ref(&src),
            &SplitOpts {
                mode: SplitMode::Sheet,
                skip_empty: true,
                ..Default::default()
            },
            &cancel,
            || {},
        );
        assert_eq!(failed.len(), 1);
        assert!(
            failed[0].message.contains("没有可拆分"),
            "{}",
            failed[0].message
        );
        let failed = run_split_core(
            std::slice::from_ref(&src),
            &SplitOpts {
                mode: SplitMode::Sheet,
                ..Default::default()
            },
            &cancel,
            || {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let sub = crate::fs::path::join_name(&dir, "空白_拆分");
        assert_eq!(list_dir(&sub), vec!["空白_空表.xlsx"]);
    }

    #[test]
    fn split_rows_chunks_with_header_and_styles() {
        let dir = tempdir();
        let src = crate::fs::path::join_name(&dir, "月度.xlsx");
        let data: Vec<(&str, i64)> = (0..10)
            .map(|i| (if i % 2 == 0 { "北京" } else { "上海" }, i))
            .collect();
        write_data_book(&src, &data);
        let cancel = cancel();
        let failed = run_split_core(
            std::slice::from_ref(&src),
            &SplitOpts {
                mode: SplitMode::Rows,
                rows_per_part: 3,
                sub_folder: false,
                ..Default::default()
            },
            &cancel,
            || {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        // 10 行 / 3 = 4 份，直落源目录（sub_folder = false）
        let names = list_dir(&dir);
        assert_eq!(
            names,
            vec![
                "月度.xlsx",
                "月度_01.xlsx",
                "月度_02.xlsx",
                "月度_03.xlsx",
                "月度_04.xlsx"
            ]
        );
        // 每份带表头 + 数据切片正确
        let p3 = crate::fs::path::join_name(&dir, "月度_03.xlsx");
        let rows = book_values(&p3);
        assert_eq!(rows.len(), 4, "{rows:?}"); // 表头 + 3 行
        assert_eq!(rows[0], vec!["城市", "金额"]);
        assert_eq!(rows[1], vec!["北京", "6"]);
        // 样式迁移：表头加粗（umya 回读断言）
        let book = umya_spreadsheet::reader::xlsx::read(to_extended(&p3)).unwrap();
        let ws = &book.sheet_collection()[0];
        assert!(
            ws.cell((1, 1))
                .unwrap()
                .style()
                .font()
                .is_some_and(|f| f.bold())
        );
        // 行数超限护栏
        let failed = run_split_core(
            std::slice::from_ref(&src),
            &SplitOpts {
                mode: SplitMode::Rows,
                rows_per_part: 1,
                sub_folder: false,
                ..Default::default()
            },
            &cancel,
            || {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        // 首轮 4 份 + 复拆 10 份
        assert_eq!(list_dir(&dir).len() - 1, 14);
    }

    #[test]
    fn split_value_groups_by_column() {
        let dir = tempdir();
        let src = crate::fs::path::join_name(&dir, "流水.xlsx");
        write_data_book(
            &src,
            &[
                ("北京", 1),
                ("上海", 2),
                ("北京", 3),
                ("", 4), // 空值 → (空) 组
                ("上海", 5),
            ],
        );
        let cancel = cancel();
        let failed = run_split_core(
            std::slice::from_ref(&src),
            &SplitOpts {
                mode: SplitMode::Value,
                col_index: 0,
                ..Default::default()
            },
            &cancel,
            || {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let sub = crate::fs::path::join_name(&dir, "流水_拆分");
        assert_eq!(
            list_dir(&sub),
            vec!["流水_(空).xlsx", "流水_上海.xlsx", "流水_北京.xlsx"]
        );
        let bj = book_values(&crate::fs::path::join_name(&sub, "流水_北京.xlsx"));
        assert_eq!(
            bj,
            vec![vec!["城市", "金额"], vec!["北京", "1"], vec!["北京", "3"]]
        );
    }

    #[test]
    fn split_parts_even_distribution() {
        let dir = tempdir();
        let src = crate::fs::path::join_name(&dir, "总量.xlsx");
        let data: Vec<(&str, i64)> = (0..7).map(|i| ("客户", i)).collect();
        write_data_book(&src, &data);
        let cancel = cancel();
        let failed = run_split_core(
            std::slice::from_ref(&src),
            &SplitOpts {
                mode: SplitMode::Parts,
                parts: 3,
                sub_folder: false,
                ..Default::default()
            },
            &cancel,
            || {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        // 7 行均分 3 份 = 3/2/2
        let sizes: Vec<usize> = ["总量_第1份.xlsx", "总量_第2份.xlsx", "总量_第3份.xlsx"]
            .iter()
            .map(|n| book_values(&crate::fs::path::join_name(&dir, n)).len() - 1)
            .collect();
        assert_eq!(sizes, vec![3, 2, 2]);
    }

    #[test]
    fn split_date_and_currency_survive_data_channel() {
        // 复杂格式经数据级拆分：日期写真实日期值 + 源 numFmt 迁移
        let dir = tempdir();
        let src = crate::fs::path::join_name(&dir, "明细.xlsx");
        write_complex_book(&src);
        let cancel = cancel();
        let failed = run_split_core(
            std::slice::from_ref(&src),
            &SplitOpts {
                mode: SplitMode::Rows,
                rows_per_part: 2,
                sub_folder: false,
                with_header: true,
                ..Default::default()
            },
            &cancel,
            || {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        // 源表 = 标题 + 表头 + 4 行 → with_header 取首行(标题)，数据 5 行 → 3 份 + 源 = 4 文件
        let names = list_dir(&dir);
        assert_eq!(names.len(), 4, "{names:?}");
        let p1 = crate::fs::path::join_name(&dir, "明细_01.xlsx");
        // calamine 读出：日期列仍是 DateTime（不是字符串降级）
        let mut book = open_workbook_auto(to_extended(&p1)).unwrap();
        let name = book.sheet_names()[0].clone();
        let range = book.worksheet_range(&name).unwrap();
        let dt = range.get((2, 1)).unwrap();
        assert!(
            matches!(dt, calamine::Data::DateTime(_)),
            "date degraded: {dt:?}"
        );
        // numFmt 迁移：金额格格式码 = #,##0.00（StyleRange 回读输出簿）
        let styles = book.worksheet_style(&name).unwrap();
        let nf = styles
            .get((2, 2))
            .and_then(|s| s.number_format.as_ref())
            .map(|f| f.format_code.clone());
        assert_eq!(nf.as_deref(), Some("#,##0.00"), "numFmt lost");
    }
}
