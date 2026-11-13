//! 工作日历命令薄封装（design/calendar-plan.md §5.1）：月度读取 + 单日写入。
//! 纯逻辑在 crate::worklog（带 cargo test），此处只做 IPC 形状适配。

use crate::worklog::{self, WorkEntry, WorklogDay};

#[tauri::command]
pub fn worklog_get_month(year: i32, month: u32) -> Result<Vec<WorklogDay>, String> {
    worklog::get_month(year, month)
}

#[tauri::command]
pub fn worklog_set_day(date: String, entries: Vec<WorkEntry>) -> Result<(), String> {
    worklog::set_day(&date, entries)
}
