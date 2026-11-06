//! 剪贴板历史命令（§3.7）：核心逻辑见 crate::cliphist，此处仅薄封装。
//! 重命令（DB 查询 / PNG 编解码 / OCR / 备份导入导出）一律 async +
//! spawn_blocking（2026-11-01 响应速度优化）：同步命令在主线程执行，
//! watcher 大图入库持有 conn 锁做 PNG 编码（数百 ms）时，主线程同步命令
//! 会排队等锁 = 整个应用冻住；async 化后最多等待的是空闲的 blocking 池。

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

/// 启停监听 + 推送容量/天数护栏（前端启动与设置变更时调用）
#[tauri::command]
pub fn cliphist_configure(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    capacity: usize,
    keep_days: i64,
    exclude_apps: Option<String>,
    rich_text: Option<bool>,
) -> Result<(), String> {
    let h = &state.cliphist;
    h.capacity
        .store(capacity.clamp(50, 10_000), Ordering::SeqCst);
    h.keep_days.store(keep_days.max(0), Ordering::SeqCst);
    // 排除应用清单（T1-1）：watcher 逐条比对前台进程名
    if let Some(list) = exclude_apps {
        *h.exclude_apps.lock().unwrap_or_else(|p| p.into_inner()) = list;
    }
    if let Some(rich) = rich_text {
        h.rich_text.store(rich, Ordering::SeqCst);
    }
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
pub async fn cliphist_list(
    app: AppHandle,
    query: String,
    kind: String,
    offset: i64,
    limit: i64,
) -> Result<crate::cliphist::ClipHistPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let conn = st.cliphist.conn.lock().unwrap_or_else(|p| p.into_inner());
        crate::cliphist::list_page(&conn, &query, &kind, offset, limit)
            .map_err(|e| format!("查询剪贴板历史失败：{e}"))
    })
    .await
    .map_err(|e| format!("查询线程失败：{e}"))?
}

/// 写回系统剪贴板（paste=true 时直接粘贴到目标窗口，失败降级仅复制）。
/// 返回 pasted：直接粘贴是否成功。图片条目含 PNG 解码 + DIB 构建（4K
/// ~300ms）、直接粘贴含 60ms 等待——全部在 blocking 线程，粘贴图片不再
/// 冻住全部窗口
#[tauri::command]
pub async fn cliphist_write_back(app: AppHandle, id: i64, paste: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let h = &app.state::<AppState>().cliphist;
        crate::cliphist::write_back(&app, h, id, paste)
    })
    .await
    .map_err(|e| format!("写回线程失败：{e}"))?
}

/// 备份导出（T3-3）：全部条目写 JSON 文件（image 转 base64）。全库序列化
/// 随条目数线性增长，blocking 线程执行
#[tauri::command]
pub async fn cliphist_export(app: AppHandle, path: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bak = {
            let st = app.state::<AppState>();
            let conn = st.cliphist.conn.lock().unwrap_or_else(|p| p.into_inner());
            crate::cliphist::export_backup(&conn).map_err(|e| format!("导出读取失败：{e}"))?
        };
        let n = bak.items.len();
        let json = serde_json::to_string_pretty(&bak).map_err(|e| format!("序列化失败：{e}"))?;
        std::fs::write(&path, json).map_err(|e| format!("写文件失败：{e}"))?;
        Ok(n)
    })
    .await
    .map_err(|e| format!("导出线程失败：{e}"))?
}

/// 备份导入（T3-3）：JSON 文件追加导入（保留收藏/置顶/时间戳）
#[tauri::command]
pub async fn cliphist_import(app: AppHandle, path: String) -> Result<usize, String> {
    let app_in = app.clone();
    let n = tauri::async_runtime::spawn_blocking(move || {
        let json = std::fs::read_to_string(&path).map_err(|e| format!("读文件失败：{e}"))?;
        let bak: crate::cliphist::Backup =
            serde_json::from_str(&json).map_err(|e| format!("备份文件格式不正确：{e}"))?;
        if bak.app != "x-dir" {
            return Err("不是 X-Dir 剪贴板备份文件".into());
        }
        let st = app_in.state::<AppState>();
        let conn = st.cliphist.conn.lock().unwrap_or_else(|p| p.into_inner());
        crate::cliphist::import_backup(&conn, &bak).map_err(|e| format!("导入失败：{e}"))
    })
    .await
    .map_err(|e| format!("导入线程失败：{e}"))??;
    let _ = app.emit("cliphist-updated", ());
    Ok(n)
}

