//! 主窗几何持久化（2026-11-25）：尺寸/位置/最大化存 settings.json `windowState`
//! 键（物理 px），关窗/退出时保存、启动时还原。窗口专属态不进前端 store——
//! save_settings 以 PATCH_OWNED_KEYS 保磁盘值（同 cliphistWinW/H 口径），
//! 本模块直写该键，前端全链无感。

use serde::{Deserialize, Serialize};

/// 解析钳制域：仅拦明显损坏档（负数/天文数字），合法域由系统最小/最大
/// 尺寸约束兜底（config minWidth 等由 OS 在 set_size 时钳回）
const MIN_SIZE: i64 = 200;
const MAX_SIZE: i64 = 16384;
/// 还原有效性阈值：保存矩形与任一显示器交叠双向 ≥100px 才认有效——显示器
/// 拓扑变更/拔扩展屏后旧坐标视同失效，回落默认位置（避免窗开在屏外够不着）
const MIN_VISIBLE: i64 = 100;

/// 主窗几何。rect = 非最小化/最大化时的正常外框；最大化/最小化态落盘时经
/// Windows 恢复矩形（GetWindowPlacement rcNormalPosition）取，否则会把
/// 最大化框 / -32000 离屏最小化坐标当几何存下来
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
}

/// settings.json windowState 值 → 状态。宽容解析：数值字段接受浮点四舍五入；
/// 任意字段缺失/类型不符即 None 整体回落默认；尺寸越界钳进合法域
pub fn from_value(v: &serde_json::Value) -> Option<WindowState> {
    let o = v.as_object()?;
    let n = |k: &str| o.get(k)?.as_f64().map(|f| f.round() as i64);
    let (x, y) = (n("x")?, n("y")?);
    let (w, h) = (
        n("width")?.clamp(MIN_SIZE, MAX_SIZE),
        n("height")?.clamp(MIN_SIZE, MAX_SIZE),
    );
    let to_i32 = |v: i64| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    Some(WindowState {
        x: to_i32(x),
        y: to_i32(y),
        width: to_i32(w),
        height: to_i32(h),
        maximized: o.get("maximized")?.as_bool()?,
    })
}

/// 保存矩形与显示器矩形（x,y,w,h 物理 px）交叠是否达还原阈值
fn overlaps(mon: (i64, i64, i64, i64), s: &WindowState) -> bool {
    let (mx, my, mw, mh) = mon;
    let ow = (mx + mw).min(s.x as i64 + s.width as i64) - mx.max(s.x as i64);
    let oh = (my + mh).min(s.y as i64 + s.height as i64) - my.max(s.y as i64);
    ow >= MIN_VISIBLE && oh >= MIN_VISIBLE
}

/// 还原有效性（纯函数）：rect 至少与一块显示器有 ≥100×100 交叠
pub fn valid_on(monitors: &[(i64, i64, i64, i64)], s: &WindowState) -> bool {
    monitors.iter().any(|m| overlaps(*m, s))
}

fn load(root: &std::path::Path) -> Option<WindowState> {
    let v = crate::config::load_settings_doc_at(root)?;
    from_value(v.get("windowState")?)
}

/// 启动还原：有效档（屏内）→ 先落正常矩形再最大化回放（Windows 自动把
/// 普通矩形记为恢复矩形，取消最大化即回到退出前尺寸位置）；无档/失效档
/// 直接 show 走 tauri.conf.json 默认 1280×800。主窗以 visible:false 建窗，
/// 几何就绪再 show 防默认位置闪现
pub fn restore(app: &tauri::AppHandle) {
    use tauri::{Manager, PhysicalPosition, PhysicalSize};
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let mons: Vec<(i64, i64, i64, i64)> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            (
                m.position().x as i64,
                m.position().y as i64,
                m.size().width as i64,
                m.size().height as i64,
            )
        })
        .collect();
    if let Some(s) = load(&crate::config::config_root()).filter(|s| valid_on(&mons, s)) {
        let _ = w.set_position(PhysicalPosition::new(s.x, s.y));
        let _ = w.set_size(PhysicalSize::new(
            s.width.max(0) as u32,
            s.height.max(0) as u32,
        ));
        if s.maximized {
            let _ = w.maximize();
        }
    }
    let _ = w.show();
}

