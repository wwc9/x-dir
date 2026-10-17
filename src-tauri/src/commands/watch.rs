//! 目录监控命令（§6.8）：watch_dir / unwatch_dir。
//! 回调内做两件事：失效后端快照 + 推送 dir-changed 脏标记事件。

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use super::files::AppError;
use crate::AppState;
use crate::fs::entry::path_exists;

#[tauri::command]
pub fn watch_dir(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    if !path_exists(&path) {
        return Err(AppError::new("E_NOT_FOUND", format!("目录不存在：{path}")));
    }
    let app2 = app.clone();
    state
        .watches
        .watch(&path, move |p| {
            let st = app2.state::<AppState>();
            st.cache.lock().unwrap().invalidate(p);
            let _ = app2.emit("dir-changed", json!({ "path": p }));
        })
        .map_err(|e| AppError::new("E_IO", e))
}

#[tauri::command]
pub fn unwatch_dir(state: State<'_, AppState>, path: String) {
    state.watches.unwatch(&path);
}
