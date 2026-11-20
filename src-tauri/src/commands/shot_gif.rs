// GIF 录制（2026-11-19 新功能，§3.6 截图域增强）：框选区 → 覆盖窗停靠、
// 弹录制浮条（label "shot-bar" 复用，boot 换装 gifbar）→ 循环线程按当前
// fps 间隔 capture_region 实时抓选区 → 智能剔除重复帧（2026-11-20：静止
// 帧不写盘、时长并入下一变化帧延迟，2s 兜底补帧防超长延迟兼容问题，体积
// 大降）→ 逐帧 NeuQuant 量化（gif crate Frame::from_rgba_speed，palette
// 逐帧独立）→ gif::Encoder 流式写临时盘（内存只持一帧，不囤整段）→ 完成
// （浮条/Enter/120s 上限）出结果窗（保存 .gif / 打开所在文件夹），取消
// 丢弃并删临时文件。
//
// 结构完全镜像 shot_scroll.rs：两段式入口（begin 存载荷 + end_session 停靠、
// launch 等停靠确认后建窗起循环——蒙层在场时 build() 泵消息卡死同款坑）；
// AtomicU8 控制标志 + 常驻窗 hide 复用 + 失败弹原生对话框（覆盖窗收场后
// 前端提示条不可见）。与滚动会话经 GIF_ACTIVE/SCROLL_ACTIVE 双向互斥
// （共享 shot-frame/shot-bar 窗与抓屏资源，不可并行）。
//
// 依赖合规（docs/agents/opensource.md §3 白名单口径）：gif 0.14（MIT OR
// Apache-2.0，随 image gif feature 已在依赖树）+ color_quant（MIT，直接
// 引入）；gifski（AGPL）是红线，已记 §2 打回台账。
//
// 时长护栏：120s 上限自动收场（原始尺寸模式下体量的硬护栏，浮条同时实时
// 显示秒数/帧数/文件字节数）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

use super::shot::{MonRect, millis, monitor_at, shot_dir};

/// 单次录制时长上限（2026-11-19 用户定案 120s）：到顶自动按完成收场
const GIF_MAX_SECS: u64 = 120;
/// 帧率三档（2026-11-19 用户定案：浮条可切，默认 12）
const FPS_CHOICES: [u32; 3] = [8, 12, 15];
const FPS_DEFAULT: u32 = 12;
/// 重复帧剔除兜底上限（2026-11-20 用户需求「智能剔除重复帧」）：静止段不写
/// 重复帧、时长并入下一变化帧延迟（GIF 静止 = 帧停留，视觉完全一致，体积
/// 大降）；静止超过该上限补一帧重复帧，防个别播放器对超长延迟的兼容问题
/// ——等效静止段最低 0.5fps 采样。用户提议的「重复帧保留 5fps」按延迟合并
/// 口径放大为 2s 上限：视觉相同、体积收益 ~96% vs ~58%（口径见 features.md）
const DUP_FLUSH_MS: u64 = 2000;
/// 连续抓帧失败次数：有帧按完成收场（用已有帧出结果），无帧报错收场
const BAD_CAPTURE_STREAK: u32 = 5;
/// 选区下限（与滚动截图同款口径）
const MIN_REGION: (u32, u32) = (96, 80);

/// 0=待命（浮条「开始录制」前的预览态，选区已框定不抓帧）1=录制中
/// 2=请求完成（用已录内容出结果）3=请求取消（丢弃并删临时文件）
static GIF_FLAG: AtomicU8 = AtomicU8::new(0);
/// 会话进行中（begin 到收尾全程）：热键叠加截图 / 滚动会话的互斥依据
static GIF_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 录制态暂停（2026-11-20 用户需求「增加暂停按钮」）：暂停期间跳过抓帧，
/// 时长上限与浮条计时都停摆（只计真实录制时间）；待命态忽略
static GIF_PAUSED: AtomicBool = AtomicBool::new(false);
/// 鼠标指针叠画开关（2026-11-20 用户需求「指针录制」，市场惯例默认开——
/// ScreenToGif/ShareX 教程场景光标刚需）：待命/录制中可切，下一帧起生效
static GIF_CURSOR: AtomicBool = AtomicBool::new(true);
/// 当前帧率档（待命/录制中均可切，下一帧起生效）
static GIF_FPS: AtomicU32 = AtomicU32::new(FPS_DEFAULT);
/// 底部进度条开关（2026-11-19 用户定案：待命态可选，开启则导出后对 GIF
/// 逐帧合成底部进度条——随回放填充到 100%，标示「看到全程的多少处」）
static GIF_BAR: AtomicBool = AtomicBool::new(true);
/// begin 与 launch 两段间的会话载荷，launch 取走即清；重入未消费即拒绝
static GIF_PENDING: Mutex<Option<GifGeo>> = Mutex::new(None);

/// 会话几何：选区显示器相对物理坐标 + 目标显示器矩形
struct GifGeo {
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
    mon: MonRect,
}

/// 会话是否进行中（shot.rs 热键互斥 / 失焦自毁豁免用）
pub(crate) fn gif_active() -> bool {
    GIF_ACTIVE.load(Ordering::Relaxed)
}

/// fps 档合法性（浮条只发三档；非法回落默认）
fn normalize_fps(fps: u32) -> u32 {
    if FPS_CHOICES.contains(&fps) {
        fps
    } else {
        FPS_DEFAULT
    }
}

/// 帧延迟（GIF 延迟单位 = 10ms 厘秒）= **实际捕获间隔**：原始尺寸模式下
/// 大选区量化超预算会自然降帧率（~1-5fps），帧延迟跟随真实节奏则回放
/// 速度与录制所见一致（不快进不慢放）；满帧率时等于目标间隔。<2cs 抬到
/// 2（浏览器对 <2cs 按 10cs 处理的通行约定）
fn gif_delay_cs(elapsed_ms: u64) -> u16 {
    u16::try_from((elapsed_ms / 10).max(2)).unwrap_or(u16::MAX)
}

/// 重复帧写入决策（纯函数，单测锁定 2026-11-20「智能剔除重复帧」）：
/// `is_dup` = 本帧与上一写入帧精确等值；`since_written_ms` = 距上一写入帧
/// 的毫秒数（None = 尚未写过帧）。返回 Some(delay_ms) = 写帧并采用该延迟，
/// None = 跳过本帧（时长随后续帧延迟合并）。变化帧恒写：延迟 = 距上一写入
/// 帧的真实间隔（静止段整段并入，回放节奏与录制所见一致），首帧用目标间隔；
/// 重复帧仅静止达兜底上限时补一帧（延迟 = 上限，防超长延迟兼容问题）
fn dedup_delay(is_dup: bool, since_written_ms: Option<u64>, target_ms: u64) -> Option<u64> {
    if !is_dup {
        return Some(since_written_ms.unwrap_or(target_ms));
    }
    match since_written_ms {
        Some(ms) if ms >= DUP_FLUSH_MS => Some(DUP_FLUSH_MS),
        _ => None,
    }
}

/// NeuQuant 速度档（1 质量/30 速度）按帧像素数自适应：小窗走高质量档，
/// 原始尺寸大面积选区用快档控单帧预算（帧数在浮条实时可见）
fn quant_speed(px: u32) -> i32 {
    if px >= 1_500_000 {
        30
    } else if px >= 600_000 {
        20
    } else {
        10
    }
}

