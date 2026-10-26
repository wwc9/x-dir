// 截图与贴图（2026-10-24，§3.6）：热键 → xcap 定格光标所在显示器 → 全屏覆盖
// 窗（label "shot"）内选区/标注 → 复制（位图剪贴板）/ 保存（原生对话框）/
// 贴图（label "pin-*" 置顶窗）。会话数据流转走临时 BMP 文件 + asset
// protocol（scope **）加载，不经 IPC 传大图；捕获+编码在后台线程
// （SESSION_STARTING 门闸拦连按），主线程只建窗；覆盖窗销毁即清理自己的
// 临时文件，失焦自动收场（保存对话框期间豁免），启动时清理上次会话残留。
//
// 坐标系约定：全链路物理像素（虚拟桌面坐标，左上显示器可为负）；前端把
// CSS 像素 × scale 还原为物理坐标后再回传，与定格截图逐像素对齐。

use base64::Engine as _;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

/// 会话/贴图临时文件目录（%TEMP%/xdir_shot）
pub(crate) fn shot_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("xdir_shot")
}

/// 运行时建窗必须与 tauri.conf.json 主窗口的 additionalBrowserArgs 完全一致：
/// WebView2 每进程每 user-data-folder 只允许一个 Environment，第二个环境
/// 参数不同即失败（0x8007139F「组或资源的状态不正确」）——截图/贴图/滚动
/// 各窗曾因此全部无法创建。改 conf 时必须同步此处。
pub(crate) const WEBVIEW_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion";

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
    /// 定格截图 BMP 路径（前端经 asset protocol 加载）
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

/// 捕获+建窗进行中标记：拦截连按（begin_session 只在主线程跑，load/store 无竞争）
static SESSION_STARTING: AtomicBool = AtomicBool::new(false);
/// 原生保存对话框打开中：对话框会抢走系统焦点，此时豁免覆盖窗的失焦自毁
static SAVE_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);
/// 覆盖窗内容首帧已上屏（前端 shot_ready 回执）：失焦自毁仅在此之后生效
static SHOT_VISIBLE: AtomicBool = AtomicBool::new(false);

/// 热键/菜单入口：开始一次截图会话。
/// 捕获+编码在后台线程，主线程只做建窗——在 WndProc 里内联跑 500ms 的
/// 捕获会冻结整个应用，且 build() 泵消息期间排队的 WM_HOTKEY 会重入
/// begin_session、对建到一半的窗口 close()（卡死与 double-fire 的根源）。
/// begin_session 必须在主线程调用（热键 WndProc / shot_begin 派发均满足）。
fn begin_session(app: &AppHandle) {
    // 捕获/建窗进行中：连按忽略
    if SESSION_STARTING.load(Ordering::SeqCst) {
        return;
    }
    // 覆盖窗已开 = 本拍收掉旧会话（销毁钩子清临时文件），再按即全新会话
    if let Some(w) = app.get_webview_window("shot") {
        let _ = w.close();
        return;
    }
    SESSION_STARTING.store(true, Ordering::SeqCst);
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("shot-capture".into())
        .spawn(move || match capture_session(&app) {
            Ok(cap) => {
                let app2 = app.clone();
                let dispatch = app.run_on_main_thread(move || {
                    if let Err(e) = show_shot_window(&app2, &cap) {
                        log::error!("截图启动失败：{e}");
                    }
                    SESSION_STARTING.store(false, Ordering::SeqCst);
                });
                if let Err(e) = dispatch {
                    log::error!("截图任务派发失败：{e}");
                    SESSION_STARTING.store(false, Ordering::SeqCst);
                }
            }
            Err(e) => {
                log::error!("截图启动失败：{e}");
                SESSION_STARTING.store(false, Ordering::SeqCst);
            }
        });
    if let Err(e) = spawned {
        SESSION_STARTING.store(false, Ordering::SeqCst);
        log::error!("截图启动失败：捕获线程启动失败：{e}");
    }
}

/// 后台线程：定格光标所在显示器 + 写会话图 + 枚举可截窗口
fn capture_session(app: &AppHandle) -> Result<ShotCapture, String> {
    let cur = app
        .cursor_position()
        .map_err(|e| format!("无法获取光标位置：{e}"))?;
    let (cx, cy) = (cur.x.round() as i32, cur.y.round() as i32);
    let mon = monitor_at(cx, cy).ok_or("未找到光标所在显示器")?;
    let t0 = std::time::Instant::now();

    let img = xcap::Monitor::all()
        .map_err(|e| format!("显示器枚举失败：{e}"))?
        .into_iter()
        .find(|m| m.x().ok() == Some(mon.x) && m.y().ok() == Some(mon.y))
        .ok_or("未找到目标显示器")?
        .capture_image()
        .map_err(|e| format!("屏幕捕获失败：{e}"))?;
    log::debug!("截图计时：捕获 {}ms", t0.elapsed().as_millis());

    let dir = shot_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    // BMP 而非 PNG：4K PNG 编码 ~2s（感知延迟大头），BMP 编码≈memcpy 级，
    // 浏览器解码同为原生快路径；文件仅作会话内传递，销毁即清
    let file = dir.join("session.bmp");
    img.save(&file).map_err(|e| format!("截图写盘失败：{e}"))?;
    log::debug!("截图计时：BMP 写盘 {}ms", t0.elapsed().as_millis());

    let windows = enum_windows_abs()
        .into_iter()
        .map(|(x, y, w, h)| ShotWindow {
            x: x - mon.x,
            y: y - mon.y,
            w,
            h,
        })
        .collect();

    Ok(ShotCapture {
        file: file.to_string_lossy().into_owned(),
        mx: mon.x,
        my: mon.y,
        mw: mon.w,
        mh: mon.h,
        scale: mon.scale as f64,
        windows,
    })
}

