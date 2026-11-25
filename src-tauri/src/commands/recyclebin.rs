//! 回收站虚拟页命令（2026-11-25）：核心逻辑见 crate::recyclebin。
//! 枚举/还原/清空均 async + spawn_blocking（$I 遍历与批量删除可达百 ms 级）。

use tauri::AppHandle;

use crate::recyclebin::{self, RecycleEntry, RecycleOpResult};

/// 回收站条目清单（本用户可读桶；按删除时刻排序由前端做）
#[tauri::command]
pub async fn recyclebin_list(_app: AppHandle) -> Result<Vec<RecycleEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(recyclebin::list_entries()))
        .await
        .map_err(|e| format!("回收站枚举线程失败：{e}"))?
}

/// 还原一批条目（成功数 + 逐项失败）；涉及目录由前端 bumpAffected 刷新
#[tauri::command]
pub async fn recyclebin_restore(
    _app: AppHandle,
    items: Vec<RecycleEntry>,
) -> Result<RecycleOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(recyclebin::restore_entries(&items)))
        .await
        .map_err(|e| format!("还原线程失败：{e}"))?
}

/// 永久删除一批 $R 数据体（文件/目录递归；清空回收站 = 全量本命令）
#[tauri::command]
pub async fn recyclebin_delete(
    _app: AppHandle,
    r_paths: Vec<String>,
) -> Result<RecycleOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(recyclebin::delete_permanent(&r_paths)))
        .await
        .map_err(|e| format!("删除线程失败：{e}"))?
}