/// 会话开始：rx/ry/rw/rh = 选区显示器相对物理坐标；mx/my = 显示器原点。
/// 录的是覆盖窗停靠后的实时屏幕（与滚动截图首帧定格、后续实时同口径）
#[tauri::command]
pub fn shot_gif_begin(
    app: AppHandle,
    rx: i32,
    ry: i32,
    rw: i32,
    rh: i32,
    mx: i32,
    my: i32,
) -> Result<(), String> {
    // 与滚动会话双向互斥（共享 shot-frame/shot-bar 窗与抓屏）
    if super::shot_scroll::scroll_active() {
        log::error!("GIF 录制开始被拒绝：滚动截图进行中");
        return Err("滚动截图进行中".into());
    }
    if GIF_ACTIVE.load(Ordering::Relaxed) {
        log::error!(
            "GIF 录制开始被拒绝：会话进行中（flag={}）",
            GIF_FLAG.load(Ordering::Relaxed)
        );
        return Err("GIF 录制进行中".into());
    }
    // 残留浮条 = 上场收尾 close 未奏效的僵尸（滚动同款实测），销毁放行
    for label in ["shot-bar", "shot-frame"] {
        if let Some(w) = app.get_webview_window(label) {
            log::warn!("GIF 录制：清理残留窗 {label}（僵尸收尾）");
            let _ = w.destroy();
        }
    }
    if GIF_PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
    {
        log::error!("GIF 录制开始被拒绝：上一会话载荷未被 launch 消费");
        return Err("GIF 录制进行中".into());
    }
    if rw < MIN_REGION.0 as i32 || rh < MIN_REGION.1 as i32 {
        let m = format!(
            "选区太小（{rw}×{rh}），请框选更大的录制区域（至少 {}×{}）",
            MIN_REGION.0, MIN_REGION.1
        );
        log::error!("GIF 录制开始被拒绝：{m}");
        return Err(m);
    }
    let Some(mon) = monitor_at(mx, my) else {
        log::error!("GIF 录制开始被拒绝：未找到显示器（原点 {mx},{my}）");
        return Err("未找到目标显示器".into());
    };
    if rx < 0 || ry < 0 || rx + rw > mon.w as i32 || ry + rh > mon.h as i32 {
        log::error!(
            "GIF 录制开始被拒绝：选区 ({rx},{ry}) {rw}×{rh} 超出显示器 {}×{}",
            mon.w,
            mon.h
        );
        return Err("选区超出显示器范围".into());
    }
    log::info!(
        "GIF 录制开始：选区 ({rx},{ry}) {rw}×{rh} @显示器 ({mx},{my})，fps {}",
        GIF_FPS.load(Ordering::Relaxed)
    );
    GIF_FLAG.store(0, Ordering::Relaxed);
    GIF_FPS.store(FPS_DEFAULT, Ordering::Relaxed);
    GIF_BAR.store(true, Ordering::Relaxed);
    GIF_PAUSED.store(false, Ordering::Relaxed);
    GIF_CURSOR.store(true, Ordering::Relaxed);
    GIF_ACTIVE.store(true, Ordering::Relaxed);
    // 覆盖窗停靠（异步消息，必须等真正摘屏才能建窗——蒙层在场时 build()
    // 泵消息永久卡死，滚动截图同款坑在案），拆两段命令由前端顺序调用
    super::shot::end_session(&app);
    *GIF_PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some(GifGeo {
        rx: rx as u32,
        ry: ry as u32,
        rw: rw as u32,
        rh: rh as u32,
        mon,
    });
    Ok(())
}

