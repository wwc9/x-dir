//! V3 原生集成命令：双轨右键菜单（IContextMenu）与 OLE 拖拽。

use tauri::{AppHandle, Manager};

use super::files::AppError;

/// 弹出系统原生右键菜单（Shift+右键 / “显示更多选项”入口）。
/// 模态阻塞直至菜单关闭；坐标取实时光标位置。
#[tauri::command]
pub fn show_context_menu(paths: Vec<String>, app: AppHandle) -> Result<(), AppError> {
    let hwnd = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .ok_or_else(|| AppError::new("E_UNKNOWN", "主窗口句柄不可用"))?;
    crate::native_menu::show(&paths, hwnd).map_err(|e| AppError::new("E_UNSUPPORTED", e))
}

/// 发起 OLE 拖拽（阻塞直至放下/取消），返回 "copy" | "move" | "none"
#[tauri::command]
pub fn start_drag(paths: Vec<String>, app: AppHandle) -> Result<String, AppError> {
    crate::ole_dnd::start(&paths, app).map_err(|e| AppError::new("E_UNKNOWN", e))
}
