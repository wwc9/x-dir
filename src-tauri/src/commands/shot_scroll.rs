// 滚动长截图（§3.6 二期 B 批，2026-10-24 首版；2026-10-28 改手动滚轮模式；
// 2026-10-29 改「选区保留 + 侧边实时预览」）：
// 框选滚动区 → 覆盖窗隐藏、弹两窗：选区框窗（label "shot-frame"，整窗点击
// 穿透，只画选区边框——选区内容保持可交互，用户滚的是下面的真实窗口）和
// 侧边预览窗（label "shot-scroll"，贴选区右/左侧，实时显示已拼长图，底部
// 完成/取消）→ WH_MOUSE_LL 低级鼠标钩子监听用户滚轮〔光标在选区内：下滚记
// 时刻置待捕获；上滚只置标记——"下滚持续截图、上滚不动"〕→ 循环线程在下滚
// 静默窗（合并连滚/惯性）后 capture_region 实时捕获 → 灰度 SAD 模板匹配求
// 有符号纵向位移 → dy≥2（内容上移）追加底部新内容，dy≤-2（上滚回看）只重
// 定基准不追加 → 到底 / 用户完成 / 高度上限收尾 → 长图存临时盘 → 结果窗
// （label "shot-result"：复制 / 保存 / 贴图 / 关闭；窗体尺寸与长图解耦，
// 宽 ≤62% 屏宽、高 =80% 屏高，图在窗内滚动+缩放，2026-10-29 用户定案）。
// 拼接算法自研（ShareX 思路，未读 GPL 实现）；首版不含固定栏自动检测与视差
// 修复，动态内容（动画/加载条）连续两帧无法匹配即诚实截断并在结果窗提示。
// 注入式自动滚动（SendInput + SetCursorPos）已废弃。
//
// 预览像素同步：循环线程的累积画布经 Arc<Mutex<_>> 注册进 PREVIEW_CANVAS
// 静态，预览窗收到进度事件后 invoke shot_scroll_chunk(fromY) 增量拉取新行
// （原始 RGBA 二进制直传，免 base64/JSON）。
// 可观测性（2026-10-29 事故在案）：所有启动期拒绝路径必须 log（曾全部静默，
// 「点击滚动无任何反应」无从排查）；启动失败另弹原生错误对话框——覆盖窗
// 可能已收场，前端提示条不可见。
//
// 会话状态：SCROLL_ACTIVE = 会话从 begin 到收尾全程（热键/失焦收场的互斥
// 依据）；SCROLL_FLAG（0=滚动中 1=请求完成 2=请求取消）begin 时重置；循环
// 跑独立 std::thread，经事件 shot-scroll-progress 推送已捕获高度。钩子回调
// 必须即刻返回，故钩子线程只置静态标记、全部分匹配逻辑在循环线程执行；收尾
// 经 PostThreadMessageW(WM_QUIT) 令钩子线程退出消息泵并卸钩。

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use image::RgbaImage;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

use super::shot::{MonRect, local_stamp, millis, monitor_at, shot_dir};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW,
    PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL, WM_MOUSEWHEEL,
    WM_QUIT,
};

/// 长图高度上限（物理像素，§3.6 定案 20000）
const MAX_H: u32 = 20000;
/// 下滚事件后的静默窗：滚轮停歇此时长才收尾帧（连滚/惯性多格合并）
const QUIET: Duration = Duration::from_millis(240);
/// 滚动进行中的流式增量帧：最小捕获间隔（每帧行程小，必落在匹配域内——
/// 首版只做停歇合并，一格连滚 > 选区高时帧间无重叠、匹配必败，实测事故）
const STREAM_GAP: Duration = Duration::from_millis(150);
/// 流式帧的单击渲染等待
const TICK_SETTLE: Duration = Duration::from_millis(60);
/// 无滚轮活动的自动收场时限（兜底：钩子被系统摘除等异常不再永久挂死）
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// 循环线程轮询节奏
const POLL: Duration = Duration::from_millis(20);
/// 到底判定：下滚后位移为 0 的连续捕获帧数
const BOTTOM_STREAK: u32 = 3;
/// 动态内容判定：匹配连续失败的帧数（单次失败先跳过再试）
const BAD_STREAK: u32 = 2;

/// 0=滚动中 1=请求完成（用已拼内容出结果）2=请求取消（丢弃）
static SCROLL_FLAG: AtomicU8 = AtomicU8::new(0);
/// 会话进行中（begin 入口到收尾全程）：热键叠加截图、覆盖窗失焦自毁的互斥
/// 依据（2026-10-29 实测事故：滚动中按热键叠加新会话，钩子/窗口状态互踩）
static SCROLL_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 会话几何：选区显示器相对物理坐标 + 目标显示器矩形（launch → 建窗/循环
/// 线程一次携带，免多参散传）
struct ScrollGeo {
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
    mon: MonRect,
}