/// 关窗/退出钩子：主窗当前几何补丁进 settings.json（RMW 保留其余键）。
/// 最大化/最小化态读恢复矩形；窗口缺失/几何读失败静默跳过（退出期窗口
/// 可能已销毁，不允许因持久化失败阻断关闭）
pub fn save_current(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let maximized = w.is_maximized().unwrap_or(false);
    let minimized = w.is_minimized().unwrap_or(false);
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else {
        return;
    };
    let mut st = WindowState {
        x: pos.x,
        y: pos.y,
        width: size.width as i32,
        height: size.height as i32,
        maximized,
    };
    if (maximized || minimized)
        && let Some(r) = normal_rect(&w)
    {
        st.x = r.0;
        st.y = r.1;
        st.width = r.2;
        st.height = r.3;
    }
    write_patch(&st);
}

fn write_patch(st: &WindowState) {
    // 读经 load_settings_doc（损坏自愈）、写经 write_settings_doc（原子 +
    // 写前快照 .bak）——旧直写路径断电即全档损坏（2026-11-26 审计修复）
    let mut v = crate::config::load_settings_doc().unwrap_or_else(|| serde_json::json!({}));
    let Some(o) = v.as_object_mut() else {
        return;
    };
    o.insert("windowState".into(), serde_json::json!(st));
    let _ = crate::config::write_settings_doc(&v);
}

/// Windows 恢复矩形（rcNormalPosition，物理 px 工作区坐标，实际等于屏幕
/// 物理坐标）——窗口处于最大化/最小化时 Windows 自身维护的正常态矩形
#[cfg(windows)]
fn normal_rect(w: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT};
    let hwnd = w.hwnd().ok()?;
    let mut wp = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    unsafe { GetWindowPlacement(hwnd, &mut wp) }.ok()?;
    let r = wp.rcNormalPosition;
    Some((
        r.left,
        r.top,
        (r.right - r.left).max(1),
        (r.bottom - r.top).max(1),
    ))
}

#[cfg(not(windows))]
fn normal_rect(_w: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_accepts_rounded_floats_and_rejects_broken() {
        let ok = from_value(&json!({
            "x": -8.4, "y": 100.6, "width": 1296, "height": 816, "maximized": true
        }))
        .unwrap();
        assert_eq!(
            ok,
            WindowState {
                x: -8,
                y: 101,
                width: 1296,
                height: 816,
                maximized: true
            }
        );
        // 缺字段 / 类型不符 / 缺 maximized / 非对象整体回落
        assert!(from_value(&json!({"x": 1, "y": 2, "width": 800, "height": 600})).is_none());
        assert!(
            from_value(&json!({"x": "a", "y": 2, "width": 800, "height": 600, "maximized": false}))
                .is_none()
        );
        assert!(from_value(&json!("junk")).is_none());
        assert!(from_value(&serde_json::Value::Null).is_none());
    }

    #[test]
    fn parse_clamps_corrupt_values_into_legal_domain() {
        let s = from_value(&json!({
            "x": 0, "y": 0, "width": 1, "height": 999999, "maximized": false
        }))
        .unwrap();
        assert_eq!(s.width as i64, MIN_SIZE);
        assert_eq!(s.height as i64, MAX_SIZE);
        // 坐标越 i32 域安全收敛，不回绕
        let big = from_value(&json!({
            "x": 9e15, "y": -9e15, "width": 800, "height": 600, "maximized": false
        }))
        .unwrap();
        assert_eq!(big.x, i32::MAX);
        assert_eq!(big.y, i32::MIN);
    }

    #[test]
    fn valid_on_requires_min_overlap_on_some_monitor() {
        let mons = [(0i64, 0, 1920, 1080), (-1920, 0, 1920, 1080)];
        let on = WindowState {
            x: 100,
            y: 100,
            width: 1280,
            height: 800,
            maximized: false,
        };
        assert!(valid_on(&mons, &on));
        // 副屏（负坐标）内有效
        let secondary = WindowState {
            x: -1000,
            y: 0,
            width: 800,
            height: 600,
            maximized: false,
        };
        assert!(valid_on(&mons, &secondary));
        // 探出主屏右缘恰 100px = 达阈值有效；99px = 失效
        let edge_ok = WindowState {
            x: 1820,
            y: 0,
            width: 1280,
            height: 800,
            maximized: false,
        };
        assert!(valid_on(&mons, &edge_ok));
        let edge_bad = WindowState {
            x: 1821,
            y: 0,
            width: 1280,
            height: 800,
            maximized: false,
        };
        assert!(!valid_on(&mons, &edge_bad));
        // 双屏之外整体屏外
        let off = WindowState {
            x: 2000,
            y: 2000,
            width: 1280,
            height: 800,
            maximized: false,
        };
        assert!(!valid_on(&mons, &off));
        // 无显示器信息（枚举失败）一律回落默认
        assert!(!valid_on(&[], &on));
    }
}
