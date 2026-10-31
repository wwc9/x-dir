//! 全局热键单点注册（§3.7，2026-10-30 定案）：所有系统级热键（截图
//! shot-open / 剪贴板历史 cliphist-toggle）经 hotkeys_sync 一次性全量重建，
//! 回调按 id 分发——取代 shot_register_hotkey（其 unregister_all 全清语义
//! 无法与第二个全局热键共存）。

use serde::Deserialize;
use tauri::AppHandle;

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
            match id.as_str() {
                "shot-open" => super::shot::begin_session(app),
                "cliphist-toggle" => crate::cliphist::toggle_clip_window(app),
                other => log::debug!("未知全局热键 id：{other}"),
            }
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