/// begin 与 launch 两段间的会话载荷（定格图裁剪 + 几何），launch 取走即清；
/// begin 重入（载荷未消费）即拒绝，防重复装钩
type ScrollPayload = (RgbaImage, ScrollGeo);
static SCROLL_PENDING: Mutex<Option<ScrollPayload>> = Mutex::new(None);
/// 预览窗增量拉取的数据源：循环线程的累积画布（会话收尾即清）
static PREVIEW_CANVAS: Mutex<Option<Arc<Mutex<CanvasBuf>>>> = Mutex::new(None);
/// 钩子反应区 = 选区全局物理坐标（x, y, w, h）——光标在内才响应滚轮，
/// 滚轮落点即目标窗口（Win10+ 悬停滚动），光标挪出选区不误触
static HOOK_ZONE: Mutex<(i32, i32, i32, i32)> = Mutex::new((0, 0, 0, 0));
/// 最近一次钩内下滚时刻（None = 会话尚无下滚）
static WHEEL_DOWN: Mutex<Option<Instant>> = Mutex::new(None);
/// 最近一次捕获时刻（流式帧间隔节流）
static LAST_CAPTURE: Mutex<Option<Instant>> = Mutex::new(None);
/// 待捕获 / 上滚标记（钩回调置位，循环线程消费后清零）
static WHEEL_PEND: AtomicBool = AtomicBool::new(false);
static WHEEL_UP: AtomicBool = AtomicBool::new(false);
/// 钩子线程 id（收尾 PostThreadMessageW WM_QUIT）
static HOOK_TID: AtomicU32 = AtomicU32::new(0);
/// 钩子收到的选区内滚轮事件计数（诊断：捕获间隔期计数冻结 = 钩子被系统摘除）
static HOOK_TICKS: AtomicU32 = AtomicU32::new(0);

/// 会话是否进行中（shot.rs 热键互斥 / 失焦自毁豁免用）
pub(crate) fn scroll_active() -> bool {
    SCROLL_ACTIVE.load(Ordering::Relaxed)
}

// ── 用户滚轮监听（WH_MOUSE_LL 低级钩子）─────────────────────────────────────

/// 低级鼠标钩子回调：WM_MOUSEWHEEL 且光标在选区内——下滚记时刻置待捕获，
/// 上滚置上滚标记（上滚不截取）。只写静态标记即刻返回，耗时分匹配全在
/// 循环线程（回调阻塞超时会令系统摘钩丢事件）。
unsafe extern "system" fn wheel_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if code >= 0 && wparam.0 as u32 == WM_MOUSEWHEEL {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            let (zx, zy, zw, zh) = *HOOK_ZONE.lock().unwrap_or_else(|e| e.into_inner());
            if info.pt.x >= zx && info.pt.x < zx + zw && info.pt.y >= zy && info.pt.y < zy + zh {
                HOOK_TICKS.fetch_add(1, Ordering::Relaxed);
                let delta = (info.mouseData >> 16) as u16 as i16;
                if delta < 0 {
                    if let Ok(mut t) = WHEEL_DOWN.lock() {
                        *t = Some(Instant::now());
                    }
                    WHEEL_PEND.store(true, Ordering::Relaxed);
                } else if delta > 0 {
                    WHEEL_UP.store(true, Ordering::Relaxed);
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }
}

/// 装钩 + 握手：钩子线程装 WH_MOUSE_LL 后经 channel 回执，调用方至多等 1s。
/// 首版用 TID/HOOK_OK 两静态轮询——TID 先于装钩置位，循环线程几乎必然在
/// HOOK_OK 置位前误判「装钩失败」秒关浮条（2026-10-28 实测闪退根因），改握手。
/// 返回 false（装钩失败/超时）时调用方必须仍 quit_hook 兜底（超时挂死情形）。
fn install_wheel_hook() -> bool {
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    std::thread::spawn(move || unsafe {
        HOOK_TID.store(GetCurrentThreadId(), Ordering::Relaxed);
        // 先 PeekMessage 一拍（PM_NOREMOVE 即建线程消息队列）：确保此后 quit
        // 的 PostThreadMessageW 必达，钩子线程总能收到 WM_QUIT 退出卸钩
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(wheel_proc), None, 0);
        let ok = hook.is_ok();
        let _ = tx.send(ok);
        if let Ok(hook) = hook {
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
            let _ = UnhookWindowsHookEx(hook);
        }
    });
    match rx.recv_timeout(Duration::from_secs(1)) {
        Ok(true) => true,
        Ok(false) => false,
        Err(_) => {
            log::error!("滚动截图：滚轮钩子安装握手超时");
            quit_hook();
            false
        }
    }
}

/// 令钩子线程退出消息泵（WM_QUIT 投给钩子线程 id）
fn quit_hook() {
    let tid = HOOK_TID.load(Ordering::Relaxed);
    if tid != 0 {
        unsafe {
            if let Err(e) = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0)) {
                log::error!("滚动截图：滚轮钩子退出通知失败：{e}");
            }
        }
    }
}

// ── 纵向位移匹配（灰度 SAD 模板匹配，自研；有符号）──────────────────────────

