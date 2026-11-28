//! 盘符插拔感知（2026-11-27 审查修复；2026-11-28 二轮修正窗口类型）：
//! U 盘插入后导航树/收藏下拉/面包屑此前只在挂载时拉一次 getDrives，重启前
//! 盘符列表冻结（树自带的「刷新」钮也救不了——它只清子目录缓存，盘符是
//! 另一份 state）。隐藏顶层窗口收 WM_DEVICECHANGE 广播（DBT_DEVICEARRIVAL /
//! DBT_DEVICEREMOVECOMPLETE，卷挂载与移除都走这两族），事件驱动前端重拉
//! 盘符清单。
//!
//! ⚠ 窗口类型必须是**普通隐藏顶层窗**：message-only 窗（HWND_MESSAGE 父）
//! 被系统排除在广播投递之外，收不到 WM_DEVICECHANGE（Raymond Chen
//! "What kind of messages can a message-only window receive?"）——初版正是
//! 踩了这一点整条链路静默失效。WS_POPUP 风格 + 不带 WS_VISIBLE 建窗 =
//! 不可见、不进任务栏、不抢焦点（从不 show）；GetMessage 循环随线程常驻，
//! 进程退出自然回收。

use std::sync::OnceLock;

use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, RegisterClassW,
    TranslateMessage, WNDCLASSW, WS_POPUP,
};
use windows::core::w;

const WM_DEVICECHANGE: u32 = 0x0219;
const DBT_DEVICEARRIVAL: usize = 0x8000;
const DBT_DEVICEREMOVECOMPLETE: usize = 0x8002;

static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "system" fn drive_wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_DEVICECHANGE
        && (wp.0 == DBT_DEVICEARRIVAL || wp.0 == DBT_DEVICEREMOVECOMPLETE)
        && let Some(app) = APP.get()
    {
        let _ = app.emit("drives-changed", ());
    }
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

/// 启动盘符监听线程（setup 调用一次；线程内建 message-only 窗口并驻留消息循环）
pub fn spawn_drive_watch(app: AppHandle) {
    let _ = APP.set(app);
    std::thread::Builder::new()
        .name("drive-watch".into())
        .spawn(|| unsafe {
            let Ok(hinstance) = GetModuleHandleW(None) else {
                return;
            };
            let class_name = w!("xdir-drive-watch");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(drive_wnd_proc),
                lpszClassName: class_name,
                hInstance: hinstance.into(),
                ..Default::default()
            };
            if RegisterClassW(&wc) == 0 {
                return;
            }
            // 普通隐藏顶层窗（WS_POPUP 且不带 WS_VISIBLE）：广播 WM_DEVICECHANGE
            // 只投递给顶层窗；从不 show 故不可见不抢焦点
            let hwnd = CreateWindowExW(
                Default::default(),
                class_name,
                w!("x-dir drive watch"),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(hinstance.into()),
                None,
            )
            .unwrap_or_default();
            if hwnd.is_invalid() {
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, Some(hwnd), 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .ok();
}
