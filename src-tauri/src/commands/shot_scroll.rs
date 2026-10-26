// 滚动长截图（§3.6 二期 B 批，2026-10-24）：框选滚动区 → 覆盖窗隐藏、弹控制
// 浮条窗（label "shot-scroll"）→ Rust 循环〔光标悬停选区中心 + SendInput 滚轮
// 注入 → 稳定延时 → xcap capture_region 实时捕获 → 上一帧下部窄竖条灰度 SAD
// 匹配求纵向位移 → 追加新内容〕→ 到底 / 用户完成 / 高度上限收尾 → 长图存临时
// 盘 → 结果窗（label "shot-result"：复制 / 保存 / 贴图 / 关闭）。拼接算法
// 自研（ShareX 思路，未读 GPL 实现）；首版不含固定栏自动检测与视差修复，
// 动态内容（动画/加载条）连续两帧无法匹配即诚实截断并在结果窗提示。
//
// 会话状态：单会话静态标志（0=滚动中 1=请求完成 2=请求取消），begin 时重置；
// 循环跑独立 std::thread，经事件 shot-scroll-progress 推送已捕获高度。

use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use image::RgbaImage;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

use super::shot::{MonRect, local_stamp, millis, monitor_at, shot_dir};

/// 长图高度上限（物理像素，§3.6 定案 20000）
const MAX_H: u32 = 20000;
/// 每帧滚轮注入后的稳定等待：等页面滚动动画与渲染完成
const SETTLE: Duration = Duration::from_millis(320);
/// 到底判定：位移连续为 0 的帧数
const BOTTOM_STREAK: u32 = 3;
/// 动态内容判定：匹配连续失败的帧数（单次失败先跳过再试）
const BAD_STREAK: u32 = 2;

/// 0=滚动中 1=请求完成（用已拼内容出结果）2=请求取消（丢弃）
static SCROLL_FLAG: AtomicU8 = AtomicU8::new(0);

// ── 滚轮注入 ────────────────────────────────────────────────────────────────

/// 向光标下窗口注入一格向下滚动（Win10+ 默认"悬停滚动非活动窗口"；
/// mouseData 负值 = 朝用户方向滚 = 露出下方新内容）
fn send_wheel_down() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput,
    };
    let inp = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: (-120i32) as u32,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[inp], std::mem::size_of::<INPUT>() as i32);
    }
}

// ── 纵向位移匹配（灰度 SAD 模板匹配，自研）────────────────────────────────

/// 求 cur 相对 prev 的上移量 dy：prev[y] 的内容出现在 cur[y-dy]，新内容 =
/// cur 底部 [h-dy..h)。模板取 prev 下部两条窄竖条（左右 1/4 处，规避开居中
/// 的 sticky header / 加载条），灰度 + 隔点采样后做 SAD；最小 SAD 超阈值 =
/// 置信不足（动态内容干扰），返回 None。
fn match_scroll_dy(prev: &RgbaImage, cur: &RgbaImage) -> Option<u32> {
    let (w, h) = (prev.width(), prev.height());
    if cur.width() != w || cur.height() != h {
        return None;
    }
    /// 模板条宽（物理像素）
    const TW: u32 = 48;
    // 模板条高 = 帧高 1/3（取 prev 下部：滚动后仍在画面内的区域）
    let th = h / 3;
    if th < 40 {
        return None;
    }
    let gray = |img: &RgbaImage, x: u32, y: u32| -> i32 {
        let p = img.get_pixel(x, y).0;
        (i32::from(p[0]) * 299 + i32::from(p[1]) * 587 + i32::from(p[2]) * 114) / 1000
    };
    let xs = [w / 4 - TW / 2, w * 3 / 4 - TW / 2];
    let max_dy = (h - th).min(h / 2);
    let mut best_dy = 0u32;
    let mut best_sad = f32::MAX;
    for dy in 0..=max_dy {
        let mut total = 0i64;
        let mut cnt = 0i64;
        for &tx in &xs {
            for y in (h - th..h).step_by(3) {
                let cy = y - dy;
                for x in (tx..tx + TW).step_by(4) {
                    total += i64::from((gray(prev, x, y) - gray(cur, x, cy)).abs());
                    cnt += 1;
                }
            }
        }
        let sad = total as f32 / cnt as f32;
        if sad < best_sad {
            best_sad = sad;
            best_dy = dy;
        }
    }
    // 阈值 16/255 ≈ 6% 平均灰度差：页面噪声可过，明显换内容拒绝
    if best_sad > 16.0 {
        return None;
    }
    Some(best_dy)
}

/// 累积画布：预分配 MAX_H 高度的行缓冲，逐帧尾部追加，免整图反复搬运
struct CanvasBuf {
    w: u32,
    h: u32,
    buf: Vec<u8>,
}

