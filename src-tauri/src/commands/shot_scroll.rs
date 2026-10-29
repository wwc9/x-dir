// 滚动长截图（§3.6 二期 B 批，2026-10-24 首版；2026-10-28 改手动滚轮模式；
// 2026-10-29 改「选区保留 + 侧边实时预览」）：
// 框选滚动区 → 覆盖窗隐藏、弹两窗：选区框窗（label "shot-frame"，整显示器
// 透明窗点击穿透，画选区外遮罩+边框——选区内容保持可交互，用户滚的是下面
// 的真实窗口）和
// 侧边预览窗（label "shot-scroll"，贴选区右/左侧，实时显示已拼长图，底部
// 完成/取消）→ WH_MOUSE_LL 低级鼠标钩子监听用户滚轮〔光标在选区内：下滚记
// 时刻置待捕获；上滚只置标记——"下滚持续截图、上滚不动"〕→ 循环线程在下滚
// 静默窗（合并连滚/惯性）后 capture_region 实时捕获 → NCC 两带共识模板匹配求
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
/// 下滚事件后的静默窗：滚轮停歇此时长才收尾帧（合并连滚/惯性）。步长越小
/// 帧间行程越小，位移歧义（周期性自相似页面的并列峰）越少
const QUIET: Duration = Duration::from_millis(160);
/// 滚动进行中的流式增量帧：最小捕获间隔（每帧行程小，必落在匹配域内——
/// 首版只做停歇合并，一格连滚 > 选区高时帧间无重叠、匹配必败，实测事故）
const STREAM_GAP: Duration = Duration::from_millis(80);
/// 流式帧的单击渲染等待
const TICK_SETTLE: Duration = Duration::from_millis(30);
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
/// 已拼长图成品（会话收尾置入，下一场 begin 清）：复制命令直供内存，
/// 免去大 PNG 落盘后重新解码（200MP 级 PNG 解码秒级）
static SCROLL_IMAGE: Mutex<Option<RgbaImage>> = Mutex::new(None);
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

// ── 纵向位移匹配（NCC 两带共识模板匹配，自研实现；有符号）──────────────────
//
// 参考 Apache-2.0 项目的公开数学（OpenCV matchTemplate 的 TM_CCOEFF_NORMED
// 归一化互相关公式，未复制其代码）：prev 两条全宽横带在 cur 中搜索归一化互
// 相关峰值。相比旧 SAD 逐点差：NCC 对全局亮度变化（hover 态/光标/对比度
// 漂移）不变，归一化分母杜绝「低方差区域假零差」误配。稳健性三件套：
//   1. 1/4 分辨率粗搜全范围 → 全分辨率 ±4px 两带精化（速度）；
//   2. A/B 双带（帧高 50% 与 25% 起，避开 <20%h 的 sticky header）精化后
//      独立求峰，分歧 >1px 拒绝（局部动态内容/视差）；
//   3. 绝对置信门槛 NCC_MIN（换页/加载动画拒绝）+ 并列取 |dy| 小（周期性
//      列表/空白底安全落到小位移与到底检测）。
// AOSP 的滚动截图（同 Apache-2.0）走 App 协作 API，图块坐标由应用精确提供、
// 无像素匹配，对外部截屏场景不适用，未采用其流程。

/// 匹配带纵位（帧高占比）：T 顶带管大负位移（上滚回看 + 聊天页流式输出
/// 把可视内容整体下推——帧转储实测 -1424px 超旧负向覆盖 -0.65h → 假峰
/// +33 → 整帧重复）、B 上中、A 中部；末带由 h-th 底锚（band_tops 追加）
/// 管大正位移（快速下滚，单帧行程可达 0.9375h）。可见行 < 半带的位置不计
/// 分；顶带贴 selection 顶缘，sticky header 在选区内时会污染其上部，靠多
/// 带均值 + 投票共识兜底
const BAND_FRACS: [f32; 3] = [0.03, 0.25, 0.5];
/// 最终多带平均 NCC 下限：低于 = 内容已变（换页/动态刷新），置信不足拒绝
const NCC_MIN: f32 = 0.55;
/// 并列判定：精化后分差在此以内视为同分，取 |dy| 更小者（周期列表/纯色底
/// 的多峰等价场景落小位移，也使未滚动帧落到 0 供到底检测）
const TIE_EPS: f32 = 0.02;

/// 帧灰度 + 两级 2×2 均值降采样（全分辨率精化 / 1/4 粗搜）
struct GrayPyr {
    full: Vec<u8>,
    quarter: Vec<u8>,
}

impl GrayPyr {
    fn new(img: &RgbaImage) -> Self {
        let (w, h) = img.dimensions();
        let mut full = Vec::with_capacity((w * h) as usize);
        for p in img.pixels() {
            let c = p.0;
            full.push(
                ((i32::from(c[0]) * 299 + i32::from(c[1]) * 587 + i32::from(c[2]) * 114) / 1000)
                    as u8,
            );
        }
        let (half, hw, hh) = downsample2(&full, w, h);
        let (quarter, _, _) = downsample2(&half, hw, hh);
        Self { full, quarter }
    }
}

/// 2×2 均值降采样（奇数尾行/列丢弃）
fn downsample2(src: &[u8], w: u32, h: u32) -> (Vec<u8>, u32, u32) {
    let (ow, oh) = (w / 2, h / 2);
    let mut out = Vec::with_capacity((ow * oh) as usize);
    for y in 0..oh {
        let (y0, y1) = ((y * 2) as usize, (y * 2 + 1) as usize);
        for x in 0..ow {
            let x0 = (x * 2) as usize;
            let s = (u16::from(src[y0 * w as usize + x0])
                + u16::from(src[y0 * w as usize + x0 + 1])
                + u16::from(src[y1 * w as usize + x0])
                + u16::from(src[y1 * w as usize + x0 + 1]))
                / 4;
            out.push(s as u8);
        }
    }
    (out, ow, oh)
}

/// 单带归一化互相关求值器：持有一对灰度帧（t=prev / i=cur）与匹配列域
/// [x0, x1)（静止页边距/侧栏列被 active_cols 排除，全宽传 (0, w)）。
/// TM_CCOEFF_NORMED 公式；col_step 列抽稀提速。分母近零（低方差）时：双方
/// 皆低方差 = 同色块记满分，仅一方低方差 = 无结构不可比记 0。返回
/// (score, 可见行数)
struct Ncc<'a> {
    t: &'a [u8],
    i: &'a [u8],
    w: usize,
    x0: usize,
    x1: usize,
}

