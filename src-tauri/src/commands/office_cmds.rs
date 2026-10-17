//! Office 文档命令（右键菜单）：COM 转 PDF / 隐私属性清理 / 导出文本 TXT。
//! 全部入任务引擎；此处只做入队前校验（存在性 + 扩展名）。

use tauri::{AppHandle, State};

use super::files::AppError;
use super::jobs_cmds::JobId;
use crate::AppState;
use crate::fs::entry::path_exists;
use crate::jobs::{JobKind, Policy};

fn ext_of(path: &str) -> String {
    path.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}

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

/// Office/WPS COM 转 PDF（旁写 <stem>.pdf）。转换引擎不打包（AGPL 红线），
/// 需用户已装 Microsoft Office 或 WPS；未装时错误由任务失败项给出提示。
#[tauri::command]
pub fn office_to_pdf(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<JobId, AppError> {
    reject_exists(&paths)?;
    let unsupported = paths
        .iter()
        .find(|p| crate::office::office_kind(p).is_none());
    if let Some(p) = unsupported {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("不支持的 Office 格式：{}", crate::fs::path::file_name_of(p)),
        ));
    }
    Ok(JobId {
        job_id: state
            .jobs
            .enqueue(JobKind::OfficeToPdf, paths, None, Policy::Skip, false, app),
    })
}

/// OOXML 隐私属性清理（旁写 <stem>_清洁.<ext>，仅 OOXML 容器）
#[tauri::command]
pub fn clean_office_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<JobId, AppError> {
    reject_exists(&paths)?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::CleanOfficeMeta,
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// 导出文本 TXT（复用预览抽取管线，旁写 <stem>.txt）
#[tauri::command]
pub fn office_to_text(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<JobId, AppError> {
    reject_exists(&paths)?;
    const SUPPORTED: [&str; 10] = [
        "docx", "docm", "pptx", "pptm", "xlsx", "xlsm", "xlsb", "xls", "ods", "epub",
    ];
    let unsupported = paths
        .iter()
        .find(|p| !SUPPORTED.contains(&ext_of(p).as_str()));
    if let Some(p) = unsupported {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("不支持的抽取格式：{}", crate::fs::path::file_name_of(p)),
        ));
    }
    Ok(JobId {
        job_id: state
            .jobs
            .enqueue(JobKind::OfficeToText, paths, None, Policy::Skip, false, app),
    })
}