/// 求 cur 相对 prev 的纵向位移 dy（有符号）：dy>0 = 内容上移（用户下滚，
/// 底部新内容 = cur 底部 [h-dy..h)）；dy<0 = 内容下移 |dy|（用户上滚回看）。
/// 模板取 prev 下部两条窄竖条（左右 1/4 处，规避开居中的 sticky header /
/// 加载条），灰度 + 隔点采样后做 SAD；对 d ∈ [-(th-1), h-th] 搜索（负向
/// 只需模板带高度内可重叠，越界尾部按比例截短）。最小 SAD 超阈值 = 置信
/// 不足（动态内容干扰），返回 None。
fn match_scroll_dy(prev: &RgbaImage, cur: &RgbaImage) -> Option<i32> {
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
    let dmin = -(th as i32) + 1;
    let dmax = (h - th) as i32;
    let mut best_dy = 0i32;
    let mut best_sad = f32::MAX;
    for d in dmin..=dmax {
        // d<0（内容下移）时模板尾部移出帧界，按可重叠范围截短行区间
        let y_end = if d < 0 { (h as i32 + d) as u32 } else { h };
        let mut total = 0i64;
        let mut cnt = 0i64;
        for &tx in &xs {
            for y in (h - th..y_end).step_by(3) {
                let cy = (y as i32 - d) as u32;
                for x in (tx..tx + TW).step_by(4) {
                    total += i64::from((gray(prev, x, y) - gray(cur, x, cy)).abs());
                    cnt += 1;
                }
            }
        }
        if cnt == 0 {
            continue;
        }
        let sad = total as f32 / cnt as f32;
        // 并列（±0.25 灰阶）取 |dy| 更小者：重复行样式的 UI（列表/表格）易在
        // 大位移处出现同分误配，滚动帧间位移小者概率远高（流式帧行程本就小）
        if sad < best_sad - 0.25
            || (sad <= best_sad + 0.25 && d.unsigned_abs() < best_dy.unsigned_abs())
        {
            best_sad = best_sad.min(sad);
            best_dy = d;
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

    /// 已拼行 [from..h) 的原始 RGBA 切片（预览窗增量拉取；from 越界 = None）
    fn rows_from(&self, from: u32) -> Option<&[u8]> {
        if from > self.h || self.w == 0 {
            return None;
        }
        let start = from as usize * self.w as usize * 4;
        let end = self.h as usize * self.w as usize * 4;
        self.buf.get(start..end)
    }

    fn to_image(&self) -> Option<RgbaImage> {
        RgbaImage::from_raw(
            self.w,
            self.h,
            self.buf[..(self.w * self.h * 4) as usize].to_vec(),
        )
    }
}

// ── 预览板布局（纯函数，单测锁定）───────────────────────────────────────────

/// 预览板窗位置与尺寸（显示器相对物理像素）：高度贴选区（钳 ≤86% 屏高），
/// 宽随选区纵横比（钳 [170,430]·scale CSS）；水平贴选区右侧优先、左侧兜底，
/// 两侧都放不下则缩宽钳到屏幕右缘（窄预览好过盖住选区——盖住区滚轮会被
/// 预览窗吃掉）；垂直与选区顶对齐、越界上收。
fn panel_layout(sel: (i32, i32, i32, i32), mon: &MonRect) -> (i32, i32, u32, u32) {
    let s = f64::from(mon.scale);
    let (gx, gy, gw, gh) = sel;
    let gap = (12.0 * s).round() as i32;
    let max_h = (f64::from(mon.h) * 0.86).round() as i32;
    let min_w = (170.0 * s).round() as i32;
    let max_w = (430.0 * s).round() as i32;
    let mut pw =
        (((gh.min(max_h)) as f64 * gw as f64 / gh as f64).round() as i32).clamp(min_w, max_w);
    let mut ph = ((pw as f64 * gh as f64 / gw as f64).round() as i32).min(max_h);
    // 水平落位：右侧优先 → 左侧兜底 → 都不行缩宽钳右缘
    let mon_w = mon.w as i32;
    let fits_right = gx + gw + gap + pw <= mon_w - 8;
    let fits_left = gx - gap - pw >= 8;
    let x = if fits_right {
        gx + gw + gap
    } else if fits_left {
        gx - gap - pw
    } else {
        let avail = (mon_w - 8 - (gx + gw + gap)).clamp((110.0 * s).round() as i32, max_w);
        pw = avail;
        ph = ((pw as f64 * gh as f64 / gw as f64).round() as i32).min(max_h);
        mon_w - 8 - pw
    };
    let y = (gy).clamp(8, (mon.h as i32 - 8 - ph).max(8));
    (x, y, pw.max(1) as u32, ph.max(1) as u32)
}

// ── 会话入口 ────────────────────────────────────────────────────────────────

/// 开始滚动会话：rx/ry/rw/rh = 选区显示器相对物理坐标；mx/my = 显示器原点。
/// 第一帧从会话定格图（SESSION_FRAME）裁剪，此后 capture_region 捕获实时
/// 屏幕。不移动光标、不注入滚轮：拼接节奏完全跟手（用户下滚才捕获）。
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
    // 会话互斥：进行中拒绝（预览窗有完成/取消，Esc 也可取消）
    if SCROLL_ACTIVE.load(Ordering::Relaxed) {
        log::error!(
            "滚动截图开始被拒绝：会话进行中（flag={}）",
            SCROLL_FLAG.load(Ordering::Relaxed)
        );
        return Err("滚动截图进行中".into());
    }
    // 残留窗 = cancel/finish 收尾 close 未奏效的僵尸（实测 wry 偶发），销毁放行
    for label in ["shot-scroll", "shot-frame"] {
        if let Some(w) = app.get_webview_window(label) {
            log::warn!("滚动截图：清理残留窗 {label}（僵尸收尾）");
            let _ = w.destroy();
        }
    }
    if SCROLL_PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
    {
        log::error!("滚动截图开始被拒绝：上一会话载荷未被 launch 消费");
        return Err("滚动截图进行中".into());
    }
    if rw < 96 || rh < 80 {
        let m = format!("选区太小（{rw}×{rh}），请框选更大的滚动区域（至少 96×80）");
        log::error!("滚动截图开始被拒绝：{m}");
        return Err(m);
    }
    let Some(mon) = monitor_at(mx, my) else {
        log::error!("滚动截图开始被拒绝：未找到显示器（原点 {mx},{my}）");
        return Err("未找到目标显示器".into());
    };
    if rx < 0 || ry < 0 || rx + rw > mon.w as i32 || ry + rh > mon.h as i32 {
        log::error!(
            "滚动截图开始被拒绝：选区 ({rx},{ry}) {rw}×{rh} 超出显示器 {}×{}",
            mon.w,
            mon.h
        );
        return Err("选区超出显示器范围".into());
    }
    // 第一帧 = 定格图裁剪（此刻覆盖窗显示的就是原始画面；定格帧由 shot.rs
    // 会话捕获后留在内存，这里直接裁，无文件 IO）
    let Some(base) = super::shot::session_frame_crop(rx, ry, rw as u32, rh as u32) else {
        log::error!("滚动截图开始被拒绝：无进行中的截图会话（定格帧已被收场清空）");
        return Err("无进行中的截图会话".into());
    };
    log::info!("滚动截图开始：选区 ({rx},{ry}) {rw}×{rh} @显示器 ({mx},{my})");

    // 钩子反应区 = 选区全局物理坐标；会话静态复位（装钩前，防旧值串场）
    *HOOK_ZONE.lock().unwrap_or_else(|e| e.into_inner()) = (mon.x + rx, mon.y + ry, rw, rh);
    WHEEL_DOWN.lock().unwrap_or_else(|e| e.into_inner()).take();
    WHEEL_PEND.store(false, Ordering::Relaxed);
    WHEEL_UP.store(false, Ordering::Relaxed);
    HOOK_TID.store(0, Ordering::Relaxed);
    SCROLL_FLAG.store(0, Ordering::Relaxed);
    SCROLL_ACTIVE.store(true, Ordering::Relaxed);

    // 装钩先行（channel 握手，至多 1s）：失败直接报错返回——此刻覆盖窗尚未
    // 收场，用户不丢截图，可直接改用普通复制/保存
    if !install_wheel_hook() {
        SCROLL_ACTIVE.store(false, Ordering::Relaxed);
        log::error!("滚动截图启动失败：无法监听鼠标滚轮");
        return Err("滚动截图启动失败：无法监听鼠标滚轮".into());
    }

    // 覆盖窗退场（常驻窗停靠回屏幕外，end_session 即释放内存定格帧；base 已
    // 在内存不受影响）。停靠是投给事件循环的异步消息，必须等主循环把窗口真正
    // 摘离屏幕后才得起建窗——实测蒙层在场时 build() 泵消息永久卡死（贴图
    // 同款坑，shot.rs 在案），故拆两段命令由前端顺序调用（贴图 finish 流同款
    // 间隙）
    super::shot::end_session(&app);
    *SCROLL_PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some((
        base,
        ScrollGeo {
            rx: rx as u32,
            ry: ry as u32,
            rw: rw as u32,
            rh: rh as u32,
            mon,
        },
    ));
    Ok(())
}

/// 滚动会话第二段：不直接在主线程建窗（本命令运行于主线程，蒙层停靠消息可
/// 能还没被泵到——实测蒙层在场时 build() 泵消息永久卡死），而是派 150ms 后台
/// 定时再 run_on_main_thread 起建框窗+预览窗并起拼接循环；此间主循环早已把
/// 蒙层摘屏
#[tauri::command]
pub fn shot_scroll_launch(app: AppHandle) -> Result<(), String> {
    let Some((base, geo)) = SCROLL_PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    else {
        log::error!("滚动截图 launch 被拒绝：无待启动的会话载荷");
        return Err("无待启动的滚动会话".into());
    };
    log::info!("滚动截图：第二段进场，150ms 后建选区框窗与预览窗");
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        let runner = app2.clone();
        let dispatch = runner.run_on_main_thread(move || {
            // 框窗纯装饰，失败只记日志不流产；预览窗失败 = 会话流产（弹原生
            // 对话框——覆盖窗已收场，无前端提示条可依赖）
            if let Err(e) = show_frame_window(&app2, &geo) {
                log::error!("滚动截图：{e}");
            }
            if let Err(e) = show_preview_window(&app2, &geo) {
                log::error!("滚动截图：{e}");
                destroy_session_windows(&app2);
                quit_hook();
                SCROLL_ACTIVE.store(false, Ordering::Relaxed);
                dialog_error(&app2, &format!("滚动截图预览窗创建失败：{e}（请重新截图）"));
                return;
            }
            // 清掉装钩握手窗口期落进的滚轮标记（不属于本会话的有效滚动）
            WHEEL_DOWN.lock().unwrap_or_else(|e| e.into_inner()).take();
            LAST_CAPTURE
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            WHEEL_PEND.store(false, Ordering::Relaxed);
            WHEEL_UP.store(false, Ordering::Relaxed);
            let canvas = Arc::new(Mutex::new(CanvasBuf::new(geo.rw)));
            canvas
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(&base, 0);
            *PREVIEW_CANVAS.lock().unwrap_or_else(|e| e.into_inner()) = Some(canvas.clone());
            let app3 = app2.clone();
            std::thread::spawn(move || {
                scroll_loop(app3, geo, base, canvas);
            });
        });
        if let Err(e) = dispatch {
            log::error!("滚动截图：建窗任务派发失败：{e}");
            quit_hook();
        }
    });
    Ok(())
}

