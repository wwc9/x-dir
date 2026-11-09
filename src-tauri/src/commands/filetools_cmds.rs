//! 文件工具命令（2026-11-09 功能库「工具」组）：哈希计算 / 校验文件核对 /
//! 时间戳与属性批改 / NTFS 链接 / 文件分割 / 部件合并 / 行尾转换 / SUMS
//! 清单保存（无 BOM 裸写，GNU md5sum 兼容）。逻辑全部在 fs/filetools.rs
//! （命名/解析纯函数带 cargo test）；分割/合并/行尾走任务引擎。

use serde::Serialize;
use tauri::{AppHandle, State};

use super::files::AppError;
use super::jobs_cmds::JobId;
use crate::AppState;
use crate::fs::entry::path_exists;
use crate::fs::filetools::{self, Eol, HashAlgo};
use crate::fs::path::{file_name_of, is_valid_name, join_name, parent_of, to_extended};
use crate::jobs::{JobKind, Policy};

/// 单文件哈希结果（hash = None 时 error 给出原因，逐行展示不中断批量）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashRow {
    pub path: String,
    pub name: String,
    pub hash: Option<String>,
    pub error: Option<String>,
}

/// 批量哈希（前端逐文件循环调用亦可，本命令支持一次整批）
#[tauri::command]
pub fn hash_files(paths: Vec<String>, algo: String) -> Result<Vec<HashRow>, AppError> {
    let algo = HashAlgo::parse(&algo)
        .ok_or_else(|| AppError::new("E_INVALID_NAME", format!("未知算法：{algo}")))?;
    Ok(paths
        .iter()
        .map(|p| {
            let name = file_name_of(p);
            match filetools::hash_file(p, algo) {
                Ok(h) => HashRow {
                    path: p.clone(),
                    name,
                    hash: Some(h),
                    error: None,
                },
                Err(e) => HashRow {
                    path: p.clone(),
                    name,
                    hash: None,
                    error: Some(e.to_string()),
                },
            }
        })
        .collect())
}

/// 校验文件核对报告
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    /// 按期望哈希长度推断的算法（md5/sha1/sha256/sha512）
    pub algo: String,
    pub total: u32,
    pub ok_count: u32,
    pub rows: Vec<filetools::VerifyRow>,
}

/// 核对一个校验文件（.md5/.sha1/.sha256/.sha512，GNU SUMS 格式）：
/// 以清单所在目录为基准哈希各文件并比对
#[tauri::command]
pub fn verify_sums_file(path: String) -> Result<VerifyReport, AppError> {
    if !path_exists(&path) {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!("文件不存在：{}", file_name_of(&path)),
        ));
    }
    let text = std::fs::read_to_string(to_extended(&path))
        .map_err(|e| AppError::new("E_IO", e.to_string()))?;
    let rows = filetools::verify_sums(&path, &text);
    if rows.is_empty() {
        return Err(AppError::new(
            "E_INVALID_NAME",
            "不是有效的校验文件（未解析出合法行）",
        ));
    }
    // 算法优先按扩展名（.sha256 等），无扩展名信息时按首行哈希长度推断
    let algo = filetools::algo_from_ext(&file_name_of(&path))
        .map(|a| a.code())
        .unwrap_or_else(|| match rows[0].expected.len() {
            40 => "sha1",
            64 => "sha256",
            128 => "sha512",
            _ => "md5",
        });
    let total = rows.len() as u32;
    let ok_count = rows.iter().filter(|r| r.status == "ok").count() as u32;
    Ok(VerifyReport {
        algo: algo.into(),
        total,
        ok_count,
        rows,
    })
}

/// 批改时间戳/属性结果（best-effort：逐项失败不中断整批）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaResult {
    pub applied: u32,
    pub failed: Vec<MetaFail>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaFail {
    pub path: String,
    pub message: String,
}

