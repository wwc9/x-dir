// 截图与贴图（§3.6，2026-10-27 性能重构）：常驻覆盖窗 + 快路径会话。
// 覆盖窗（label "shot"）在应用启动后 2.5s 预热建好并常驻隐藏（页面 idle 待命，
// 监听 shot-session 事件），热键按下只做「DXGI 捕获 → BMP 落盘 → 事件下发 →
// 前端贴图回执 shot_ready → show」，砍掉旧方案每次建窗 + webview 冷启动的
// ~600ms；捕获换 DXGI Desktop Duplication（shot_dxgi，失败回落 xcap），
// 感知延迟从 ~1.2s 降到 ~300ms 内（log::info「截图感知延迟」实测）。
// 贴图（label "pin-*"）置顶窗 / 滚动浮条 / 结果窗仍按需建窗，但统一加载
// 轻量入口 shot.html（不再加载完整文件管理器 bundle）。
//
// 会话定格帧走内存直传：捕获后留在 SESSION_FRAME，前端经 shot_frame 命令
// 以 IPC 二进制（tauri::ipc::Response）拿 RGBA 原始字节 putImageData 直绘，
// 不经 BMP 落盘/asset 协议/浏览器解码（2026-10-27 感知延迟二期）。捕获+
// 编码在后台线程（SESSION_STARTING 门闸拦连按），主线程只做定位与事件下发。
// 会话收场 = 停靠常驻窗到屏幕外（不销毁、不隐藏），热键重按 = 就地重拍
// （先撤蒙层再捕获，PixPin 惯例）；失焦自动收场（保存对话框期间豁免）；
// 启动时清理上次会话残留。
//
// 防闪核心（PixPin/snow-shot 口径「内容先于窗口可见」）：常驻覆盖窗**从不
// SW_HIDE**——隐藏窗口期间 WebView2 的 DirectComposition 提交不进 DWM 场景，
// show 瞬间只能呈现旧白面（闪一帧白，2026-10-27 复检确认）。收场改为停靠在
// 虚拟桌面外（Win32 可见、rAF 全速、合成器不离场），会话内容（定格图+蒙层）
// 在屏幕外呈现完毕后 set_position 一次原子上屏，DWM 直接拿到最终 surface，
// 零空白帧。
//
// 坐标系约定：全链路物理像素（虚拟桌面坐标，左上显示器可为负）；前端把
// CSS 像素 × scale 还原为物理坐标后再回传，与定格截图逐像素对齐。

use base64::Engine as _;
use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

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
    /// 显示器原点（虚拟桌面物理坐标）与物理尺寸
    pub mx: i32,
    pub my: i32,
    pub mw: u32,
    pub mh: u32,
    /// DPI 缩放（前端 CSS 像素 ↔ 物理像素换算）
    pub scale: f64,
    /// 会话序号（millis；前端常驻覆盖窗以此为 key 重挂 ShotOverlay）
    pub seq: u64,
    /// 定格时光标位置（显示器相对物理像素；前端默认预选光标下窗口）
    pub cx: i32,
    pub cy: i32,
    /// 可截窗口矩形（智能窗口识别，本显示器相对物理坐标）
    pub windows: Vec<ShotWindow>,
}

// ── Win32 窗口枚举（可截目标判定）───────────────────────────────────────────

