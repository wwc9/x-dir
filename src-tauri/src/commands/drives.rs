//! 盘符与已知文件夹命令（仅 Win32 基础 API，无 COM 对象生命周期）。
//!
//! windows 0.62 说明：GetDriveTypeW 返回原始 u32（DRIVE_FIXED=3/REMOVABLE=2/CDROM=5），
//! 缓冲区参数为 `Option<&mut [u16]>`，详见各调用处。

use serde::Serialize;
use windows::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW, GetVolumeInformationW,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_Videos, KNOWN_FOLDER_FLAG, SHGetKnownFolderPath,
};
use windows::core::PCWSTR;

use super::files::AppError;

const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_FIXED: u32 = 3;
const DRIVE_CDROM: u32 = 5;

fn pwstr(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub letter: String,
    pub label: String,
    pub drive_type: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[tauri::command]
pub fn get_drives() -> Vec<DriveInfo> {
    logical_roots()
        .into_iter()
        .filter_map(|root| drive_info(&root))
        .collect()
}

/// 所有逻辑盘根（如 C:\），解析失败的一段直接跳过
fn logical_roots() -> Vec<String> {
    let mut buf = [0u16; 512];
    let mut out = Vec::new();
    let n = unsafe { GetLogicalDriveStringsW(Some(&mut buf)) } as usize;
    let mut start = 0;
    while start < n {
        let end = buf[start..n]
            .iter()
            .position(|&c| c == 0)
            .map(|i| start + i)
            .unwrap_or(n);
        if end > start {
            out.push(String::from_utf16_lossy(&buf[start..end]));
        }
        start = end + 1;
    }
    out
}

fn drive_type_of(root: &str) -> u32 {
    let wide = pwstr(root);
    unsafe { GetDriveTypeW(PCWSTR::from_raw(wide.as_ptr())) }
}

/// 全盘搜索（search_all）的根列表：仅固定磁盘（可移动盘/光驱不扫）
pub fn fixed_drive_roots() -> Vec<String> {
    logical_roots()
        .into_iter()
        .filter(|r| drive_type_of(r) == DRIVE_FIXED)
        .collect()
}

fn drive_info(root: &str) -> Option<DriveInfo> {
    let wide = pwstr(root);
    let pc = PCWSTR::from_raw(wide.as_ptr());
    let drive_type = match unsafe { GetDriveTypeW(pc) } {
        DRIVE_FIXED => "fixed",
        DRIVE_REMOVABLE => "removable",
        DRIVE_CDROM => "cdrom",
        _ => return None, // 网络/RAM 盘 V1 不支持（§3.4）
    };
    let mut label = [0u16; 128];
    let mut fsname = [0u16; 64];
    let label = if unsafe {
        GetVolumeInformationW(pc, Some(&mut label), None, None, None, Some(&mut fsname))
    }
    .is_ok()
    {
        from_wide(&label)
    } else {
        String::new()
    };
    let (mut free, mut total, mut _free_total) = (0u64, 0u64, 0u64);
    unsafe {
        GetDiskFreeSpaceExW(
            pc,
            Some(&mut free),
            Some(&mut total),
            Some(&mut _free_total),
        )
    }
    .ok();
    Some(DriveInfo {
        letter: root[..2].to_string(),
        label,
        drive_type: drive_type.into(),
        total_bytes: total,
        free_bytes: free,
    })
}

#[tauri::command]
pub fn get_volume(path: String) -> Result<serde_json::Value, AppError> {
    let wide = pwstr(&path);
    let (mut free, mut total, mut _ft) = (0u64, 0u64, 0u64);
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR::from_raw(wide.as_ptr()),
            Some(&mut free),
            Some(&mut total),
            Some(&mut _ft),
        )
    }
    .map_err(|e| AppError::new("E_IO", e.to_string()))?;
    Ok(serde_json::json!({ "freeBytes": free, "totalBytes": total }))
}

#[tauri::command]
pub fn get_known_folder(id: String) -> Result<String, AppError> {
    let guid = match id.as_str() {
        "desktop" => FOLDERID_Desktop,
        "documents" => FOLDERID_Documents,
        "downloads" => FOLDERID_Downloads,
        "pictures" => FOLDERID_Pictures,
        "music" => FOLDERID_Music,
        "videos" => FOLDERID_Videos,
        _ => {
            return Err(AppError::new(
                "E_UNSUPPORTED",
                format!("未知文件夹 id：{id}"),
            ));
        }
    };
    let p = unsafe { SHGetKnownFolderPath(&guid, KNOWN_FOLDER_FLAG(0), None) }
        .map_err(|e| AppError::new("E_IO", e.to_string()))?;
    let s = unsafe { p.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(p.as_ptr().cast())) };
    Ok(s)
}