/// 会话第二段：派后台线程等蒙层停靠确认（10ms 轮询 ≤500ms 兜底），再发
/// 浮条/遮罩 boot 事件、主线程建窗、起录制循环（结构镜像 shot_scroll_launch）
#[tauri::command]
pub fn shot_gif_launch(app: AppHandle) -> Result<(), String> {
    let Some(geo) = GIF_PENDING.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        log::error!("GIF 录制 launch 被拒绝：无待启动的会话载荷");
        return Err("无待启动的 GIF 录制会话".into());
    };
    log::info!("GIF 录制：第二段进场，轮询蒙层停靠后起建两窗");
    let app2 = app.clone();
    std::thread::spawn(move || {
        // 蒙层停靠确认（滚动同款）：shot 窗 outer_position 到达停靠区即续行
        let t0 = Instant::now();
        loop {
            let parked = match app2.get_webview_window("shot") {
                Some(w) => w
                    .outer_position()
                    .map(|p| p.x <= -32000 && p.y <= -32000)
                    .unwrap_or(false),
                None => true,
            };
            if parked || t0.elapsed() >= Duration::from_millis(500) {
                log::info!(
                    "GIF 录制：蒙层停靠确认 parked={parked}，耗时 {:?}",
                    t0.elapsed()
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // 两窗常驻复用：boot 事件先行换装（页面在 webview 线程），再建窗/显示。
        // 首场窗不存在事件落空无害（initialization_script 已带初始载荷）
        let _ = app2.emit_to(
            "shot-frame",
            "shot-frame-geom",
            serde_json::json!({
                "x": geo.rx, "y": geo.ry, "w": geo.rw, "h": geo.rh,
                "scale": f64::from(geo.mon.scale),
            }),
        );
        let _ = app2.emit_to(
            "shot-bar",
            "shot-gif-bar-boot",
            serde_json::json!({
                "fps": GIF_FPS.load(Ordering::Relaxed),
                // barOn/cursorOn 全量随发：常驻窗复用时前端 chip 与 Rust 复位
                // 值对齐（begin 已复位，事件缺省会让前端保留上一场切换值）
                "barOn": GIF_BAR.load(Ordering::Relaxed),
                "cursorOn": GIF_CURSOR.load(Ordering::Relaxed),
            }),
        );
        let reuse = app2.get_webview_window("shot-frame").is_some()
            && app2.get_webview_window("shot-bar").is_some();
        std::thread::sleep(Duration::from_millis(if reuse { 40 } else { 120 }));
        let runner = app2.clone();
        let dispatch = runner.run_on_main_thread(move || {
            // 遮罩窗纯装饰失败只记日志；浮条失败 = 会话流产（弹原生对话框）
            if let Err(e) = show_mask_window(&app2, &geo) {
                log::error!("GIF 录制：{e}");
            }
            if let Err(e) = show_gif_bar_window(&app2, &geo) {
                log::error!("GIF 录制：{e}");
                destroy_windows(&app2);
                GIF_ACTIVE.store(false, Ordering::Relaxed);
                dialog_error(&app2, &format!("GIF 录制浮条创建失败：{e}（请重新截图）"));
                return;
            }
            log::info!("GIF 录制：两窗就位，开始录制");
            let app3 = app2.clone();
            std::thread::spawn(move || {
                gif_loop(app3, geo);
            });
        });
        if let Err(e) = dispatch {
            log::error!("GIF 录制：建窗任务派发失败：{e}");
            GIF_ACTIVE.store(false, Ordering::Relaxed);
        }
    });
    Ok(())
}

/// 编码器初始化（借用收敛辅助：&mut writer 的借用封在本函数内，
/// 调用方拿到无借用耦合的 Encoder）
fn init_encoder(
    writer: &mut std::io::BufWriter<std::fs::File>,
    w16: u16,
    h16: u16,
) -> Result<gif::Encoder<&mut std::io::BufWriter<std::fs::File>>, String> {
    // 全局调色板传空 = 逐帧局部调色板（from_rgba_speed 每帧独立 palette）
    let mut encoder = gif::Encoder::new(writer, w16, h16, &[])
        .map_err(|e| format!("GIF 录制编码器初始化失败：{e}"))?;
    // NETSCAPE2.0 无限循环块（2026-11-20 用户反馈「预览要支持播放」根因：
    // 缺省不写循环扩展 → 浏览器只播一遍，结果窗等合成弹出时已播完呈静止）
    encoder
        .set_repeat(gif::Repeat::Infinite)
        .map_err(|e| format!("GIF 录制设置循环播放失败：{e}"))?;
    Ok(encoder)
}

/// 录制循环：按当前 fps 节奏抓帧 → 量化 → 流式写盘；控制标志/时长上限/
/// 抓帧失败连击收场；每秒发进度事件；收尾按完成/取消分流
fn gif_loop(app: AppHandle, geo: GifGeo) {
    let mon = geo.mon;
    let (rx, ry, rw, rh) = (geo.rx, geo.ry, geo.rw, geo.rh);
    let mon_obj = xcap::Monitor::all().ok().and_then(|all| {
        all.into_iter()
            .find(|m| m.x().ok() == Some(mon.x) && m.y().ok() == Some(mon.y))
    });
    let Some(monitor) = mon_obj else {
        log::error!("GIF 录制：找不到目标显示器，收场");
        hide_windows(&app);
        GIF_ACTIVE.store(false, Ordering::Relaxed);
        dialog_error(&app, "GIF 录制未能找到目标显示器，请重新截图");
        return;
    };
    let dir = shot_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("gif_{}.gif", millis()));
    let (w16, h16) = (
        u16::try_from(rw).unwrap_or(u16::MAX),
        u16::try_from(rh).unwrap_or(u16::MAX),
    );
    let file = match std::fs::File::create(&path) {
        Ok(f) => f,
        Err(e) => {
            log::error!("GIF 录制：临时文件创建失败：{e}");
            hide_windows(&app);
            GIF_ACTIVE.store(false, Ordering::Relaxed);
            dialog_error(&app, &format!("GIF 录制临时文件创建失败：{e}"));
            return;
        }
    };
    let mut writer = std::io::BufWriter::new(file);
    // 借用经辅助函数收敛（NLL 对「调用结果直接 match」的借用跨臂限制）：
    // encoder 持 &mut writer 直至收尾 drop，flush 在其后
    let mut encoder = match init_encoder(&mut writer, w16, h16) {
        Ok(e) => e,
        Err(msg) => {
            log::error!("GIF 录制：{msg}");
            let _ = std::fs::remove_file(&path);
            hide_windows(&app);
            GIF_ACTIVE.store(false, Ordering::Relaxed);
            dialog_error(&app, &msg);
            return;
        }
    };
    let mut next_tick = Instant::now();
    let mut frames: u32 = 0;
    let mut bad_streak: u32 = 0;
    let mut last_emit = Instant::now();
    let mut cancelled = false;
    let mut aborted = false;
    // 录制计时口径（2026-11-20 暂停支持）：已落账时长 + 当前段起点——暂停
    // 时把当前段落账，恢复时重开一段，120s 上限只计真实录制时间
    let mut segment_start = Instant::now(); // 待命期不计入时长上限
    let mut recorded = Duration::ZERO;
    let mut was_paused = false;
    let mut paused_at: Option<Instant> = None;
    // 重复帧剔除（2026-11-20 用户需求）：上一写入帧的原始 RGBA 供精确比对
    // （from_rgba_speed 原地消费捕获缓冲，须先克隆）+ 上一写入帧时刻 =
    // 延迟合并与兜底节奏的时间基线
    let mut prev_frame: Option<Vec<u8>> = None;
    let mut last_written: Option<Instant> = None;
    // 指针位图缓存（线程封闭）：光标形状未变时免每帧 GetIconInfo/GetDIBits
    let mut cursor_cache: Option<CursorCache> = None;
    log::info!(
        "GIF 录制循环进场（待命态）：选区 ({rx},{ry}) {rw}×{rh}，fps {}",
        GIF_FPS.load(Ordering::Relaxed)
    );
    // ── 待命态（2026-11-19 用户定案「点开始才开始录」）：选区遮罩 + 浮条
    // 已在场，用户可切 fps/进度条开关；抓帧与时长上限计时都不启动 ──
    loop {
        match GIF_FLAG.load(Ordering::Relaxed) {
            0 => std::thread::sleep(Duration::from_millis(50)),
            1 => {
                segment_start = Instant::now();
                let _ = app.emit_to(
                    "shot-bar",
                    "shot-gif-phase",
                    serde_json::json!({ "phase": "recording" }),
                );
                log::info!("GIF 录制：用户点开始，进入录制");
                break;
            }
            _ => {
                // 待命态直接取消/完成（无帧）= 与取消同径清理
                cancelled = true;
                break;
            }
        }
    }
    if !cancelled {
        // ── 录制态：按当前 fps 节奏抓帧 → 量化 → 流式写盘 ──
        loop {
            // 控制与时长上限（先于本帧捕获：停止请求即刻生效）
            let flag = GIF_FLAG.load(Ordering::Relaxed);
            if flag == 3 {
                cancelled = true;
                break;
            }
            // 暂停/恢复跃迁（2026-11-20 用户需求）：暂停期间不抓帧、不推进
            // 帧节奏，完成/取消仍即时生效；跃迁即时发进度事件供浮条换面
            let paused = GIF_PAUSED.load(Ordering::Relaxed);
            if paused && !was_paused {
                recorded += segment_start.elapsed();
                was_paused = true;
                paused_at = Some(Instant::now());
                log::info!(
                    "GIF 录制：暂停（已录 {}s / {frames} 帧）",
                    recorded.as_secs()
                );
                let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let _ = app.emit_to(
                    "shot-bar",
                    "shot-gif-progress",
                    serde_json::json!({
                        "secs": recorded.as_secs(),
                        "frames": frames,
                        "bytes": bytes,
                        "fps": GIF_FPS.load(Ordering::Relaxed),
                        "paused": true,
                    }),
                );
            } else if !paused && was_paused {
                was_paused = false;
                segment_start = Instant::now();
                // 暂停时长平移出帧写入基线：延迟合并与兜底节奏只计录制时间
                //（否则恢复后首帧延迟会吞进整段暂停时长，回放卡一大拍）
                if let Some(shifted) = last_written
                    .zip(paused_at)
                    .and_then(|(t, p)| t.checked_add(p.elapsed()))
                {
                    last_written = Some(shifted);
                }
                next_tick = Instant::now();
                log::info!("GIF 录制：继续录制");
                let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let _ = app.emit_to(
                    "shot-bar",
                    "shot-gif-progress",
                    serde_json::json!({
                        "secs": recorded.as_secs(),
                        "frames": frames,
                        "bytes": bytes,
                        "fps": GIF_FPS.load(Ordering::Relaxed),
                        "paused": false,
                    }),
                );
            }
            // 完成判定计时：录制中 = 已落账 + 当前段；暂停中 = 已落账（冻结）
            let secs = if paused {
                recorded
            } else {
                recorded + segment_start.elapsed()
            }
            .as_secs();
            if flag == 2 || secs >= GIF_MAX_SECS {
                if secs >= GIF_MAX_SECS {
                    log::info!("GIF 录制：达到 {GIF_MAX_SECS}s 上限，自动收场");
                }
                break;
            }
            if paused {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            let fps = normalize_fps(GIF_FPS.load(Ordering::Relaxed));
            match monitor.capture_region(rx, ry, rw, rh) {
                Ok(frame) => {
                    bad_streak = 0;
                    let now = Instant::now();
                    let (fw, fh) = frame.dimensions();
                    let mut rgba = frame.into_raw();
                    // 指针叠画先于重复帧判定（2026-11-20 用户需求）：光标
                    // 参与比对——光标动 = 帧变化（语义正确），光标静止画面
                    // 静止仍可剔除
                    if GIF_CURSOR.load(Ordering::Relaxed) {
                        overlay_cursor(&mut rgba, fw, fh, &geo, &mut cursor_cache);
                    }
                    let (fw16, fh16) = (
                        u16::try_from(fw).unwrap_or(w16),
                        u16::try_from(fh).unwrap_or(h16),
                    );
                    // ── 智能剔除重复帧（2026-11-20 用户需求）：与上一写入帧
                    // 精确等值 = 静止帧默认跳过（时长并入后续变化帧延迟，GIF
                    // 静止 = 帧停留视觉完全一致），静止达兜底上限才补一帧重复
                    // 帧。跳过帧照常落到循环底部节奏/进度段（continue 会丢帧拍）
                    let is_dup = prev_frame.as_deref() == Some(rgba.as_slice());
                    let since_written =
                        last_written.map(|t| now.duration_since(t).as_millis() as u64);
                    if let Some(delay_ms) =
                        dedup_delay(is_dup, since_written, 1000 / u64::from(fps))
                    {
                        // 变化帧先克隆原始 RGBA 供下一帧比对（量化原地消费缓冲）
                        if !is_dup {
                            prev_frame = Some(rgba.clone());
                        }
                        let mut gframe = gif::Frame::from_rgba_speed(
                            fw16,
                            fh16,
                            &mut rgba,
                            quant_speed(rw * rh),
                        );
                        gframe.delay = gif_delay_cs(delay_ms);
                        if let Err(e) = encoder.write_frame(&gframe) {
                            log::error!("GIF 录制：帧写入失败：{e}");
                            aborted = true;
                            break;
                        }
                        frames += 1;
                        last_written = Some(now);
                    }
                }
                Err(e) => {
                    bad_streak += 1;
                    log::warn!("GIF 录制：抓帧失败（{bad_streak} 连击）：{e}");
                    if bad_streak >= BAD_CAPTURE_STREAK {
                        if frames == 0 {
                            aborted = true;
                            break;
                        }
                        log::warn!("GIF 录制：抓帧连击收场，用已录 {frames} 帧出结果");
                        break;
                    }
                }
            }
            // 进度事件（≥1s 间隔；浮条显示秒数/帧数/字节；paused 恒 false——
            // 暂停跃迁各自即时发）
            if last_emit.elapsed() >= Duration::from_secs(1) {
                last_emit = Instant::now();
                let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let _ = app.emit_to(
                    "shot-bar",
                    "shot-gif-progress",
                    serde_json::json!({
                        "secs": (recorded + segment_start.elapsed()).as_secs(),
                        "frames": frames,
                        "bytes": bytes,
                        "fps": GIF_FPS.load(Ordering::Relaxed),
                        "paused": false,
                    }),
                );
            }
            // 节奏：等下一拍（超预算 = 编码超时，基点重置继续，不追帧）
            next_tick += Duration::from_millis(1000 / u64::from(fps));
            let now = Instant::now();
            if next_tick > now {
                std::thread::sleep(next_tick - now);
            } else {
                next_tick = now;
            }
        }
    }
    // 静止尾巴收尾（重复帧剔除配套，2026-11-20）：录制停在静止段结束时，
    // 尾巴时长尚未并入任何帧延迟——补一帧兜底帧把尾巴并入，回放时长与录制
    // 所见一致（否则录完停了 5s 再保存，回放会提前 5s 收尾）。微尾巴（<100ms）
    // 不可感知，省一帧不补；取消/写盘异常路径不补
    let tail = if cancelled || aborted || frames == 0 {
        None
    } else {
        last_written.zip(prev_frame.take())
    };
    if let Some((t, mut prev)) = tail.filter(|(t, _)| t.elapsed().as_millis() as u64 >= 100) {
        let trailing_ms = t.elapsed().as_millis() as u64;
        let mut gframe = gif::Frame::from_rgba_speed(w16, h16, &mut prev, quant_speed(rw * rh));
        gframe.delay = gif_delay_cs(trailing_ms);
        match encoder.write_frame(&gframe) {
            Ok(()) => frames += 1,
            Err(e) => {
                log::warn!("GIF 录制：静止尾巴补帧失败（按已有帧出结果）：{e}");
            }
        }
    }
    // 收尾：drop 编码器冲刷缓冲（取消即丢弃整文件）
    drop(encoder);
    let flush = std::io::Write::flush(&mut writer);
    drop(writer);
    GIF_ACTIVE.store(false, Ordering::Relaxed);
    // 窗口收场延后到出结果窗之前：进度条合成期间浮条保持「生成中」可见
    if cancelled || (aborted && frames == 0) {
        hide_windows(&app);
        let _ = std::fs::remove_file(&path);
        if cancelled {
            log::info!("GIF 录制：用户取消，临时文件已删除（{frames} 帧）");
            return;
        }
        log::error!("GIF 录制：无有效帧（启动/抓帧异常）");
        dialog_error(&app, "GIF 录制未能生成结果（抓帧异常），请重新截图");
        return;
    }
    if let Err(e) = flush {
        log::error!("GIF 录制：编码收尾冲刷失败：{e}");
        hide_windows(&app);
        let _ = std::fs::remove_file(&path);
        dialog_error(&app, &format!("GIF 录制写盘失败：{e}"));
        return;
    }
    log::info!(
        "GIF 录制完成：{frames} 帧 / {}s / {} KB → {}",
        if was_paused {
            recorded
        } else {
            recorded + segment_start.elapsed()
        }
        .as_secs(),
        std::fs::metadata(&path)
            .map(|m| m.len() / 1024)
            .unwrap_or(0),
        path.display()
    );
    // 底部进度条（2026-11-19 用户定案：待命态可选）：逐帧合成随回放填充的
    // 进度条。生成可能秒级~数十秒（帧数×重新量化），浮条停在「生成中」提示
    if GIF_BAR.load(Ordering::Relaxed) {
        let _ = app.emit_to(
            "shot-bar",
            "shot-gif-phase",
            serde_json::json!({ "phase": "processing" }),
        );
        if let Err(e) = append_progress_bar(&path) {
            log::error!("GIF 录制：进度条合成失败（保留原 GIF 出结果）：{e}");
        }
    }
    hide_windows(&app);
    // 结果窗尺寸取文件实际头（进度条合成后高度 +PROGRESS_BAR_H）
    let (out_w, out_h) = image::image_dimensions(&path).unwrap_or((rw, rh));
    if let Err(e) = show_gif_result_window(&app, &mon, &path, out_w, out_h) {
        log::error!("打开 GIF 结果窗失败：{e}");
        dialog_error(&app, &format!("打开 GIF 结果窗失败：{e}"));
    }
}

/// 进度条高度（物理像素）：细条不遮挡内容，原始尺寸下清晰可辨
const PROGRESS_BAR_H: u32 = 8;

/// 逐帧合成底部进度条：解码原 GIF 全部帧，画布向下扩 PROGRESS_BAR_H——
/// 第 i 帧（1 起）的填充宽 = w×i/total（回放到最后一帧恰好填满），随帧
/// 重编码（逐帧独立调色板，与录制路径同款）。两遍扫描：先跳解码数帧数
///（skip_frame_decoding 零 LZW 开销），再 RGBA 解码逐帧合成流式写新文件
/// 后原子替换。线程阻塞型：由录制线程在收尾阶段调用，浮条已切「生成中」
fn append_progress_bar(path: &Path) -> Result<(), String> {
    // pass 1：帧数计数（不解码像素）
    let total = {
        let file = std::fs::File::open(path).map_err(|e| format!("打开 GIF 失败：{e}"))?;
        let mut options = gif::DecodeOptions::new();
        options.skip_frame_decoding(true);
        let mut dec = options
            .read_info(file)
            .map_err(|e| format!("GIF 解析失败：{e}"))?;
        let mut n = 0u32;
        while dec
            .next_frame_info()
            .map_err(|e| format!("GIF 解析失败：{e}"))?
            .is_some()
        {
            n += 1;
        }
        n
    };
    if total == 0 {
        return Err("无帧可合成".into());
    }
    // pass 2：逐帧 RGBA 解码 → 画布合成 → 重编码流式写临时文件
    let tmp_path = path.with_extension("gif.tmp");
    let out = std::fs::File::create(&tmp_path).map_err(|e| format!("进度条写盘失败：{e}"))?;
    let mut writer = std::io::BufWriter::new(out);
    let encode = encode_with_bar(path, &mut writer, total);
    drop(writer);
    match encode {
        Ok(()) => {
            std::fs::rename(&tmp_path, path).map_err(|e| format!("进度条替换失败：{e}"))?;
            log::info!("GIF 录制：底部进度条合成完成（{total} 帧，条高 {PROGRESS_BAR_H}px）");
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path); // 失败保留原 GIF 出结果
            Err(e)
        }
    }
}

/// 进度条合成主体（&mut writer 借用收敛在函数边界）：RGBA 解码逐帧 →
/// 画布扩底条 → 重编码流式写 writer
fn encode_with_bar(
    path: &Path,
    writer: &mut std::io::BufWriter<std::fs::File>,
    total: u32,
) -> Result<(), String> {
    {
        use gif::ColorOutput;
        let file = std::fs::File::open(path).map_err(|e| format!("打开 GIF 失败：{e}"))?;
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(ColorOutput::RGBA);
        let mut dec = options
            .read_info(file)
            .map_err(|e| format!("GIF 解析失败：{e}"))?;
        let (gw, gh) = (dec.width(), dec.height());
        let bar_h = u16::try_from(PROGRESS_BAR_H.min(u32::from(gh))).unwrap_or(0);
        let mut encoder = gif::Encoder::new(writer, gw, gh + bar_h, &[])
            .map_err(|e| format!("进度条编码器失败：{e}"))?;
        // 循环块随合成重编码重写（漏写 = 合成后的 GIF 不循环，同上）
        encoder
            .set_repeat(gif::Repeat::Infinite)
            .map_err(|e| format!("进度条设置循环播放失败：{e}"))?;
        let mut i: u32 = 0;
        while let Some(frame) = dec
            .read_next_frame()
            .map_err(|e| format!("GIF 解码失败：{e}"))?
        {
            i += 1;
            let fw = u32::from(frame.width);
            let delay = frame.delay;
            // RGBA 解码缓冲（read_next_frame 产物按 ColorOutput::RGBA 展平）
            // 画布向下扩 bar_h：底条 = 深色轨道 + accent 填充（i/total，
            // 回放到最后一帧恰好填满）。解码缓冲直接扩容复用
            let mut rgba = frame.buffer.to_vec();
            rgba.resize(usize::from(gw) * usize::from(gh + bar_h) * 4, 0);
            let fill_w =
                u32::try_from(u64::from(gw) * u64::from(i) / u64::from(total)).unwrap_or(0);
            for y in (gh..gh + bar_h).rev() {
                for x in 0..fw {
                    let off = (y as usize) * (gw as usize) + x as usize;
                    let (r, g, b) = if x < fill_w {
                        (53, 116, 240)
                    } else {
                        (26, 26, 26)
                    };
                    rgba[off * 4..off * 4 + 4].copy_from_slice(&[r, g, b, 255]);
                }
            }
            let mut out_frame = gif::Frame::from_rgba_speed(gw, gh + bar_h, &mut rgba, 10);
            out_frame.delay = delay;
            encoder
                .write_frame(&out_frame)
                .map_err(|e| format!("进度条帧写入失败：{e}"))?;
        }
        if i != total {
            return Err(format!("帧数两遍扫描不一致（{total} vs {i}）"));
        }
        Ok(())
    }
}

/// 浮条按钮/键盘：finish = 用已录内容出结果；cancel = 丢弃结束；
/// fps:N = 切换帧率档（下一帧起生效）；pause/resume = 录制中暂停/继续
#[tauri::command]
pub fn shot_gif_control(action: String) -> Result<(), String> {
    if let Some(fps) = action
        .strip_prefix("fps:")
        .and_then(|s| s.parse::<u32>().ok())
    {
        GIF_FPS.store(normalize_fps(fps), Ordering::Relaxed);
        return Ok(());
    }
    // 底部进度条开关（待命态可切）
    if let Some(on) = action.strip_prefix("bar:") {
        GIF_BAR.store(on == "on", Ordering::Relaxed);
        return Ok(());
    }
    // 鼠标指针叠画开关（待命/录制中可切，下一帧起生效）
    if let Some(on) = action.strip_prefix("cursor:") {
        GIF_CURSOR.store(on == "on", Ordering::Relaxed);
        return Ok(());
    }
    match action.as_str() {
        // 待命 → 录制（浮条「开始录制」）
        "start" => GIF_FLAG.store(1, Ordering::Relaxed),
        // 录制中 → 完成出结果
        "finish" => GIF_FLAG.store(2, Ordering::Relaxed),
        // 任意态 → 取消丢弃
        "cancel" => GIF_FLAG.store(3, Ordering::Relaxed),
        // 录制中暂停/继续（2026-11-20 用户需求；暂停期间不抓帧不计时长）
        "pause" => GIF_PAUSED.store(true, Ordering::Relaxed),
        "resume" => GIF_PAUSED.store(false, Ordering::Relaxed),
        _ => return Err("未知操作".into()),
    }
    Ok(())
}

// ── 鼠标指针叠画（2026-11-20 用户需求「指针录制」，市场惯例默认开）────────
// GetCursorInfo 取当前光标句柄与屏幕物理坐标（per-monitor DPI aware 进程
// 下即物理像素，与选区坐标系同源），GetIconInfo+GetDIBits 解码 32bpp RGBA
// （句柄未变走缓存，免每帧建/读位图），SrcOver 叠进选区帧。光标叠画先于
// 重复帧判定：光标动 = 帧变化（语义正确），光标静止画面静止仍可剔除。
// 彩色光标（Vista+ 箭头/手型 ARGB）直接混合，alpha 全 0 的旧式彩色光标用
// AND mask 兜底透明度；单色光标（I-beam 等）按 ICONINFO 上半 AND 下半
// XOR 经典公式绘制。

/// 光标位图缓存（线程封闭于录制循环）：句柄未变复用已解码 RGBA
struct CursorCache {
    handle: isize,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    hotspot_x: u32,
    hotspot_y: u32,
}

/// 叠画落位裁剪（纯函数，单测锁定）：光标贴图左上角可落在帧外（负坐标/
/// 超右下），返回 (帧内起点 fx,fy，源偏移 sx,sy，交集尺寸 w,h)——None =
/// 完全在帧外不画
fn cursor_clip(
    dst_x: i32,
    dst_y: i32,
    cw: u32,
    ch: u32,
    fw: u32,
    fh: u32,
) -> Option<(u32, u32, u32, u32, u32, u32)> {
    let x0 = dst_x.clamp(0, fw as i32) as u32;
    let y0 = dst_y.clamp(0, fh as i32) as u32;
    let x1 = dst_x.saturating_add(cw as i32).clamp(0, fw as i32) as u32;
    let y1 = dst_y.saturating_add(ch as i32).clamp(0, fh as i32) as u32;
    if x0 >= x1 || y0 >= y1 {
        return None;
    }
    Some((
        x0,
        y0,
        (x0 as i32 - dst_x) as u32,
        (y0 as i32 - dst_y) as u32,
        x1 - x0,
        y1 - y0,
    ))
}

/// SrcOver 叠画（缓存位图 → 帧）：帧背景恒不透明（xcap 捕获 A=255），
/// 逐像素 out = src*a + dst*(1-a)；帧 alpha 不动保持 255
fn blend_cursor(frame: &mut [u8], fw: u32, fh: u32, cache: &CursorCache, dst_x: i32, dst_y: i32) {
    let Some((fx, fy, sx, sy, w, h)) = cursor_clip(dst_x, dst_y, cache.width, cache.height, fw, fh)
    else {
        return;
    };
    let stride = fw as usize * 4;
    let src_stride = cache.width as usize * 4;
    for row in 0..h as usize {
        let drow = (fy as usize + row) * stride + fx as usize * 4;
        let srow = (sy as usize + row) * src_stride + sx as usize * 4;
        for col in 0..w as usize {
            let s = srow + col * 4;
            let a = u32::from(cache.rgba[s + 3]);
            if a == 0 {
                continue;
            }
            let d = drow + col * 4;
            if a == 255 {
                frame[d..d + 3].copy_from_slice(&cache.rgba[s..s + 3]);
            } else {
                let ia = 255 - a;
                for c in 0..3 {
                    frame[d + c] =
                        ((u32::from(cache.rgba[s + c]) * a + u32::from(frame[d + c]) * ia + 127)
                            / 255) as u8;
                }
            }
        }
    }
}

/// HBITMAP → 32bpp top-down 原始字节（BGRA 顺序；失败 = None）
#[cfg(windows)]
fn read_dib_32bpp(hbm: windows::Win32::Graphics::Gdi::HBITMAP, w: u32, h: u32) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
        GetDIBits, RGBQUAD,
    };
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32), // 负高 = top-down：行序自上而下
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [RGBQUAD::default()],
    };
    let mut buf = vec![0u8; w as usize * h as usize * 4];
    let hdc = unsafe { CreateCompatibleDC(None) };
    if hdc.is_invalid() {
        return None;
    }
    let lines = unsafe {
        GetDIBits(
            hdc,
            hbm,
            0,
            h,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bi,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        let _ = DeleteDC(hdc);
    }
    (lines == h as i32).then_some(buf)
}

