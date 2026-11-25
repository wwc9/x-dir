//! V2 图标命令（§3.2）：批量取真实图标，缓存命中不再触盘。
//! async 命令：GDI 提取 + PNG 编码不能跑在主线程（整批可达数百 ms，阻塞 UI）；
//! 锁只护缓存读写，编码在锁外——持锁编码会让并发批次互相排队。

use std::collections::HashMap;

use crate::AppState;
use crate::icons::icon_key;

/// 批量取 32×32 真实文件图标（data URL）。未命中缓存的路径现取，取不到不产出键。
#[tauri::command]
pub async fn get_file_icons(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<HashMap<String, String>, ()> {
    #[cfg(windows)]
    {
        // is_dir 判定是逐路径 stat（IO），与缓存读写一样在锁外做
        let infos: Vec<(String, bool)> = paths
            .iter()
            .map(|p| {
                let is_dir = std::fs::metadata(crate::fs::path::to_extended(p))
                    .map(|m| m.is_dir())
                    .unwrap_or(false);
                (p.clone(), is_dir)
            })
            .collect();
        let mut out = HashMap::new();
        let mut misses: Vec<(String, bool)> = Vec::new();
        {
            let mut store = state.icons.lock().unwrap();
            for (p, is_dir) in &infos {
                let key = icon_key(p, *is_dir);
                if let Some(v) = store.icons.get(&key) {
                    out.insert(p.clone(), v.clone());
                } else {
                    misses.push((p.clone(), *is_dir));
                }
            }
        }
        for (p, is_dir) in misses {
            if let Some(v) = crate::icons::file_icon_png(&p, is_dir) {
                state
                    .icons
                    .lock()
                    .unwrap()
                    .icons
                    .put(icon_key(&p, is_dir), v.clone());
                out.insert(p, v);
            }
        }
        Ok(out)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, paths);
        Ok(HashMap::new())
    }
}

/// 批量取缩略图（2026-11-25 缩略图视图）：96px PNG data URL；缓存键含 mtime
/// （文件改动自动失效）。目录不出缩略图（列表侧文件夹走图标管线）。
#[tauri::command]
pub async fn get_thumbnails(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<HashMap<String, String>, ()> {
    #[cfg(windows)]
    {
        let mut out = HashMap::new();
        let mut misses: Vec<String> = Vec::new();
        {
            let mut store = state.icons.lock().unwrap();
            for p in &paths {
                let key = thumb_key(p);
                if let Some(v) = store.thumbs.get(&key) {
                    out.insert(p.clone(), v.clone());
                } else {
                    misses.push(p.clone());
                }
            }
        }
        for p in misses {
            let is_dir = std::fs::metadata(crate::fs::path::to_extended(&p))
                .map(|m| m.is_dir())
                .unwrap_or(false);
            if is_dir {
                continue;
            }
            if let Some(v) = crate::icons::thumbnail_png(&p) {
                let key = thumb_key(&p);
                state.icons.lock().unwrap().thumbs.put(key, v.clone());
                out.insert(p, v);
            }
        }
        Ok(out)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, paths);
        Ok(HashMap::new())
    }
}

/// 缩略图缓存键：路径 + mtime（改动即失效；读不到 mtime 用 0 兜底）
fn thumb_key(path: &str) -> String {
    let mtime = std::fs::metadata(crate::fs::path::to_extended(path))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{path}|{mtime}")
}
