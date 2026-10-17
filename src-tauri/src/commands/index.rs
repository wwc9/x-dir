//! 索引模式命令：状态查询 / 开启（UAC 拉起守护）/ 关闭（stop 文件）。

use super::files::AppError;
use crate::index::daemon;

/// 设置面板与搜索面板的状态源：守护存活 / 开关 / 各卷条目数与新鲜度
#[tauri::command]
pub fn index_status() -> serde_json::Value {
    crate::index::status_summary()
}

/// 开启索引模式：写守护配置（全部固定 NTFS 盘）；守护未运行则经 UAC 拉起
/// （一次提权，托盘常驻由用户手动关闭或写 stop 文件退出）。
#[tauri::command]
pub fn enable_index_mode() -> Result<(), AppError> {
    let letters = daemon::indexable_volumes();
    if letters.is_empty() {
        return Err(AppError::new(
            "E_UNSUPPORTED",
            "未找到可索引的 NTFS 固定磁盘",
        ));
    }
    daemon::write_daemon_config(&letters)
        .map_err(|e| AppError::new("E_IO", format!("写入守护配置失败：{e}")))?;
    if daemon::daemon_alive() {
        return Ok(()); // 已在运行：新卷清单待其重启后生效
    }
    crate::index::launch_elevated_daemon().map_err(|e| AppError::new("E_CANCELLED", e))
}

/// 关闭索引模式：写停止文件（守护进程轮询到后保存并退出）
#[tauri::command]
pub fn disable_index_mode() {
    daemon::request_stop();
}
