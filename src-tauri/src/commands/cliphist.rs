//! 剪贴板历史命令（§3.7）：核心逻辑见 crate::cliphist，此处仅薄封装。

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, State};

use crate::AppState;

/// 启停监听 + 推送容量/天数护栏（前端启动与设置变更时调用）
#[tauri::command]
pub fn cliphist_configure(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    capacity: usize,
    keep_days: i64,
) -> Result<(), String> {
    let h = &state.cliphist;
    h.capacity
        .store(capacity.clamp(50, 10_000), Ordering::SeqCst);
    h.keep_days.store(keep_days.max(0), Ordering::SeqCst);
    #[cfg(windows)]
    {
        if enabled {
            crate::cliphist::start_watcher(&app)?;
        } else {
            crate::cliphist::stop_watcher(&app);
        }
    }
    #[cfg(not(windows))]
    let _ = (app, enabled);
    Ok(())
}

/// 分页查询（query 空串 = 全部；kind 空串 = 全部类型）
#[tauri::command]
pub fn cliphist_list(
    state: State<'_, AppState>,
    query: String,
    kind: String,
    offset: i64,
    limit: i64,
) -> Result<crate::cliphist::ClipHistPage, String> {
    let conn = state
        .cliphist
        .conn
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    crate::cliphist::list_page(&conn, &query, &kind, offset, limit)
        .map_err(|e| format!("查询剪贴板历史失败：{e}"))
}

/// 写回系统剪贴板（paste=true 时直接粘贴到目标窗口，失败降级仅复制）。
/// 返回 pasted：直接粘贴是否成功
#[tauri::command]
pub fn cliphist_write_back(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    paste: bool,
) -> Result<bool, String> {
    crate::cliphist::write_back(&app, &state.cliphist, id, paste)
}

#[tauri::command]
pub fn cliphist_set_pin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    pinned: bool,
) -> Result<(), String> {
    {
        let conn = state
            .cliphist
            .conn
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE clip_items SET pinned = ?1 WHERE id = ?2",
            rusqlite::params![pinned as i64, id],
        )
        .map_err(|e| format!("置顶失败：{e}"))?;
    }
    let _ = app.emit("cliphist-updated", ());
    Ok(())
}

#[tauri::command]
pub fn cliphist_delete(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<(), String> {
    {
        let conn = state
            .cliphist
            .conn
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        conn.execute("DELETE FROM clip_items WHERE id = ?1", [id])
            .map_err(|e| format!("删除失败：{e}"))?;
    }
    let _ = app.emit("cliphist-updated", ());
    Ok(())
}

/// 清空全部未置顶条目
#[tauri::command]
pub fn cliphist_clear(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let conn = state
            .cliphist
            .conn
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        conn.execute("DELETE FROM clip_items WHERE pinned = 0", [])
            .map_err(|e| format!("清空失败：{e}"))?;
    }
    let _ = app.emit("cliphist-updated", ());
    Ok(())
}

/// 收浮窗（前端 Esc / 选中条目后调用；失焦自动收由窗口事件处理）
#[tauri::command]
pub fn cliphist_hide(app: AppHandle) -> Result<(), String> {
    crate::cliphist::close_clip_window(&app);
    Ok(())
}

/// 浮窗置顶常驻开关（置顶钮）：true = 失焦不自动收窗（Esc/热键仍收）
#[tauri::command]
pub fn cliphist_set_pinned(pinned: bool) -> Result<(), String> {
    crate::cliphist::set_window_pinned(pinned);
    Ok(())
}

/// 浮窗最大化/还原（顶栏窗口钮）：手动撑满所在显示器工作区
#[tauri::command]
pub fn cliphist_set_maximized(app: AppHandle, maximized: bool) -> Result<(), String> {
    crate::cliphist::set_window_maximized(&app, maximized)
}