/// hCursor → 32bpp RGBA 位图 + 热区（解码失败 = None，叠画静默跳过）。
/// GetIconInfo 产出的 hbmMask/hbmColor 用完必须 DeleteObject
#[cfg(windows)]
fn decode_cursor(handle: isize) -> Option<CursorCache> {
    use windows::Win32::Graphics::Gdi::{BITMAP, DeleteObject, GetObjectW, HGDIOBJ};
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, HICON, ICONINFO};

    let ptr = handle as *mut core::ffi::c_void;
    let mut info = ICONINFO::default();
    unsafe {
        GetIconInfo(HICON(ptr), &mut info).ok()?;
        let (mask, color) = (info.hbmMask, info.hbmColor);
        let mut bm = BITMAP::default();
        let ok = GetObjectW(
            HGDIOBJ(mask.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut core::ffi::c_void),
        );
        if ok == 0 {
            let _ = DeleteObject(HGDIOBJ(mask.0));
            if !color.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(color.0));
            }
            return None;
        }
        let (bw, bh) = (bm.bmWidth.max(0) as u32, bm.bmHeight.max(0) as u32);
        let mask_buf = read_dib_32bpp(mask, bw, bh);
        let decoded = if !color.is_invalid() {
            // 彩色：hbmColor 32bpp BGRA→RGBA；alpha 全 0 的旧式光标用 AND
            // mask 兜底透明度（AND 位 1 = 透明）
            let mut rgba = read_dib_32bpp(color, bw, bh)?;
            let alpha_fallback = mask_buf
                .as_deref()
                .filter(|_| !rgba.as_chunks::<4>().0.iter().any(|px| px[3] != 0));
            if let Some(m) = alpha_fallback {
                for (px, mp) in rgba
                    .as_chunks_mut::<4>()
                    .0
                    .iter_mut()
                    .zip(m.as_chunks::<4>().0)
                {
                    px[3] = u8::from(mp[0] == 0) * 255;
                }
            }
            for px in rgba.as_chunks_mut::<4>().0 {
                px.swap(0, 2);
            }
            Some((rgba, bw, bh))
        } else {
            // 单色：mask 高 2h，上 AND 下 XOR（ICONINFO 约定）；AND 位 0 =
            // 不透明画 XOR 色（1bpp 32bpp 化后 0/255 两值），位 1 = 透明
            if bh % 2 != 0 {
                None
            } else {
                let h = bh / 2;
                let m = mask_buf?;
                let stride = bw as usize * 4;
                let mut rgba = vec![0u8; bw as usize * h as usize * 4];
                for i in 0..(bw * h) as usize {
                    if m[i * 4] == 0 {
                        let g = u8::from(m[h as usize * stride + i * 4] != 0) * 255;
                        rgba[i * 4..i * 4 + 4].copy_from_slice(&[g, g, g, 255]);
                    }
                }
                Some((rgba, bw, h))
            }
        };
        let _ = DeleteObject(HGDIOBJ(mask.0));
        if !color.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(color.0));
        }
        let (rgba, width, height) = decoded?;
        Some(CursorCache {
            handle,
            rgba,
            width,
            height,
            hotspot_x: info.xHotspot,
            hotspot_y: info.yHotspot,
        })
    }
}

