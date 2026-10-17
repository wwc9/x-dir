//! 长任务命令：入队复制/移动/删除、取消（§6.5 / §6.7）。
//! native = V2 IFileOperation 原生引擎（进度/冲突交给系统 UI，§3.2）。

use serde::Serialize;
use tauri::{AppHandle, State};

use super::files::AppError;
use crate::AppState;
use crate::fs::entry::path_exists;
use crate::fs::path::file_name_of;
use crate::jobs::{JobKind, JobManager, Policy};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobId {
    pub job_id: u32,
}

fn reject_missing(sources: &[String]) -> Option<AppError> {
    sources
        .iter()
        .find(|s| !path_exists(s))
        .map(|s| AppError::new("E_NOT_FOUND", format!("源不存在：{}", file_name_of(s))))
}

fn check_dest(dest_dir: &str) -> Result<(), AppError> {
    if path_exists(dest_dir) {
        Ok(())
    } else {
        Err(AppError::new(
            "E_NOT_FOUND",
            format!("目标目录不存在：{dest_dir}"),
        ))
    }
}

#[tauri::command]
pub fn copy_items(
    app: AppHandle,
    state: State<'_, AppState>,
    sources: Vec<String>,
    dest_dir: String,
    policy: String,
    native: Option<bool>,
) -> Result<JobId, AppError> {
    check_dest(&dest_dir)?;
    reject_missing(&sources).map_or(Ok(()), Err)?;
    for s in &sources {
        if dest_inside_source(s, &dest_dir) {
            return Err(AppError::new("E_UNKNOWN", "不能把项目复制到它自身内部"));
        }
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::Copy,
            sources,
            Some(dest_dir),
            Policy::parse(&policy),
            native.unwrap_or(false),
            app,
        ),
    })
}

#[tauri::command]
pub fn move_items(
    app: AppHandle,
    state: State<'_, AppState>,
    sources: Vec<String>,
    dest_dir: String,
    policy: String,
    native: Option<bool>,
) -> Result<JobId, AppError> {
    check_dest(&dest_dir)?;
    reject_missing(&sources).map_or(Ok(()), Err)?;
    for s in &sources {
        if dest_inside_source(s, &dest_dir) {
            return Err(AppError::new("E_UNKNOWN", "不能把目录移动到它自身内部"));
        }
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::Move,
            sources,
            Some(dest_dir),
            Policy::parse(&policy),
            native.unwrap_or(false),
            app,
        ),
    })
}

/// 目标目录是否位于源路径内部或就是源本身（防把父目录移动/复制进子目录）。
/// Windows 路径大小写不敏感，且前缀必须落在路径组件边界上——
/// "E:\ab" 不是 "E:\a" 的内部路径；两端都可能来自手输地址栏，大小写不定。
fn dest_inside_source(src: &str, dest_dir: &str) -> bool {
    let src_norm = src.trim_end_matches('\\').to_ascii_lowercase();
    let dest_norm = dest_dir.trim_end_matches('\\').to_ascii_lowercase();
    if dest_norm.len() == src_norm.len() {
        return dest_norm == src_norm; // 目标就是源目录自身（复制/移动进自身）
    }
    dest_norm.len() > src_norm.len()
        && dest_norm.starts_with(&src_norm)
        && dest_norm.as_bytes()[src_norm.len()] == b'\\'
}

#[tauri::command]
pub fn delete_items(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    // false = 移入回收站；true = 永久删除（Shift+Del，前端强制 danger 确认）
    permanent: bool,
) -> Result<JobId, AppError> {
    reject_missing(&paths).map_or(Ok(()), Err)?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::Delete { permanent },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>, job_id: u32) {
    let manager: &JobManager = &state.jobs;
    manager.cancel(job_id);
}

/// 暂停传输任务（仅 Copy/Move 响应；批处理类瞬态任务忽略）
#[tauri::command]
pub fn pause_job(state: State<'_, AppState>, job_id: u32) {
    state.jobs.pause(job_id);
}

/// 恢复已暂停的传输任务
#[tauri::command]
pub fn resume_job(state: State<'_, AppState>, job_id: u32) {
    state.jobs.resume(job_id);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored: usize,
    pub missing: usize,
}

/// 回收站路径匹配的归一化：去尾反斜杠 + 小写（Windows 路径语义）
fn norm_path(p: &str) -> String {
    p.trim_end_matches('\\').to_ascii_lowercase()
}

/// 为每个待恢复路径在回收站条目里找全部匹配：返回 (命中条目下标, 未命中路径数)。
/// 同一原路径可能删过多次（多条回收站记录），全部命中一并恢复。
fn partition_matches(want: &[String], item_paths: &[String]) -> (Vec<usize>, usize) {
    let mut hits = Vec::new();
    let mut missing = 0usize;
    for w in want {
        let wn = norm_path(w);
        let mut any = false;
        for (i, p) in item_paths.iter().enumerate() {
            if norm_path(p) == wn {
                hits.push(i);
                any = true;
            }
        }
        if !any {
            missing += 1;
        }
    }
    (hits, missing)
}

/// Ctrl+Z 撤销"删除到回收站"：按原始路径匹配回收站条目并还原
#[tauri::command]
pub fn restore_trash(paths: Vec<String>) -> Result<RestoreResult, AppError> {
    let items = trash::os_limited::list().map_err(|e| AppError::new("E_TRASH", e.to_string()))?;
    let item_paths: Vec<String> = items
        .iter()
        .map(|it| it.original_path().to_string_lossy().to_string())
        .collect();
    let (hits, missing) = partition_matches(&paths, &item_paths);
    let restored = hits.len();
    let matched: Vec<_> = hits.into_iter().map(|i| items[i].clone()).collect();
    if !matched.is_empty() {
        trash::os_limited::restore_all(matched)
            .map_err(|e| AppError::new("E_TRASH", e.to_string()))?;
    }
    Ok(RestoreResult { restored, missing })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trash_match_normalizes_and_keeps_duplicates() {
        let want = vec![
            "E:\\a\\测试.TXT".to_string(),
            "E:\\".to_string(),
            "E:\\gone.txt".to_string(),
        ];
        let items = vec![
            "e:\\a\\测试.txt".to_string(),   // 大小写折叠命中
            "E:\\a\\测试.txt\\".to_string(), // 尾反斜杠归一命中（同路径删两次）
            "c:\\".to_string(),              // 不命中 want[1]（盘符不同）
        ];
        let (hits, missing) = partition_matches(&want, &items);
        assert_eq!(hits, vec![0, 1]);
        assert_eq!(missing, 2); // E:\ 与 E:\gone.txt 均无匹配
    }

    #[test]
    fn dest_inside_source_case_and_boundary() {
        // 组件边界：同名前缀兄弟目录不是内部
        assert!(!dest_inside_source("E:\\a", "E:\\abc\\x"));
        assert!(!dest_inside_source("E:\\ab", "E:\\a"));
        // 大小写不敏感（Windows 路径语义）
        assert!(dest_inside_source("E:\\a", "e:\\a\\b"));
        assert!(dest_inside_source("e:\\a", "E:\\A\\B"));
        // 目标就是源目录自身
        assert!(dest_inside_source("E:\\a", "e:\\A"));
        // 正常子目录
        assert!(dest_inside_source("E:\\a", "E:\\a\\b"));
        // 尾反斜杠归一
        assert!(dest_inside_source("E:\\a\\", "E:\\a\\b"));
        assert!(!dest_inside_source("E:\\a\\", "E:\\b"));
    }
}