impl Ncc<'_> {
    fn band(&self, top: usize, th: usize, d: i32, col_step: usize) -> (f32, usize) {
        let h = self.i.len() / self.w;
        // 模板行 r 对应 cur 行 r-d，可见域：0 ≤ r-d < h → r ∈ [max(top,d) .. min(top+th, d+h))
        let r0 = (i64::from(top as i32).max(i64::from(d)).max(0)) as usize;
        let r1 = (i64::from((top + th) as i32)
            .min(i64::from(d) + h as i64)
            .max(0)) as usize;
        let rows = r1.saturating_sub(r0);
        if rows == 0 || self.x1 <= self.x0 {
            return (0.0, 0);
        }
        let cols = (self.x1 - self.x0).div_ceil(col_step);
        let (mut st, mut si, mut stt, mut sii, mut sti) = (0i64, 0i64, 0i64, 0i64, 0i64);
        for r in r0..r1 {
            let tr = &self.t[r * self.w..];
            let ir = &self.i[((r as i64) - i64::from(d)) as usize * self.w..];
            let mut x = self.x0;
            while x < self.x1 {
                let tv = i64::from(tr[x]);
                let iv = i64::from(ir[x]);
                st += tv;
                si += iv;
                stt += tv * tv;
                sii += iv * iv;
                sti += tv * iv;
                x += col_step;
            }
        }
        let nf = (rows * cols) as f64;
        let (vt, vi) = (
            nf * stt as f64 - (st as f64) * (st as f64),
            nf * sii as f64 - (si as f64) * (si as f64),
        );
        if vt < 1.0 || vi < 1.0 {
            return (if vt < 1.0 && vi < 1.0 { 1.0 } else { 0.0 }, rows);
        }
        let num = nf * sti as f64 - (st as f64) * (si as f64);
        ((num / (vt * vi).sqrt()) as f32, rows)
    }
}

/// 活动列域检测：帧间逐列平均绝对差（隔行采样 + ±2 列平滑）。滚动页常见
/// 「左右定宽页边距/侧栏静止、中间内容滚动」——全宽横带会被静止列支配产生
/// d≈0 假峰，真实位移与零位移并列后按并列策略落小位移 → 拼接大段重复（实
/// 测事故）。返回最长显著变化列段 [x0, x1)（段内允许 ≤5%w 静止小岛：内容
/// 留白列）；无显著变化列（帧静止/仅光标动）返回 None，调用方回退全宽。
fn active_cols(prev: &[u8], cur: &[u8], w: usize, h: usize) -> Option<(usize, usize)> {
    let mut diff = vec![0i64; w];
    let step = (h / 48).max(1);
    let mut rows = 0u64;
    let mut y = 0;
    while y < h {
        let (rp, rc) = (&prev[y * w..][..w], &cur[y * w..][..w]);
        for (x, (a, b)) in rp.iter().zip(rc.iter()).enumerate() {
            diff[x] += i64::from(a.abs_diff(*b));
        }
        rows += 1;
        y += step;
    }
    let f = rows as f64;
    let sig = |x: usize| -> bool {
        let lo = x.saturating_sub(2);
        let hi = (x + 3).min(w);
        (lo..hi).map(|i| diff[i] as f64 / f).sum::<f64>() / (hi - lo) as f64 > 3.0
    };
    let gap = (w / 20).max(4);
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let (mut start, mut last_true) = (None, 0usize);
    for x in 0..w {
        if sig(x) {
            start = start.or(Some(x));
            last_true = x;
        } else if let Some(st) = start.take_if(|_| x - last_true > gap) {
            runs.push((st, last_true + 1));
        }
    }
    if let Some(st) = start {
        runs.push((st, last_true + 1));
    }
    let (x0, x1) = runs.into_iter().max_by_key(|r| r.1 - r.0)?;
    (x1 - x0 >= 16).then_some((x0, x1))
}