/// 枚举候选窗口（z 序 = 前→后，EnumWindows 天然顺序）：可见、未最小化、非
/// cloaked、非工具窗、根窗口、碎片窗过滤，且只收与目标显示器相交的（其他
/// 显示器上的窗口对本次会话无意义）。是否真正露出屏幕（遮挡剔除）由
/// `visible_shot_targets` 的纯函数判定。
fn enum_windows_abs(mon: (i32, i32, i32, i32)) -> Vec<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GA_ROOT, GWL_EXSTYLE, GetAncestor, GetWindowLongPtrW, GetWindowRect, IsIconic,
        IsWindowVisible, WS_EX_TOOLWINDOW,
    };
    use windows::core::BOOL;
    struct Ctx {
        mon: (i32, i32, i32, i32),
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
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_err() {
                return BOOL(1);
            }
            // 只收与目标显示器相交的（其他显示器的窗口对本次会话无意义）；
            // 覆盖窗自身带 WS_EX_TOOLWINDOW 不会入列，主窗/贴图窗不排除
            let (mx, my, mw, mh) = ctx.mon;
            if r.right <= mx || r.left >= mx + mw || r.bottom <= my || r.top >= my + mh {
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
    let mut ctx = Ctx {
        mon,
        out: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(proc_impl), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.out
}

/// 可截目标判定（PixPin 口径）：只认「最前面可见层」——按 z 序从最前往后
/// 逐个做可见区域减法（矩形集合），只有真正露出屏幕的部分达标（存在 ≥8×8
/// 的可见块）的窗口才入列，被完全盖住的后层窗口不再出现；候选末尾追加整
/// 个显示器矩形（桌面兜底 = 最大区域）。任务栏本身是可见的顶层窗口，随减
/// 法自然入列。z_windows 必须按 z 序（前→后）排列（EnumWindows 天然顺序），
/// 坐标为虚拟桌面绝对物理像素；返回按 z 序排列、显示器相对坐标，末行为桌
/// 面兜底（前端 hitWindow 顺序命中时桌面自然最后）。
fn visible_shot_targets(
    z_windows: &[(i32, i32, i32, i32)],
    mon: (i32, i32, i32, i32),
) -> Vec<ShotWindow> {
    let (mx, my, mw, mh) = mon;
    // 未被任何更前层窗口盖住的桌面可见区域（互不重叠的矩形集合），初始 =
    // 整个显示器
    let mut region: Vec<(i32, i32, i32, i32)> = vec![(mx, my, mw, mh)];
    let mut out = Vec::new();
    for &(wx, wy, ww, wh) in z_windows {
        // 裁剪到本显示器（跨屏窗口的域外部分不参与遮挡运算）
        let l = wx.max(mx);
        let t = wy.max(my);
        let r = (wx + ww).min(mx + mw);
        let b = (wy + wh).min(my + mh);
        if r - l < 8 || b - t < 8 {
            continue;
        }
        // 可见块 = 窗口矩形 ∩ 剩余区域；存在 ≥8×8 的块即入列
        let mut visible_enough = false;
        for &(rx, ry, rw, rh) in &region {
            let vl = l.max(rx);
            let vt = t.max(ry);
            let vr = r.min(rx + rw);
            let vb = b.min(ry + rh);
            if vr - vl >= 8 && vb - vt >= 8 {
                visible_enough = true;
                break;
            }
        }
        if visible_enough {
            out.push(ShotWindow {
                x: wx - mx,
                y: wy - my,
                w: ww,
                h: wh,
            });
        }
        // 该窗口盖住的区域从剩余集合里扣除（受影响块拆成上下左右四条）
        let mut next = Vec::with_capacity(region.len() + 4);
        for &(rx, ry, rw, rh) in &region {
            let rr = rx + rw;
            let rb = ry + rh;
            if r <= rx || l >= rr || b <= ry || t >= rb {
                next.push((rx, ry, rw, rh));
                continue;
            }
            let mid_t = t.max(ry);
            let mid_b = b.min(rb);
            if ry < t {
                next.push((rx, ry, rw, t - ry));
            }
            if rb > b {
                next.push((rx, b, rw, rb - b));
            }
            if rx < l && mid_b > mid_t {
                next.push((rx, mid_t, l - rx, mid_b - mid_t));
            }
            if rr > r && mid_b > mid_t {
                next.push((r, mid_t, rr - r, mid_b - mid_t));
            }
        }
        region = next.into_iter().filter(|p| p.2 > 0 && p.3 > 0).collect();
        if region.is_empty() {
            break;
        }
    }
    // 桌面兜底：整个显示器（最大区域；hitWindow 顺序命中时自然最后）
    out.push(ShotWindow {
        x: 0,
        y: 0,
        w: mw,
        h: mh,
    });
    out
}

/// 光标点所在显示器物理参数（找不到 = None，由调用方回落）
#[derive(Clone, Copy)]
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

/// 捕获+下发进行中标记：拦截连按（begin_session 只在主线程跑，load/store 无竞争）
static SESSION_STARTING: AtomicBool = AtomicBool::new(false);
/// 会话进行中（覆盖窗显示着选区）：热键重按 = 就地重拍；收场即复位
static SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 覆盖窗内容首帧已上屏（前端 shot_ready 回执）：失焦自毁仅在此之后生效
static SHOT_VISIBLE: AtomicBool = AtomicBool::new(false);
/// 原生保存对话框打开中：对话框会抢走系统焦点，此时豁免覆盖窗的失焦自毁
static SAVE_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);
/// 常驻覆盖窗页面就绪（前端 shot_page_ready 回执，事件监听已注册）：
/// 会话事件在此之前下发会丢，capture 线程等此标记再下发
static SHOT_PAGE_READY: AtomicBool = AtomicBool::new(false);
/// 本次会话起始时刻（millis）：shot_ready 时算感知延迟（log::info 实测口径）
static SESSION_T0: AtomicU64 = AtomicU64::new(0);
/// 5s 看门狗连续未就绪次数：≥2 = 常驻窗页面僵死（WebView2 建窗 0x8007139F
/// 前科机器实证），销毁常驻窗待下按热键冷重建自愈
static READY_FAIL_STREAK: AtomicU32 = AtomicU32::new(0);
/// 当前会话定格帧（RGBA 原始字节，显示器整幅）：shot_frame 经 IPC 二进制
/// 直传前端（putImageData 直绘，无落盘/读回/解码三跳）；收场释放；滚动
/// 截图从内存裁首帧（不再读临时文件）
static SESSION_FRAME: Mutex<Option<SessionFrame>> = Mutex::new(None);
/// 待上屏的显示器原点（dispatch 时登记，shot_ready 时消费）：覆盖窗停靠在
/// 屏幕外，会话内容就绪后才移动到该原点原子上屏
static SESSION_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);

/// 会话定格帧（显示器整幅 RGBA）
pub(crate) struct SessionFrame {
    pub mw: u32,
    pub mh: u32,
    pub rgba: Vec<u8>,
}

/// 滚动截图取第一帧用：从内存定格帧裁出滚动区域（坐标相对显示器；
/// 无会话 = None）
pub(crate) fn session_frame_crop(x: i32, y: i32, w: u32, h: u32) -> Option<image::RgbaImage> {
    let g = SESSION_FRAME.lock().unwrap_or_else(|p| p.into_inner());
    let f = g.as_ref()?;
    crop_rgba_rows(f.mw, f.mh, &f.rgba, x, y, w as i32, h as i32)
        .map(|c| image::RgbaImage::from_raw(c.mw, c.mh, c.rgba).expect("裁剪尺寸与数据一致"))
}

