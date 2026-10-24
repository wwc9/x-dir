// 截图与贴图（2026-10-24，§3.6）：热键 → xcap 定格光标所在显示器 → 全屏覆盖
// 窗（label "shot"）内选区/标注 → 复制（位图剪贴板）/ 保存（原生对话框）/
// 贴图（label "pin-*" 置顶窗）。会话数据流转全部走临时 PNG 文件 + asset
// protocol（scope **）加载，不经 IPC 传大图；会话窗销毁即清理自己的临时
// 文件，启动时清理上次会话残留。
//
// 坐标系约定：全链路物理像素（虚拟桌面坐标，左上显示器可为负）；前端把
// CSS 像素 × scale 还原为物理坐标后再回传，与定格截图逐像素对齐。

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

/// 会话/贴图临时文件目录（%TEMP%/xdir_shot）
pub(crate) fn shot_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("xdir_shot")
}

/// 启动清理：删掉上次会话/贴图残留的临时 PNG
pub fn cleanup_stale() {
    let _ = std::fs::remove_dir_all(shot_dir());
}

pub(crate) fn millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 前端 canvas.toDataURL 的 PNG dataURL → 原始 PNG 字节
fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let b64 = data_url
        .split_once("base64,")
        .map(|(_, b)| b)
        .unwrap_or(data_url);
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("PNG 数据解码失败：{e}"))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShotWindow {
    /// 本显示器相对物理坐标（原点 = 显示器左上角）
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotCapture {
    /// 定格截图 PNG 路径（前端经 asset protocol 加载）
    pub file: String,
    /// 显示器原点（虚拟桌面物理坐标）与物理尺寸
    pub mx: i32,
    pub my: i32,
    pub mw: u32,
    pub mh: u32,
    /// DPI 缩放（前端 CSS 像素 ↔ 物理像素换算）
    pub scale: f64,
    /// 可截窗口矩形（智能窗口识别，本显示器相对物理坐标）
    pub windows: Vec<ShotWindow>,
}

// ── Win32 窗口枚举（智能窗口识别）───────────────────────────────────────────

/// 枚举可截窗口（可见、未最小化、非 cloaked、非工具窗、根窗口、面积达标），
/// 返回虚拟桌面绝对物理坐标
fn enum_windows_abs() -> Vec<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GA_ROOT, GWL_EXSTYLE, GetAncestor, GetWindowLongPtrW, GetWindowRect, IsIconic,
        IsWindowVisible, WS_EX_TOOLWINDOW,
    };
    use windows::core::BOOL;
    struct Ctx {
        out: Vec<(i32, i32, i32, i32)>,
    }
    unsafe extern "system" fn proc_impl(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return BOOL(1);
            }
            // UWP 挂起/虚拟桌面隐藏的窗口在 DWM 层被 cloaked，截不到也点不到
            let mut cloaked: u32 = 0;
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
            .is_ok()
                && cloaked != 0
            {
                return BOOL(1);
            }
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 {
                return BOOL(1);
            }
            if GetAncestor(hwnd, GA_ROOT) != hwnd {
                return BOOL(1);
            }
            // 不排除本进程：枚举发生在覆盖窗创建之前，主窗/已贴图窗均应可截
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_err() {
                return BOOL(1);
            }
            let w = r.right - r.left;
            let h = r.bottom - r.top;
            // 过滤细微碎片窗（1px 占位/阴影窗等）
            if w < 24 || h < 24 {
                return BOOL(1);
            }
            ctx.out.push((r.left, r.top, w, h));
        }
        BOOL(1)
    }
    let mut ctx = Ctx { out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(proc_impl), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.out
}

/// 光标点所在显示器物理参数（找不到 = None，由调用方回落）
pub(crate) struct MonRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f32,
}

pub(crate) fn monitor_at(x: i32, y: i32) -> Option<MonRect> {
    for m in xcap::Monitor::all().ok()? {
        let (mx, my) = (m.x().ok()?, m.y().ok()?);
        let (mw, mh) = (m.width().ok()?, m.height().ok()?);
        if x >= mx && x < mx + mw as i32 && y >= my && y < my + mh as i32 {
            return Some(MonRect {
                x: mx,
                y: my,
                w: mw,
                h: mh,
                scale: m.scale_factor().unwrap_or(1.0),
            });
        }
    }
    None
}

// ── 截图会话 ────────────────────────────────────────────────────────────────

/// 定格光标所在显示器并打开全屏覆盖窗（热键回调与 shot_begin 命令共用）
fn begin_session(app: &AppHandle) -> Result<(), String> {
    // 连按热键：旧覆盖窗先行关闭（销毁事件会清临时文件，随后重建）
    if let Some(w) = app.get_webview_window("shot") {
        let _ = w.close();
    }
    let cur = app
        .cursor_position()
        .map_err(|e| format!("无法获取光标位置：{e}"))?;
    let (cx, cy) = (cur.x.round() as i32, cur.y.round() as i32);
    let mon = monitor_at(cx, cy).ok_or("未找到光标所在显示器")?;

    let img = xcap::Monitor::all()
        .map_err(|e| format!("显示器枚举失败：{e}"))?
        .into_iter()
        .find(|m| m.x().ok() == Some(mon.x) && m.y().ok() == Some(mon.y))
        .ok_or("未找到目标显示器")?
        .capture_image()
        .map_err(|e| format!("屏幕捕获失败：{e}"))?;

    let dir = shot_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let file = dir.join("session.png");
    img.save(&file).map_err(|e| format!("截图写盘失败：{e}"))?;

    let windows = enum_windows_abs()
        .into_iter()
        .map(|(x, y, w, h)| ShotWindow {
            x: x - mon.x,
            y: y - mon.y,
            w,
            h,
        })
        .collect();

    let cap = ShotCapture {
        file: file.to_string_lossy().into_owned(),
        mx: mon.x,
        my: mon.y,
        mw: mon.w,
        mh: mon.h,
        scale: mon.scale as f64,
        windows,
    };
    show_shot_window(app, &cap)
}