/// 滚动拼接主循环（独立线程）：等下滚静默 → 捕获 → 有符号匹配 → 追加/重定基准。
/// 钩子已由 shot_scroll_begin 握手装好，本线程只消费标记。
fn scroll_loop(app: AppHandle, geo: ScrollGeo, base: RgbaImage, canvas: Arc<Mutex<CanvasBuf>>) {
    let mon = geo.mon;
    let (rx, ry, rw, rh) = (geo.rx, geo.ry, geo.rw, geo.rh);
    let mon_obj = xcap::Monitor::all().ok().and_then(|all| {
        all.into_iter()
            .find(|m| m.x().ok() == Some(mon.x) && m.y().ok() == Some(mon.y))
    });
    let Some(monitor) = mon_obj else {
        log::error!("滚动截图：找不到目标显示器，收场");
        quit_hook();
        end_scroll(&app, mon, None, false);
        return;
    };
    let mut last = base;
    let mut zero_streak = 0u32;
    let mut bad_streak = 0u32;
    let mut truncated = false;
    let mut last_activity = Instant::now();
    emit_height(&app, canvas.lock().unwrap_or_else(|e| e.into_inner()).h);
    // 预览窗页加载晚于首发事件会漏听初始高度（实测显示 0px），隔一拍补发
    std::thread::sleep(Duration::from_millis(600));
    emit_height(&app, canvas.lock().unwrap_or_else(|e| e.into_inner()).h);
    loop {
        let now = Instant::now();
        let h = canvas.lock().unwrap_or_else(|e| e.into_inner()).h;
        if SCROLL_FLAG.load(Ordering::Relaxed) != 0 || h >= MAX_H {
            truncated = h >= MAX_H;
            break;
        }
        // 上滚不截取（“上滚不动”）：只重置到底计数，回看后继续下滚仍可拼接
        if WHEEL_UP.swap(false, Ordering::Relaxed) {
            zero_streak = 0;
        }
        // 捕获调度：滚动进行中（末次滚轮 < QUIET）按 ≥STREAM_GAP 流式出增量帧
        //（每帧行程小，必落在匹配域内）；滚轮停歇 ≥QUIET 收尾帧（合并惯性）。
        // 两路都受 STREAM_GAP 节流，防同刻连拍
        if WHEEL_PEND.load(Ordering::Relaxed) {
            last_activity = now;
            let last_tick = *WHEEL_DOWN.lock().unwrap_or_else(|e| e.into_inner());
            let since_tick = last_tick.map(|t| now.duration_since(t));
            let since_cap = LAST_CAPTURE
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .map(|t| now.duration_since(t));
            let settled = since_tick.is_some_and(|d| d >= QUIET);
            let streaming = !settled
                && since_tick.is_some_and(|d| d >= TICK_SETTLE)
                && since_cap.is_none_or(|d| d >= STREAM_GAP);
            if (settled || streaming) && since_cap.is_none_or(|d| d >= STREAM_GAP) {
                WHEEL_PEND.store(false, Ordering::Relaxed);
                *LAST_CAPTURE.lock().unwrap_or_else(|e| e.into_inner()) = Some(now);
                let ticks = HOOK_TICKS.load(Ordering::Relaxed);
                match monitor.capture_region(rx, ry, rw, rh) {
                    Ok(frame) => match match_scroll_dy(&last, &frame) {
                        // 内容上移 ≥2px：底部新内容追加
                        Some(dy) if dy >= 2 => {
                            zero_streak = 0;
                            bad_streak = 0;
                            canvas
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .push(&frame, dy as u32);
                            last = frame;
                            let h = canvas.lock().unwrap_or_else(|e| e.into_inner()).h;
                            log::debug!("滚动截图：追加 {dy}px，累计 {h}px（钩子 {ticks} ticks）");
                            emit_height(&app, h);
                        }
                        // 内容下移（上滚回看）：只重定基准，不追加不倒退
                        Some(dy) if dy <= -2 => {
                            zero_streak = 0;
                            bad_streak = 0;
                            last = frame;
                            log::debug!(
                                "滚动截图：上滚回看 {dy}px，重定基准（钩子 {ticks} ticks）"
                            );
                        }
                        // 0/±1px：视作未滚动（到底或滚动被拦截）
                        Some(_) => {
                            zero_streak += 1;
                            log::debug!(
                                "滚动截图：未滚动 {zero_streak}/{BOTTOM_STREAK}（钩子 {ticks} ticks）"
                            );
                            if zero_streak >= BOTTOM_STREAK {
                                log::info!("滚动截图：到底（连续 {BOTTOM_STREAK} 帧未滚动）");
                                break;
                            }
                        }
                        None => {
                            bad_streak += 1;
                            log::debug!("滚动截图：匹配失败 {bad_streak}/{BAD_STREAK}");
                            if bad_streak >= BAD_STREAK {
                                truncated = true;
                                break;
                            }
                        }
                    },
                    Err(e) => {
                        log::error!("滚动截图：帧捕获失败：{e}");
                        bad_streak += 1;
                        if bad_streak >= BAD_STREAK {
                            truncated = true;
                            break;
                        }
                    }
                }
            }
        }
        // 兜底：长时间无滚轮活动（钩子被系统摘除等异常）自动收场，不留死会话
        if now.duration_since(last_activity) >= IDLE_TIMEOUT {
            log::info!(
                "滚动截图：{} 分钟无滚轮活动，自动收场",
                IDLE_TIMEOUT.as_secs() / 60
            );
            break;
        }
        std::thread::sleep(POLL);
    }
    quit_hook();
    // 会话状态收场（先清预览数据源再关窗：拉取命令对空响应安全）
    *PREVIEW_CANVAS.lock().unwrap_or_else(|e| e.into_inner()) = None;
    SCROLL_ACTIVE.store(false, Ordering::Relaxed);
    if SCROLL_FLAG.load(Ordering::Relaxed) == 2 {
        // 取消：丢弃，不出结果（会话窗也须关闭——首版此处提前 return 漏关，
        // 僵尸窗挂着导致下次 begin 被「滚动截图进行中」挡死，实测事故）
        log::info!(
            "滚动截图：用户取消，丢弃已拼内容（{}px）",
            canvas.lock().unwrap_or_else(|e| e.into_inner()).h
        );
        destroy_session_windows(&app);
        return;
    }
    let (img, h) = {
        let c = canvas.lock().unwrap_or_else(|e| e.into_inner());
        (c.to_image(), c.h)
    };
    if truncated {
        log::info!("滚动截图：动态内容/捕获异常截断，累计 {h}px");
    }
    match img {
        Some(img) => end_scroll(&app, mon, Some(img), truncated),
        None => {
            log::error!("滚动截图：拼接缓冲转图失败");
            end_scroll(&app, mon, None, false)
        }
    }
}

