//! 解除占用命令（2026-11-01）：查询占用进程 / 远程关闭句柄。
//! spawn_blocking：全系统句柄枚举十万级 syscall，数百 ms 起，不占主线程。

use super::files::AppError;
use crate::locks::{self, FileLocks, ReleaseLocksResult};

#[tauri::command]
pub async fn find_file_locks(paths: Vec<String>) -> Result<Vec<FileLocks>, AppError> {
    tauri::async_runtime::spawn_blocking(move || Ok(locks::find_locks(&paths)))
        .await
        .map_err(|e| AppError::new("E_LOCKS", format!("查询占用线程失败：{e}")))?
}

#[tauri::command]
pub async fn release_file_locks(path: String) -> Result<ReleaseLocksResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || Ok(locks::release_locks(&path)))
        .await
        .map_err(|e| AppError::new("E_LOCKS", format!("解除占用线程失败：{e}")))?
}