fn show_shot_window(app: &AppHandle, cap: &ShotCapture) -> Result<(), String> {
    let boot = serde_json::json!({
        "window": "shot",
        "file": cap.file,
        "mx": cap.mx,
        "my": cap.my,
        "mw": cap.mw,
        "mh": cap.mh,
        "scale": cap.scale,
        "windows": cap.windows,
    });
    let win = WebviewWindowBuilder::new(app, "shot", WebviewUrl::App("index.html".into()))
        .title("X-Dir 截图")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        .visible(false)
        .initialization_script(format!("window.__BOOT__ = {boot};"))
        .build()
        .map_err(|e| format!("创建截图窗口失败：{e}"))?;
    win.set_position(PhysicalPosition::new(cap.mx, cap.my))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(cap.mw, cap.mh))
        .map_err(|e| e.to_string())?;
    // 覆盖窗销毁（完成/取消）即清理会话定格文件
    let session_file = shot_dir().join("session.png");
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            let _ = std::fs::remove_file(&session_file);
        }
    });
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// 热键/菜单入口：开始一次截图会话
#[tauri::command]
pub fn shot_begin(app: AppHandle) -> Result<(), String> {
    begin_session(&app)
}

/// 关闭覆盖窗（完成/取消后的收尾）
#[tauri::command]
pub fn shot_close(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("shot") {
        let _ = w.close();
    }
    Ok(())
}

// ── 三个完成动作：复制 / 贴图 / 保存 ────────────────────────────────────────

#[tauri::command]
pub fn shot_copy(app: AppHandle, data_url: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let bytes = decode_data_url(&data_url)?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("PNG 解码失败：{e}"))?
        .to_rgba8();
    let (w, h) = img.dimensions();
    app.clipboard()
        .write_image(&tauri::image::Image::new_owned(img.into_raw(), w, h))
        .map_err(|e| format!("写入剪贴板失败：{e}"))
}

#[tauri::command]
pub fn shot_pin(
    app: AppHandle,
    data_url: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    if w < 8 || h < 8 || w > 20000 || h > 20000 {
        return Err("贴图尺寸非法".into());
    }
    let bytes = decode_data_url(&data_url)?;
    let dir = shot_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let ts = millis();
    let file = dir.join(format!("pin_{ts}.png"));
    std::fs::write(&file, &bytes).map_err(|e| format!("贴图写盘失败：{e}"))?;

    let label = format!("pin-{ts}");
    let scale = monitor_at(x + w / 2, y + h / 2)
        .map(|m| m.scale as f64)
        .unwrap_or(1.0);
    let boot = serde_json::json!({
        "window": "pin",
        "file": file.to_string_lossy(),
        "w": w,
        "h": h,
        "scale": scale,
    });
    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("X-Dir 贴图")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        .focused(false)
        .visible(false)
        .initialization_script(format!("window.__BOOT__ = {boot};"))
        .build()
        .map_err(|e| format!("创建贴图窗口失败：{e}"))?;
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(w as u32, h as u32))
        .map_err(|e| e.to_string())?;
    let pin_file = file.clone();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            let _ = std::fs::remove_file(&pin_file);
        }
    });
    // 贴图不抢焦点（Snipaste 惯例）：贴完继续手头工作
    win.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存为文件：原生保存对话框（阻塞版跑在 blocking 线程）→ 写盘，返回路径
/// （用户取消 = null）
#[tauri::command]
pub async fn shot_save_data(app: AppHandle, data_url: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let bytes = decode_data_url(&data_url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let name = format!("截图_{}.png", local_stamp());
        let picked = app
            .dialog()
            .file()
            .add_filter("PNG 图片", &["png"])
            .set_file_name(&name)
            .blocking_save_file();
        let Some(p) = picked else {
            return Ok(None);
        };
        let path = p.into_path().map_err(|e| format!("路径解析失败：{e}"))?;
        std::fs::write(&path, &bytes).map_err(|e| format!("保存失败：{e}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("保存线程失败：{e}"))?
}

/// 本地时间戳 yyyymmdd_hhmmss（GetLocalTime，免 chrono；同 fs 模块口径）
pub(crate) fn local_stamp() -> String {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::SYSTEMTIME;
        use windows::Win32::System::SystemInformation::GetLocalTime;
        let st: SYSTEMTIME = unsafe { GetLocalTime() };
        format!(
            "{:04}{:02}{:02}_{:02}{:02}{:02}",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
        )
    }
    #[cfg(not(windows))]
    {
        millis().to_string()
    }
}

// ── 全局热键 ────────────────────────────────────────────────────────────────

/// 注册/更新截图全局热键（前端启动与设置变更时调用；返回 Err = 键被占用）
#[tauri::command]
pub fn shot_register_hotkey(app: AppHandle, enabled: bool, hotkey: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if !enabled {
        return Ok(());
    }
    let sc: Shortcut = hotkey
        .to_lowercase()
        .parse()
        .map_err(|_| format!("无法识别快捷键「{hotkey}」"))?;
    gs.on_shortcut(sc, |app, _sc, event| {
        if event.state == ShortcutState::Pressed
            && let Err(e) = begin_session(app)
        {
            log::error!("截图启动失败：{e}");
        }
    })
    .map_err(|e| format!("快捷键「{hotkey}」注册失败（可能被其他程序占用）：{e}"))
}