/// 批改时间戳/属性（None = 保持不动；时间 = 毫秒时间戳）
#[tauri::command]
pub fn set_file_meta(
    paths: Vec<String>,
    mtime_ms: Option<i64>,
    atime_ms: Option<i64>,
    readonly: Option<bool>,
    hidden: Option<bool>,
) -> Result<MetaResult, AppError> {
    if paths.is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "至少需要 1 个对象"));
    }
    if mtime_ms.is_none() && atime_ms.is_none() && readonly.is_none() && hidden.is_none() {
        return Err(AppError::new("E_INVALID_NAME", "未选择任何要修改的项"));
    }
    let mut out = MetaResult {
        applied: 0,
        failed: Vec::new(),
    };
    for p in &paths {
        match filetools::set_file_meta(p, mtime_ms, atime_ms, readonly, hidden) {
            Ok(()) => out.applied += 1,
            Err(message) => out.failed.push(MetaFail {
                path: p.clone(),
                message,
            }),
        }
    }
    Ok(out)
}

/// 同目录旁建 NTFS 链接（kind ∈ hard|symlink），返回新链接路径
#[tauri::command]
pub fn create_link(path: String, kind: String) -> Result<String, AppError> {
    if !path_exists(&path) {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!("文件不存在：{}", file_name_of(&path)),
        ));
    }
    let hard = match kind.as_str() {
        "hard" => true,
        "symlink" => false,
        _ => {
            return Err(AppError::new(
                "E_INVALID_NAME",
                format!("未知链接类型：{kind}"),
            ));
        }
    };
    filetools::create_sibling_link(&path, hard).map_err(|e| AppError::new("E_IO", e.to_string()))
}

/// 分割文件入任务引擎（part_mb ∈ 0.1–10240 MB → 字节数）
#[tauri::command]
pub fn split_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    part_mb: f64,
) -> Result<JobId, AppError> {
    if !path_exists(&path) {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!("文件不存在：{}", file_name_of(&path)),
        ));
    }
    if !(0.1..=10240.0).contains(&part_mb) {
        return Err(AppError::new("E_INVALID_NAME", "部件大小须在 0.1–10240 MB"));
    }
    let part_bytes = (part_mb * 1024.0 * 1024.0) as u64;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::SplitFile { part_bytes },
            vec![path],
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// 合并分割部件入任务引擎（须含 ≥1 个 名称.partN 部件或 .crc 清单）
#[tauri::command]
pub fn combine_parts(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<JobId, AppError> {
    if paths.is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "至少需要 1 个对象"));
    }
    let ok = paths.iter().any(|p| {
        filetools::parse_part_name(&file_name_of(p)).is_some()
            || file_name_of(p).to_ascii_lowercase().ends_with(".crc")
    });
    if !ok {
        return Err(AppError::new(
            "E_INVALID_NAME",
            "未选中有效的分割部件（须形如 名称.part001）",
        ));
    }
    Ok(JobId {
        job_id: state
            .jobs
            .enqueue(JobKind::CombineParts, paths, None, Policy::Skip, false, app),
    })
}

/// 行尾转换入任务引擎（to ∈ crlf|lf；字节级重写不改编码）
#[tauri::command]
pub fn convert_eol(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    to: String,
) -> Result<JobId, AppError> {
    let to = Eol::parse(&to)
        .ok_or_else(|| AppError::new("E_INVALID_NAME", format!("未知行尾：{to}")))?;
    if paths.is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "至少需要 1 个文件"));
    }
    let bad = paths.iter().find(|p| !path_exists(p));
    if let Some(p) = bad {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!("文件不存在：{}", file_name_of(p)),
        ));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ConvertEol { to },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// 保存校验清单文件（GNU SUMS 纯文本：无 BOM、LF 行尾——带 BOM 会被
/// md5sum/sha256sum 拒读，与 save_text_file 的 Excel 友好口径相反）
#[tauri::command]
pub fn save_sums_file(path: String, content: String) -> Result<(), AppError> {
    let name = file_name_of(&path);
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
    std::fs::write(
        to_extended(&join_name(&parent, &name)),
        content.into_bytes(),
    )?;
    Ok(())
}
