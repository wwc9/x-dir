//! 文件元数据条目与目录扫描（§6.4 FileEntry）。

use serde::Serialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::path::{file_name_of, join_name, same_name_ci, to_extended};

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
    /// 拼音首字母匹配变体（首字母跳转用；多音字全读音首字母的组合，首选
    /// 读音变体在前；不含汉字为 None，前端回落名称前缀匹配）
    pub py: Option<Vec<String>>,
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

/// metadata → FileEntry（dir_entry_to_file 与 path_to_entry 共用构建器：
/// py 变体、Windows 属性位、目录 size 恒 0 等口径单源）
fn meta_to_file(path: String, name: String, meta: &std::fs::Metadata) -> FileEntry {
    let is_dir = meta.is_dir();
    #[cfg(windows)]
    let raw = std::os::windows::fs::MetadataExt::file_attributes(meta);
    #[cfg(not(windows))]
    let raw = 0u32;
    // 定位 py 串只覆盖主名（2026-11-05 用户定案：不对扩展名定位）——文件夹
    // 整名即主名（"2.收子公司附件" 的点不是扩展名分隔）；首点文件
    // （".gitignore"）无扩展名不剥
    let stem: &str = if is_dir {
        name.as_str()
    } else {
        match name.rfind('.') {
            Some(i) if i > 0 && i + 1 < name.len() => &name[..i],
            _ => name.as_str(),
        }
    };
    let py = super::search::pinyin_initial_variants(stem, 32);
    FileEntry {
        path,
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
    }
}

/// DirEntry → FileEntry（Windows 下 metadata 复用 FindData，无额外系统调用）
pub fn dir_entry_to_file(dir: &str, entry: &std::fs::DirEntry) -> Option<FileEntry> {
    let meta = entry.metadata().ok()?;
    let name = entry.file_name().to_string_lossy().into_owned();
    Some(meta_to_file(join_name(dir, &name), name, &meta))
}

/// 任意路径 → FileEntry（批量重命名「添加文件」用，2026-11-08）：原生多选
/// 对话框回传的路径可来自任意目录，逐路径读 metadata 补全 mtime/size/属性
/// （「加修改日期」等时间类规则才有正确数据）；路径不存在/不可读时 None
pub fn path_to_entry(path: &str) -> Option<FileEntry> {
    let meta = std::fs::metadata(to_extended(path)).ok()?;
    let name = file_name_of(path);
    if name.is_empty() {
        return None;
    }
    Some(meta_to_file(path.to_string(), name, &meta))
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
        assert_eq!(fe.py.as_deref(), Some(&["ysb".to_string()][..])); // 主名定位：xlsx 扩展名不入 py
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn path_to_entry_fills_meta_and_skips_missing() {
        let d = std::env::temp_dir().join(format!("xdir-pentry-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("数据2026.csv");
        std::fs::write(&p, "hello").unwrap();
        let ps = p.to_str().unwrap();
        let fe = path_to_entry(ps).unwrap();
        assert_eq!(fe.name, "数据2026.csv");
        assert_eq!(fe.path, ps);
        assert!(!fe.is_dir);
        assert_eq!(fe.size, 5); // 逐路径 metadata：size/mtime 真实值（时间类规则依赖）
        assert!(fe.mtime_ms > 0);
        assert_eq!(fe.py.as_deref(), Some(&["sj2026".to_string()][..])); // ASCII 数字原样入变体
        assert!(path_to_entry(&d.join("不存在.exe").to_string_lossy()).is_none());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