/// 帧内叠画当前光标（每帧调用；句柄未变走缓存）。坐标链 = ptScreenPos
///（虚拟屏幕物理像素）- 热区 - 选区原点（显示器绝对）= 帧内左上角
fn overlay_cursor(
    frame: &mut [u8],
    fw: u32,
    fh: u32,
    geo: &GifGeo,
    cache: &mut Option<CursorCache>,
) {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{CURSOR_SHOWING, CURSORINFO, GetCursorInfo};
        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetCursorInfo(&mut ci) }.is_err() {
            return;
        }
        // 系统隐藏光标（触屏/程序隐藏）不画；flags 位测（SHOWING|SUPPRESSED）
        if (ci.flags.0 & CURSOR_SHOWING.0) == 0 {
            return;
        }
        let handle = ci.hCursor.0 as isize;
        if cache.as_ref().map(|c| c.handle) != Some(handle) {
            *cache = decode_cursor(handle);
        }
        if let Some(c) = cache {
            let dx = ci.ptScreenPos.x - c.hotspot_x as i32 - (geo.mon.x + geo.rx as i32);
            let dy = ci.ptScreenPos.y - c.hotspot_y as i32 - (geo.mon.y + geo.ry as i32);
            blend_cursor(frame, fw, fh, c, dx, dy);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (frame, fw, fh, geo, cache);
    }
}

