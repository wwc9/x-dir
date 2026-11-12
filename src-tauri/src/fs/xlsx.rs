//! Excel 工作簿合并与表信息（2026-10-17 建，2026-11-12 扩展参数集）。
//!
//! 双通道定案（调研 WPS/Kutools/Power Query 后与 umya 源码勘察一致）：
//! - **保真通道**：全部源为 .xlsx/.xlsm 且模式 = 分表保留时，umya-spreadsheet
//!   （MIT）整档建模跨簿克隆工作表——样式/合并单元格/列宽/冻结窗格/图片图表
//!   原样迁移（已知坑：跨簿数组公式、数据透视表丢失；旁写不覆盖原件兜底）。
//! - **数据通道**：calamine 读值（xlsx/xlsm/xls/xlsb/ods 通吃）→
//!   rust_xlsxwriter 写 .xlsx；xlsx/xlsm 源逐格迁移样式（xlsx_style）并回贴
//!   合并单元格，日期写真实日期值；其余源纯值（旧行为）。
//!
//! 参数集（对标市场工具）：sheet_scope 工作表范围（仅可见/含隐藏）、
//! name_rule 目标表名规则（文件名·表名/仅表名/仅文件名）、dedup_header
//! 纵向拼接去重复表头、source_col 来源列（文件名/文件名·表名）。
//! 核心读写抽成 run_merge_core（不依赖 AppHandle，可测）；merge_xlsx 包装
//! 进度上报供任务引擎调用；输出一律旁写不覆盖。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

use calamine::{Data, Reader, SheetVisible, Sheets, open_workbook_auto};
use umya_spreadsheet::EnumTrait;

use crate::fs::path::to_extended;
use crate::jobs::FailItem;

/// Excel 单表行数上限（xlsx 规范 1,048,576）
pub const ROW_CAP: u32 = 1_048_576;
/// 总写入单元格护栏（防病态合并拖爆内存）
pub const CELL_CAP: usize = 5_000_000;
/// 单表列数上限（xlsx 规范 16,384）
pub const COL_CAP: u16 = 16_384;

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

/// 工作表范围：仅可见表（默认）/ 含隐藏与深度隐藏表
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SheetScope {
    Visible,
    All,
}

impl SheetScope {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("all") => Self::All,
            _ => Self::Visible,
        }
    }
}

/// 分表保留模式的目标表名规则（对标 WPS「合并同名工作表」等）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SheetNameRule {
    /// 智能（默认）：单表文件 = 文件名；多表文件 = 文件名·表名
    Smart,
    /// 仅工作表名（跨文件同名自动 (2)）
    Sheet,
    /// 仅文件名（多表文件同文件名自动 (2)）
    File,
}

impl SheetNameRule {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("sheet") => Self::Sheet,
            Some("file") => Self::File,
            _ => Self::Smart,
        }
    }
}

/// 纵向拼接模式的来源标记列（Kutools「插入来源信息」同款）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceCol {
    None,
    /// 追加首列「来源文件」= 源文件名
    File,
    /// 追加首列「来源文件·表」= 源文件名·表名
    FileSheet,
}

impl SourceCol {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("file") => Self::File,
            Some("fileSheet") => Self::FileSheet,
            _ => Self::None,
        }
    }

    fn header(&self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::File => Some("来源文件"),
            Self::FileSheet => Some("来源文件·表"),
        }
    }
}

/// 合并参数（JobKind::MergeXlsx 携带；缺省 = 旧行为完全一致）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MergeOpts {
    pub scope: SheetScope,
    pub name_rule: SheetNameRule,
    pub dedup_header: bool,
    pub source_col: SourceCol,
}

impl Default for MergeOpts {
    fn default() -> Self {
        Self {
            scope: SheetScope::Visible,
            name_rule: SheetNameRule::Smart,
            dedup_header: true,
            source_col: SourceCol::None,
        }
    }
}

/// .xlsx/.xlsm = 保真通道资格（umya 读写范围）
pub(crate) fn fidelity_eligible(path: &str) -> bool {
    let name = crate::fs::path::file_name_of(path);
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    ext == "xlsx" || ext == "xlsm"
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

/// 拆分输出文件名清洗（纯函数）：Windows 禁字符换 ·、掐首尾空白点、截 60 字符、
/// 空名兜底「空」（按列值拆分的组名落文件名场景）
pub fn sanitize_file_stem(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '·',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c.is_whitespace() || c == '.');
    if trimmed.is_empty() {
        return "空".into();
    }
    trimmed.chars().take(60).collect()
}

