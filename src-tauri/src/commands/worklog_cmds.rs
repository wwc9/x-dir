//! 工作日历命令薄封装（design/calendar-plan.md §5.1 + 2026-11-13 增强批）：
//! 月度读取 / 单日写入 / 全量搜索 / XLSX 导出。纯逻辑在 crate::worklog
//! （带 cargo test），此处只做 IPC 形状适配与导出文件写出。

use crate::worklog::{self, WorkEntry, WorklogDay, WorklogHit};
use serde::{Deserialize, Serialize};

#[tauri::command]
pub fn worklog_get_month(year: i32, month: u32) -> Result<Vec<WorklogDay>, String> {
    worklog::get_month(year, month)
}

#[tauri::command]
pub fn worklog_set_day(date: String, entries: Vec<WorkEntry>) -> Result<(), String> {
    worklog::set_day(&date, entries)
}

#[tauri::command]
pub fn worklog_search(query: String, category: Option<String>) -> Result<Vec<WorklogHit>, String> {
    worklog::search(&query, category.as_deref())
}

/// XLSX 导出行（前端已按展示口径组装好显示串——星期/类型/状态/分类均为
/// 中文展示文本，Rust 只负责校验路径与写表，保持导出措辞与 Markdown 同源）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorklogXlsxRow {
    pub date: String,
    pub weekday: String,
    pub kind: String,
    pub status: String,
    pub category: String,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorklogXlsxStat {
    pub label: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorklogXlsxSummary {
    pub rows: usize,
}

#[tauri::command]
pub fn worklog_export_xlsx(
    path: String,
    rows: Vec<WorklogXlsxRow>,
    stats: Vec<WorklogXlsxStat>,
) -> Result<WorklogXlsxSummary, String> {
    use crate::fs::path::{is_valid_name, parent_of};
    use rust_xlsxwriter::Format;

    // 路径校验与 save_text_file 同口径：文件名合法 + 段落无 .. + 父目录存在
    let name = crate::fs::path::file_name_of(&path);
    if path.trim().is_empty() || !is_valid_name(&name) {
        return Err("输出文件名无效".into());
    }
    if path.split('\\').any(|seg| seg == "..") {
        return Err("路径不允许包含 ..".into());
    }
    let Some(parent) = parent_of(&path) else {
        return Err("缺少所在目录".into());
    };
    if !std::path::Path::new(&parent).exists() {
        return Err(format!("目录不存在：{parent}"));
    }

    let mut wb = rust_xlsxwriter::Workbook::new();
    let header = Format::new().set_bold();

    // 统计表
    let ws_stat = wb.add_worksheet();
    ws_stat.set_name("统计").map_err(|e| e.to_string())?;
    let _ = ws_stat.write(0, 0, "指标").map_err(|e| e.to_string())?;
    let _ = ws_stat
        .write_with_format(0, 1, "值", &header)
        .map_err(|e| e.to_string())?;
    let _ = ws_stat
        .write_with_format(0, 0, "指标", &header)
        .map_err(|e| e.to_string())?;
    for (i, st) in stats.iter().enumerate() {
        let _ = ws_stat
            .write((i + 1) as u32, 0, &st.label)
            .map_err(|e| e.to_string())?;
        let _ = ws_stat
            .write((i + 1) as u32, 1, &st.value)
            .map_err(|e| e.to_string())?;
    }
    let _ = ws_stat.set_column_width(0, 16);
    let _ = ws_stat.set_column_width(1, 16);

    // 明细表
    let ws = wb.add_worksheet();
    ws.set_name("明细").map_err(|e| e.to_string())?;
    let heads = ["日期", "星期", "类型", "状态", "分类", "内容"];
    for (col, h) in heads.iter().enumerate() {
        let _ = ws
            .write_with_format(0, col as u16, *h, &header)
            .map_err(|e| e.to_string())?;
    }
    for (i, r) in rows.iter().enumerate() {
        let row = (i + 1) as u32;
        let _ = ws.write(row, 0, &r.date).map_err(|e| e.to_string())?;
        let _ = ws.write(row, 1, &r.weekday).map_err(|e| e.to_string())?;
        let _ = ws.write(row, 2, &r.kind).map_err(|e| e.to_string())?;
        let _ = ws.write(row, 3, &r.status).map_err(|e| e.to_string())?;
        let _ = ws.write(row, 4, &r.category).map_err(|e| e.to_string())?;
        let _ = ws.write(row, 5, &r.text).map_err(|e| e.to_string())?;
    }
    let _ = ws.set_column_width(0, 12);
    let _ = ws.set_column_width(1, 8);
    let _ = ws.set_column_width(2, 14);
    let _ = ws.set_column_width(3, 10);
    let _ = ws.set_column_width(4, 10);
    let _ = ws.set_column_width(5, 80);

    wb.save(&path).map_err(|e| format!("写入失败：{e}"))?;
    Ok(WorklogXlsxSummary { rows: rows.len() })
}
