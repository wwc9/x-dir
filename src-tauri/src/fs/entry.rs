//! 文件元数据条目与目录扫描（§6.4 FileEntry）。

use serde::Serialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::path::{join_name, same_name_ci, to_extended};

pub const FILE_ATTRIBUTE_READONLY: u32 = 0x1;
pub const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
pub const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileAttrs {
    pub hidden: bool,
    pub system: bool,
    pub readonly: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// 字节；目录恒 0（V1 不计算目录大小）
    pub size: u64,
    pub mtime_ms: u64,
    /// 创建时间（§7.3 属性对话框）；文件系统不支持时为 0
    pub ctime_ms: u64,
    pub attrs: FileAttrs,
    /// 拼音首字母匹配串（首字母跳转用；不含汉字为 None，前端回落名称前缀匹配）
    pub py: Option<String>,
}

pub fn systemtime_to_unix_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn path_exists(path: &str) -> bool {
    Path::new(&to_extended(path)).exists()
}

/// 目录内是否存在与 name 同名（大小写折叠）的条目（§6.11）。
/// 目录不可读时退回直接探测（NTFS 默认大小写不敏感可隐式命中）。
pub fn name_exists_ci(dir: &str, name: &str) -> bool {
    if let Ok(rd) = std::fs::read_dir(to_extended(dir)) {
        for entry in rd.flatten() {
            let n = entry.file_name().to_string_lossy().into_owned();
            if same_name_ci(&n, name) {
                return true;
            }
        }
        return false;
    }
    path_exists(&join_name(dir, name))
}

/// 扫描目录（单层，不递归）。单个条目失败时跳过，不中断整体（§6.10）。
pub fn scan_dir(dir: &str) -> std::io::Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(to_extended(dir))? {
        let Ok(entry) = entry else { continue };
        if let Some(e) = dir_entry_to_file(dir, &entry) {
            out.push(e);
        }
    }
    Ok(out)
}

/// DirEntry → FileEntry（Windows 下 metadata 复用 FindData，无额外系统调用）
pub fn dir_entry_to_file(dir: &str, entry: &std::fs::DirEntry) -> Option<FileEntry> {
    let meta = entry.metadata().ok()?;
    let name = entry.file_name().to_string_lossy().into_owned();
    let is_dir = meta.is_dir();
    #[cfg(windows)]
    let raw = std::os::windows::fs::MetadataExt::file_attributes(&meta);
    #[cfg(not(windows))]
    let raw = 0u32;
    let py = super::search::pinyin_initials(&name);
    Some(FileEntry {
        path: join_name(dir, &name),
        name,
        is_dir,
        size: if is_dir { 0 } else { meta.len() },
        mtime_ms: systemtime_to_unix_ms(meta.modified().unwrap_or(UNIX_EPOCH)),
        ctime_ms: systemtime_to_unix_ms(meta.created().unwrap_or(UNIX_EPOCH)),
        attrs: FileAttrs {
            hidden: raw & FILE_ATTRIBUTE_HIDDEN != 0,
            system: raw & FILE_ATTRIBUTE_SYSTEM != 0,
            readonly: raw & FILE_ATTRIBUTE_READONLY != 0,
        },
        py,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_entry_fills_pinyin_initials() {
        let d = std::env::temp_dir().join(format!("xdir-entry-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("预算表.xlsx"), "x").unwrap();
        let mut rd = std::fs::read_dir(&d).unwrap();
        let e = rd.next().unwrap().unwrap();
        let fe = dir_entry_to_file(d.to_str().unwrap(), &e).unwrap();
        assert_eq!(fe.name, "预算表.xlsx");
        assert_eq!(fe.py.as_deref(), Some("ysb.xlsx"));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