// ── 会话窗（遮罩复用滚动框窗组件；浮条 boot 换装 gifbar）────────────────────

/// 选区遮罩窗：与滚动截图同款（整显示器透明点击穿透窗，前端 ScrollFrame
/// 画选区外遮罩 + 边框角点）——录制期间标示被录区域，内容实时可见
fn show_mask_window(app: &AppHandle, geo: &GifGeo) -> Result<(), String> {
    let mon = &geo.mon;
    let boot = serde_json::json!({
        "window": "frame",
        "x": geo.rx, "y": geo.ry, "w": geo.rw, "h": geo.rh,
        "scale": f64::from(mon.scale),
    });
    let win = match app.get_webview_window("shot-frame") {
        Some(w) => w,
        None => {
            let w =
                WebviewWindowBuilder::new(app, "shot-frame", WebviewUrl::App("shot.html".into()))
                    .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
                    .title("X-Dir GIF 录制")
                    .decorations(false)
                    .resizable(false)
                    .maximizable(false)
                    .minimizable(false)
                    .skip_taskbar(true)
                    .always_on_top(true)
                    .shadow(false)
                    .transparent(true)
                    .focused(false)
                    .visible(false)
                    .initialization_script(format!("window.__BOOT__ = {boot};"))
                    .build()
                    .map_err(|e| format!("创建录制遮罩窗失败：{e}"))?;
            w.set_ignore_cursor_events(true)
                .map_err(|e| format!("录制遮罩窗设置穿透失败：{e}"))?;
            w
        }
    };
    win.set_position(PhysicalPosition::new(mon.x, mon.y))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(mon.w, mon.h))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())
}

/// 录制浮条：停靠选区正下方（bar_layout_sized 定位同滚动；宽度 560——
/// GIF 按钮组含 暂停/保存/取消 + fps/进度条/指针 三 chip，固定 310 时
/// 「开始录制」被窗缘裁掉、480 时加指针 chip 后暂停态偏紧（2026-11-20
/// 用户反馈），定位算法单一来源），持有焦点使 Enter/Esc 生效；boot 换装
/// gifbar（常驻窗复用同款）
fn show_gif_bar_window(app: &AppHandle, geo: &GifGeo) -> Result<(), String> {
    let mon = &geo.mon;
    let s = f64::from(mon.scale);
    let (bx, by, bw, bh) = super::shot_scroll::bar_layout_sized(
        (geo.rx as i32, geo.ry as i32, geo.rw as i32, geo.rh as i32),
        mon,
        (560.0 * s).round() as i32,
        (44.0 * s).round() as i32,
    );
    let boot = serde_json::json!({ "window": "gifbar", "fps": GIF_FPS.load(Ordering::Relaxed), "barOn": GIF_BAR.load(Ordering::Relaxed), "cursorOn": GIF_CURSOR.load(Ordering::Relaxed) });
    let win = match app.get_webview_window("shot-bar") {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, "shot-bar", WebviewUrl::App("shot.html".into()))
            .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
            .title("X-Dir GIF 录制")
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
            .map_err(|e| format!("创建录制浮条失败：{e}"))?,
    };
    win.set_position(PhysicalPosition::new(mon.x + bx, mon.y + by))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(bw, bh))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

