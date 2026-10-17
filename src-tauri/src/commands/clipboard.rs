//! 系统剪贴板命令（V2 §3.2 CF_HDROP 互通）。

use serde::Serialize;

use super::files::AppError;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipFiles {
    pub paths: Vec<String>,
    pub cut: bool,
}

#[tauri::command]
pub fn set_clipboard_files(paths: Vec<String>, cut: bool) -> Result<(), AppError> {
    crate::clip::set_files(&paths, cut).map_err(|e| AppError::new("E_IO", e))
}

#[tauri::command]
pub fn get_clipboard_files() -> Option<ClipFiles> {
    #[cfg(windows)]
    {
        crate::clip::get_files().map(|(paths, cut)| ClipFiles { paths, cut })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[tauri::command]
pub fn clear_clipboard() -> Result<(), AppError> {
    #[cfg(windows)]
    {
        crate::clip::clear().map_err(|e| AppError::new("E_IO", e))
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}
