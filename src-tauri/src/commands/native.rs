//! V3 原生集成命令：双轨右键菜单（IContextMenu）、OLE 拖拽与窗口边框色。

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager};

use super::files::AppError;

/// 无边框窗口顶部 1px 非客户区的填充色（COLORREF 0x00BBGGRR）。
/// 默认浅色画布 #e9ecf1；深色主题由前端经 set_border_color 同步（#161616，
/// 2026-11-11 深色画布参考 zcode 方案，随 index.css --np-bg 同改）
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

/// Win11 系统级窗口圆角（2026-11-18 外观打磨）：无边框窗默认直角，渐变画布
/// 铺满全窗后直角观感被放大（用户反馈「右上角好像是直角」）。交还给系统做
/// 原生圆角——四角一致、抗锯齿、阴影跟随。Win10 无此属性静默忽略保持直角；
/// shot-* 全屏覆盖层窗不参与（贴屏直角是正确形态）。幂等，可反复刷
pub fn apply_rounded_corners(app: &AppHandle) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Dwm::{
            DWM_WINDOW_CORNER_PREFERENCE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
            DwmSetWindowAttribute,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GWL_STYLE, GetWindowLongPtrW, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            SetWindowLongPtrW, SetWindowPos, WS_THICKFRAME,
        };
        for (name, w) in app.webview_windows() {
            if name.starts_with("shot") {
                continue;
            }
            if let Ok(hwnd) = w.hwnd() {
                // ⚠ 无边框窗（WS_POPUP、缺 WS_THICKFRAME 框架样式）会被系统忽略
                // 圆角偏好——补 thickframe 样式位 + FRAMECHANGED 才能让 DWM 圆角
                // 真正渲染（原生边缘缩放/阴影亦随 thickframe 恢复）
                unsafe {
                    let style = GetWindowLongPtrW(HWND(hwnd.0), GWL_STYLE);
                    SetWindowLongPtrW(HWND(hwnd.0), GWL_STYLE, style | WS_THICKFRAME.0 as isize);
                    let _ = SetWindowPos(
                        HWND(hwnd.0),
                        Some(HWND(hwnd.0)),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
                    );
                }
                let pref = DWMWCP_ROUND;
                unsafe {
                    let _ = DwmSetWindowAttribute(
                        HWND(hwnd.0),
                        DWMWA_WINDOW_CORNER_PREFERENCE,
                        &pref as *const DWM_WINDOW_CORNER_PREFERENCE as *const std::ffi::c_void,
                        std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
                    );
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// 弹出系统原生右键菜单（Shift+右键 / “显示更多选项”入口）。async：枚举交给
/// 常驻 STA 工作线程（native_menu，2026-11-25 呼出提速——扩展枚举期间主线程
/// 事件循环不冻结，扩展 DLL 随首次调用常驻进程），显示经 run_on_main_thread
/// 挪回主线程（2026-11-26 修复：跨线程 TrackPopupMenu 秒回 cmd=0 静默无菜单），
/// 菜单关闭后回执，前端 await 语义不变。
/// x/y = 前端自定义菜单的呼出点（CSS 像素，客户区坐标）：系统二级菜单锚定最初
/// 右键位置（Explorer「显示更多选项」同惯例），不随「更多系统选项」菜单项的
/// 点击位走——自定义菜单条目多、sysMenu 驻尾部，项位离文件可达数百 px
/// （2026-11-27 用户报告「面板和选中的文件有点远」）。换算 = 客户逻辑点 ×
/// 缩放 → ClientToScreen 屏幕物理坐标（精确吸收客户区偏移）；None 兜底取
/// 实时光标。
#[tauri::command]
pub async fn show_context_menu(
    paths: Vec<String>,
    x: Option<f64>,
    y: Option<f64>,
    app: AppHandle,
) -> Result<(), AppError> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::new("E_UNKNOWN", "主窗口句柄不可用"))?;
    let hwnd = w
        .hwnd()
        .map_err(|_| AppError::new("E_UNKNOWN", "主窗口句柄不可用"))?;
    let anchor = match (x, y) {
        (Some(x), Some(y)) => {
            let scale = w.scale_factor().unwrap_or(1.0);
            let mut pt = windows::Win32::Foundation::POINT {
                x: (x * scale).round() as i32,
                y: (y * scale).round() as i32,
            };
            unsafe {
                let _ = windows::Win32::Graphics::Gdi::ClientToScreen(
                    windows::Win32::Foundation::HWND(hwnd.0),
                    &mut pt,
                );
            }
            Some((pt.x, pt.y))
        }
        _ => None,
    };
    crate::native_menu::show_async(paths, hwnd.0 as isize, anchor, app)
        .await
        .map_err(|e| AppError::new("E_UNSUPPORTED", e))
}

/// 发起 OLE 拖拽（阻塞直至放下/取消），返回 "copy" | "move" | "none"
#[tauri::command]
pub fn start_drag(paths: Vec<String>, app: AppHandle) -> Result<String, AppError> {
    crate::ole_dnd::start(&paths, app).map_err(|e| AppError::new("E_UNKNOWN", e))
}