impl CanvasBuf {
    fn new(w: u32) -> Self {
        Self {
            w,
            h: 0,
            buf: Vec::with_capacity(w as usize * MAX_H as usize * 4),
        }
    }

    /// 追加 frame 的 [from..height) 行
    fn push(&mut self, frame: &RgbaImage, from: u32) {
        let fw = frame.width();
        debug_assert_eq!(fw, self.w);
        for y in from..frame.height() {
            let row = &frame.as_raw()[(y * fw * 4) as usize..][..(fw * 4) as usize];
            self.buf.extend_from_slice(row);
        }
        self.h += frame.height() - from;
    }

    fn to_image(&self) -> Option<RgbaImage> {
        RgbaImage::from_raw(
            self.w,
            self.h,
            self.buf[..(self.w * self.h * 4) as usize].to_vec(),
        )
    }
}

// ── 会话入口 ────────────────────────────────────────────────────────────────

/// 开始滚动会话：rx/ry/rw/rh = 选区显示器相对物理坐标；mx/my = 显示器原点。
/// 第一帧从会话定格图（session.bmp）裁剪，此后 capture_region 捕获实时屏幕。
#[tauri::command]
pub fn shot_scroll_begin(
    app: AppHandle,
    rx: i32,
    ry: i32,
    rw: i32,
    rh: i32,
    mx: i32,
    my: i32,
) -> Result<(), String> {
    if app.get_webview_window("shot-scroll").is_some() {
        return Err("滚动截图进行中".into());
    }
    if rw < 96 || rh < 80 {
        return Err("选区太小，请框选更大的滚动区域".into());
    }
    let mon = monitor_at(mx, my).ok_or("未找到目标显示器")?;
    if rx < 0 || ry < 0 || rx + rw > mon.w as i32 || ry + rh > mon.h as i32 {
        return Err("选区超出显示器范围".into());
    }
    // 第一帧 = 定格图裁剪（此刻覆盖窗显示的就是原始画面）
    let session = shot_dir().join("session.bmp");
    let base: RgbaImage = image::open(&session)
        .map_err(|e| format!("读取会话截图失败：{e}"))?
        .crop_imm(rx as u32, ry as u32, rw as u32, rh as u32)
        .to_rgba8();

    // 覆盖窗退场（其销毁钩子会清 session.bmp，base 已在内存不受影响）
    if let Some(w) = app.get_webview_window("shot") {
        let _ = w.close();
    }
    // 光标悬停选区中心：滚轮事件落点 = 目标窗口（Win10+ 悬停滚动）
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
        let _ = SetCursorPos(mx + rx + rw / 2, my + ry + rh / 2);
    }
    std::thread::sleep(Duration::from_millis(120));

    SCROLL_FLAG.store(0, Ordering::Relaxed);
    show_scrollbar_window(&app, &mon)?;

    let app2 = app.clone();
    std::thread::spawn(move || {
        scroll_loop(app2, mon, rw as u32, rh as u32, rx as u32, ry as u32, base);
    });
    Ok(())
}

/// 滚动拼接主循环（独立线程）：注入 → 稳定 → 捕获 → 匹配 → 追加
fn scroll_loop(app: AppHandle, mon: MonRect, rw: u32, rh: u32, rx: u32, ry: u32, base: RgbaImage) {
    let mon_obj = xcap::Monitor::all().ok().and_then(|all| {
        all.into_iter()
            .find(|m| m.x().ok() == Some(mon.x) && m.y().ok() == Some(mon.y))
    });
    let Some(monitor) = mon_obj else {
        end_scroll(&app, mon, None, false);
        return;
    };
    let mut canvas = CanvasBuf::new(rw);
    canvas.push(&base, 0);
    let mut last = base;
    let mut zero_streak = 0u32;
    let mut bad_streak = 0u32;
    let mut truncated = false;
    emit_height(&app, canvas.h);
    loop {
        if SCROLL_FLAG.load(Ordering::Relaxed) != 0 || canvas.h >= MAX_H {
            truncated = canvas.h >= MAX_H;
            break;
        }
        send_wheel_down();
        std::thread::sleep(SETTLE);
        let frame = monitor.capture_region(rx, ry, rw, rh);
        let Ok(frame) = frame else {
            bad_streak += 1;
            if bad_streak >= BAD_STREAK {
                truncated = true;
                break;
            }
            continue;
        };
        match match_scroll_dy(&last, &frame) {
            Some(dy) if dy >= 2 => {
                zero_streak = 0;
                bad_streak = 0;
                canvas.push(&frame, dy);
                last = frame;
                emit_height(&app, canvas.h);
            }
            Some(_) => {
                // 0/1px：视作未滚动（到底或滚动被拦截）
                zero_streak += 1;
                if zero_streak >= BOTTOM_STREAK {
                    break;
                }
            }
            None => {
                bad_streak += 1;
                if bad_streak >= BAD_STREAK {
                    truncated = true;
                    break;
                }
            }
        }
    }
    if SCROLL_FLAG.load(Ordering::Relaxed) == 2 {
        // 取消：丢弃，不出结果
        return;
    }
    match canvas.to_image() {
        Some(img) => end_scroll(&app, mon, Some(img), truncated),
        None => end_scroll(&app, mon, None, false),
    }
}

