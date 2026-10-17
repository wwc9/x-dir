//! 文本/表格批处理命令：编码转换 / CSV 合并 / 文本合并 / 压缩 zip / 保存文本文件
//! （导出文件清单用）。批量项入任务引擎，save_text_file 为轻量同步命令。

use tauri::{AppHandle, State};

use super::files::AppError;
use super::jobs_cmds::JobId;
use crate::AppState;
use crate::fs::entry::path_exists;
use crate::fs::path::{is_valid_name, join_name, parent_of, to_extended};
use crate::jobs::{JobKind, Policy};

fn reject_exists(paths: &[String]) -> Result<(), AppError> {
    let bad = paths.iter().find(|p| !path_exists(p));
    if let Some(p) = bad {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!("文件不存在：{}", crate::fs::path::file_name_of(p)),
        ));
    }
    Ok(())
}

/// 文本/表格编码转换（旁写 <stem><后缀>.<ext>；target ∈ utf8bom/utf8/gbk）
#[tauri::command]
pub fn convert_encoding(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    target: String,
) -> Result<JobId, AppError> {
    reject_exists(&paths)?;
    let target = crate::fs::textops::EncTarget::parse(&target)
        .ok_or_else(|| AppError::new("E_INVALID_NAME", format!("未知目标编码：{target}")))?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ConvertEncoding { target },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// CSV/TSV 合并（去重复表头）→ output（UTF-8 BOM）
#[tauri::command]
pub fn merge_csv(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    output: String,
) -> Result<JobId, AppError> {
    if paths.len() < 2 {
        return Err(AppError::new("E_INVALID_NAME", "合并至少需要 2 个文件"));
    }
    reject_exists(&paths)?;
    validate_output(&output)?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::MergeCsv { output },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// 文本合并（空行分隔）→ output（UTF-8 BOM）
#[tauri::command]
pub fn merge_texts(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    output: String,
) -> Result<JobId, AppError> {
    if paths.len() < 2 {
        return Err(AppError::new("E_INVALID_NAME", "合并至少需要 2 个文件"));
    }
    reject_exists(&paths)?;
    validate_output(&output)?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::MergeTexts { output },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// 压缩为 zip（文件平铺、文件夹递归含顶层目录；同名覆盖）
#[tauri::command]
pub fn zip_files(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    output: String,
) -> Result<JobId, AppError> {
    if paths.is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "至少需要 1 个对象"));
    }
    reject_exists(&paths)?;
    if !output.to_ascii_lowercase().ends_with(".zip") || output.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名须为 .zip"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ZipFiles { output },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

fn validate_output(output: &str) -> Result<(), AppError> {
    if output.trim().is_empty() || !is_valid_name(&crate::fs::path::file_name_of(output)) {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名无效"));
    }
    Ok(())
}

/// 保存文本文件（导出文件清单等轻量写出；UTF-8 BOM，Excel 友好）
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), AppError> {
    if !is_valid_name(&crate::fs::path::file_name_of(&path)) {
        return Err(AppError::new("E_INVALID_NAME", "文件名无效"));
    }
    let Some(parent) = parent_of(&path) else {
        return Err(AppError::new("E_INVALID_NAME", "缺少所在目录"));
    };
    if !path_exists(&parent) {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!("目录不存在：{parent}"),
        ));
    }
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(content.as_bytes());
    std::fs::write(
        to_extended(&join_name(&parent, &crate::fs::path::file_name_of(&path))),
        bytes,
    )?;
    Ok(())
}