/// 结果窗（复用 shot-result 窗，boot kind = gif）：保存 .gif / 打开所在
/// 文件夹；窗销毁时清临时文件（保存的是副本不受影响，滚动结果窗同款）
fn show_gif_result_window(
    app: &AppHandle,
    mon: &MonRect,
    file: &Path,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let s = f64::from(mon.scale);
    // 适配 GIF 尺寸（2026-11-20 用户反馈「预览界面要适合 gif 尺寸」：旧版
    // 高度恒取 80% 屏高，矮 GIF 留大片空白）。内容 = 图（CSS 像素 = 物理/
    // scale）+ 视口 padding 24 + 状态条 ~43；宽钳 [520s, 屏宽-32]，高钳
    // [160, 屏高-120]（含标题栏/任务栏余量）；钳小后靠前端初始缩放适配
    let view_pad = 24.0; // .np-shot-result-view padding 12×2
    let bar_h = 43.0; // .np-shot-result-bar 高（8×2 padding + 26 按钮 + 1 发丝线）
    let css_w = f64::from(w) / s + view_pad + 2.0; // +2 滚动条余量
    let css_h = f64::from(h) / s + view_pad + bar_h;
    let ww = ((css_w * s).round() as i32).clamp(
        (520.0 * s).round() as i32,
        (mon.w as i32 - 32).max((520.0 * s) as i32),
    );
    let wh = ((css_h * s).round() as i32).clamp(160, (mon.h as i32 - 120).max(160));
    let boot = serde_json::json!({
        "window": "result",
        "file": file.to_string_lossy(),
        "w": w,
        "h": h,
        "truncated": false,
        "kind": "gif",
    });
    let win = WebviewWindowBuilder::new(app, "shot-result", WebviewUrl::App("shot.html".into()))
        .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
        .title("X-Dir GIF 录制")
        .decorations(true)
        .resizable(true)
        .minimizable(true)
        .maximizable(true)
        .skip_taskbar(false)
        .always_on_top(true)
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
    let gif_file: PathBuf = file.to_path_buf();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            let _ = std::fs::remove_file(&gif_file);
        }
    });
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