/// 单元格显示文本（表头比对与错误格文案）
pub(crate) fn cell_text(v: &Data) -> String {
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

/// 保真合并（umya 跨簿克隆工作表；旁写 output）。每处理完一个源文件回调。
fn run_merge_fidelity(
    paths: &[String],
    output: &str,
    opts: &MergeOpts,
    cancel: &AtomicBool,
    mut on_file: impl FnMut(usize),
) -> Vec<FailItem> {
    let mut failed: Vec<FailItem> = Vec::new();
    let mut done = 0usize;
    // 载体簿 = 首个源文件（清空其表后并入全部克隆表）。umya 的「空簿
    // + add_sheet」写出链路不登记克隆格样式（读取侧正常、同簿/已初始化簿
    // 均正常——探针实证），载体簿法等价于后者，样式完整保留
    let mut wb = umya_spreadsheet::reader::xlsx::read(to_extended(&paths[0])).unwrap_or_default();
    while !wb.sheet_collection().is_empty() {
        let _ = wb.remove_sheet(0);
    }
    let mut used_names: HashSet<String> = HashSet::new();
    let mut cells: usize = 0usize;
    for p in paths {
        if cancel.load(Ordering::Relaxed) {
            return failed;
        }
        let r = (|| -> Result<(), String> {
            let book = umya_spreadsheet::reader::xlsx::read(to_extended(p))
                .map_err(|e| format!("读取失败：{e}"))?;
            let stem = stem_of(p);
            // multi = 过滤后实际并入的表数（只并入一张时目标名不带 ·表名 后缀）
            let multi = book
                .sheet_collection()
                .iter()
                .filter(|ws| {
                    let st = ws.state().value_string();
                    !(opts.scope == SheetScope::Visible
                        && (st.eq_ignore_ascii_case("hidden")
                            || st.eq_ignore_ascii_case("veryHidden")))
                })
                .count()
                > 1;
            for ws in book.sheet_collection() {
                let sname = ws.name().to_string();
                // umya 读取器把 state 属性解析进枚举字段（sheet_state()
                // 遗留字符串字段恒空）：经 EnumTrait::value_string 判隐藏族
                use umya_spreadsheet::EnumTrait;
                let state = ws.state().value_string();
                let hidden = state.eq_ignore_ascii_case("hidden")
                    || state.eq_ignore_ascii_case("veryHidden");
                if opts.scope == SheetScope::Visible && hidden {
                    continue;
                }
                cells += ws.highest_row() as usize * ws.highest_column() as usize;
                if cells > CELL_CAP {
                    return Err("超出合并单元格总量上限".into());
                }
                let label = match opts.name_rule {
                    SheetNameRule::Smart => {
                        if multi {
                            format!("{stem}·{sname}")
                        } else {
                            stem.clone()
                        }
                    }
                    SheetNameRule::Sheet => sname.clone(),
                    SheetNameRule::File => stem.clone(),
                };
                let mut cloned = ws.clone();
                let target = allocate_sheet_name(&label, &mut used_names);
                // 图表公式引用旧表名时 umya 写出会 panic（chart 求值按表名
                // 找表），改名后同步重映射全部图表公式（values/分类/系列名）
                if target != sname && !cloned.chart_collection().is_empty() {
                    for chart in cloned.chart_collection_mut() {
                        // PlotArea::formula_mut 统一收集全部图表公式
                        // （values/分类/系列名，各图表类型通吃）
                        for f in chart.plot_area_mut().formula_mut() {
                            let addr = f.address_mut();
                            if addr.sheet_name() == sname {
                                addr.set_sheet_name(target.clone());
                            }
                        }
                    }
                }
                cloned.set_name(&target);
                wb.add_sheet(cloned).map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if let Err(e) = r {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
                reason: None,
            });
        }
        done += 1;
        on_file(done);
    }
    if cancel.load(Ordering::Relaxed) {
        return failed;
    }
    if wb.sheet_collection().is_empty() {
        failed.push(FailItem {
            path: output.to_string(),
            message: "无可合并的工作表（源工作表均被过滤）".into(),
            reason: None,
        });
        return failed;
    }
    // 写出兜底 catch_unwind：未建模的图表/名称边缘 case 即便 panic 也降级为
    // 逐条失败项（任务引擎有全局兜底，这里保证同批其他文件结果不被拖垮）
    let write = std::panic::catch_unwind(|| {
        umya_spreadsheet::writer::xlsx::write(&wb, to_extended(output))
    });
    match write {
        Ok(Ok(())) => {}
        Ok(Err(e)) => failed.push(FailItem {
            path: output.to_string(),
            message: format!("写出失败：{e}"),
            reason: None,
        }),
        Err(_) => failed.push(FailItem {
            path: output.to_string(),
            message: "写出失败：工作簿包含无法迁移的结构（图表/名称引用等），请改用纵向拼接模式"
                .into(),
            reason: None,
        }),
    }
    failed
}

/// 合并核心（无进度/取消上报之外的引擎依赖）：读全部源 → 写 output。
/// 每处理完一个源文件回调 on_file(已完成数)；返回失败清单，输出写失败也在其中。
pub(crate) fn run_merge_core(
    paths: &[String],
    output: &str,
    mode: XlsxMergeMode,
    opts: &MergeOpts,
    cancel: &AtomicBool,
    mut on_file: impl FnMut(usize),
) -> Vec<FailItem> {
    // 分表保留 + 全部源为 xlsx/xlsm → 保真通道（整表克隆，格式/列宽/冻结全保留）
    if mode == XlsxMergeMode::Sheets && paths.iter().all(|p| fidelity_eligible(p)) {
        return run_merge_fidelity(paths, output, opts, cancel, on_file);
    }
    let mut failed: Vec<FailItem> = Vec::new();
    let mut done = 0usize;
    let mut wb = rust_xlsxwriter::Workbook::new();
    let mut used_names: HashSet<String> = HashSet::new();
    // rows 模式的单张目标表：懒建 + 按名复取（每次借用即取即还，规避自借冲突）
    const MERGED_SHEET: &str = "合并";
    let mut header: Option<Vec<String>> = None;
    let mut row_cursor: u32 = 0;
    let mut cells: usize = 0;
    let source_header = opts.source_col.header();

    for p in paths {
        if cancel.load(Ordering::Relaxed) {
            return failed;
        }
        let r = (|| -> Result<(), String> {
            let mut book = open_workbook_auto(to_extended(p)).map_err(|e| e.to_string())?;
            // 工作表范围过滤（仅可见/含隐藏；xlsb/ods 等同样经 sheets_metadata 判可见性）
            let meta: Vec<(String, bool)> = book
                .sheets_metadata()
                .iter()
                .map(|s| (s.name.clone(), s.visible == SheetVisible::Visible))
                .collect();
            if meta.is_empty() {
                return Err("工作簿没有工作表".into());
            }
            let stem = stem_of(p);
            let multi = meta
                .iter()
                .filter(|(_, v)| opts.scope == SheetScope::All || *v)
                .count()
                > 1;
            for (sname, visible) in &meta {
                if opts.scope == SheetScope::Visible && !visible {
                    continue;
                }
                if cells >= CELL_CAP {
                    return Err("超出合并单元格总量上限".into());
                }
                // xlsx/xlsm 源取合并区域（仅 Xlsx 变体有此 API）；其余源纯值
                let (range, merges) = match &mut book {
                    Sheets::Xlsx(x) => {
                        // merge_cells_by_sheet_name 自含解析（无需先 load_merged_regions）
                        let m = x.merge_cells_by_sheet_name(sname).unwrap_or_default();
                        let r = x.worksheet_range(sname).map_err(|e| e.to_string())?;
                        (r, m)
                    }
                    b => {
                        let r = b.worksheet_range(sname).map_err(|e| e.to_string())?;
                        (r, Vec::new())
                    }
                };
                // 逐格样式（仅 xlsx/xlsm；xls/xlsb/ods Err → None 纯值）
                let styles = book.worksheet_style(sname).ok();
                let mut cache = crate::fs::xlsx_style::FormatCache::default();
                let fmt_of = |cache: &mut crate::fs::xlsx_style::FormatCache,
                              row: u32,
                              col: u32,
                              st: Option<&calamine::StyleRange>|
                 -> Option<rust_xlsxwriter::Format> {
                    st.and_then(|s| s.get((row, col)))
                        .and_then(|st| cache.get_or_build(st))
                        .cloned()
                };
                let start = range.start().unwrap_or((0, 0));
                match mode {
                    XlsxMergeMode::Sheets => {
                        let label = match opts.name_rule {
                            SheetNameRule::Smart => {
                                if multi {
                                    format!("{stem}·{sname}")
                                } else {
                                    stem.clone()
                                }
                            }
                            SheetNameRule::Sheet => sname.to_string(),
                            SheetNameRule::File => stem.clone(),
                        };
                        let target = allocate_sheet_name(&label, &mut used_names);
                        let ws = wb.add_worksheet();
                        let _ = ws.set_name(&target);
                        let mut r: u32 = 0;
                        for row in range.rows() {
                            for (c, v) in row.iter().enumerate() {
                                let c = c as u16;
                                if c >= COL_CAP {
                                    break;
                                }
                                let fmt = fmt_of(
                                    &mut cache,
                                    start.0 + r,
                                    start.1 + c as u32,
                                    styles.as_ref(),
                                );
                                crate::fs::xlsx_style::write_value(ws, r, c, v, fmt.as_ref());
                            }
                            cells += row.len();
                            r += 1;
                            if r >= ROW_CAP {
                                break;
                            }
                        }
                        // 回贴合并单元格：锚值 + 锚样式 → merge_range 后重写锚值
                        for m in &merges {
                            let (r0, c0) = m.start;
                            let (r1, c1) = m.end;
                            if r0 >= ROW_CAP || c0 >= COL_CAP as u32 || (r0 == r1 && c0 == c1) {
                                continue;
                            }
                            let rel = (
                                r0.saturating_sub(start.0) as usize,
                                c0.saturating_sub(start.1) as usize,
                            );
                            let val = range.get(rel).cloned().unwrap_or(Data::Empty);
                            let fmt = fmt_of(&mut cache, r0, c0, styles.as_ref());
                            let base = fmt.clone().unwrap_or_default();
                            let _ = ws.merge_range(
                                r0,
                                c0 as u16,
                                r1.min(ROW_CAP - 1),
                                c1.min(u32::from(COL_CAP) - 1) as u16,
                                "",
                                &base,
                            );
                            crate::fs::xlsx_style::write_value(
                                ws,
                                r0,
                                c0 as u16,
                                &val,
                                fmt.as_ref(),
                            );
                        }
                    }
                    XlsxMergeMode::Rows => {
                        let rows: Vec<&[Data]> = range.rows().collect();
                        // 重复表头去除：首个非空首行作表头快照，后续逐格相同才跳过
                        // （快照不含来源列——来源列每文件不同，去重只比数据部分）
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
                        let label = match opts.source_col {
                            SourceCol::None => String::new(),
                            SourceCol::File => stem.clone(),
                            SourceCol::FileSheet => {
                                if multi {
                                    format!("{stem}·{sname}")
                                } else {
                                    stem.clone()
                                }
                            }
                        };
                        let mut r = row_cursor;
                        let extra: u32 = u32::from(source_header.is_some());
                        for (ri, row) in rows.iter().enumerate() {
                            if ri == 0 && skip_first {
                                continue;
                            }
                            if ri == 0 {
                                // 表头行：来源列头 + 原行
                                if let Some(h) = source_header {
                                    crate::fs::xlsx_style::write_value(
                                        ws,
                                        r,
                                        0,
                                        &Data::String((*h).into()),
                                        None,
                                    );
                                }
                            } else if extra == 1 {
                                crate::fs::xlsx_style::write_value(
                                    ws,
                                    r,
                                    0,
                                    &Data::String(label.clone()),
                                    None,
                                );
                            }
                            for (c, v) in row.iter().enumerate() {
                                let c = c as u16 + extra as u16;
                                if c >= COL_CAP {
                                    break;
                                }
                                let fmt = fmt_of(
                                    &mut cache,
                                    start.0 + ri as u32,
                                    start.1 + (c - extra as u16) as u32,
                                    styles.as_ref(),
                                );
                                crate::fs::xlsx_style::write_value(ws, r, c, v, fmt.as_ref());
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
                reason: None,
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
            reason: None,
        });
    }
    failed
}

/// 任务引擎入口：进度语义 = 已处理的源文件数
#[allow(clippy::too_many_arguments)]
pub(crate) fn merge_xlsx(
    paths: &[String],
    output: &str,
    mode: XlsxMergeMode,
    opts: &MergeOpts,
    cancel: &AtomicBool,
    prog: &mut crate::jobs::JobProgress,
    em: &mut crate::jobs::EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    *failed = run_merge_core(paths, output, mode, opts, cancel, |done| {
        prog.done_files = done as u64;
        em.progress(prog);
    });
}

/// 目标表行数快照（拆分进度总量估算用：显式表名或首个可见表）
pub(crate) fn sheet_row_count(path: &str, sheet: Option<&str>) -> u64 {
    let Ok(mut book) = open_workbook_auto(to_extended(path)) else {
        return 0;
    };
    let meta = book.sheets_metadata();
    if meta.is_empty() {
        return 0;
    }
    let name = match sheet {
        Some(n) if meta.iter().any(|s| s.name == *n) => (*n).to_string(),
        _ => meta
            .iter()
            .find(|s| s.visible == SheetVisible::Visible)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| meta[0].name.clone()),
    };
    book.worksheet_range(&name)
        .map(|r| r.get_size().0 as u64)
        .unwrap_or(0)
}

/// 工作表元信息（xlsx_sheet_info 下发前端：拆分对话框选表/选列）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetMeta {
    pub name: String,
    pub visible: bool,
    /// 行/列数（None = 超出解析预算未统计）
    pub rows: Option<u64>,
    pub cols: Option<u64>,
    /// 首行前 48 格显示文本（依据列拆分的列选择器）
    pub first_row: Option<Vec<String>>,
}

/// 表信息快照（轻命令 async + spawn_blocking）：表名/可见性 + 行列数 +
/// 首行样本；解析预算 50 万格，超出部分 rows/cols/first_row 置 None
pub(crate) fn collect_sheet_meta(path: &str) -> Result<Vec<SheetMeta>, String> {
    let mut book = open_workbook_auto(to_extended(path)).map_err(|e| e.to_string())?;
    const BUDGET: usize = 500_000;
    let mut used = 0usize;
    let mut out = Vec::new();
    // 先落清单再逐表解析（worksheet_range 需要 &mut book，避免与元数据借用冲突）
    let list: Vec<(String, bool)> = book
        .sheets_metadata()
        .iter()
        .map(|s| (s.name.clone(), s.visible == SheetVisible::Visible))
        .collect();
    for (sname, visible) in list {
        let (mut rows, mut cols, mut first_row) = (None, None, None);
        if used < BUDGET
            && let Ok(range) = book.worksheet_range(&sname)
        {
            let (h, w) = range.get_size();
            rows = Some(h as u64);
            cols = Some(w as u64);
            used += h * w;
            if let Some(first) = range.rows().next() {
                first_row = Some(
                    first
                        .iter()
                        .take(48)
                        .map(|c| crate::sheet_fmt::display_for(c, None))
                        .collect(),
                );
            }
        }
        out.push(SheetMeta {
            name: sname,
            visible,
            rows,
            cols,
            first_row,
        });
    }
    Ok(out)
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
        // 拆分文件名清洗：禁字符换 ·、掐点、空兜底
        assert_eq!(sanitize_file_stem("a/b\\c:d"), "a·b·c·d");
        assert_eq!(sanitize_file_stem(" . "), "空");
        assert_eq!(sanitize_file_stem("北京"), "北京");
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
            &MergeOpts::default(),
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
            &MergeOpts::default(),
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let names: Vec<String> = read_book(&out).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec!["s·一月", "s·二月", "s", "s (2)"]);
    }

    #[test]
    fn merge_scope_filters_hidden_sheets_in_data_channel() {
        // 隐藏表默认被过滤；scope=All 时并入。用 rust_xlsxwriter 建档 +
        // zip 重打包置隐藏（xlsx.rs 同款手法见 preview 测试）过于繁琐，
        // 直接经 umya 建含隐藏表的 xlsx（拆分测试也要用）
        let dir = tempdir();
        let a = crate::fs::path::join_name(&dir, "h.xlsx");
        let mut wb = umya_spreadsheet::Workbook::default();
        let mut ws = umya_spreadsheet::Worksheet::default();
        ws.set_name("明表");
        ws.cell_mut((1, 1)).set_value("A1");
        wb.add_sheet(ws).unwrap();
        let mut ws2 = umya_spreadsheet::Worksheet::default();
        ws2.set_name("暗表");
        ws2.cell_mut((1, 1)).set_value("X");
        ws2.set_state(umya_spreadsheet::structs::SheetStateValues::Hidden);
        wb.add_sheet(ws2).unwrap();
        umya_spreadsheet::writer::xlsx::write(&wb, to_extended(&a)).unwrap();

        let out_v = crate::fs::path::join_name(&dir, "仅可见.xlsx");
        let out_a = crate::fs::path::join_name(&dir, "含隐藏.xlsx");
        let cancel = AtomicBool::new(false);
        let failed = run_merge_core(
            std::slice::from_ref(&a),
            &out_v,
            XlsxMergeMode::Sheets,
            &MergeOpts::default(),
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let names: Vec<String> = read_book(&out_v).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec!["h"]);
        let failed = run_merge_core(
            std::slice::from_ref(&a),
            &out_a,
            XlsxMergeMode::Sheets,
            &MergeOpts {
                scope: SheetScope::All,
                ..Default::default()
            },
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let mut names: Vec<String> = read_book(&out_a).into_iter().map(|(n, _)| n).collect();
        names.sort();
        assert_eq!(names, vec!["h·明表", "h·暗表"]);
    }

    #[test]
    fn merge_rows_source_col_and_dedup_switch() {
        let dir = tempdir();
        let a = crate::fs::path::join_name(&dir, "甲.xlsx");
        let b = crate::fs::path::join_name(&dir, "乙.xlsx");
        let out = crate::fs::path::join_name(&dir, "带来源.xlsx");
        let header = || vec![Data::String("名称".into()), Data::String("数量".into())];
        write_book(
            &a,
            &[(
                "Sheet1",
                vec![header(), vec![Data::String("甲".into()), Data::Int(1)]],
            )],
        );
        // 表头同名 → 去重生效（来源列不参与比对）
        write_book(
            &b,
            &[(
                "Sheet1",
                vec![header(), vec![Data::String("乙".into()), Data::Int(2)]],
            )],
        );
        let cancel = AtomicBool::new(false);
        let failed = run_merge_core(
            &[a.clone(), b.clone()],
            &out,
            XlsxMergeMode::Rows,
            &MergeOpts {
                source_col: SourceCol::File,
                ..Default::default()
            },
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let sheets = read_book(&out);
        let rows = &sheets[0].1;
        // 表头行 = 来源文件 + 原表头；数据行带各自文件名；重复表头行整体消失
        assert_eq!(
            rows[0],
            vec![
                "来源文件".to_string(),
                "名称".to_string(),
                "数量".to_string()
            ]
        );
        assert_eq!(rows[1][0], "甲");
        assert_eq!(rows[2][0], "乙");
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn merge_fidelity_preserves_formatting() {
        // 全 xlsx 源 + 分表保留 → umya 保真通道：合并格/列宽/冻结/样式 roundtrip
        use rust_xlsxwriter::Format;
        let dir = tempdir();
        let a = crate::fs::path::join_name(&dir, "甲.xlsx");
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("数据").unwrap();
        let _ = ws.set_column_width(0, 30);
        let _ = ws.set_freeze_panes(1, 0);
        let title = Format::new().set_bold();
        ws.merge_range(0, 0, 0, 1, "季度汇总", &title).unwrap();
        ws.write_string_with_format(1, 0, "指标", &title).unwrap();
        ws.write_number_with_format(1, 1, 0.25, &Format::new().set_num_format("0.00%"))
            .unwrap();
        wb.save(to_extended(&a)).unwrap();
        let b = crate::fs::path::join_name(&dir, "乙.xlsx");
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("附表").unwrap();
        ws.write(0, 0, "备注").unwrap();
        wb.save(to_extended(&b)).unwrap();
        let out = crate::fs::path::join_name(&dir, "保真合并.xlsx");
        let cancel = AtomicBool::new(false);
        let failed = run_merge_core(
            &[a, b],
            &out,
            XlsxMergeMode::Sheets,
            &MergeOpts::default(),
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let book = umya_spreadsheet::reader::xlsx::read(to_extended(&out)).unwrap();
        assert_eq!(book.sheet_collection().len(), 2);
        let ws = &book.sheet_collection()[0];
        assert!(ws.merge_cells().iter().any(|m| m.range() == "A1:B1"));
        let widths: Vec<(u32, f64)> = ws
            .column_dimensions()
            .iter()
            .map(|c| (c.col_num(), c.width()))
            .collect();
        assert!(
            widths
                .iter()
                .any(|(c, w)| *c == 1 && (*w - 30.0).abs() < 1.0)
        );
        let pane = ws
            .sheets_views()
            .sheet_view_list()
            .first()
            .and_then(|sv| sv.pane());
        assert!(pane.is_some());
        assert!(
            ws.cell((1, 2))
                .unwrap()
                .style()
                .font()
                .is_some_and(|f| f.bold())
        );
    }

    /// 复杂格式回归：嵌入图表 + 图片的源簿经保真合并——图表/媒体保留、
    /// 图表公式随表名重命名重映射（umya 写出按表名求值，改名不映射即 panic）
    #[test]
    fn merge_fidelity_preserves_charts_and_images() {
        let dir = tempdir();
        let a = crate::fs::path::join_name(&dir, "带图表.xlsx");
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("数据").unwrap();
        ws.write(0, 0, "系列").unwrap();
        ws.write(0, 1, "值").unwrap();
        for (i, v) in [1.0, 2.0, 3.0].iter().enumerate() {
            ws.write((i + 1) as u32, 0, format!("项{i}")).unwrap();
            ws.write_number((i + 1) as u32, 1, *v).unwrap();
        }
        let mut chart = rust_xlsxwriter::Chart::new(rust_xlsxwriter::ChartType::Column);
        chart
            .add_series()
            .set_name("系列")
            .set_categories("数据!$A$2:$A$4")
            .set_values("数据!$B$2:$B$4");
        ws.insert_chart(5, 0, &chart).unwrap();
        let mut png_bytes: Vec<u8> = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut png_bytes, 1, 1);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[0xFF, 0, 0]).unwrap();
        }
        ws.insert_image(
            0,
            4,
            &rust_xlsxwriter::Image::new_from_buffer(&png_bytes).unwrap(),
        )
        .unwrap();
        wb.save(to_extended(&a)).unwrap();
        let out = crate::fs::path::join_name(&dir, "合并.xlsx");
        let cancel = AtomicBool::new(false);
        let failed = run_merge_core(
            std::slice::from_ref(&a),
            &out,
            XlsxMergeMode::Sheets,
            &MergeOpts::default(),
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let file = std::fs::File::open(to_extended(&out)).unwrap();
        let mut z = zip::ZipArchive::new(file).unwrap();
        let (mut charts, mut media) = (0, 0);
        let mut chart_xml = String::new();
        for i in 0..z.len() {
            let mut entry = z.by_index(i).unwrap();
            let n = entry.name().to_string();
            if n.contains("charts/chart") && n.ends_with(".xml") {
                charts += 1;
                std::io::Read::read_to_string(&mut entry, &mut chart_xml).unwrap();
            }
            if n.contains("media/") {
                media += 1;
            }
        }
        assert_eq!((charts, media), (1, 1), "chart/image lost");
        // 公式已重映射到新表名（单表文件 Smart 规则 = 文件名干「带图表」）
        assert!(chart_xml.contains("带图表!"), "formula not remapped");
        assert!(!chart_xml.contains("数据!"), "old sheet name remains");
    }

    #[test]
    fn merge_sheet_name_rules() {
        let dir = tempdir();
        let a = crate::fs::path::join_name(&dir, "年报.xlsx");
        write_book(
            &a,
            &[
                ("一月", vec![vec![Data::Int(1)]]),
                ("二月", vec![vec![Data::Int(2)]]),
            ],
        );
        let cancel = AtomicBool::new(false);
        // 仅表名
        let out = crate::fs::path::join_name(&dir, "r1.xlsx");
        let failed = run_merge_core(
            std::slice::from_ref(&a),
            &out,
            XlsxMergeMode::Sheets,
            &MergeOpts {
                name_rule: SheetNameRule::Sheet,
                ..Default::default()
            },
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let names: Vec<String> = read_book(&out).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec!["一月", "二月"]);
        // 仅文件名（第二张自动 (2)）
        let out = crate::fs::path::join_name(&dir, "r2.xlsx");
        let failed = run_merge_core(
            std::slice::from_ref(&a),
            &out,
            XlsxMergeMode::Sheets,
            &MergeOpts {
                name_rule: SheetNameRule::File,
                ..Default::default()
            },
            &cancel,
            |_| {},
        );
        assert!(failed.is_empty(), "{failed:?}");
        let names: Vec<String> = read_book(&out).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec!["年报", "年报 (2)"]);
    }
}