/// 收藏/取消收藏（T3-2）：豁免清理、排序最前、独立过滤档
#[tauri::command]
pub fn cliphist_set_fav(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    fav: bool,
) -> Result<(), String> {
    {
        let conn = state
            .cliphist
            .conn
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE clip_items SET fav = ?1 WHERE id = ?2",
            rusqlite::params![fav as i64, id],
        )
        .map_err(|e| format!("收藏失败：{e}"))?;
    }
    let _ = app.emit("cliphist-updated", ());
    Ok(())
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
        conn.execute("DELETE FROM clip_items WHERE pinned = 0 AND fav = 0", [])
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

/// 开/关浮窗（顶栏剪贴板钮，2026-11-06）：与系统热键同入口——开 = 抓前台
/// （= 主窗）为粘贴目标、光标显示器居中上屏聚焦；已开 = 收浮窗。
/// toggle_clip_window 要求主线程：本命令为 sync 命令（同 cliphist_hide 模式）
#[tauri::command]
pub fn cliphist_toggle(app: AppHandle) -> Result<(), String> {
    crate::cliphist::toggle_clip_window(&app);
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

/// 图片 OCR 取字（T2-4）：识别文本写回剪贴板并返回。OCR 秒级重活在
/// blocking 线程——旧同步命令在主线程 block_on，期间全部窗口冻住
#[tauri::command]
pub async fn cliphist_ocr(app: AppHandle, id: i64) -> Result<String, String> {
    let png = crate::cliphist::image_png_bytes(&app.state::<AppState>().cliphist, id)?;
    tauri::async_runtime::spawn_blocking(move || crate::cliphist::ocr_png(&png))
        .await
        .map_err(|e| format!("OCR 线程失败：{e}"))?
}

/// 图片条目放大预览（T2-1）：原图 dataURL（多 MB base64，blocking 线程）
#[tauri::command]
pub async fn cliphist_get_image(app: AppHandle, id: i64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::cliphist::get_image_data_url(&app.state::<AppState>().cliphist, id)
    })
    .await
    .map_err(|e| format!("读取线程失败：{e}"))?
}

/// 多选合并粘贴（T1-4）：ids 按列表可见序传入，换行连接后写回/直接粘贴。
/// 直接粘贴路径含 60ms 焦点等待，blocking 线程执行
#[tauri::command]
pub async fn cliphist_merge_paste(
    app: AppHandle,
    ids: Vec<i64>,
    paste: bool,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let h = &app.state::<AppState>().cliphist;
        crate::cliphist::merge_paste(&app, h, &ids, paste)
    })
    .await
    .map_err(|e| format!("合并线程失败：{e}"))?
}

/// 文件/文件夹条目「粘贴到当前窗格」（T1-2）：回写 CF_HDROP 到系统剪贴板
/// （带剪切意图原样），唤起主窗并通知其按 Ctrl+V 同款例程粘贴进活动窗格
#[tauri::command]
pub fn cliphist_paste_to_pane(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    crate::cliphist::write_back(&app, &state.cliphist, id, false)?;
    // 与设置直达同款：先收浮窗（不归还焦点），再唤主窗，最后发事件
    crate::cliphist::park_clip_window(&app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    let _ = app.emit_to("main", "cliphist-paste-to-pane", ());
    Ok(())
}

/// 顶栏设置钮：唤起主窗并直达设置面板（收浮窗）。先收浮窗但**不做焦点
/// 归还**——归还 paste_target 会把随后聚焦的主窗前台抢走，面板开了却
/// 被压在后面（2026-10-31 用户实测「直达失败」根因）；本进程持有点击
/// 输入权，最后一步聚焦主窗必成
#[tauri::command]
pub fn cliphist_open_settings(app: AppHandle) -> Result<(), String> {
    crate::cliphist::park_clip_window(&app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    let _ = app.emit_to("main", "cliphist-open-settings", ());
    Ok(())
}
