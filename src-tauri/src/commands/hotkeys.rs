//! 全局热键单点注册（§3.7，2026-10-30 定案）：所有系统级热键（截图
//! shot-open / 剪贴板历史 cliphist-toggle）经 hotkeys_sync 一次性全量重建，
//! 回调按 id 分发——取代 shot_register_hotkey（其 unregister_all 全清语义
//! 无法与第二个全局热键共存）。

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeySpec {
    pub id: String,
    pub hotkey: String,
}

#[tauri::command]
pub fn hotkeys_sync(app: AppHandle, hotkeys: Vec<HotkeySpec>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    for spec in hotkeys {
        let sc: Shortcut = spec
            .hotkey
            .to_lowercase()
            .parse()
            .map_err(|_| format!("无法识别快捷键「{}」", spec.hotkey))?;
        let id = spec.id.clone();
        let label = spec.hotkey.clone();
        gs.on_shortcut(sc, move |app, _sc, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            // 线程归位（2026-11-06 崩溃修复）：插件的事件 handler 在 global-hotkey
            // 的热键线程执行（GlobalHotKeyEvent::set_event_handler），并非主
            // 线程——此前直接调用，toggle_clip_window 的建窗（WebviewWindow
            // Builder::build）与截图会话的窗口操作从非 GUI 线程执行，连续快速
            // 按热键时偶发死锁/崩溃（用户实测"卡死退出"）；marshal 回主线程
            // 串行执行，窗口操作全部归位（tauri 2 在主线程调用时同步执行，
            // 命令入口同样安全）
            let id2 = id.clone();
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || match id2.as_str() {
                "shot-open" => super::shot::begin_session(&app2),
                "cliphist-toggle" => crate::cliphist::toggle_clip_window(&app2),
                // 工作日历（主窗整页）：确保主窗可见/聚焦后发事件，前端监听开页。
                // 主窗已关闭 = 应用已退出，热键本身不存在，无需建窗路径
                "calendar-open" => {
                    if let Some(w) = app2.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    let _ = app2.emit_to("main", "calendar-open", ());
                }
                other => log::debug!("未知全局热键 id：{other}"),
            });
        })
        .map_err(|e| {
            // App.tsx 启动路径静默 catch，此处必须留痕可查（shot 同口径）
            log::warn!("热键「{label}」注册失败：{e}");
            format!("快捷键「{label}」注册失败（可能被其他程序占用）：{e}")
        })?;
        log::info!("全局热键已注册：{} = {label}", spec.id);
    }
    Ok(())
}