/// 从整幅 RGBA 帧按行拷贝裁剪出子帧（免整帧 clone，矩形钳到帧内，裁出
/// 至少 1×1；w/h ≤ 0 或载荷长度不符 = None）。快存/贴图零 IPC 路与滚动
/// 截图首帧共用。独立纯函数供 test。
pub(crate) fn crop_rgba_rows(
    mw: u32,
    mh: u32,
    rgba: &[u8],
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Option<SessionFrame> {
    if mw == 0 || mh == 0 || w <= 0 || h <= 0 || rgba.len() != mw as usize * mh as usize * 4 {
        return None;
    }
    let x0 = x.clamp(0, mw as i32 - 1) as usize;
    let y0 = y.clamp(0, mh as i32 - 1) as usize;
    let cw = (w as u32).min(mw - x0 as u32) as usize;
    let ch = (h as u32).min(mh - y0 as u32) as usize;
    let stride = mw as usize * 4;
    let mut out = Vec::with_capacity(cw * ch * 4);
    for row in y0..y0 + ch {
        let start = row * stride + x0 * 4;
        out.extend_from_slice(&rgba[start..start + cw * 4]);
    }
    Some(SessionFrame {
        mw: cw as u32,
        mh: ch as u32,
        rgba: out,
    })
}

/// 常驻覆盖窗的停靠坐标（虚拟桌面外，任何显示器都够不到）。Windows 把窗口
/// 坐标钳制在 ±32768 内（E2E 实证 -40000 被钳到 -32768），取 -32700：不触
/// 钳制、远离最小化惯例的 -32000，即使 8K 窗宽右缘也仍在屏外
fn park_position() -> PhysicalPosition<i32> {
    PhysicalPosition::new(-32700, -32700)
}

/// 覆盖窗停靠回屏幕外（收场）。绝不用 hide()：SW_HIDE 会让 WebView2 合成器
/// 离场，再 show 时 DWM 只能呈现旧白面（闪白）；停靠期间窗口对合成器持续
/// 在场，会话内容提前呈现，上屏只是一次原子移动
fn park_shot_window(w: &tauri::WebviewWindow) {
    let _ = w.set_position(park_position());
}

/// snow-shot 同款：禁用 DWM 对该窗的显示/隐藏过渡动画，上屏/停靠零渐隐
#[cfg(windows)]
fn disable_dwm_transitions(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::Graphics::Dwm::{DWMWA_TRANSITIONS_FORCEDISABLED, DwmSetWindowAttribute};
    let disable: i32 = 1;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &disable as *const i32 as *const std::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

/// 热键/菜单入口：开始一次截图会话。
/// 捕获在后台线程（在 WndProc 里内联跑捕获会冻结整个应用，且 build() 泵消息
/// 期间排队的 WM_HOTKEY 会重入），主线程只做窗口定位与事件下发。
/// begin_session 必须在主线程调用（热键 WndProc / shot_begin 派发均满足）。
fn begin_session(app: &AppHandle) {
    // 捕获/下发进行中：连按忽略
    if SESSION_STARTING.load(Ordering::SeqCst) {
        log::debug!("截图热键触发：上一拍仍在进行，忽略");
        return;
    }
    // 滚动截图进行中忽略热键（2026-10-29 实测事故：滚动会话上叠加新截图
    // 会话，钩子/定格帧/窗口状态互踩）：预览窗上有「完成/取消」，Esc 同效
    if super::shot_scroll::scroll_active() {
        log::debug!("截图热键触发：滚动截图进行中，忽略");
        return;
    }
    log::debug!("截图热键触发");
    // 常驻覆盖窗缺失（预热未跑完/异常销毁）：现场补建（冷路径），门闸复位
    if app.get_webview_window("shot").is_none() {
        SESSION_ACTIVE.store(false, Ordering::SeqCst);
        SHOT_VISIBLE.store(false, Ordering::SeqCst);
        if let Err(e) = ensure_shot_window(app) {
            log::error!("截图启动失败：{e}");
            return;
        }
    }
    // 会话进行中 = 就地重拍（PixPin 惯例）：先撤蒙层再捕获，否则定格的是
    // 蒙层自己；撤下后给合成器约 140ms 把窗口真正摘离屏幕
    let reentry = SESSION_ACTIVE.load(Ordering::SeqCst);
    if reentry {
        end_session(app);
    }
    SESSION_STARTING.store(true, Ordering::SeqCst);
    SESSION_T0.store(millis() as u64, Ordering::SeqCst);
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("shot-capture".into())
        .spawn(move || match capture_session(&app, reentry) {
            Ok(cap) => {
                let app2 = app.clone();
                let dispatch = app.run_on_main_thread(move || {
                    if let Some(w) = app2.get_webview_window("shot") {
                        // 只改尺寸不动位置：窗口此刻应仍停靠在屏幕外，位置由
                        // shot_ready 在内容就绪后一次性移动（提前移上屏会把
                        // 上一次会话的残影/空壳暴露给用户）
                        let _ = w.set_size(PhysicalSize::new(cap.mw, cap.mh));
                        *SESSION_POS.lock().unwrap_or_else(|p| p.into_inner()) =
                            Some((cap.mx, cap.my));
                        SESSION_ACTIVE.store(true, Ordering::SeqCst);
                        if let Err(e) = app2.emit_to("shot", "shot-session", &cap) {
                            log::error!("截图会话下发失败：{e}");
                        }
                        // 5s 看门狗：前端迟迟不回执（页面挂死/事件丢失）就收场
                        // 重置门闸，热键可再按；不强制 show 空白窗（白屏闪屏）。
                        // 连续两次未就绪 = 页面僵死（非偶发丢事件），销毁常驻窗
                        // 让下次热键走冷重建路径自愈（滚动会话 WebView 僵死事故
                        // 2026-10-28：热键从此永久打不开截图，只能重启应用）
                        let app3 = app2.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_secs(5));
                            if SESSION_ACTIVE.load(Ordering::SeqCst)
                                && !SHOT_VISIBLE.load(Ordering::SeqCst)
                            {
                                let n = READY_FAIL_STREAK.fetch_add(1, Ordering::SeqCst) + 1;
                                log::warn!("截图覆盖窗 5s 未就绪，收场重置（连续第 {n} 次）");
                                end_session(&app3);
                                if n >= 2 {
                                    READY_FAIL_STREAK.store(0, Ordering::SeqCst);
                                    if let Some(w) = app3.get_webview_window("shot") {
                                        log::info!("截图覆盖窗页面连续未就绪，销毁待冷重建自愈");
                                        let _ = w.destroy();
                                    }
                                }
                            }
                        });
                    } else {
                        log::error!("截图会话下发失败：覆盖窗已不存在");
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
fn capture_session(app: &AppHandle, reentry: bool) -> Result<ShotCapture, String> {
    if reentry {
        std::thread::sleep(Duration::from_millis(140));
    }
    let cur = app
        .cursor_position()
        .map_err(|e| format!("无法获取光标位置：{e}"))?;
    let (cx, cy) = (cur.x.round() as i32, cur.y.round() as i32);
    let mon = monitor_at(cx, cy).ok_or("未找到光标所在显示器")?;
    let t0 = std::time::Instant::now();

    // DXGI Desktop Duplication 优先（4K ~60-100ms，会话保活零初始化），任何
    // 不满足回落 xcap/GDI
    let img = crate::commands::shot_dxgi::capture(&mon)
        .or_else(|| xcap_capture(&mon))
        .ok_or("屏幕捕获失败（DXGI 与 GDI 均不可用）")?;
    log::debug!("截图计时：捕获 {}ms", t0.elapsed().as_millis());

    // 定格帧留在内存：shot_frame 经 IPC 二进制直传前端 putImageData 直绘，
    // 滚动截图从内存裁剪——不再有 BMP 落盘/asset 读回/解码三跳（各 ~100ms 级）
    let seq = millis();
    let (fw, fh) = (img.width(), img.height());
    *SESSION_FRAME.lock().unwrap_or_else(|p| p.into_inner()) = Some(SessionFrame {
        mw: fw,
        mh: fh,
        rgba: img.into_raw(),
    });

    // 等常驻页就绪（事件监听注册完成）再下发，会话事件不丢；超 3s 照发
    // （看门狗兜底）——只发生在启动后头几秒预热未完成的极端时序
    let t_wait = std::time::Instant::now();
    while !SHOT_PAGE_READY.load(Ordering::SeqCst) {
        if t_wait.elapsed() >= Duration::from_secs(3) {
            log::warn!("截图覆盖窗页面 3s 未就绪，照发会话（可能丢失）");
            break;
        }
        std::thread::sleep(Duration::from_millis(8));
    }

    let mon_key = (mon.x, mon.y, mon.w as i32, mon.h as i32);
    let windows = visible_shot_targets(&enum_windows_abs(mon_key), mon_key);

    Ok(ShotCapture {
        mx: mon.x,
        my: mon.y,
        mw: mon.w,
        mh: mon.h,
        scale: mon.scale as f64,
        seq: seq as u64,
        cx: (cx - mon.x).clamp(0, mon.w as i32 - 1),
        cy: (cy - mon.y).clamp(0, mon.h as i32 - 1),
        windows,
    })
}

/// xcap（GDI）回落捕获：DXGI 不可用（HDR/旋转/独占全屏/安全桌面等）时兜底
fn xcap_capture(mon: &MonRect) -> Option<image::RgbaImage> {
    xcap::Monitor::all()
        .ok()?
        .into_iter()
        .find(|m| m.x().ok() == Some(mon.x) && m.y().ok() == Some(mon.y))?
        .capture_image()
        .ok()
}

/// 确保常驻覆盖窗存在（启动预热与热键冷路径共用）。idle 态仅挂 ShotHost
/// 空壳监听会话事件；建窗一次，之后所有会话复用，不再销毁。建好即停靠屏幕
/// 外并保持「可见」：合成器持续在场，会话上屏只是一次原子移动（防闪白）
pub(crate) fn ensure_shot_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("shot").is_some() {
        return Ok(());
    }
    let boot = serde_json::json!({ "window": "shot-idle" });
    let win = WebviewWindowBuilder::new(app, "shot", WebviewUrl::App("shot.html".into()))
        .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
        .title("X-Dir 截图")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        // 透明窗兜底：即便极端时序下有陈旧帧先上屏，也是透出真实桌面而非
        // 白屏（shot.html 的 html/body 已是 transparent）；会话 UI 本身有
        // 定格图铺底，透明不影响观感
        .transparent(true)
        // 不可见窗口默认 focused(true) 在部分 WebView2 上聚焦异常（wry#1798）；
        // show() 后再 set_focus()，保险起见显式关闭
        .focused(false)
        .visible(false)
        .initialization_script(format!("window.__BOOT__ = {boot};"))
        .build()
        .map_err(|e| format!("创建截图覆盖窗失败：{e}"))?;
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        disable_dwm_transitions(hwnd);
    }
    // 先停靠屏幕外再放行可见：页面在屏外加载呈现（rAF 全速、合成器不离场），
    // 热键首按即有「已渲染完毕」的窗体可原子上屏
    let _ = win.set_position(park_position());
    let _ = win.show();
    // 失焦自动收会话（QQ 惯例）：全屏置顶蒙层失焦后 Esc/Enter 全部失效，
    // 留在屏上形同卡死。仅在内容首帧上屏（SHOT_VISIBLE）后生效；保存对话框
    // 抢焦点时豁免；滚动截图会话期豁免（begin 装钩/建窗期间焦点可能短暂
    // 抖动，此时收场会清掉刚裁好的定格帧 →「无进行中的截图会话」静默失败，
    // 2026-10-29「点击滚动截图没反应」事故链在案）。常驻窗不销毁，销毁只发
    // 生在应用退出/异常（门闸复位即可，会话文件由下次启动 cleanup_stale 兜底）
    let app2 = app.clone();
    win.on_window_event(move |e| match e {
        tauri::WindowEvent::Focused(false)
            if SHOT_VISIBLE.load(Ordering::SeqCst)
                && !SAVE_DIALOG_OPEN.load(Ordering::SeqCst)
                && !super::shot_scroll::scroll_active() =>
        {
            end_session(&app2);
        }
        tauri::WindowEvent::Destroyed => {
            SESSION_ACTIVE.store(false, Ordering::SeqCst);
            SHOT_VISIBLE.store(false, Ordering::SeqCst);
            SHOT_PAGE_READY.store(false, Ordering::SeqCst);
        }
        _ => {}
    });
    Ok(())
}

/// 收场：停靠常驻覆盖窗到屏幕外回到 idle（不销毁、不 SW_HIDE），清会话状态
/// 与定格帧（33MB 内存即还），并通知前端卸载会话 UI（释放画布内存）
pub(crate) fn end_session(app: &AppHandle) {
    SESSION_ACTIVE.store(false, Ordering::SeqCst);
    SHOT_VISIBLE.store(false, Ordering::SeqCst);
    *SESSION_POS.lock().unwrap_or_else(|p| p.into_inner()) = None;
    *SESSION_FRAME.lock().unwrap_or_else(|p| p.into_inner()) = None;
    if let Some(w) = app.get_webview_window("shot") {
        park_shot_window(&w);
        // 停靠是投给事件循环的异步消息，而 emit 直达 webview——若立即通知
        // 前端卸载会话 UI，可能在窗口真正离屏前触发一帧多余重绘。延迟一拍
        // 等停靠呈现后再卸载（此后重绘全部发生在屏幕外，不可见）
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            let _ = app2.emit_to("shot", "shot-session-end", ());
        });
    }
}

/// 覆盖窗/贴图窗/结果窗内容首帧就绪后由前端调用：此刻才真正可见——
/// 覆盖窗从屏幕外停靠位一次移动到目标显示器原点，DWM 直接呈现已就绪的
/// 最终 surface（零白帧）；show 仅作异常兜底（窗口若处于真隐藏态）
#[tauri::command]
pub fn shot_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "shot" || label == "shot-result" || label.starts_with("pin-") {
        if label == "shot" {
            let pos = SESSION_POS.lock().unwrap_or_else(|p| p.into_inner()).take();
            if let Some((x, y)) = pos {
                let _ = window.set_position(PhysicalPosition::new(x, y));
            }
        }
        window.show().map_err(|e| e.to_string())?;
        if label == "shot" {
            SHOT_VISIBLE.store(true, Ordering::SeqCst);
            READY_FAIL_STREAK.store(0, Ordering::SeqCst);
            let t0 = SESSION_T0.load(Ordering::SeqCst);
            if t0 > 0 {
                log::info!("截图感知延迟 {}ms", millis().saturating_sub(u128::from(t0)));
            }
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 常驻覆盖窗页面就绪回执（事件监听已注册）：Rust 侧放行会话事件下发
#[tauri::command]
pub fn shot_page_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "shot" {
        SHOT_PAGE_READY.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// 会话定格帧二进制直传（snow-shot 同款 ipc::Response 路线）：前端收到
/// shot-session 后 invoke 本命令拿 RGBA 原始字节，putImageData 直绘——
/// 替代「BMP 落盘 → asset 协议读回 → 浏览器解码」三跳（各 ~100ms 级）。
/// 空响应 = 无进行中的会话（前端展示加载失败兜底）
#[tauri::command]
pub fn shot_frame() -> tauri::ipc::Response {
    let g = SESSION_FRAME.lock().unwrap_or_else(|p| p.into_inner());
    match g.as_ref() {
        Some(f) => tauri::ipc::Response::new(f.rgba.clone()),
        None => tauri::ipc::Response::new(Vec::new()),
    }
}

/// 热键/菜单入口：开始一次截图会话（异步派发，立即返回）
#[tauri::command]
pub async fn shot_begin(app: AppHandle) -> Result<(), String> {
    // begin_session 依赖主线程串行（SESSION_STARTING 的 load/store 无锁假设）
    let app2 = app.clone();
    app.run_on_main_thread(move || begin_session(&app2))
        .map_err(|e| format!("截图任务派发失败：{e}"))
}

/// 关闭覆盖窗会话（完成/取消后的收尾）：隐藏常驻窗回到 idle
#[tauri::command]
pub fn shot_close(app: AppHandle) -> Result<(), String> {
    end_session(&app);
    Ok(())
}

// ── 三个完成动作：复制 / 贴图 / 保存 ────────────────────────────────────────

#[tauri::command]
pub fn shot_copy(app: AppHandle, data_url: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    log::debug!("剪贴板走 dataURL 回落路径（{} 字节）", data_url.len());
    let bytes = decode_data_url(&data_url)?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("PNG 解码失败：{e}"))?
        .to_rgba8();
    let (w, h) = img.dimensions();
    app.clipboard()
        .write_image(&tauri::image::Image::new_owned(img.into_raw(), w, h))
        .map_err(|e| format!("写入剪贴板失败：{e}"))
}

/// 帧头解析：前 16 字节 = [width u32 LE][height u32 LE][x i32 LE][y i32 LE]
/// + RGBA 载荷（copy/stage/pin 原始直传共用；x/y 仅贴图落位使用，其余填 0）。
///
/// 独立成纯函数供 test。
fn parse_frame_header(bytes: &[u8]) -> Option<(u32, u32, i32, i32, &[u8])> {
    if bytes.len() < 16 {
        return None;
    }
    let w = u32::from_le_bytes(bytes[0..4].try_into().ok()?);
    let h = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    let x = i32::from_le_bytes(bytes[8..12].try_into().ok()?);
    let y = i32::from_le_bytes(bytes[12..16].try_into().ok()?);
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h, x, y, &bytes[16..]))
}

/// PNG 快速编码（CompressionType::Fast = fdeflate 后端，4K 约百 ms 级，
/// 对话框打开期间在后台线程并行执行）
fn encode_png_fast(mw: u32, mh: u32, rgba: Vec<u8>) -> Result<Vec<u8>, String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    let mut buf = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_raw(mw, mh, rgba)
        .ok_or("帧尺寸与数据不符")?
        .write_with_encoder(PngEncoder::new_with_quality(
            &mut buf,
            CompressionType::Fast,
            FilterType::Adaptive,
        ))
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    Ok(buf.into_inner())
}

/// 暂存的选区帧（保存/贴图的 RGBA 原始字节，前端合成结果）
static STAGED_FRAME: Mutex<Option<SessionFrame>> = Mutex::new(None);

/// 复制选区到剪贴板（感知优先路径）：前端把选区合成结果以 RGBA 原始字节
/// 经 ipc 二进制（fetch POST octet-stream）直传——免「canvas PNG 编码 /
/// base64 膨胀传输 / JSON 解析 / PNG 解码」四道工序（4K 整屏省 ~0.5-2s）。
/// 请求体 = [w u32 LE][h u32 LE][RGBA...]；前端失败时回落 shot_copy dataURL
/// 路径，两条路并存。
#[tauri::command]
pub fn shot_copy_raw(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("需要二进制请求体".into()),
    };
    let Some((w, h, _, _, rgba)) = parse_frame_header(bytes) else {
        return Err("帧头不合法".into());
    };
    if rgba.len() != w as usize * h as usize * 4 {
        return Err(format!(
            "RGBA 尺寸不符：{} 字节 ≠ {}×{}×4",
            rgba.len(),
            w,
            h
        ));
    }
    let t0 = std::time::Instant::now();
    write_clipboard_image(&app, w, h, rgba)?;
    log::debug!(
        "剪贴板直传：{}×{} {}KB，写剪贴板 {}ms",
        w,
        h,
        rgba.len() / 1024,
        t0.elapsed().as_millis()
    );
    Ok(())
}

