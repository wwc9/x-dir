//! 文件查询与单文件操作命令（§6.5）。

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

use crate::AppState;
use crate::fs::entry::{name_exists_ci, path_exists};
use crate::fs::path::{
    file_name_of, is_valid_name, join_name, parent_of, same_name_ci, to_extended,
};
use crate::fs::sort::{DirPage, SortDir, SortKey, SortSpec, build_page};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<io::Error> for AppError {
    fn from(e: io::Error) -> Self {
        let code = match e.kind() {
            io::ErrorKind::NotFound => "E_NOT_FOUND",
            io::ErrorKind::PermissionDenied => "E_PERM",
            io::ErrorKind::AlreadyExists => "E_EXISTS",
            io::ErrorKind::InvalidInput => "E_INVALID_NAME",
            _ => "E_IO",
        };
        AppError::new(code, e.to_string())
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // 参数表 = §6.5 IPC 契约，双端同步不宜拆
pub async fn list_dir(
    state: tauri::State<'_, AppState>,
    path: String,
    sort: Option<SortSpec>,
    ext_filter: Option<Vec<String>>,
    name_filter: Option<String>,
    show_hidden: bool,
    offset: usize,
    limit: usize,
    force: Option<bool>,
) -> Result<DirPage, AppError> {
    let sort = sort.unwrap_or(SortSpec {
        key: SortKey::Name,
        dir: SortDir::Asc,
    });
    let exts = ext_filter.filter(|v| !v.is_empty());
    let query = name_filter.filter(|s| !s.trim().is_empty());
    let mut cache = state.cache.lock().unwrap();
    cache
        .with_entries(&path, force.unwrap_or(false), |entries| {
            build_page(
                entries,
                &sort,
                exts.as_deref(),
                query.as_deref(),
                show_hidden,
                offset,
                limit,
            )
        })
        .map_err(AppError::from)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub source_name: String,
    pub existing_is_dir: bool,
    pub existing_size: u64,
}

/// 导航树：列出子目录名（自然排序；复用 list_dir 的目录缓存，无额外 IO）。
/// async：冷目录首扫是全量 IO，不能跑在主线程。
#[tauri::command]
pub async fn list_dirs(
    state: tauri::State<'_, AppState>,
    path: String,
    show_hidden: Option<bool>,
) -> Result<Vec<String>, AppError> {
    let show_hidden = show_hidden.unwrap_or(false);
    let mut cache = state.cache.lock().unwrap();
    cache
        .with_entries(&path, false, |entries| {
            crate::fs::sort::dir_names(entries, show_hidden)
        })
        .map_err(AppError::from)
}

/// 粘贴/拖放前的冲突预检（§6.7）。大小写折叠判定（§6.11）：
/// 一次读目录建立折叠名索引，同时覆盖 NTFS 与大小写敏感卷（Dev Drive 等）。
/// async：粘贴目标可能是上万条的目录，整目录枚举不能跑在主线程。
#[tauri::command]
pub async fn check_conflicts(sources: Vec<String>, dest_dir: String) -> Vec<ConflictInfo> {
    let mut existing: HashMap<String, (bool, u64)> = HashMap::new();
    if let Ok(rd) = fs::read_dir(to_extended(&dest_dir)) {
        for entry in rd.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            let name = entry.file_name().to_string_lossy().to_uppercase();
            existing.insert(
                name,
                (meta.is_dir(), if meta.is_dir() { 0 } else { meta.len() }),
            );
        }
    }
    sources
        .iter()
        .filter_map(|s| {
            let name = file_name_of(s);
            existing
                .get(&name.to_uppercase())
                .map(|(is_dir, size)| ConflictInfo {
                    source_name: name,
                    existing_is_dir: *is_dir,
                    existing_size: *size,
                })
        })
        .collect()
}

#[tauri::command]
pub fn rename_item(path: String, new_name: String) -> Result<(), AppError> {
    if !is_valid_name(&new_name) {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("非法文件名：{new_name}"),
        ));
    }
    let parent = parent_of(&path).ok_or_else(|| AppError::new("E_UNKNOWN", "路径缺少父目录"))?;
    // 仅改大小写的重命名合法；折叠后与"其他"条目同名才冲突（§6.11）
    if !same_name_ci(&new_name, &file_name_of(&path)) && name_exists_ci(&parent, &new_name) {
        return Err(AppError::new(
            "E_EXISTS",
            format!("已存在同名项：{new_name}"),
        ));
    }
    let target = join_name(&parent, &new_name);
    fs::rename(to_extended(&path), to_extended(&target))?;
    Ok(())
}

#[tauri::command]
pub fn create_dir(parent_dir: String, name: String) -> Result<String, AppError> {
    if !is_valid_name(&name) {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("非法文件夹名：{name}"),
        ));
    }
    let p = join_name(&parent_dir, &name);
    fs::create_dir(to_extended(&p))?;
    Ok(p)
}

#[tauri::command]
pub fn create_file(parent_dir: String, name: String) -> Result<String, AppError> {
    if !is_valid_name(&name) {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("非法文件名：{name}"),
        ));
    }
    let p = join_name(&parent_dir, &name);
    fs::File::create(to_extended(&p))?;
    Ok(p)
}

#[tauri::command]
pub fn open_item(path: String) -> Result<(), AppError> {
    if !path_exists(&path) {
        return Err(AppError::new("E_NOT_FOUND", path));
    }
    tauri_plugin_opener::open_path(Path::new(&path), None::<&str>)
        .map_err(|e| AppError::new("E_UNSUPPORTED", e.to_string()))
}