/// 常驻会话窗收场（hide 复用，下一场换装；滚动截图同款免建窗闪屏）
fn hide_windows(app: &AppHandle) {
    for label in ["shot-frame", "shot-bar"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
}

/// 破坏性清理（浮条启动失败）：销毁重建，下一场走冷建路径
fn destroy_windows(app: &AppHandle) {
    for label in ["shot-frame", "shot-bar"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}

/// 原生错误对话框：会话期覆盖窗已收场，前端提示条不可见（滚动同款）
fn dialog_error(app: &AppHandle, msg: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog()
        .message(msg.to_owned())
        .title("X-Dir GIF 录制")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_cs_follows_real_elapsed_and_clamps() {
        // 实际捕获间隔口径：12fps 满速 83ms → 8cs；量化降速 500ms 间隔 →
        // 50cs（回放节奏与录制一致，不快进）；下限 2cs；超大值不回卷
        assert_eq!(gif_delay_cs(83), 8);
        assert_eq!(gif_delay_cs(125), 12);
        assert_eq!(gif_delay_cs(66), 6);
        assert_eq!(gif_delay_cs(500), 50);
        assert_eq!(gif_delay_cs(19), 2);
        assert_eq!(gif_delay_cs(0), 2);
        assert_eq!(gif_delay_cs(300_000), 30_000); // u16 内合法不饱和
    }

    #[test]
    fn normalize_fps_accepts_only_choices() {
        assert_eq!(normalize_fps(8), 8);
        assert_eq!(normalize_fps(12), 12);
        assert_eq!(normalize_fps(15), 15);
        assert_eq!(normalize_fps(30), FPS_DEFAULT);
        assert_eq!(normalize_fps(0), FPS_DEFAULT);
    }

    #[test]
    fn dedup_delay_skips_static_and_flushes_at_cap() {
        // 变化帧恒写：有基线 = 距上一写入帧真实间隔（静止段整段并入，回放
        // 节奏不丢），无基线（首帧）= 目标间隔；重复帧：兜底上限内跳过
        //（None），达上限补兜底帧（延迟 = 上限，防超长延迟兼容问题）
        assert_eq!(dedup_delay(false, Some(83), 83), Some(83));
        assert_eq!(dedup_delay(false, Some(2100), 83), Some(2100));
        assert_eq!(dedup_delay(false, None, 83), Some(83));
        assert_eq!(dedup_delay(true, Some(1900), 83), None);
        assert_eq!(dedup_delay(true, Some(2000), 83), Some(DUP_FLUSH_MS));
        assert_eq!(dedup_delay(true, Some(5100), 83), Some(DUP_FLUSH_MS));
    }

    #[test]
    fn cursor_clip_intersects_and_offsets() {
        // 全在帧内（源偏移 0）；左上越界（源偏移 = 负差值）；右下越界（交集
        // 收缩）；完全出帧（None 不画）
        assert_eq!(
            cursor_clip(10, 20, 32, 32, 200, 100),
            Some((10, 20, 0, 0, 32, 32))
        );
        assert_eq!(
            cursor_clip(-5, -7, 32, 32, 200, 100),
            Some((0, 0, 5, 7, 27, 25))
        );
        assert_eq!(
            cursor_clip(190, 90, 32, 32, 200, 100),
            Some((190, 90, 0, 0, 10, 10))
        );
        assert_eq!(cursor_clip(-40, 0, 32, 32, 200, 100), None);
        assert_eq!(cursor_clip(250, 0, 32, 32, 200, 100), None);
    }

    /// 体积基准（#[ignore] 手跑：`cargo test --lib dedup_size_benchmark
    /// -- --ignored --nocapture`）：合成典型录制内容对比剔除重复帧前后的
    /// 产物体积。编码管线与真实录制完全同源——NeuQuant speed 档（
    /// quant_speed）、帧延迟口径（gif_delay_cs）、剔除决策（dedup_delay）、
    /// 尾巴收帧、循环块，差异只有帧内容来源（合成 vs 真实屏幕）
    #[test]
    #[ignore = "体积基准手跑（约 15s 逐帧量化），日常 CI 不跑"]
    fn dedup_size_benchmark() {
        // 场景 = 480×300 选区 @12fps 录 10s（120 帧，间隔 83ms）：
        // A 静止为主（教程典型：约每 7 帧一次变化） / B 全程动态（逐帧变化）
        let (w, h) = (480u16, 300u16);
        let interval = 1000 / 12u64;
        let total = 120usize;
        // LCG 伪随机噪声底图（避免纯色量化失真不真实）
        let mut rng = 0x2545_F491_4F6C_DD1Du64;
        let mut next_px = move || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng >> 24) as u8
        };
        let mut base = vec![0u8; w as usize * h as usize * 4];
        for y in 0..h as usize {
            for x in 0..w as usize {
                let p = (y * w as usize + x) * 4;
                base[p] = next_px();
                base[p + 1] = (x * 255 / w as usize) as u8;
                base[p + 2] = (y * 255 / h as usize) as u8;
                base[p + 3] = 255;
            }
        }
        // 帧序列：every = 变化间隔帧数；变化帧 = 移动 24×24 色块（擦除式
        // 重画，同光标/弹窗语义），其余帧与当前内容逐字节相同
        let make_frames = |every: usize| -> Vec<Vec<u8>> {
            let mut out = Vec::with_capacity(total);
            let mut cur = base.clone();
            for i in 0..total {
                if i % every == 0 {
                    let mut f = base.clone();
                    let bx = (i as u32 * 5) % (u32::from(w) - 48);
                    let by = (i as u32 * 3) % (u32::from(h) - 48);
                    for y in by..by + 24 {
                        for x in bx..bx + 24 {
                            let p = (y as usize * w as usize + x as usize) * 4;
                            f[p] = 240;
                            f[p + 1] = 80;
                            f[p + 2] = 40;
                            f[p + 3] = 255;
                        }
                    }
                    cur = f;
                }
                out.push(cur.clone());
            }
            out
        };
        // 编码模拟（dedup = 新管线；否则旧管线逐帧全写）
        let encode = |frames: &[Vec<u8>], dedup: bool| -> (usize, u32) {
            let mut buf: Vec<u8> = Vec::new();
            let mut enc = gif::Encoder::new(&mut buf, w, h, &[]).unwrap();
            enc.set_repeat(gif::Repeat::Infinite).unwrap();
            let mut prev: Option<Vec<u8>> = None;
            let mut last_written = 0u64;
            let mut frames_n = 0u32;
            for (i, f) in frames.iter().enumerate() {
                let now = (i as u64 + 1) * interval;
                let mut rgba = f.clone();
                let is_dup = prev.as_deref() == Some(rgba.as_slice());
                let delay_ms = if dedup {
                    match dedup_delay(is_dup, Some(now - last_written), interval) {
                        Some(d) => d,
                        None => continue, // 静止帧剔除
                    }
                } else {
                    interval
                };
                if !is_dup {
                    prev = Some(rgba.clone());
                }
                let mut g = gif::Frame::from_rgba_speed(
                    w,
                    h,
                    &mut rgba,
                    quant_speed(u32::from(w) * u32::from(h)),
                );
                g.delay = gif_delay_cs(delay_ms);
                enc.write_frame(&g).unwrap();
                frames_n += 1;
                last_written = now;
            }
            // 尾巴收帧（新管线口径）
            if dedup {
                let tail = total as u64 * interval - last_written;
                if tail >= 100 {
                    if let Some(mut p) = prev.take() {
                        let mut g = gif::Frame::from_rgba_speed(
                            w,
                            h,
                            &mut p,
                            quant_speed(u32::from(w) * u32::from(h)),
                        );
                        g.delay = gif_delay_cs(tail);
                        enc.write_frame(&g).unwrap();
                        frames_n += 1;
                    }
                }
            }
            drop(enc);
            (buf.len(), frames_n)
        };
        let frames_a = make_frames(7);
        let frames_b = make_frames(1);
        let (old_a, fa) = encode(&frames_a, false);
        let (new_a, na) = encode(&frames_a, true);
        let (old_b, fb) = encode(&frames_b, false);
        let (new_b, nb) = encode(&frames_b, true);
        println!(
            "场景 A 静止为主（10s@12fps，每 7 帧一变）：{} KB / {} 帧 → {} KB / {} 帧（体积 -{}%）",
            old_a / 1024,
            fa,
            new_a / 1024,
            na,
            100 - (new_a * 100 / old_a)
        );
        println!(
            "场景 B 全程动态（10s@12fps，逐帧变化）：{} KB / {} 帧 → {} KB / {} 帧（体积 {}{}%）",
            old_b / 1024,
            fb,
            new_b / 1024,
            nb,
            if new_b <= old_b { "-" } else { "+" },
            old_b.abs_diff(new_b) * 100 / old_b
        );
        // 断言：静止场景剔除收益过半；动态场景不劣化（>5% 即回归）
        assert!(new_a < old_a / 2, "静止场景应省过半体积");
        assert!(new_b * 20 < old_b * 21, "动态场景不应明显变大");
    }

    #[test]
    fn append_progress_bar_extends_and_fills() {
        // 两帧 8×4 GIF：合成后高 +8（进度条），帧 1 底条半填充（fill=w×1/2）、
        // 帧 2 全填充；轨道深色在填充段之外
        let dir = std::env::temp_dir().join(format!("xdir-gifbar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bar_test.gif");
        let (w, h) = (8u16, 4u16);
        {
            let mut buf = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
            let mut enc = gif::Encoder::new(&mut buf, w, h, &[]).unwrap();
            for (i, (r, g, b)) in [(255u8, 255u8, 255u8), (0u8, 255u8, 0u8)]
                .iter()
                .enumerate()
            {
                let mut rgba = vec![0u8; usize::from(w) * usize::from(h) * 4];
                for px in rgba.chunks_exact_mut(4) {
                    px[0] = *r;
                    px[1] = *g;
                    px[2] = *b;
                    px[3] = 255;
                }
                let mut frame = gif::Frame::from_rgba_speed(w, h, &mut rgba, 10);
                frame.delay = if i == 0 { 5 } else { 9 };
                enc.write_frame(&frame).unwrap();
            }
        }
        append_progress_bar(&path).unwrap();
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::RGBA);
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::RGBA);
        let mut dec = options
            .read_info(std::fs::File::open(&path).unwrap())
            .unwrap();
        // 条高护栏 = min(PROGRESS_BAR_H, 帧高)：测试帧仅 4px 高
        let expect_bar = PROGRESS_BAR_H.min(u32::from(h));
        assert_eq!(
            u32::from(dec.height()),
            u32::from(h) + expect_bar,
            "画布应向下扩进度条"
        );
        let mut delays: Vec<u16> = Vec::new();
        let mut fills: Vec<(bool, bool)> = Vec::new(); // (左半=填充色, 右半=轨道色)
        let stride = usize::from(w) * 4; // dec 不可在 read_next_frame 借用期取值，用已知宽
        while let Some(frame) = dec.read_next_frame().unwrap() {
            delays.push(frame.delay);
            // 底条第一行的左半与右半采样（y = h，即进度条行）
            let row = usize::from(h) * stride;
            let left = &frame.buffer[row + 4..row + 8];
            let right = &frame.buffer[row + (usize::from(w) / 2) * 4 + 4..][..4];
            fills.push((left[0] == 53, right[0] == 26));
        }
        assert_eq!(delays, vec![5u16, 9u16], "帧延迟应逐帧保留");
        assert_eq!(
            fills,
            vec![(true, true), (true, false)],
            "帧 1 右半仍轨道色（半填充）、帧 2 全填充"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn gif_encode_decode_roundtrip() {
        // 内存编码两帧（不同颜色 + 不同延迟）→ 解码回读：尺寸/帧数/延迟对齐
        let (w, h) = (16u16, 8u16);
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut enc = gif::Encoder::new(&mut buf, w, h, &[]).unwrap();
            for (i, (r, delay)) in [(255u8, 8u16), (0u8, 13u16)].iter().enumerate() {
                let mut rgba = vec![0u8; usize::from(w) * usize::from(h) * 4];
                for px in rgba.chunks_exact_mut(4) {
                    px[0] = *r;
                    px[1] = if i == 0 { 128 } else { 64 };
                    px[2] = 0;
                    px[3] = 255;
                }
                let mut frame = gif::Frame::from_rgba_speed(w, h, &mut rgba, 10);
                frame.delay = *delay;
                enc.write_frame(&frame).unwrap();
            }
        }
        let mut dec = gif::Decoder::new(&buf[..]).unwrap();
        assert_eq!(dec.width(), w);
        assert_eq!(dec.height(), h);
        let mut delays: Vec<u16> = Vec::new();
        while let Some(frame) = dec.read_next_frame().unwrap() {
            delays.push(frame.delay);
        }
        assert_eq!(delays.len(), 2, "应有两帧");
        assert_eq!(delays, vec![8u16, 13u16], "帧延迟应逐帧保留");
    }

    #[test]
    fn encoder_writes_netscape_loop_block() {
        // 循环播放扩展（NETSCAPE2.0，2026-11-20「预览要支持播放」根因修复）：
        // set_repeat(Infinite) 必须在写帧前调用 → 产物含循环块，浏览器无限
        // 循环；漏写 = 只播一遍呈静止帧
        let mut buf: Vec<u8> = Vec::new();
        let mut enc = gif::Encoder::new(&mut buf, 4, 4, &[]).unwrap();
        enc.set_repeat(gif::Repeat::Infinite).unwrap();
        let mut rgba = vec![255u8; 4 * 4 * 4];
        let frame = gif::Frame::from_rgba_speed(4, 4, &mut rgba, 10);
        enc.write_frame(&frame).unwrap();
        drop(enc);
        assert!(
            buf.windows(11).any(|w| w == b"NETSCAPE2.0"),
            "GIF 应含 NETSCAPE2.0 循环块"
        );
    }
}