/// 写入位图到剪贴板：Windows 走原生 CF_DIB（clip.rs 行式转换，4K 全屏
/// ~百 ms 级——剪贴板插件的逐像素路径 debug 下 4K 要 2.3s）；其他平台走
/// tauri 剪贴板插件
fn write_clipboard_image(_app: &AppHandle, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    return crate::clip::set_image(w, h, rgba);
    #[cfg(not(windows))]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        _app.clipboard()
            .write_image(&tauri::image::Image::new(rgba, w, h))
            .map_err(|e| format!("写入剪贴板失败：{e}"))
    }
}

/// 复制零 IPC 快路：无标注时合成结果像素与会话定格帧一致，前端只传选区
/// 整数矩形，Rust 进程内从 SESSION_FRAME 裁剪后直写剪贴板——免前端
/// getImageData（GPU→CPU 同步回读）与整幅选区 RGBA 跨进程拷贝；写完才返回
/// 供前端收场（点击→剪贴板就绪 ~50ms，且消除「先收场、贴上时还没写完」的
/// 竞态）。有标注或失败时前端回落 shot_copy_raw / dataURL 路径
#[tauri::command]
pub fn shot_copy_crop(app: AppHandle, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    let cropped = {
        let g = SESSION_FRAME.lock().unwrap_or_else(|p| p.into_inner());
        let Some(f) = g.as_ref() else {
            log::warn!("复制快存失败：无会话定格帧");
            return Err("无会话定格帧".into());
        };
        match crop_rgba_rows(f.mw, f.mh, &f.rgba, x, y, w, h) {
            Some(c) => c,
            None => {
                log::warn!(
                    "复制快存失败：裁剪矩形不合法（帧 {}×{}，请求 {},{} {}×{}）",
                    f.mw,
                    f.mh,
                    x,
                    y,
                    w,
                    h
                );
                return Err("复制裁剪矩形不合法".into());
            }
        }
    };
    let t0 = std::time::Instant::now();
    write_clipboard_image(&app, cropped.mw, cropped.mh, &cropped.rgba).map_err(|e| {
        log::warn!("复制快存写剪贴板失败：{e}");
        e
    })?;
    log::debug!(
        "复制快存：定格帧裁剪 {}×{}（零 IPC 路），写剪贴板 {}ms",
        cropped.mw,
        cropped.mh,
        t0.elapsed().as_millis()
    );
    Ok(())
}