fn emit_height(app: &AppHandle, height: u32) {
    let _ = app.emit_to(
        "shot-scroll",
        "shot-scroll-progress",
        serde_json::json!({ "height": height }),
    );
}

/// 收尾：关浮条窗，长图存临时盘后开结果窗
fn end_scroll(app: &AppHandle, mon: MonRect, img: Option<RgbaImage>, truncated: bool) {
    if let Some(w) = app.get_webview_window("shot-scroll") {
        let _ = w.close();
    }
    let Some(img) = img else { return };
    let dir = shot_dir();
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join(format!("scroll_{}.png", millis()));
    if let Err(e) = img.save(&file) {
        log::error!("滚动长图写盘失败：{e}");
        return;
    }
    let (w, h) = img.dimensions();
    if let Err(e) = show_result_window(app, &file, w, h, truncated, &mon) {
        log::error!("打开滚动结果窗失败：{e}");
    }
}

// ── 浮条窗 / 结果窗 ─────────────────────────────────────────────────────────

fn show_scrollbar_window(app: &AppHandle, mon: &MonRect) -> Result<(), String> {
    const BW: f64 = 356.0;
    const BH: f64 = 42.0;
    let s = f64::from(mon.scale);
    let boot = serde_json::json!({ "window": "scrollbar" });
    let win = WebviewWindowBuilder::new(app, "shot-scroll", WebviewUrl::App("index.html".into()))
        .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
        .title("X-Dir 滚动截图")
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
        .map_err(|e| format!("创建滚动浮条窗失败：{e}"))?;
    let (w, h) = ((BW * s).round() as i32, (BH * s).round() as i32);
    win.set_position(PhysicalPosition::new(
        mon.x + (mon.w as i32 - w) / 2,
        mon.y + mon.h as i32 - h - (32.0 * s).round() as i32,
    ))
    .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(w as u32, h as u32))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

fn show_result_window(
    app: &AppHandle,
    file: &Path,
    w: u32,
    h: u32,
    truncated: bool,
    mon: &MonRect,
) -> Result<(), String> {
    let s = f64::from(mon.scale);
    // 结果窗 fit：宽 ≤ 72% 屏宽，高 ≤ 72% 屏高（先按比例缩到双约束内）
    let dw = (f64::from(w))
        .min(f64::from(mon.w) * 0.72)
        .min(f64::from(w) * (f64::from(mon.h) * 0.72) / f64::from(h));
    let dh = f64::from(h) * dw / f64::from(w);
    let pw = (dw * s).round() as i32;
    let ph = (dh * s).round() as i32;
    let boot = serde_json::json!({
        "window": "result",
        "file": file.to_string_lossy(),
        "w": w,
        "h": h,
        "truncated": truncated,
    });
    let win = WebviewWindowBuilder::new(app, "shot-result", WebviewUrl::App("index.html".into()))
        .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
        .title("X-Dir 滚动长图")
        .decorations(true)
        .resizable(true)
        .minimizable(true)
        .maximizable(true)
        .skip_taskbar(false)
        .always_on_top(true)
        // 不可见建窗显式 focused(false)（wry#1798）
        .focused(false)
        .visible(false)
        .initialization_script(format!("window.__BOOT__ = {boot};"))
        .build()
        .map_err(|e| format!("创建结果窗失败：{e}"))?;
    win.set_position(PhysicalPosition::new(
        mon.x + (mon.w as i32 - pw) / 2,
        mon.y + (mon.h as i32 - ph) / 2,
    ))
    .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(pw as u32, ph as u32))
        .map_err(|e| e.to_string())?;
    let scroll_file = file.to_path_buf();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            let _ = std::fs::remove_file(&scroll_file);
        }
    });
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

// ── 浮条/结果窗的命令 ───────────────────────────────────────────────────────

/// 浮条按钮：finish = 用已拼内容出结果；cancel = 丢弃结束
#[tauri::command]
pub fn shot_scroll_control(action: String) -> Result<(), String> {
    match action.as_str() {
        "finish" => SCROLL_FLAG.store(1, Ordering::Relaxed),
        "cancel" => SCROLL_FLAG.store(2, Ordering::Relaxed),
        _ => return Err("未知操作".into()),
    }
    Ok(())
}