fn emit_height(app: &AppHandle, height: u32) {
    let _ = app.emit_to(
        "shot-scroll",
        "shot-scroll-progress",
        serde_json::json!({ "height": height }),
    );
}

/// 预览窗增量拉取已拼行 [from_y..h)（原始 RGBA 行主序二进制直传；空响应 =
/// 无新内容或会话已收尾）。预览窗收到进度事件后调用，from_y = 已拉到的行号
#[tauri::command]
pub fn shot_scroll_chunk(from_y: u32) -> tauri::ipc::Response {
    let g = PREVIEW_CANVAS.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = g
        .as_ref()
        .and_then(|c| {
            c.lock()
                .unwrap_or_else(|e| e.into_inner())
                .rows_from(from_y)
                .map(<[u8]>::to_vec)
        })
        .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

/// 关闭本会话全部窗口（预览窗 + 选区框窗；destroy 而非 close：close 走
/// CloseRequested 语义，实测偶发不奏效留僵尸）
fn destroy_session_windows(app: &AppHandle) {
    for label in ["shot-scroll", "shot-frame"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}

/// 原生错误对话框：滚动会话期覆盖窗已收场，前端提示条不可见，失败必须落到
/// 系统级弹窗（2026-10-29 事故在案：静默失败 = 用户视角「点了没反应」）
fn dialog_error(app: &AppHandle, msg: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog()
        .message(msg.to_owned())
        .title("X-Dir 滚动截图")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/// 收尾：关会话窗，长图存临时盘后开结果窗
fn end_scroll(app: &AppHandle, mon: MonRect, img: Option<RgbaImage>, truncated: bool) {
    destroy_session_windows(app);
    let Some(img) = img else {
        log::error!("滚动截图：无拼接结果可出（启动/收场异常）");
        dialog_error(app, "滚动截图未能生成结果（启动异常），请重新截图");
        return;
    };
    let dir = shot_dir();
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join(format!("scroll_{}.png", millis()));
    if let Err(e) = img.save(&file) {
        log::error!("滚动长图写盘失败：{e}");
        dialog_error(app, &format!("滚动长图写盘失败：{e}"));
        return;
    }
    let (w, h) = img.dimensions();
    if let Err(e) = show_result_window(app, &file, w, h, truncated, &mon) {
        log::error!("打开滚动结果窗失败：{e}");
        dialog_error(app, &format!("打开滚动结果窗失败：{e}"));
    }
}

// ── 选区框窗 / 预览窗 / 结果窗 ──────────────────────────────────────────────

/// 选区框窗：与选区矩形精确重合的透明窗，只画边框与角点提示捕获区域；整窗
/// 点击穿透（set_ignore_cursor_events）——其下就是真实可交互窗口，滚轮直达
/// （滚动截图的数据源），选区视觉锚定不挡操作
fn show_frame_window(app: &AppHandle, geo: &ScrollGeo) -> Result<(), String> {
    let mon = &geo.mon;
    let (rx, ry, rw, rh) = (geo.rx, geo.ry, geo.rw, geo.rh);
    let boot = serde_json::json!({ "window": "frame" });
    let win = WebviewWindowBuilder::new(app, "shot-frame", WebviewUrl::App("shot.html".into()))
        .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
        .title("X-Dir 滚动选区")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        .transparent(true)
        // 不可见窗口默认 focused(true) 在部分 WebView2 上聚焦异常（wry#1798）
        .focused(false)
        .visible(false)
        .initialization_script(format!("window.__BOOT__ = {boot};"))
        .build()
        .map_err(|e| format!("创建选区框窗失败：{e}"))?;
    // 整窗穿透：滚轮/点击直达下层真实窗口（穿透设置须在 show 前，防一拍拦截）
    win.set_ignore_cursor_events(true)
        .map_err(|e| format!("选区框窗设置穿透失败：{e}"))?;
    win.set_position(PhysicalPosition::new(mon.x + rx as i32, mon.y + ry as i32))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(rw, rh))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    log::debug!("滚动截图：选区框窗已显示 ({rx},{ry}) {rw}×{rh}");
    Ok(())
}

/// 侧边预览窗：贴选区右/左侧（panel_layout 定位），实时显示已拼长图
fn show_preview_window(app: &AppHandle, geo: &ScrollGeo) -> Result<(), String> {
    let mon = &geo.mon;
    let (rx, ry, rw, rh) = (geo.rx, geo.ry, geo.rw, geo.rh);
    let s = f64::from(mon.scale);
    let (px, py, pw, ph) = panel_layout((rx as i32, ry as i32, rw as i32, rh as i32), mon);
    let boot = serde_json::json!({ "window": "scrollbar", "w": rw, "h": rh, "scale": s });
    // 本机 WebView2 建窗有 0x8007139F 前科（shot.rs 日志在案）：失败清掉可能
    // 的僵尸 label 重试一次，仍败才报错
    let mut win = None;
    let mut last_err = String::new();
    for attempt in 0..2 {
        match WebviewWindowBuilder::new(app, "shot-scroll", WebviewUrl::App("shot.html".into()))
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
        {
            Ok(w) => {
                win = Some(w);
                break;
            }
            Err(e) => {
                last_err = format!("创建预览窗失败（第 {} 次）：{e}", attempt + 1);
                log::error!("滚动截图：{last_err}");
                // 建窗失败可能残留僵尸 label，先销毁再重试
                if let Some(z) = app.get_webview_window("shot-scroll") {
                    let _ = z.destroy();
                }
                if attempt == 0 {
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        }
    }
    let win = win.ok_or(last_err)?;
    win.set_position(PhysicalPosition::new(mon.x + px, mon.y + py))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(pw, ph))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    log::info!("滚动截图：预览窗已显示 @({px},{py}) {pw}×{ph}（选区 {rw}×{rh}）");
    Ok(())
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
    // 窗体尺寸与长图解耦（2026-10-29 用户定案）：旧公式按长图等比缩窗，超长
    // 图被缩成细窄条不可用。改为宽 = min(图宽+2边距, 62% 屏宽，下限 520css)、
    // 高 = 80% 屏高；图在窗内滚动查看，缩放由结果窗前端负责
    let pad = (24.0 * s).round();
    let ww = ((f64::from(w) + pad * 2.0)
        .min(f64::from(mon.w) * 0.62)
        .max(520.0 * s))
    .min(f64::from(mon.w) - 32.0)
    .round() as i32;
    let wh = (f64::from(mon.h) * 0.8).round() as i32;
    let boot = serde_json::json!({
        "window": "result",
        "file": file.to_string_lossy(),
        "w": w,
        "h": h,
        "truncated": truncated,
    });
    let win = WebviewWindowBuilder::new(app, "shot-result", WebviewUrl::App("shot.html".into()))
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
        mon.x + (mon.w as i32 - ww) / 2,
        mon.y + (mon.h as i32 - wh) / 2,
    ))
    .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(ww as u32, wh as u32))
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

// ── 预览窗/结果窗的命令 ─────────────────────────────────────────────────────

/// 预览窗按钮：finish = 用已拼内容出结果；cancel = 丢弃结束
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

/// 结果窗：原生保存对话框（默认名 `滚动截图_时间戳.png`），用户取消 = null。
/// 对话框以结果窗为 parent，否则会被置顶窗压住看不见
#[tauri::command]
pub async fn shot_result_save(
    app: AppHandle,
    window: tauri::WebviewWindow,
    file: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&file).map_err(|e| format!("读取长图失败：{e}"))?;
        let picked = app
            .dialog()
            .file()
            .add_filter("PNG 图片", &["png"])
            .set_file_name(format!("滚动截图_{}.png", local_stamp()))
            .set_parent(&window)
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

    /// 确定性非周期纹理（整数哈希，可分辨 10px 级位移；线性取模式纹理在
    /// mod 素数下存在 Δy×13+Δseed×61≡0 的混叠位移，会使错误 d 同得 SAD 0）
    fn pattern(x: u32, y: u32, seed: u32) -> u8 {
        let mut h = x.wrapping_mul(0x9E37_79B1)
            ^ y.wrapping_mul(0x85EB_CA77)
            ^ seed.wrapping_mul(0xC2B2_AE3D);
        h ^= h >> 13;
        h = h.wrapping_mul(0x27D4_EB2F);
        h ^= h >> 15;
        (h % 251) as u8
    }

    fn img(w: u32, h: u32, seed: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([pattern(x, y, seed), 128, 64, 255]))
    }

    fn mon(x: i32, y: i32, w: i32, h: i32, scale: f32) -> MonRect {
        MonRect {
            x,
            y,
            w: w as u32,
            h: h as u32,
            scale,
        }
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
    fn match_scroll_dy_finds_negative_shift() {
        // cur = prev 内容整体下移 40px（上滚回看：prev[y] 出现在 cur[y+40]），
        // 返回有符号 -40 供循环线程重定基准而非追加
        let prev = img(200, 200, 0);
        let mut cur = img(200, 200, 9); // 顶部回看露出区用不同纹理
        for y in 40..200u32 {
            for x in 0..200u32 {
                cur.put_pixel(x, y, *prev.get_pixel(x, y - 40));
            }
        }
        assert_eq!(match_scroll_dy(&prev, &cur), Some(-40));
    }

    #[test]
    fn match_scroll_dy_bottom_is_zero() {
        let prev = img(200, 200, 0);
        let cur = prev.clone();
        assert_eq!(match_scroll_dy(&prev, &cur), Some(0));
    }

    #[test]
    fn match_scroll_dy_rejects_dynamic_content() {
        // 完全不相关的两帧（动态内容/换页）：置信不足应返回 None。
        // cur 用黑白棋盘（对平场 prev 的 SAD ≈ 38，远超阈值；随机哈希纹理
        // 经隔点采样后平均灰度差可能恰好落入 16 阈值内，不稳）
        let prev = RgbaImage::from_pixel(200, 200, Rgba([128, 128, 128, 255]));
        let cur = RgbaImage::from_fn(200, 200, |x, y| {
            Rgba([if (x + y) % 2 == 0 { 255 } else { 0 }, 128, 64, 255])
        });
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

    #[test]
    fn canvas_buf_rows_from_slices_delta() {
        let mut c = CanvasBuf::new(2);
        c.push(&img(2, 3, 0), 0);
        c.push(&img(2, 2, 7), 1); // 追加第 1 行起（1 行）
        assert_eq!(c.h, 4);
        // 全量 = h×w×4 字节；增量 [3..4) = 1 行
        assert_eq!(c.rows_from(0).map(<[u8]>::len), Some(4 * 2 * 4));
        assert_eq!(c.rows_from(3).map(<[u8]>::len), Some(1 * 2 * 4));
        // 越界 = None；恰好等于 h = 空切片（无新行，拉取协议按空响应跳过）
        assert_eq!(c.rows_from(4).map(<[u8]>::len), Some(0));
        assert_eq!(c.rows_from(5), None);
    }

    #[test]
    fn panel_layout_prefers_right_side() {
        // 选区在屏幕左侧：预览贴右侧；宽随纵横比但钳在 max_w（430css·scale），
        // 高随钳后宽回算
        let m = mon(0, 0, 2560, 1440, 1.5);
        let (x, y, pw, ph) = panel_layout((100, 200, 800, 600), &m);
        assert_eq!(x, 100 + 800 + 18); // gap = 12*1.5
        assert_eq!(y, 200);
        assert_eq!(pw, 645); // 800:600 比例 → 800，撞 max_w 645 上限
        assert_eq!(ph, 484); // 645×600/800
    }

    #[test]
    fn panel_layout_falls_back_left() {
        // 选区右侧贴屏：预览翻到左侧
        let m = mon(0, 0, 2560, 1440, 1.0);
        let (x, _y, pw, _ph) = panel_layout((1900, 100, 600, 400), &m);
        assert!(x + pw as i32 <= 1900, "预览应整体落在选区左侧");
        assert_eq!(x + pw as i32, 1900 - 12);
    }

    #[test]
    fn panel_layout_shrinks_at_right_edge_when_both_sides_tight() {
        // 选区几乎全屏宽：右侧放不下 → 缩宽钳到屏幕右缘
        let m = mon(0, 0, 2560, 1440, 1.0);
        let (x, _y, pw, ph) = panel_layout((100, 100, 2420, 600), &m);
        assert_eq!(x + pw as i32, 2560 - 8);
        assert!(pw < 4300); // 已缩窄
        assert!(ph >= 1 && pw >= 1);
    }

    #[test]
    fn panel_layout_clamps_height_and_top() {
        // 选区高超屏 86%：预览高被钳；选区顶在屏外：y 钳回屏内
        let m = mon(0, 0, 2560, 1440, 1.0);
        let (_x, y, _pw, ph) = panel_layout((100, 0, 400, 1400), &m);
        assert!(ph as f64 <= 1440.0 * 0.86);
        assert!(y >= 8);
    }
}