fn show_shot_window(app: &AppHandle, cap: &ShotCapture) -> Result<(), String> {
    let t_show = std::time::Instant::now();
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
        .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
        .title("X-Dir 截图")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        // 不可见窗口默认 focused(true) 在部分 WebView2 上聚焦异常（wry#1798）；
        // show() 后再 set_focus()，保险起见显式关闭
        .focused(false)
        .visible(false)
        .initialization_script(format!("window.__BOOT__ = {boot};"))
        .build()
        .map_err(|e| format!("创建截图窗口失败：{e}"))?;
    log::debug!("截图计时：建窗 {}ms", t_show.elapsed().as_millis());
    win.set_position(PhysicalPosition::new(cap.mx, cap.my))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(cap.mw, cap.mh))
        .map_err(|e| e.to_string())?;
    // 覆盖窗销毁（完成/取消）即清理会话定格文件；失焦自动收会话（QQ 惯例）：
    // 全屏置顶黑罩失焦后 Esc/Enter 全部失效，留在屏上形同卡死。仅在内容
    // 首帧上屏（SHOT_VISIBLE）后生效；保存对话框抢焦点时豁免
    let session_file = shot_dir().join("session.bmp");
    let w2 = win.clone();
    win.on_window_event(move |e| match e {
        tauri::WindowEvent::Destroyed => {
            let _ = std::fs::remove_file(&session_file);
        }
        // 保存对话框抢焦点时豁免
        tauri::WindowEvent::Focused(false)
            if SHOT_VISIBLE.load(Ordering::SeqCst) && !SAVE_DIALOG_OPEN.load(Ordering::SeqCst) =>
        {
            let _ = w2.close();
        }
        _ => {}
    });
    // 不在此处 show：此刻 webview 还是空内容，提前 show 会闪黑屏。
    // 前端首帧绘制完成后经 shot_ready 回执再显示；4s 兜底防前端加载
    // 失败时窗口永远不可见（hotkey 的 toggle 语义也能收拾这种残局）
    SHOT_VISIBLE.store(false, Ordering::SeqCst);
    let app3 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        if let Some(w) = app3.get_webview_window("shot") {
            let _ = w.show();
            let _ = w.set_focus();
            SHOT_VISIBLE.store(true, Ordering::SeqCst);
        }
    });
    Ok(())
}

/// 覆盖窗/贴图窗/结果窗内容首帧就绪后由前端调用：此刻才真正 show——
/// 提前 show 出来的是未渲染的空 WebView2（Windows 上呈黑底，即「黑屏」）
#[tauri::command]
pub fn shot_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "shot" || label == "shot-result" || label.starts_with("pin-") {
        window.show().map_err(|e| e.to_string())?;
        if label == "shot" {
            SHOT_VISIBLE.store(true, Ordering::SeqCst);
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 热键/菜单入口：开始一次截图会话（异步派发，立即返回）
#[tauri::command]
pub async fn shot_begin(app: AppHandle) -> Result<(), String> {
    // begin_session 依赖主线程串行（SESSION_STARTING 的 load/store 无锁假设）
    let app2 = app.clone();
    app.run_on_main_thread(move || begin_session(&app2))
        .map_err(|e| format!("截图任务派发失败：{e}"))
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
        .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
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
    SAVE_DIALOG_OPEN.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let name = format!("截图_{}.png", local_stamp());
        let picked = app
            .dialog()
            .file()
            .add_filter("PNG 图片", &["png"])
            .set_file_name(&name)
            .blocking_save_file();
        // 对话框已收场，解除覆盖窗失焦豁免
        SAVE_DIALOG_OPEN.store(false, Ordering::SeqCst);
        match picked {
            None => Ok(None),
            Some(p) => {
                let path = p.into_path().map_err(|e| format!("路径解析失败：{e}"))?;
                std::fs::write(&path, &bytes).map_err(|e| format!("保存失败：{e}"))?;
                Ok(Some(path.to_string_lossy().into_owned()))
            }
        }
    })
    .await
    .map_err(|e| {
        SAVE_DIALOG_OPEN.store(false, Ordering::SeqCst);
        format!("保存线程失败：{e}")
    })?
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
        if event.state == ShortcutState::Pressed {
            begin_session(app);
        }
    })
    .map_err(|e| {
        // App.tsx 启动路径对注册失败静默 catch，这里必须留痕可查
        log::warn!("截图热键注册失败：{e}");
        format!("快捷键「{hotkey}」注册失败（可能被其他程序占用）：{e}")
    })
}
