//! PDF 处理命令（右键菜单）：合并 / 拆分单页 / 文字水印，入任务引擎队列。
//! 校验：路径存在 + .pdf 扩展名；水印文字非空、≤100 字符。

use tauri::{AppHandle, State};

use super::files::AppError;
use super::jobs_cmds::JobId;
use crate::AppState;
use crate::fs::entry::path_exists;
use crate::fs::path::to_extended;
use crate::jobs::{JobKind, Policy};

fn is_pdf(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".pdf")
}

fn reject_not_pdf(paths: &[String]) -> Result<(), AppError> {
    let bad = paths.iter().find(|p| !path_exists(p) || !is_pdf(p));
    match bad {
        Some(p) => Err(AppError::new(
            "E_NOT_FOUND",
            format!("文件不存在或不是 PDF：{}", crate::fs::path::file_name_of(p)),
        )),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn pdf_page_count(path: String) -> Result<u32, AppError> {
    reject_not_pdf(std::slice::from_ref(&path))?;
    let doc = lopdf::Document::load(to_extended(&path))
        .map_err(|e| AppError::new("E_PDF", format!("无法读取 PDF：{e}")))?;
    Ok(doc.get_pages().len() as u32)
}

#[tauri::command]
pub fn pdf_merge(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    output: String,
    merge_by_folder: Option<bool>,
    auto_insert_blank_page: Option<bool>,
    blank_page_position: Option<String>,
) -> Result<JobId, AppError> {
    let auto_blank = auto_insert_blank_page.unwrap_or(false);
    let blank_first = matches!(blank_page_position.as_deref(), Some("第1页之前"));
    if merge_by_folder.unwrap_or(false) || auto_blank {
        // 扩展路径：文件夹递归收集 pdf/图片，缺失/不可读源在任务内自动跳过
        if paths.is_empty() {
            return Err(AppError::new("E_INVALID_NAME", "未选择任何文件或文件夹"));
        }
        return Ok(JobId {
            job_id: state.jobs.enqueue(
                JobKind::PdfMergeEx {
                    merge_by_folder: merge_by_folder.unwrap_or(false),
                    auto_blank,
                    blank_first,
                    output,
                },
                paths,
                None,
                Policy::Skip,
                false,
                app,
            ),
        });
    }
    if paths.len() < 2 {
        return Err(AppError::new("E_INVALID_NAME", "合并至少需要 2 个 PDF"));
    }
    reject_not_pdf(&paths)?;
    if !output.to_ascii_lowercase().ends_with(".pdf") || output.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名无效"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfMerge { output },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn pdf_split(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    out_dir: String,
) -> Result<JobId, AppError> {
    reject_not_pdf(std::slice::from_ref(&path))?;
    if out_dir.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出目录无效"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfSplit { out_dir },
            vec![path],
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn pdf_watermark(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    text: String,
) -> Result<JobId, AppError> {
    reject_not_pdf(&paths)?;
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 100 {
        return Err(AppError::new("E_INVALID_NAME", "水印文字需为 1–100 个字符"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfWatermark { text },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

// ── 页级编辑与图片合并（2026-10-14）──

/// 提取/删除页共用校验：文档可读 + 页码范围对真实页数合法 + 输出名有效
fn validate_page_spec(path: &str, spec: &str, output: &str) -> Result<(), AppError> {
    reject_not_pdf(&[path.to_string()])?;
    let doc = lopdf::Document::load(to_extended(path))
        .map_err(|e| AppError::new("E_PDF", format!("无法读取 PDF：{e}")))?;
    let total = doc.get_pages().len() as u32;
    crate::pdf::parse_page_ranges(spec, total).map_err(|e| AppError::new("E_INVALID_NAME", e))?;
    if !output.to_ascii_lowercase().ends_with(".pdf") || output.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名无效"));
    }
    Ok(())
}

#[tauri::command]
pub fn pdf_extract_pages(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    spec: String,
    output: String,
) -> Result<JobId, AppError> {
    validate_page_spec(&path, &spec, &output)?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfExtractPages { spec, output },
            vec![path],
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn pdf_remove_pages(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    spec: String,
    output: String,
) -> Result<JobId, AppError> {
    validate_page_spec(&path, &spec, &output)?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfRemovePages { spec, output },
            vec![path],
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn pdf_rotate(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    degrees: i64,
) -> Result<JobId, AppError> {
    reject_not_pdf(std::slice::from_ref(&path))?;
    if degrees == 0 || degrees % 90 != 0 || degrees.abs() > 270 {
        return Err(AppError::new(
            "E_INVALID_NAME",
            "旋转角度须为 ±90/±180/±270",
        ));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfRotate { degrees },
            vec![path],
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn pdf_compress(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<JobId, AppError> {
    reject_not_pdf(&paths)?;
    Ok(JobId {
        job_id: state
            .jobs
            .enqueue(JobKind::PdfCompress, paths, None, Policy::Skip, false, app),
    })
}

fn is_image(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg")
    )
}

#[tauri::command]
pub fn images_to_pdf(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    output: String,
) -> Result<JobId, AppError> {
    if paths.is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "至少需要 1 张图片"));
    }
    let bad = paths.iter().find(|p| !path_exists(p) || !is_image(p));
    if let Some(p) = bad {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!(
                "文件不存在或不是 PNG/JPG：{}",
                crate::fs::path::file_name_of(p)
            ),
        ));
    }
    if !output.to_ascii_lowercase().ends_with(".pdf") || output.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名无效"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ImagesToPdf { output },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}