/// 暂存选区帧（保存/贴图第一步）：RGBA 原始字节进内存，随后 shot_save_raw
/// 开对话框 / shot_pin_raw 建贴图窗——把「PNG 编码 + base64 传输」从点击到
/// 对话框的关键路径上整体移除
#[tauri::command]
pub fn shot_stage_raw(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("需要二进制请求体".into()),
    };
    let Some((w, h, _, _, rgba)) = parse_frame_header(bytes) else {
        return Err("帧头不合法".into());
    };
    if rgba.len() != w as usize * h as usize * 4 {
        return Err(format!(
            "RGBA 尺寸不符：{} 字节 ≠ {}×{}×4",
            rgba.len(),
            w,
            h
        ));
    }
    *STAGED_FRAME.lock().unwrap_or_else(|p| p.into_inner()) = Some(SessionFrame {
        mw: w,
        mh: h,
        rgba: rgba.to_vec(),
    });
    Ok(())
}

/// 零 IPC 快存暂存：无标注时合成结果像素与会话定格帧一致，前端只传选区
/// 整数矩形，Rust 进程内从 SESSION_FRAME 按行裁剪进 STAGED_FRAME——免前端
/// getImageData（JS 同步读全选区像素）与整幅选区 RGBA 跨进程拷贝；有标注
/// 或本命令失败时前端仍走 shot_stage_raw 合成直传
#[tauri::command]
pub fn shot_stage_crop(x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    let cropped = {
        let g = SESSION_FRAME.lock().unwrap_or_else(|p| p.into_inner());
        let f = g.as_ref().ok_or("无会话定格帧")?;
        crop_rgba_rows(f.mw, f.mh, &f.rgba, x, y, w, h).ok_or("裁剪矩形不合法")?
    };
    log::debug!(
        "快存暂存：定格帧裁剪 {}×{}（零 IPC 路）",
        cropped.mw,
        cropped.mh
    );
    *STAGED_FRAME.lock().unwrap_or_else(|p| p.into_inner()) = Some(cropped);
    Ok(())
}

