//! 压缩包解压命令（zip / 7z）：入任务引擎，每包解到目标目录下 `<包名>/` 子目录。

use tauri::{AppHandle, State};

use super::files::AppError;
use super::jobs_cmds::JobId;
use crate::AppState;
use crate::fs::entry::path_exists;
use crate::fs::path::file_name_of;
use crate::jobs::{JobKind, Policy};

/// 解压到指定目录（前端传选中项所在目录；输出 = <dest>/<包名>/ 子文件夹）
#[tauri::command]
pub fn extract_archives(
    app: AppHandle,
    state: State<'_, AppState>,
    sources: Vec<String>,
    dest_dir: String,
) -> Result<JobId, AppError> {
    if sources.is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "至少需要 1 个压缩包"));
    }
    let bad = sources.iter().find(|p| !path_exists(p));
    if let Some(p) = bad {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!("文件不存在：{}", file_name_of(p)),
        ));
    }
    if dest_dir.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "缺少目标目录"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::Extract,
            sources,
            Some(dest_dir),
            Policy::Skip,
            false,
            app,
        ),
    })
}