/// 求 cur 相对 prev 的纵向位移 dy（有符号）：dy>0 = 内容上移（用户下滚，
/// 底部新内容 = cur 底部 [h-dy..h)）；dy<0 = 内容下移 |dy|（用户上滚回看）。
fn match_scroll_dy(prev: &RgbaImage, cur: &RgbaImage) -> Option<i32> {
    let (w, h) = (prev.width(), prev.height());
    if cur.width() != w || cur.height() != h || h < 120 {
        return None;
    }
    // 带高 = 帧高 1/8（4 的倍数）：带越靠下可见域越远，窄带把正位移覆盖推到
    // h - th/2 ≈ 0.9375h（每 tick 滚动接近整屏的场景）
    let th = ((h as usize) / 8 / 4 * 4).clamp(16, 320);
    let band_tops: Vec<usize> = BAND_FRACS
        .iter()
        .map(|f| (h as f32 * f) as usize / 4 * 4)
        .chain(std::iter::once(h as usize - th))
        .collect();
    let w4 = (w / 4) as usize;
    let thq = th / 4;
    let pf = GrayPyr::new(prev);
    let cf = GrayPyr::new(cur);
    // 匹配列域：排除静止页边距/侧栏（None = 全宽）
    let (cx0, cx1) =
        active_cols(&pf.full, &cf.full, w as usize, h as usize).unwrap_or((0, w as usize));
    let fq = Ncc {
        t: &pf.quarter,
        i: &cf.quarter,
        w: w4,
        x0: cx0 / 4,
        x1: cx1.div_ceil(4).min(w4),
    };
    let ff = Ncc {
        t: &pf.full,
        i: &cf.full,
        w: w as usize,
        x0: cx0,
        x1: cx1,
    };

    // ── 粗搜（1/4 分辨率，三带均值，扩展域 ±(h - th/2)——各带可见域并集，
    //    覆盖单帧 ~0.85h 的大行程滚动）────────────────────────────────────
    let (d_lo, d_hi) = (-(h as i32) + th as i32 / 2, h as i32 - th as i32 / 2);
    let mut scores: Vec<(i32, f32)> = Vec::with_capacity(((d_hi - d_lo) / 4 + 1) as usize);
    // 步长 1 个 1/4 像素全量扫（步长 2 有奇偶盲区：真峰落在网格外时粗搜
    // 打分缺失、候选集丢失真峰——hash 纹理单测实证）。列采样 ×8 控耗时
    for d in (d_lo / 4)..=(d_hi / 4) {
        let (mut sum, mut cnt) = (0.0f32, 0u32);
        for &bt in &band_tops {
            let (s2, rows) = fq.band(bt / 4, thq, d, 8);
            if rows >= thq / 2 {
                sum += s2;
                cnt += 1;
            }
        }
        if cnt > 0 {
            scores.push((d, sum / cnt as f32));
        }
    }
    let &(_, best_s) = scores.iter().max_by(|a, b| a.1.total_cmp(&b.1))?;
    // 候选 = 分离度（≥半带高）约束下的最高 3 峰 + 近并列中 |d| 最小者
    let mut ranked: Vec<(i32, f32)> = scores.clone();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut cands: Vec<i32> = Vec::new();
    for &(d, _) in &ranked {
        if cands.iter().all(|c| (*c - d).abs() >= thq as i32 / 2) {
            cands.push(d);
            if cands.len() == 3 {
                break;
            }
        }
    }
    let near_small = scores
        .iter()
        .filter(|(_, s)| *s >= best_s - TIE_EPS)
        .min_by_key(|(d, _)| (d.unsigned_abs(), -*d))
        .map(|(d, _)| *d);
    if let Some(sd) = near_small.filter(|sd| !cands.contains(sd)) {
        cands.push(sd);
    }

    // ── 精化（全分辨率，候选 ±4px，A/B 带平均分）──────────────────────────
    let mut refined: Vec<(i32, f32)> = Vec::with_capacity(cands.len());
    for &cd in &cands {
        let base = cd * 4;
        let mut local: Option<(i32, f32)> = None;
        for d in (base - 4)..=(base + 4) {
            if !(d_lo..=d_hi).contains(&d) {
                continue;
            }
            // 可见不足半带的带不计入（大位移场景边带自然退出）
            let (mut sum, mut cnt) = (0.0f32, 0u32);
            for &bt in &band_tops {
                let (s2, rows) = ff.band(bt, th, d, 2);
                if rows >= th / 2 {
                    sum += s2;
                    cnt += 1;
                }
            }
            if cnt == 0 {
                continue;
            }
            let avg = sum / cnt as f32;
            // 并列（±TIE_EPS）取 (|d|,-d) 字典序更小者：|d| 小优先，
            // 同 |d| 偏正位移（捕获只发生在下滚后，对称并列取内容上移向）
            match local {
                Some((_, bs)) if avg < bs - TIE_EPS => {}
                Some((bd, bs)) if avg <= bs + TIE_EPS => {
                    if (d.unsigned_abs(), -d) < (bd.unsigned_abs(), -bd) {
                        local = Some((d, avg));
                    }
                }
                _ => local = Some((d, avg)),
            }
        }
        if let Some((d, s)) = local {
            refined.push((d, s));
        }
    }
    let (mut dy, mut score) = refined.iter().copied().max_by(|a, b| a.1.total_cmp(&b.1))?;
    // 并列同分取 (|dy|,-dy) 字典序小（cands 已含近并列最小 |d| 成员）
    for &(d, s) in &refined {
        if s >= score - TIE_EPS && (d.unsigned_abs(), -d) < (dy.unsigned_abs(), -dy) {
            dy = d;
            score = s;
        }
    }
    // 验收门槛看最佳带而非均分：流式输出/动态区域只污染部分画面高度，把
    // 均分拖垮（帧转储实证：真实 +764px、全宽 NCC 0.80 的帧被均分误杀）；
    // 任一水平区域强相关即采信，配合下方投票共识防伪
    let mut best_band = f32::MIN;
    for &bt in &band_tops {
        let (s2, rows) = ff.band(bt, th, dy, 2);
        if rows >= th / 2 {
            best_band = best_band.max(s2);
        }
    }
    if best_band < NCC_MIN {
        return None;
    }
    // ── 歧义拒绝：周期性自相似页面（聊天气泡/列表行）在非零位移处出现
    // 近并列峰时，两帧原理上无法分辨真实位移——取小拼重复、取大挖缺失，
    // 都比不上留白。诚实拒绝（None → bad_streak，下一帧重试），唯一豁免是
    // 并列 winner 为 0（未滚动/纯色底，到底检测依赖它，且不追加不产生重复）
    if dy != 0
        && refined
            .iter()
            .any(|&(d, s)| d != dy && s >= score - TIE_EPS)
    {
        log::debug!("滚动截图：位移并列 {refined:?}，拒绝");
        return None;
    }
    // ── 多带共识：各带在终选 ±6px 内独立求峰；定位良好的带（可见 ≥3/4 带
    //    高）投票，任意两票分歧 >2px 拒绝（整数位移下带间应一致，超出 = 非
    //    均匀滚动/视差）；不足两票则依赖 NCC_MIN 门槛起步
    let argmax = |top: usize, lo: i32, hi: i32| -> Option<i32> {
        let mut pts: Vec<(i32, f32)> = Vec::new();
        for d in lo..=hi {
            let (s2, rows) = ff.band(top, th, d, 2);
            if rows >= th / 2 {
                pts.push((d, s2));
            }
        }
        let best = pts.iter().map(|p| p.1).fold(f32::MIN, f32::max);
        pts.iter()
            .filter(|(_, s2)| *s2 >= best - TIE_EPS)
            .min_by_key(|(d, _)| (d.unsigned_abs(), -*d))
            .map(|(d, _)| *d)
    };
    let w6 = 6i32;
    let mut votes: Vec<i32> = Vec::new();
    for &bt in &band_tops {
        let (_, rows) = ff.band(bt, th, dy, 2);
        if rows * 4 >= th * 3
            && let Some(dv) = argmax(bt, dy - w6, dy + w6)
        {
            votes.push(dv);
        }
    }
    for i in 0..votes.len() {
        for j in i + 1..votes.len() {
            if (votes[i] - votes[j]).abs() > 2 {
                log::debug!("滚动截图：多带分歧 {votes:?}，拒绝");
                return None;
            }
        }
    }
    Some(dy)
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

    /// 消耗画布取图（缓冲所有权转移，免整图拷贝）
    fn into_image(mut self) -> Option<RgbaImage> {
        RgbaImage::from_raw(self.w, self.h, std::mem::take(&mut self.buf))
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

/// 控制条停靠位（纯函数，单测锁定）：选区正下方居中（PixPin 样式），下方
/// 放不下翻选区上方，均钳屏内。窗尺寸固定 (310,44)·scale，返回左上角与尺寸
/// （显示器相对物理像素）
fn bar_layout(sel: (i32, i32, i32, i32), mon: &MonRect) -> (i32, i32, u32, u32) {
    let s = f64::from(mon.scale);
    let bw = (310.0 * s).round() as i32;
    let bh = (44.0 * s).round() as i32;
    let (gx, gy, gw, gh) = sel;
    let x = (gx + (gw - bw) / 2).clamp(8, (mon.w as i32 - bw - 8).max(8));
    let gap = (10.0 * s).round() as i32;
    let mut y = gy + gh + gap;
    if y + bh > mon.h as i32 - 8 {
        y = gy - gap - bh;
    }
    let y = y.clamp(8, (mon.h as i32 - bh - 8).max(8));
    (x, y, bw.max(1) as u32, bh.max(1) as u32)
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
    for label in ["shot-scroll", "shot-frame", "shot-bar"] {
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
    *SCROLL_IMAGE.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
    log::info!("滚动截图：第二段进场，150ms 后就位三窗并起循环");
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        // 三窗常驻（首场后 hide 不销毁）：boot/几何事件先行——页面在 webview
        // 线程换装，与主线程建窗/显示并行，无闪屏空窗期。首场窗尚不存在，
        // 事件落空无害（initialization_script 已带同款初始载荷）
        let _ = app2.emit_to(
            "shot-frame",
            "shot-frame-geom",
            serde_json::json!({
                "x": geo.rx, "y": geo.ry, "w": geo.rw, "h": geo.rh,
                "scale": f64::from(geo.mon.scale),
            }),
        );
        let _ = app2.emit_to(
            "shot-scroll",
            "shot-preview-boot",
            serde_json::json!({ "w": geo.rw, "h": geo.rh }),
        );
        let _ = app2.emit_to(
            "shot-bar",
            "shot-bar-boot",
            serde_json::json!({ "w": geo.rw }),
        );
        std::thread::sleep(Duration::from_millis(120));
        let runner = app2.clone();
        let dispatch = runner.run_on_main_thread(move || {
            // 框窗纯装饰，失败只记日志不流产；预览窗/控制条失败 = 会话流产
            //（弹原生对话框——覆盖窗已收场，无前端提示条可依赖）
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
            if let Err(e) = show_bar_window(&app2, &geo) {
                log::error!("滚动截图：{e}");
                destroy_session_windows(&app2);
                quit_hook();
                SCROLL_ACTIVE.store(false, Ordering::Relaxed);
                dialog_error(&app2, &format!("滚动截图控制条创建失败：{e}（请重新截图）"));
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

/// dev 构建帧转储（离线分析真位移用）：base 与每个捕获帧写裸 RGB（行主序，
/// 尺寸入文件名）到临时目录 scroll_dump/{会话戳}/（xdir_shot 的兄弟目录，
/// 免遭启动期 cleanup_stale 整删）；保留最近 2 个会话目录。release 构建
/// 零开销（编译期剔除）
#[cfg(debug_assertions)]
fn dump_frame(dir: &Path, name: &str, frame: &RgbaImage) {
    let (w, h) = frame.dimensions();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for p in frame.pixels() {
        let c = p.0;
        rgb.extend_from_slice(&[c[0], c[1], c[2]]);
    }
    let path = dir.join(format!("{name}_{w}x{h}.rgb"));
    if let Err(e) = std::fs::write(&path, &rgb) {
        log::debug!("滚动截图：帧转储失败 {name}: {e}");
    }
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
    #[cfg(debug_assertions)]
    let dump_dir = {
        let root = shot_dir()
            .parent()
            .map(|p| p.join("xdir_scroll_dump"))
            .unwrap_or_else(|| shot_dir().join("scroll_dump"));
        let _ = std::fs::create_dir_all(&root);
        // 只留最近 2 个会话目录
        let mut olds: Vec<_> = std::fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir())
            .collect();
        olds.sort_by_key(|e| e.file_name());
        if olds.len() > 2 {
            for o in &olds[..olds.len() - 2] {
                let _ = std::fs::remove_dir_all(o.path());
            }
        }
        let d = root.join(format!("{}", millis()));
        let _ = std::fs::create_dir_all(&d);
        (d, true)
    };
    let mut last = base;
    #[cfg(debug_assertions)]
    if dump_dir.1 {
        dump_frame(&dump_dir.0, "b000", &last);
    }
    let mut zero_streak = 0u32;
    #[cfg(debug_assertions)]
    let mut dump_seq = 0u32;
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
                    Ok(frame) => {
                        #[cfg(debug_assertions)]
                        {
                            dump_seq += 1;
                            if dump_dir.1 {
                                dump_frame(&dump_dir.0, &format!("f{dump_seq:03}"), &frame);
                            }
                        }
                        match match_scroll_dy(&last, &frame) {
                            // 内容上移 ≥2px：底部新内容追加。下滚 dy 后新内容
                            // 在 cur 的底部 dy 行 [h-dy..h)；顶部 [0..h-dy) 是与
                            // 上一帧的重叠区（追加它 = 整屏重复、丢真新内容
                            // ——历轮「重复」事故的终极根因）
                            Some(dy) if dy >= 2 => {
                                zero_streak = 0;
                                bad_streak = 0;
                                canvas
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .push(&frame, rh - dy as u32);
                                last = frame;
                                let ch = canvas.lock().unwrap_or_else(|e| e.into_inner()).h;
                                log::debug!(
                                    "滚动截图：滚动 {dy}px，新增 {}px，累计 {ch}px（钩子 {ticks} ticks）",
                                    rh - dy as u32
                                );
                                emit_height(&app, ch);
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
                        }
                    }
                    Err(e) => {
                        log::error!("滚动截图：帧捕获失败：{e}");
                        // 捕获错误与匹配失败同口径：滚动中可能是 DXGI 瞬时繁忙，
                        // 静默后才计截断
                        let settled_now = WHEEL_DOWN
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .is_some_and(|t| now.duration_since(t) >= QUIET);
                        if !settled_now {
                            let _ = app.emit_to("shot-bar", "shot-scroll-fast", ());
                        }
                        if settled_now {
                            bad_streak += 1;
                            if bad_streak >= BAD_STREAK {
                                truncated = true;
                                break;
                            }
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
        hide_session_windows(&app);
        return;
    }
    let h = canvas.lock().unwrap_or_else(|e| e.into_inner()).h;
    if truncated {
        log::info!("滚动截图：动态内容/捕获异常截断，累计 {h}px");
    }
    // into_image：缓冲所有权直移，免整图拷贝
    let img = {
        let mut c = canvas.lock().unwrap_or_else(|e| e.into_inner());
        let cw = c.w;
        std::mem::replace(&mut *c, CanvasBuf::new(cw)).into_image()
    };
    match img {
        Some(img) => end_scroll(&app, mon, Some(img), truncated),
        None => {
            log::error!("滚动截图：拼接缓冲转图失败");
            end_scroll(&app, mon, None, false)
        }
    }
}

fn emit_height(app: &AppHandle, height: u32) {
    // 预览窗（触发增量拉取）与控制条（尺寸显示）都消费进度
    for label in ["shot-scroll", "shot-bar"] {
        let _ = app.emit_to(
            label,
            "shot-scroll-progress",
            serde_json::json!({ "height": height }),
        );
    }
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

/// 关闭本会话全部窗口（预览窗 + 选区框窗 + 控制条；destroy 而非 close：
/// close 走 CloseRequested 语义，实测偶发不奏效留僵尸）
/// 常驻会话窗收场：hide 不销毁——下一场直接换装复用，免 WebView2 建窗
/// 闪屏（三窗重建 600-900ms 是启动闪烁主因）。窗内页面保持存活，boot/
/// 几何事件驱动换装
fn hide_session_windows(app: &AppHandle) {
    for label in ["shot-scroll", "shot-frame", "shot-bar"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
}

/// 破坏性清理（启动失败/僵尸窗）：销毁重建，下一场走冷建路径
fn destroy_session_windows(app: &AppHandle) {
    for label in ["shot-scroll", "shot-frame", "shot-bar"] {
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
    // 常驻窗收场（hide 复用），结果窗随后独占交互
    hide_session_windows(app);
    let Some(img) = img else {
        log::error!("滚动截图：无拼接结果可出（启动/收场异常）");
        dialog_error(app, "滚动截图未能生成结果（启动异常），请重新截图");
        return;
    };
    // 成品入内存静态：复制命令直供，免大 PNG 解码；随下一场 begin 清除
    *SCROLL_IMAGE.lock().unwrap_or_else(|e| e.into_inner()) = Some(img.clone());
    let dir = shot_dir();
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join(format!("scroll_{}.png", millis()));
    // 临时中转 PNG 用快速压缩（Fast + Up 行滤波：截图行相关性好，速度优先
    // ——image 默认 deflate 慢一个量级，200MP 级编码阻塞结果窗出现）
    use image::ImageEncoder as _;
    let png_result = std::fs::File::create(&file).and_then(|f| {
        let encoder = image::codecs::png::PngEncoder::new_with_quality(
            std::io::BufWriter::new(f),
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Up,
        );
        encoder
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(std::io::Error::other)
    });
    if let Err(e) = png_result {
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

/// 选区框窗：整显示器透明窗（点击穿透），内部画选区外遮罩（PixPin 样式，
/// 前端 CSS 四条 --np-overlay）+ 选区边框角点；整窗 set_ignore_cursor_events
/// ——其下就是真实可交互窗口，滚轮直达（滚动截图的数据源），遮罩纯视觉
fn show_frame_window(app: &AppHandle, geo: &ScrollGeo) -> Result<(), String> {
    let mon = &geo.mon;
    let (rx, ry, rw, rh) = (geo.rx, geo.ry, geo.rw, geo.rh);
    let boot = serde_json::json!({
        "window": "frame",
        "x": rx,
        "y": ry,
        "w": rw,
        "h": rh,
        "scale": f64::from(mon.scale),
    });
    // 常驻复用：已有窗（上场 hide）直接换装显示，免 WebView2 建窗 300ms+ 闪屏
    let win = match app.get_webview_window("shot-frame") {
        Some(w) => w,
        None => {
            let w =
                WebviewWindowBuilder::new(app, "shot-frame", WebviewUrl::App("shot.html".into()))
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
            // 整窗穿透：滚轮/点击直达下层真实窗口（穿透须在 show 前生效）
            w.set_ignore_cursor_events(true)
                .map_err(|e| format!("选区框窗设置穿透失败：{e}"))?;
            w
        }
    };
    win.set_position(PhysicalPosition::new(mon.x, mon.y))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(mon.w, mon.h))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    log::debug!("滚动截图：选区框窗已显示（整屏遮罩，选区 ({rx},{ry}) {rw}×{rh}）");
    Ok(())
}

/// 侧边预览窗：贴选区右/左侧（panel_layout 定位），实时显示已拼长图（纯
/// 预览，PixPin 样式——控制按钮在选区正下方的 shot-bar 控制条上）
fn show_preview_window(app: &AppHandle, geo: &ScrollGeo) -> Result<(), String> {
    let mon = &geo.mon;
    let (rx, ry, rw, rh) = (geo.rx, geo.ry, geo.rw, geo.rh);
    let (px, py, pw, ph) = panel_layout((rx as i32, ry as i32, rw as i32, rh as i32), mon);
    let boot = serde_json::json!({ "window": "scroll-preview", "w": rw, "h": rh });
    // 常驻复用优先（上场 hide 的窗直接换装显示，免建窗闪屏）；仅首场走
    // 建窗——本机 WebView2 建窗有 0x8007139F 前科（shot.rs 日志在案）：
    // 失败清掉可能的僵尸 label 重试一次，仍败才报错
    let mut win = app.get_webview_window("shot-scroll");
    let mut last_err = String::new();
    for attempt in 0..2 {
        if win.is_some() {
            break;
        }
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
    // 不抢焦点：控制条（shot-bar）才持有焦点（Esc 生效），用户点选目标窗
    // 滚动时焦点自然移走，预览纯展示
    log::info!("滚动截图：预览窗已显示 @({px},{py}) {pw}×{ph}（选区 {rw}×{rh}）");
    Ok(())
}

/// 控制条：停靠选区正下方（bar_layout 定位，PixPin 样式）——尺寸显示 / 方向
/// 指示 / 完成 / 取消；持有焦点使 Esc/Enter 生效
fn show_bar_window(app: &AppHandle, geo: &ScrollGeo) -> Result<(), String> {
    let mon = &geo.mon;
    let (rx, ry, rw, rh) = (geo.rx, geo.ry, geo.rw, geo.rh);
    let (bx, by, bw, bh) = bar_layout((rx as i32, ry as i32, rw as i32, rh as i32), mon);
    let boot = serde_json::json!({ "window": "scrollbar", "w": rw });
    // 常驻复用优先（同预览窗）
    let win = match app.get_webview_window("shot-bar") {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, "shot-bar", WebviewUrl::App("shot.html".into()))
            .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
            .title("X-Dir 滚动截图")
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .shadow(false)
            // 不可见窗口默认 focused(true) 在部分 WebView2 上聚焦异常
            // （wry#1798）；show() 后再 set_focus()，保险起见显式关闭
            .focused(false)
            .visible(false)
            .initialization_script(format!("window.__BOOT__ = {boot};"))
            .build()
            .map_err(|e| format!("创建控制条失败：{e}"))?,
    };
    win.set_position(PhysicalPosition::new(mon.x + bx, mon.y + by))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(bw, bh))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    log::info!("滚动截图：控制条已显示 @({bx},{by}) {bw}×{bh}");
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

/// 结果窗：长图写入剪贴板（大图处理放 blocking 线程）。优先内存成品直供
/// （SCROLL_IMAGE，免 200MP 级 PNG 解码秒级等待），静态缺失回落文件解码
#[tauri::command]
pub async fn shot_result_copy(app: AppHandle, file: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mem = SCROLL_IMAGE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let img = match mem {
            Some(img) => img,
            None => image::open(&file)
                .map_err(|e| format!("读取长图失败：{e}"))?
                .to_rgba8(),
        };
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
    fn ncc_band_perfect_at_true_shift() {
        // 原语：真位移处 NCC ≈ 1（排查用，保留作回归锁定）
        let prev = img(200, 200, 0);
        let mut cur = img(200, 200, 9);
        for y in 0..140u32 {
            for x in 0..200u32 {
                cur.put_pixel(x, y, *prev.get_pixel(x, y + 60));
            }
        }
        let pf = GrayPyr::new(&prev);
        let cf = GrayPyr::new(&cur);
        let ff = Ncc {
            t: &pf.full,
            i: &cf.full,
            w: 200,
            x0: 0,
            x1: 200,
        };
        let (s, rows) = ff.band(100, 40, 60, 2);
        assert!(rows >= 20, "rows={rows}");
        assert!(s > 0.99, "ncc={s}");
        let fq = Ncc {
            t: &pf.quarter,
            i: &cf.quarter,
            w: 50,
            x0: 0,
            x1: 50,
        };
        let (sq, rq) = fq.band(25, 10, 15, 2);
        assert!(rq >= 5, "rq={rq}");
        assert!(sq > 0.99, "nccq={sq}");
    }

    /// 真实帧回放验证（手动跑）：XDIR_SCROLL_REPLAY=<dump目录> cargo test
    /// --lib scroll_replay_dump -- --ignored --nocapture。读 dev 帧转储的
    /// base+f*.rgb，跑与 scroll_loop 相同的 匹配→追加/重定基准 决策，输出
    /// 拼接 PNG（out.png）与逐帧 dy 表——用真实数据验证拼接语义（base +
    /// 各帧位移区域，无重复无缺失）
    #[test]
    #[ignore]
    fn scroll_replay_dump() {
        let dir = std::env::var("XDIR_SCROLL_REPLAY").expect("set XDIR_SCROLL_REPLAY=<dump目录>");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".rgb"))
            .collect();
        names.sort();
        assert!(names.len() >= 2, "至少需要 base + 1 帧");
        let (w, h) = names[0]
            .split_once('_')
            .and_then(|(_, wh)| wh.split_once('x'))
            .map(|(w, h)| (w.parse::<u32>().unwrap(), h.parse::<u32>().unwrap()))
            .unwrap();
        let load = |name: &str| -> RgbaImage {
            let raw = std::fs::read(std::path::Path::new(&dir).join(name)).unwrap();
            let mut img = RgbaImage::new(w, h);
            for (i, p) in img.pixels_mut().enumerate() {
                let o = i * 3;
                *p = Rgba([raw[o], raw[o + 1], raw[o + 2], 255]);
            }
            img
        };
        let base = load(&names[0]);
        let mut canvas = CanvasBuf::new(w);
        canvas.push(&base, 0);
        let mut last = base;
        for (idx, name) in names[1..].iter().enumerate() {
            let frame = load(name);
            match match_scroll_dy(&last, &frame) {
                Some(dy) if dy >= 2 => {
                    canvas.push(&frame, h - dy as u32);
                    last = frame;
                    println!("f{idx:03}: 滚动 {dy}px（新增 {}px）", h - dy as u32);
                }
                Some(dy) if dy <= -2 => {
                    last = frame;
                    println!("f{idx:03}: 内容下移 {dy}px，重定基准（不追加）");
                }
                Some(_) => println!("f{idx:03}: 未滚动（不追加）"),
                None => println!("f{idx:03}: 匹配失败（不追加）"),
            }
        }
        let out = canvas.into_image().unwrap();
        let path = std::path::Path::new(&dir).join("out.png");
        out.save(&path).unwrap();
        println!(
            "拼接完成 {}×{} → {}",
            out.width(),
            out.height(),
            path.display()
        );
    }

    /// 合成整场回放（拼接语义端到端验证）：构造聊天样式的非周期长页面，
    /// 按已知偏移序列截取视口帧（大小步进混合 + 一次内容下推重定基准），
    /// 喂给与 scroll_loop 相同的 匹配→追加/重定基准 决策，断言拼接画布与
    /// 地面真值 page[0..末帧底] 逐像素一致——「第一屏 + 各帧位移区域，
    /// 无重复无缺失」
    #[test]
    fn scroll_replay_synthetic_full_session() {
        let (w, vh) = (600u32, 1000u32); // 视口 600×1000
        let page_h = 6000u32;
        // ── 构造非周期页面：消息块（头部亮条 + 正文"文字"行 + 间隔），行内
        //    灰度由块种子 LCG 决定，块高随机 → 无周期性
        let mut lcg = 0x1234_5678u32;
        let mut rnd = move || {
            lcg ^= lcg << 13;
            lcg ^= lcg >> 17;
            lcg ^= lcg << 5;
            lcg
        };
        let mut page = vec![200u8; page_h as usize * w as usize]; // 浅底
        let mut y = 0u32;
        while y < page_h {
            let bh = 80 + rnd() % 320; // 块高 80-400
            let bright = 90 + rnd() % 120;
            for yy in y..(y + bh).min(page_h) {
                for x in 0..w {
                    // 头部 12px 亮条，正文按 (x,yy) 噪声模拟文字
                    let v: u32 = if yy - y < 12 {
                        bright + 60
                    } else if (x * 7 + yy * 13 + rnd() % 3) % 5 < 2 {
                        bright
                            .saturating_sub(40 + (rnd() % 60) as u8 as u32)
                            .min(255)
                    } else {
                        bright
                    };
                    page[yy as usize * w as usize + x as usize] = v as u8;
                }
            }
            y += bh + 24; // 块间距
        }
        let crop = |page: &[u8], off: u32| -> RgbaImage {
            let mut img = RgbaImage::new(w, vh);
            for yy in 0..vh {
                for x in 0..w {
                    let v = page[(off + yy) as usize * w as usize + x as usize];
                    img.put_pixel(x, yy, Rgba([v, v, v, 255]));
                }
            }
            img
        };
        // ── 滚动会话：偏移序列（大小步进混合 + 一次 -900 内容下推）
        let offsets: Vec<u32> = vec![0, 120, 430, 460, 980, 1450, 1465, 2100, 2750, 2765, 3400];
        let frames: Vec<RgbaImage> = offsets.iter().map(|&o| crop(&page, o)).collect();
        // 与 scroll_loop 相同的决策
        let mut canvas = CanvasBuf::new(w);
        canvas.push(&frames[0], 0);
        let mut last = frames[0].clone();
        let mut last_off = offsets[0];
        for (i, frame) in frames.iter().skip(1).enumerate() {
            let dy = match_scroll_dy(&last, frame)
                .unwrap_or_else(|| panic!("帧 {i}（偏移 {}）匹配失败", offsets[i + 1]));
            if dy >= 2 {
                println!(
                    "帧 {i}: 偏移 {}→{}，dy={dy}（真值 {}）",
                    offsets[i],
                    offsets[i + 1],
                    offsets[i + 1] as i32 - offsets[i] as i32
                );
                canvas.push(frame, vh - dy as u32);
                last = frame.clone();
                last_off = offsets[i + 1];
            } else if dy <= -2 {
                last = frame.clone();
                let _ = &mut last_off; // 重定基准：视口内容变化，画布不动
                println!("帧 {i}: 负位移 {dy}，重定基准");
            }
            // 0/±1：不追加
        }
        // ── 断言：画布 == page[0..canvas.h] 逐像素
        let out = canvas.into_image().unwrap();
        assert_eq!(out.width(), w);
        for yy in 0..out.height() {
            for x in 0..w {
                let want = page[yy as usize * w as usize + x as usize];
                let got = out.get_pixel(x, yy).0;
                assert!(
                    (i32::from(got[0]) - i32::from(want)).abs() <= 2,
                    "y={yy} x={x} 拼接 {got:?} ≠ 真值 {want}"
                );
            }
        }
        println!(
            "合成回放通过：末帧偏移 {last_off}，画布 {}px，真值 {}px",
            out.height(),
            last_off + vh
        );
        assert_eq!(out.height(), last_off + vh, "画布长度应恰为末帧底");
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
        // 帧高不足（< 120，双带放不下）无法匹配
        let a = img(200, 60, 0);
        let b = img(200, 60, 1);
        assert_eq!(match_scroll_dy(&a, &b), None);
    }

    #[test]
    fn match_scroll_dy_brightness_shift_invariant() {
        // 全局亮度 +20（hover 态/对比度漂移）：SAD 旧算法会因 >16 阈值拒绝，
        // NCC 对线性亮度变化不变，应仍找到位移 50
        let prev = img(200, 200, 0);
        let mut cur = img(200, 200, 9);
        for y in 0..150u32 {
            for x in 0..200u32 {
                let p = prev.get_pixel(x, y + 50).0;
                cur.put_pixel(
                    x,
                    y,
                    Rgba([p[0].saturating_add(20), p[1].saturating_add(20), 64, 255]),
                );
            }
        }
        assert_eq!(match_scroll_dy(&prev, &cur), Some(50));
    }

    #[test]
    fn match_scroll_dy_uniform_blank_is_bottom() {
        // 纯色空白两帧（滚动到页面尽头常见）：低方差护栏记满分 → 并列取
        // |d| 最小 = 0，到底检测得以推进
        let prev = RgbaImage::from_pixel(200, 200, Rgba([240, 240, 240, 255]));
        let cur = prev.clone();
        assert_eq!(match_scroll_dy(&prev, &cur), Some(0));
    }

    #[test]
    fn match_scroll_dy_sticky_header_pollution() {
        // 顶部 30px（≈7.5%h，sticky header 惯见比例）内容整体变化 + 真实位移
        // 40：双带（25%h / 50%h 起）均在污染区之下，匹配不受影响
        let prev = img(400, 400, 0);
        let mut cur = img(400, 400, 9); // 底部 = 滚动露出的新内容
        for y in 0..360u32 {
            for x in 0..400u32 {
                cur.put_pixel(x, y, *prev.get_pixel(x, y + 40));
            }
        }
        let header = img(400, 30, 77);
        for y in 0..30u32 {
            for x in 0..400u32 {
                cur.put_pixel(x, y, *header.get_pixel(x, y));
            }
        }
        assert_eq!(match_scroll_dy(&prev, &cur), Some(40));
    }

    #[test]
    fn match_scroll_dy_content_shift_down_rebase() {
        // 聊天页流式输出场景：上方内容增长把可视内容整体下推 350px（=0.875h，
        // 旧负向覆盖 -0.65h 之外）→ 顶带 T 应命中负位移，循环重定基准不追加
        let prev = img(400, 400, 0);
        let mut cur = img(400, 400, 9);
        for y in 350..400u32 {
            for x in 0..400u32 {
                cur.put_pixel(x, y, *prev.get_pixel(x, y - 350));
            }
        }
        assert_eq!(match_scroll_dy(&prev, &cur), Some(-350));
    }

    #[test]
    fn match_scroll_dy_large_scroll_beyond_half_height() {
        // 单帧大行程滚动 300px（=0.75h，常见于快速滚轮/触摸板惯性与平滑滚
        // 动合并帧）：旧双带搜索域 ±0.5h 覆盖不到、只能取域内错误次峰 →
        // 大段重复（实测事故）；C 带（75%h 起）扩展域后应得真位移
        let prev = img(400, 400, 0);
        let mut cur = img(400, 400, 9);
        for y in 0..100u32 {
            for x in 0..400u32 {
                cur.put_pixel(x, y, *prev.get_pixel(x, y + 300));
            }
        }
        assert_eq!(match_scroll_dy(&prev, &cur), Some(300));
    }

    #[test]
    fn match_scroll_dy_static_margins_center_scrolls() {
        // 三栏布局：左右各 1/4 静止页边距、中间 1/2 滚动 200px（网页定宽
        // 页边距惯见布局）。全宽匹配被静止列支配 → d≈0 假峰与真位移并列 →
        // 并列策略落小位移 → 大段重复（实测事故）；活动列域限定后应得真位移
        let mut prev = RgbaImage::from_pixel(400, 400, Rgba([0, 0, 0, 255]));
        let mut cur = RgbaImage::from_pixel(400, 400, Rgba([0, 0, 0, 255]));
        let margin = img(400, 400, 3);
        let center = img(400, 400, 0);
        let new_c = img(400, 400, 9);
        for y in 0..400u32 {
            for x in 0..400u32 {
                let m = *margin.get_pixel(x, y);
                prev.put_pixel(x, y, m);
                cur.put_pixel(x, y, m);
            }
        }
        for y in 0..400u32 {
            for x in 100..300u32 {
                prev.put_pixel(x, y, *center.get_pixel(x, y));
            }
        }
        for y in 0..200u32 {
            for x in 100..300u32 {
                cur.put_pixel(x, y, *center.get_pixel(x, y + 200));
            }
        }
        for y in 200..400u32 {
            for x in 100..300u32 {
                cur.put_pixel(x, y, *new_c.get_pixel(x, y));
            }
        }
        assert_eq!(match_scroll_dy(&prev, &cur), Some(200));
    }

    #[test]
    fn match_scroll_dy_periodic_rows_ambiguous_rejected() {
        // 24px 周期行（列表/表格惯见）滚动半周期 12px：±12/±36… 全部满分，
        // 真实位移原理上不可分辨（取小拼重复、取大挖缺失）——诚实拒绝
        let v = |y: u32, x: u32| -> u8 { pattern(y % 24, x / 40, 7) };
        let mut prev = RgbaImage::from_pixel(200, 200, Rgba([0, 0, 0, 255]));
        for y in 0..200u32 {
            for x in 0..200u32 {
                prev.put_pixel(x, y, Rgba([v(y, x), 128, 64, 255]));
            }
        }
        let mut cur = prev.clone();
        for y in 0..188u32 {
            for x in 0..200u32 {
                cur.put_pixel(x, y, *prev.get_pixel(x, y + 12));
            }
        }
        assert_eq!(match_scroll_dy(&prev, &cur), None);
    }

    #[test]
    fn match_scroll_dy_bottom_on_periodic_rows() {
        // 周期页面滚动到尽头（两帧全同）：并列 winner = 0 豁免拒绝，
        // 到底检测得以推进且不追加任何行
        let v = |y: u32, x: u32| -> u8 { pattern(y % 24, x / 40, 7) };
        let mut prev = RgbaImage::from_pixel(200, 200, Rgba([0, 0, 0, 255]));
        for y in 0..200u32 {
            for x in 0..200u32 {
                prev.put_pixel(x, y, Rgba([v(y, x), 128, 64, 255]));
            }
        }
        let cur = prev.clone();
        assert_eq!(match_scroll_dy(&prev, &cur), Some(0));
    }

    #[test]
    fn canvas_buf_appends_and_roundtrips() {
        let mut c = CanvasBuf::new(4);
        let f1 = img(4, 3, 0);
        let f2 = img(4, 3, 1);
        c.push(&f1, 0);
        c.push(&f2, 2); // 追加 f2 的第 2 行起
        assert_eq!(c.h, 3 + 1);
        let out = std::mem::replace(&mut c, CanvasBuf::new(4))
            .into_image()
            .unwrap();
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
        assert_eq!(c.rows_from(3).map(<[u8]>::len), Some(2 * 4)); // 1 行 × w2 × 4B
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

    #[test]
    fn bar_layout_docks_below_selection() {
        // 选区在屏幕上部：控制条停靠正下方居中
        let m = mon(0, 0, 2560, 1440, 1.0);
        let (x, y, bw, bh) = bar_layout((100, 100, 800, 400), &m);
        assert_eq!(y, 100 + 400 + 10);
        assert_eq!(bw, 310);
        assert_eq!(bh, 44);
        // 水平居中于选区
        assert_eq!(x, 100 + (800 - 310) / 2);
    }

    #[test]
    fn bar_layout_flips_above_near_bottom() {
        // 选区贴近屏底：控制条翻到上方
        let m = mon(0, 0, 2560, 1440, 1.0);
        let (_x, y, _bw, bh) = bar_layout((100, 1300, 800, 120), &m);
        assert_eq!(y + bh as i32, 1300 - 10);
    }

    #[test]
    fn bar_layout_clamps_to_monitor() {
        // 选区超宽靠右：x 钳屏内；选区中部：正常停靠下方且整条在屏内
        let m = mon(0, 0, 2560, 1440, 1.0);
        let (x, _y, bw, _bh) = bar_layout((2300, 100, 250, 400), &m);
        assert_eq!(x + bw as i32, 2560 - 8);
        let (_x, y, _bw, bh) = bar_layout((100, 700, 800, 100), &m);
        assert!(y >= 8 && y + bh as i32 <= 1440 - 8);
    }
}