/// 保存暂存帧：对话框立即打开（帧已在内存），PNG 编码（Fast 档）在对话框
/// 打开期间于后台线程并行执行，选完路径即刻写盘
#[tauri::command]
pub async fn shot_save_raw(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let frame = STAGED_FRAME
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .ok_or("无暂存帧")?;
    SAVE_DIALOG_OPEN.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        // 编码线程与对话框并行：用户选路径的同时 PNG 已在编码
        let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
        let enc = std::thread::spawn(move || {
            let _ = tx.send(encode_png_fast(frame.mw, frame.mh, frame.rgba));
        });
        let name = format!("截图_{}.png", local_stamp());
        let picked = app
            .dialog()
            .file()
            .add_filter("PNG 图片", &["png"])
            .set_file_name(&name)
            .set_parent(&window)
            .blocking_save_file();
        SAVE_DIALOG_OPEN.store(false, Ordering::SeqCst);
        let _ = enc.join();
        let encoded = rx.recv().map_err(|e| format!("编码线程失败：{e}"))??;
        match picked {
            None => Ok(None),
            Some(p) => {
                let path = p.into_path().map_err(|e| format!("路径解析失败：{e}"))?;
                std::fs::write(&path, encoded).map_err(|e| format!("保存失败：{e}"))?;
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
    spawn_pin_window(&app, &file, x, y, w, h)
}

/// 建贴图窗并落位（shot_pin dataURL 回落与 shot_pin_raw 直传共用）。
/// 返回前已 end_session 收蒙层（build() 泵消息与全屏蒙层互卡的既有防护）
fn spawn_pin_window(
    app: &AppHandle,
    file: &std::path::Path,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    let label = format!("pin-{}", millis());
    let scale = monitor_at(x + w / 2, y + h / 2)
        .map(|m| m.scale as f64)
        .unwrap_or(1.0);
    // 建窗前先收蒙层（2026-10-27 E2E 实证）：build() 会泵主线程消息，全屏
    // 置顶蒙层在场时其重绘/焦点事件重入会让 build 卡死不返回（窗口已建、
    // set_position/show 永不执行，贴图永不可见）。先收场再建窗，视觉也
    // 自然——贴图落屏时蒙层恰好退场
    end_session(app);
    let boot = serde_json::json!({
        "window": "pin",
        "file": file.to_string_lossy(),
        "w": w,
        "h": h,
        "scale": scale,
    });
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("shot.html".into()))
        .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
        .title("X-Dir 贴图")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        // 透明兜底：img onLoad 回执后 show，仍可能有陈旧帧先上屏——透出桌面
        // 好过白闪（与覆盖窗同族处理）
        .transparent(true)
        .focused(false)
        .visible(false)
        .initialization_script(format!("window.__BOOT__ = {boot};"))
        .build()
        .map_err(|e| format!("创建贴图窗口失败：{e}"))?;
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        disable_dwm_transitions(hwnd);
    }
    log::debug!("贴图窗 build 返回：label={label}");
    win.set_position(PhysicalPosition::new(x, y)).map_err(|e| {
        log::warn!("贴图 set_position 失败：{e}");
        e.to_string()
    })?;
    win.set_size(PhysicalSize::new(w as u32, h as u32))
        .map_err(|e| {
            log::warn!("贴图 set_size 失败：{e}");
            e.to_string()
        })?;
    let pin_file = file.to_path_buf();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            let _ = std::fs::remove_file(&pin_file);
        }
    });
    // 贴图不抢焦点（Snipaste 惯例）：贴完继续手头工作
    win.show().map_err(|e| e.to_string())?;
    log::debug!("贴图窗已建并 show：label={label} rect=({x},{y},{w},{h})");
    Ok(())
}