/// 结果窗：长图写入剪贴板（大图解码放 blocking 线程）
#[tauri::command]
pub async fn shot_result_copy(app: AppHandle, file: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&file)
            .map_err(|e| format!("读取长图失败：{e}"))?
            .to_rgba8();
        let (w, h) = img.dimensions();
        app.clipboard()
            .write_image(&tauri::image::Image::new_owned(img.into_raw(), w, h))
            .map_err(|e| format!("写入剪贴板失败：{e}"))
    })
    .await
    .map_err(|e| format!("复制线程失败：{e}"))?
}

/// 结果窗：原生保存对话框（默认名 `滚动截图_时间戳.png`），用户取消 = null
#[tauri::command]
pub async fn shot_result_save(app: AppHandle, file: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&file).map_err(|e| format!("读取长图失败：{e}"))?;
        let picked = app
            .dialog()
            .file()
            .add_filter("PNG 图片", &["png"])
            .set_file_name(format!("滚动截图_{}.png", local_stamp()))
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

/// 结果窗：长图贴到屏幕（复制专属副本，pin 窗销毁即清；初始按 80% 屏幅适配）
#[tauri::command]
pub fn shot_pin_file(app: AppHandle, file: String, cx: i32, cy: i32) -> Result<(), String> {
    let (w, h) = image::image_dimensions(&file).map_err(|e| format!("读取长图尺寸失败：{e}"))?;
    let mon = monitor_at(cx, cy).ok_or("未找到目标显示器")?;
    let s = f64::from(mon.scale);
    let fit = (f64::from(mon.w) * 0.8 / f64::from(w))
        .min(f64::from(mon.h) * 0.8 / f64::from(h))
        .min(1.0);
    let dw = (f64::from(w) * fit).round() as i32;
    let dh = (f64::from(h) * fit).round() as i32;

    let ts = millis();
    let dst = shot_dir().join(format!("pin_{ts}.png"));
    std::fs::copy(&file, &dst).map_err(|e| format!("贴图副本创建失败：{e}"))?;

    let label = format!("pin-{ts}");
    let boot = serde_json::json!({
        "window": "pin",
        "file": dst.to_string_lossy(),
        "w": w,
        "h": h,
        "scale": s,
        "zoom": fit,
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
    win.set_position(PhysicalPosition::new(cx - dw / 2, cy - dh / 2))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(dw as u32, dh as u32))
        .map_err(|e| e.to_string())?;
    let pin_file = dst.clone();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            let _ = std::fs::remove_file(&pin_file);
        }
    });
    win.show().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// 确定性竖向纹理（可分辨 10px 级位移）
    fn pattern(x: u32, y: u32, seed: u32) -> u8 {
        ((x * 7 + y * 13 + seed * 61) % 251) as u8
    }

    fn img(w: u32, h: u32, seed: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([pattern(x, y, seed), 128, 64, 255]))
    }

    #[test]
    fn match_scroll_dy_finds_shift() {
        // cur = prev 内容整体上移 60px（prev[y] 出现在 cur[y-60]，底部 60px 新内容）
        let prev = img(200, 200, 0);
        let mut cur = img(200, 200, 9); // 底部新内容区用不同纹理
        for y in 0..140u32 {
            for x in 0..200u32 {
                cur.put_pixel(x, y, *prev.get_pixel(x, y + 60));
            }
        }
        assert_eq!(match_scroll_dy(&prev, &cur), Some(60));
    }

    #[test]
    fn match_scroll_dy_bottom_is_zero() {
        let prev = img(200, 200, 0);
        let cur = prev.clone();
        assert_eq!(match_scroll_dy(&prev, &cur), Some(0));
    }

    #[test]
    fn match_scroll_dy_rejects_dynamic_content() {
        // 完全不相关的两帧（动态内容/换页）：置信不足应返回 None
        let prev = RgbaImage::from_pixel(200, 200, Rgba([128, 128, 128, 255]));
        let cur = img(200, 200, 3);
        assert_eq!(match_scroll_dy(&prev, &cur), None);
    }

    #[test]
    fn match_scroll_dy_too_small_frame() {
        // 帧高不足（th < 40）无法匹配
        let a = img(200, 60, 0);
        let b = img(200, 60, 1);
        assert_eq!(match_scroll_dy(&a, &b), None);
    }

    #[test]
    fn canvas_buf_appends_and_roundtrips() {
        let mut c = CanvasBuf::new(4);
        let f1 = img(4, 3, 0);
        let f2 = img(4, 3, 1);
        c.push(&f1, 0);
        c.push(&f2, 2); // 追加 f2 的第 2 行起
        assert_eq!(c.h, 3 + 1);
        let out = c.to_image().unwrap();
        assert_eq!(out.dimensions(), (4, 4));
        assert_eq!(out.get_pixel(0, 3), f2.get_pixel(0, 2));
        assert_eq!(out.get_pixel(2, 0), f1.get_pixel(2, 0));
    }
}
