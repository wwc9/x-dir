//! V3 原生集成命令：双轨右键菜单（IContextMenu）、OLE 拖拽与窗口边框色。

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager};

use super::files::AppError;

/// 无边框窗口顶部 1px 非客户区的填充色（COLORREF 0x00BBGGRR）。
/// 默认浅色画布 #e9ecf1；深色主题由前端经 set_border_color 同步（#131519）
#[cfg(windows)]
pub static BORDER_COLOR: AtomicU32 = AtomicU32::new(0x00F1_ECE9);

/// 主题切换时同步窗口边框区颜色（color = COLORREF 0x00BBGGRR）。
/// 该区是 tao 阴影 insets 留出的系统绘制带（Win11 顶缘 1px），系统默认强调色
/// 或窗口背景亮条都会浮出可见横线——填成画布色融入背景（2026-10-17 定案）
#[tauri::command]
pub fn set_border_color(app: AppHandle, color: u32) {
    #[cfg(windows)]
    {
        BORDER_COLOR.store(color, Ordering::Relaxed);
        // 立即应用（不等下次焦点/缩放事件的压回）
        if let Some(w) = app.get_webview_window("main")
            && let Ok(hwnd) = w.hwnd()
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::Graphics::Dwm::{DWMWA_BORDER_COLOR, DwmSetWindowAttribute};
            unsafe {
                let _ = DwmSetWindowAttribute(
                    HWND(hwnd.0),
                    DWMWA_BORDER_COLOR,
                    &color as *const u32 as *const std::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                );
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (color, app);
}

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