/// 保存为文件：原生保存对话框（阻塞版跑在 blocking 线程）→ 写盘，返回路径
/// （用户取消 = null）。对话框以调用窗为 parent——覆盖窗全屏置顶，无主的
/// 对话框会被压在其后，看起来「没弹出来」
#[tauri::command]
pub async fn shot_save_data(
    app: AppHandle,
    window: tauri::WebviewWindow,
    data_url: String,
) -> Result<Option<String>, String> {
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
            .set_parent(&window)
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

/// 贴图（感知优先路径）：RGBA 原始字节直传，落盘为 BMP（编码 memcpy 级，
/// 浏览器原生显示）——免 PNG 编码/解码；前端失败回落 shot_pin dataURL 路径
#[tauri::command]
pub fn shot_pin_raw(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("需要二进制请求体".into()),
    };
    let Some((w, h, x, y, rgba)) = parse_frame_header(bytes) else {
        return Err("帧头不合法".into());
    };
    let (w, h) = (w as i32, h as i32);
    if w < 8 || h < 8 || w > 20000 || h > 20000 {
        return Err("贴图尺寸非法".into());
    }
    if rgba.len() != w as usize * h as usize * 4 {
        return Err(format!(
            "RGBA 尺寸不符：{} 字节 ≠ {}×{}×4",
            rgba.len(),
            w,
            h
        ));
    }
    pin_from_frame(
        &app,
        SessionFrame {
            mw: w as u32,
            mh: h as u32,
            rgba: rgba.to_vec(),
        },
        x,
        y,
    )
}

/// 贴图零 IPC 快路：无标注时前端只传选区整数矩形与屏幕落位，Rust 进程内
/// 从会话定格帧裁剪——免前端 getImageData 与整幅选区 RGBA 跨进程拷贝；
/// 失败时前端回落 shot_pin_raw / shot_pin dataURL 路径
#[tauri::command]
pub fn shot_pin_crop(
    app: AppHandle,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    sx: i32,
    sy: i32,
) -> Result<(), String> {
    if w < 8 || h < 8 || w > 20000 || h > 20000 {
        return Err("贴图尺寸非法".into());
    }
    let cropped = {
        let g = SESSION_FRAME.lock().unwrap_or_else(|p| p.into_inner());
        let f = g.as_ref().ok_or("无会话定格帧")?;
        crop_rgba_rows(f.mw, f.mh, &f.rgba, x, y, w, h).ok_or("贴图裁剪矩形不合法")?
    };
    log::debug!(
        "贴图快存：定格帧裁剪 {}×{}（零 IPC 路）",
        cropped.mw,
        cropped.mh
    );
    pin_from_frame(&app, cropped, sx, sy)
}

/// RGBA 帧落盘为贴图临时 BMP 并建贴图窗（shot_pin_raw 直传与 shot_pin_crop
/// 快存共用；BMP 编码 memcpy 级，浏览器原生显示）
fn pin_from_frame(app: &AppHandle, frame: SessionFrame, x: i32, y: i32) -> Result<(), String> {
    let (w, h) = (frame.mw as i32, frame.mh as i32);
    let img =
        image::RgbaImage::from_raw(frame.mw, frame.mh, frame.rgba).ok_or("帧尺寸与数据不符")?;
    let dir = shot_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let ts = millis();
    let file = dir.join(format!("pin_{ts}.bmp"));
    img.save_with_format(&file, image::ImageFormat::Bmp)
        .map_err(|e| format!("贴图写盘失败：{e}"))?;
    spawn_pin_window(app, &file, x, y, w, h)
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
    .map(|()| log::info!("截图热键已注册：{hotkey}"))
    .map_err(|e| {
        // App.tsx 启动路径对注册失败静默 catch，这里必须留痕可查
        log::warn!("截图热键注册失败：{e}");
        format!("快捷键「{hotkey}」注册失败（可能被其他程序占用）：{e}")
    })
}

#[cfg(test)]
mod tests {
    use super::visible_shot_targets;

    const MON: (i32, i32, i32, i32) = (0, 0, 1920, 1080);

    fn rects(v: &[super::ShotWindow]) -> Vec<(i32, i32, i32, i32)> {
        v.iter()
            .map(|w| (w.x, w.y, w.w as i32, w.h as i32))
            .collect()
    }

    #[test]
    fn 完全被盖住的后层窗口不出现() {
        // 前：全屏窗；后：完全被前窗盖住的窗口
        let z = [(0, 0, 1920, 940), (200, 200, 800, 600)];
        let v = visible_shot_targets(&z, MON);
        assert_eq!(
            rects(&v),
            vec![(0, 0, 1920, 940), (0, 0, 1920, 1080)],
            "只剩前层窗口 + 桌面兜底"
        );
    }

    #[test]
    fn 部分露出的后层窗口保留且按z序在前() {
        // 前：左半屏；后：右侧大窗（右半露出）
        let z = [(0, 0, 1000, 1080), (500, 0, 1420, 1080)];
        let v = visible_shot_targets(&z, MON);
        assert_eq!(
            rects(&v),
            vec![(0, 0, 1000, 1080), (500, 0, 1420, 1080), (0, 0, 1920, 1080)]
        );
    }

    #[test]
    fn 露出宽度不足8像素的后层窗口不出现() {
        // 后窗只剩 4px 露出（碎边），视为噪声
        let z = [(0, 0, 1920, 1076), (0, 0, 1920, 1080)];
        let v = visible_shot_targets(&z, MON);
        assert_eq!(rects(&v), vec![(0, 0, 1920, 1076), (0, 0, 1920, 1080)]);
    }

