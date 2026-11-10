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

/// Excel 工作簿合并（calamine 读 → rust_xlsxwriter 写 .xlsx；mode ∈ sheets/rows）
#[tauri::command]
pub fn merge_xlsx(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    output: String,
    mode: String,
) -> Result<JobId, AppError> {
    if paths.len() < 2 {
        return Err(AppError::new("E_INVALID_NAME", "合并至少需要 2 个文件"));
    }
    reject_exists(&paths)?;
    validate_output(&output)?;
    if !output.to_ascii_lowercase().ends_with(".xlsx") {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名须为 .xlsx"));
    }
    let mode = crate::fs::xlsx::XlsxMergeMode::parse(&mode)
        .ok_or_else(|| AppError::new("E_INVALID_NAME", format!("未知合并模式：{mode}")))?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::MergeXlsx { mode, output },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// 压缩（zip / 7z / tar.gz；文件平铺、文件夹递归含顶层目录）。
/// 输出已存在 = E_EXISTS 拒绝（对话框内联冲突校验为主，此处兜底——旁写
/// 不静默覆盖，2026-11-08）；password/encrypt_header 仅 7z 格式生效
#[tauri::command]
pub fn zip_files(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    output: String,
    format: Option<String>,
    password: Option<String>,
    encrypt_header: Option<bool>,
) -> Result<JobId, AppError> {
    if paths.is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "至少需要 1 个对象"));
    }
    reject_exists(&paths)?;
    let fmt = match format.as_deref().unwrap_or("zip") {
        "zip" => crate::fs::textops::CreateFormat::Zip,
        "7z" => crate::fs::textops::CreateFormat::SevenZ,
        "targz" => crate::fs::textops::CreateFormat::TarGz,
        other => {
            return Err(AppError::new(
                "E_INVALID_NAME",
                format!("未知压缩格式：{other}"),
            ));
        }
    };
    if output.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名无效"));
    }
    let expect_ext = match fmt {
        crate::fs::textops::CreateFormat::Zip => ".zip",
        crate::fs::textops::CreateFormat::SevenZ => ".7z",
        crate::fs::textops::CreateFormat::TarGz => ".tar.gz",
    };
    if !output.to_ascii_lowercase().ends_with(expect_ext) {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("输出文件名须为 {expect_ext}"),
        ));
    }
    if crate::fs::entry::path_exists(&output) {
        return Err(AppError::new(
            "E_EXISTS",
            format!("同名文件已存在：{output}"),
        ));
    }
    // 密码仅 7z 有效（zip 不写加密、tar.gz 无此概念），未带密码时忽略开关
    let encrypt_header = encrypt_header.unwrap_or(false) && password.is_some();
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ZipFiles {
                output,
                format: fmt,
                password,
                encrypt_header,
            },
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

/// 保存文本文件（导出文件清单等轻量写出；UTF-8 BOM，Excel 友好）。
/// 整路径逐段校验（2026-11-01 安全加固）：旧实现只查末段文件名，`..` 可
/// 留在目录段——IPC 裸调可写任意已存在目录（UI 正常路径无害，纵深防御）
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), AppError> {
    let name = crate::fs::path::file_name_of(&path);
    if !is_valid_name(&name) {
        return Err(AppError::new("E_INVALID_NAME", "文件名无效"));
    }
    for seg in path.split('\\') {
        if seg == ".." {
            return Err(AppError::new("E_INVALID_NAME", "路径不允许包含 .."));
        }
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
    std::fs::write(to_extended(&join_name(&parent, &name)), bytes)?;
    Ok(())
}

/// 导出文件清单回执：实际落点（重名 available_name 递增）+ 行数
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedListing {
    pub path: String,
    pub count: usize,
}

/// 导出文件清单（2026-11-10 五次定案参数面板）：免保存框直写 dir 下
/// 「<file_name>.<fmt>」，file_name 空 = 回落「<文件夹名>-文件清单」，非法名
/// E_INVALID_NAME，重名 available_name 递增不覆盖。content ∈ all|files|dirs
/// 内容筛选；recursive = 穿透子文件夹（选中文件夹行后跟子树；空白处整树/
/// 直接子项由它决定）。fmt ∈ csv|md|txt。行数超 MAX_ROWS 整体中止
#[tauri::command]
pub fn export_listing(
    paths: Vec<String>,
    dir: String,
    file_name: String,
    fmt: String,
    content: String,
    recursive: bool,
) -> Result<ExportedListing, AppError> {
    let ext = match fmt.as_str() {
        "csv" | "md" | "txt" => fmt.as_str(),
        _ => return Err(AppError::new("E_INVALID_NAME", "不支持的清单格式")),
    };
    let keep_dirs = match content.as_str() {
        "all" => None,
        "files" => Some(false),
        "dirs" => Some(true),
        _ => return Err(AppError::new("E_INVALID_NAME", "无效的内容筛选参数")),
    };
    if !path_exists(&dir) {
        return Err(AppError::new("E_NOT_FOUND", format!("目录不存在：{dir}")));
    }
    let mut rows = if paths.is_empty() {
        crate::fs::listing::collect_tree(&dir, recursive, crate::fs::listing::MAX_ROWS)
    } else {
        crate::fs::listing::collect_selected(&paths, &dir, recursive, crate::fs::listing::MAX_ROWS)
    }
    .map_err(|e| match e {
        crate::fs::listing::CollectError::TooMany(cap) => {
            AppError::new("E_LIMIT", format!("条目超过导出上限（{cap}），已中止"))
        }
        crate::fs::listing::CollectError::Unreadable => {
            AppError::new("E_NOT_FOUND", "所选条目均无法读取")
        }
    })?;
    crate::fs::listing::retain_content(&mut rows, keep_dirs);
    if rows.is_empty() {
        return Err(AppError::new("E_NOT_FOUND", "筛选后无条目可导出"));
    }
    let trimmed = file_name.trim();
    let base = if trimmed.is_empty() {
        crate::fs::listing::listing_base_name(&dir)
    } else if is_valid_name(trimmed) {
        trimmed.to_string()
    } else {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("文件名含非法字符或为 Windows 保留名：{trimmed}"),
        ));
    };
    let content_text = crate::fs::listing::build_listing(&rows, &fmt);
    let target = crate::jobs::pick::available_name(&join_name(&dir, &format!("{base}.{ext}")));
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(content_text.as_bytes());
    std::fs::write(to_extended(&target), bytes)?;
    Ok(ExportedListing {
        count: rows.len(),
        path: target,
    })
}
