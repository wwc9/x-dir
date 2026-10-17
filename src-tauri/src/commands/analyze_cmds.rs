//! 目录分析命令：重复文件 / 目录体积 / 双文件夹比较。
//! 扫描可能秒级耗时：经 tauri::async_runtime 的阻塞线程池执行，不占主线程。

use super::files::AppError;
use crate::fs::analyze::{self, CompareResult, DirSizeEntry, DupGroup};
use crate::fs::entry::path_exists;

fn require_dir(dir: &str) -> Result<(), AppError> {
    if !path_exists(dir) {
        return Err(AppError::new("E_NOT_FOUND", "目录不存在"));
    }
    Ok(())
}

/// 重复文件查找（SHA-256 内容指纹，同体积粗分后全量校验）
#[tauri::command]
pub async fn find_duplicates(dir: String) -> Result<Vec<DupGroup>, AppError> {
    require_dir(&dir)?;
    tauri::async_runtime::spawn_blocking(move || analyze::find_duplicates(&dir))
        .await
        .map_err(|e| AppError::new("E_JOB_FAILED", format!("扫描失败：{e}")))
}

/// 目录体积分析（直接子项，文件夹递归计）
#[tauri::command]
pub async fn dir_sizes(dir: String) -> Result<Vec<DirSizeEntry>, AppError> {
    require_dir(&dir)?;
    tauri::async_runtime::spawn_blocking(move || analyze::dir_sizes(&dir))
        .await
        .map_err(|e| AppError::new("E_JOB_FAILED", format!("扫描失败：{e}")))
}

/// 双文件夹比较（相对路径对齐）
#[tauri::command]
pub async fn compare_dirs(a: String, b: String) -> Result<CompareResult, AppError> {
    require_dir(&a)?;
    require_dir(&b)?;
    tauri::async_runtime::spawn_blocking(move || analyze::compare_dirs(&a, &b))
        .await
        .map_err(|e| AppError::new("E_JOB_FAILED", format!("比较失败：{e}")))
}