    #[test]
    fn 任务栏形态的底层窄条保留() {
        // 前：占上部；后：底部 60px 任务栏完整露出
        let z = [(0, 0, 1920, 1020), (0, 1020, 1920, 60)];
        let v = visible_shot_targets(&z, MON);
        assert_eq!(
            rects(&v),
            vec![(0, 0, 1920, 1020), (0, 1020, 1920, 60), (0, 0, 1920, 1080)]
        );
    }

    #[test]
    fn 无候选时仅桌面兜底() {
        let v = visible_shot_targets(&[], MON);
        assert_eq!(rects(&v), vec![(0, 0, 1920, 1080)]);
    }

    #[test]
    fn 其他显示器的窗口被忽略() {
        // 候选全部在右侧第二屏（MON 之外）
        let z = [(1920, 0, 1920, 1080), (2000, 100, 800, 600)];
        let v = visible_shot_targets(&z, MON);
        assert_eq!(rects(&v), vec![(0, 0, 1920, 1080)]);
    }

    #[test]
    fn 跨屏窗口按本屏内部分参与遮挡() {
        // 窗口 A 跨屏（本屏内 0..960），窗口 B 在其右侧露出，C 被重叠区盖住
        let z = [
            (0, 0, 960, 1080),    // A：本屏左半
            (900, 0, 1000, 1080), // B：901..1920 露出
            (950, 100, 400, 400), // C：完全落在 A∪B 已覆盖区
        ];
        let v = visible_shot_targets(&z, MON);
        let r = rects(&v);
        assert_eq!(r[0], (0, 0, 960, 1080));
        assert_eq!(r[1], (900, 0, 1000, 1080));
        assert!(!r.contains(&(950, 100, 400, 400)), "被覆盖的 C 不应入列");
        assert_eq!(*r.last().unwrap(), (0, 0, 1920, 1080));
    }
}

#[cfg(test)]
mod copy_header_tests {
    use super::parse_frame_header;

    #[test]
    fn 帧头解析宽高与载荷() {
        let mut b = vec![0u8; 16];
        b[0..4].copy_from_slice(&1920u32.to_le_bytes());
        b[4..8].copy_from_slice(&1080u32.to_le_bytes());
        b.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        let (w, h, x, y, rgba) = parse_frame_header(&b).expect("应解析成功");
        assert_eq!((w, h, x, y), (1920, 1080, 0, 0));
        assert_eq!(rgba.len(), 8);
    }

    #[test]
    fn png快速编码可回读() {
        // 2×2 已知像素 → Fast 编码 → 内存解码回读校验
        let rgba = vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255];
        let encoded = super::encode_png_fast(2, 2, rgba.clone()).expect("编码成功");
        let decoded = image::load_from_memory(&encoded)
            .expect("可解码")
            .to_rgba8();
        assert_eq!(decoded.dimensions(), (2, 2));
        assert_eq!(decoded.into_raw(), rgba);
    }

    #[test]
    fn png编码拒绝尺寸不符的数据() {
        assert!(super::encode_png_fast(2, 2, vec![0; 7]).is_err());
    }

    #[test]
    fn 帧头过短或零尺寸拒绝() {
        assert!(parse_frame_header(&[0u8; 8]).is_none());
        let mut b = vec![0u8; 16];
        assert!(parse_frame_header(&b).is_none(), "零尺寸拒绝");
        b[0..4].copy_from_slice(&10u32.to_le_bytes());
        b[4..8].copy_from_slice(&5u32.to_le_bytes());
        let (w, h, x, y, rgba) = parse_frame_header(&b).expect("非零尺寸应通过");
        assert_eq!((w, h, x, y), (10, 5, 0, 0));
        assert!(rgba.is_empty());
    }
}

#[cfg(test)]
mod crop_rows_tests {
    use super::crop_rgba_rows;

    /// 4×3 帧像素 = [y*40 + x*10 + c]（c = 通道序），便于逐字节断言
    fn frame() -> Vec<u8> {
        let mut v = Vec::with_capacity(4 * 3 * 4);
        for y in 0..3u8 {
            for x in 0..4u8 {
                v.extend_from_slice(&[x, y, x + y, 255]);
            }
        }
        v
    }

    #[test]
    fn 整幅裁剪等于原帧() {
        let c = crop_rgba_rows(4, 3, &frame(), 0, 0, 4, 3).expect("应成功");
        assert_eq!((c.mw, c.mh), (4, 3));
        assert_eq!(c.rgba, frame());
    }

    #[test]
    fn 偏移裁剪逐行拷贝正确() {
        // 裁 (1,1) 起 2×1：应取到帧内像素 (1,1) 与 (2,1)
        let c = crop_rgba_rows(4, 3, &frame(), 1, 1, 2, 1).expect("应成功");
        assert_eq!((c.mw, c.mh), (2, 1));
        assert_eq!(c.rgba, vec![1, 1, 2, 255, 2, 1, 3, 255]);
    }

    #[test]
    fn 越界矩形钳制到帧内() {
        // 负起点钳到 0；宽高超出右/下边界截断
        let c = crop_rgba_rows(4, 3, &frame(), -5, -7, 100, 100).expect("应成功");
        assert_eq!((c.mw, c.mh), (4, 3));
        assert_eq!(c.rgba, frame());
        let c = crop_rgba_rows(4, 3, &frame(), 2, 1, 100, 100).expect("应成功");
        assert_eq!((c.mw, c.mh), (2, 2));
        assert_eq!(
            c.rgba,
            vec![2, 1, 3, 255, 3, 1, 4, 255, 2, 2, 4, 255, 3, 2, 5, 255]
        );
    }

    #[test]
    fn 非法入参拒绝() {
        assert!(
            crop_rgba_rows(4, 3, &frame(), 0, 0, 0, 3).is_none(),
            "宽 0 拒绝"
        );
        assert!(
            crop_rgba_rows(4, 3, &frame(), 0, 0, 4, -1).is_none(),
            "负高拒绝"
        );
        assert!(crop_rgba_rows(0, 0, &[], 0, 0, 1, 1).is_none(), "空帧拒绝");
        assert!(
            crop_rgba_rows(4, 3, &[0u8; 47], 0, 0, 1, 1).is_none(),
            "载荷长度不符拒绝"
        );
    }
}
