//! 路径规整与校验（§6.11 路径与兼容性边界）。
//! 应用内一律使用"显示路径"（不含 \\?\ 前缀、盘符根带反斜杠），
//! 仅在触达文件系统 API 前经 [`to_extended`] 转换。

use std::path::PathBuf;

/// Windows 保留名（不带扩展名比较）：CON/PRN/AUX/NUL + COM1-9/LPT1-9
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const INVALID_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// 新建/重命名的文件名校验（§6.11）
pub fn is_valid_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 {
        return false;
    }
    if name
        .chars()
        .any(|c| INVALID_CHARS.contains(&c) || c.is_control())
    {
        return false;
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return false;
    }
    // 保留名连扩展名也非法（CON.txt 一样不行）
    let stem = name.split('.').next().unwrap_or("");
    !RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem))
}

/// 长路径：>240 字符自动加 \\?\ 前缀（已有则跳过）。
/// UNC 需要专门的 \\?\UNC\ 形式（直接拼 \\?\ 会得到非法路径）；
/// \\?\ 下的 Win32 不再做规范化，正斜杠先归一为反斜杠。
pub fn to_extended(path: &str) -> PathBuf {
    if path.len() <= 240 || path.starts_with("\\\\?\\") {
        return PathBuf::from(path);
    }
    if let Some(rest) = path.strip_prefix("\\\\") {
        PathBuf::from(format!("\\\\?\\UNC\\{}", rest.replace('/', "\\")))
    } else {
        PathBuf::from(format!("\\\\?\\{}", path.replace('/', "\\")))
    }
}

/// 拼接显示路径，防双反斜杠：join_name("C:\\", "a") == "C:\\a"
pub fn join_name(parent: &str, name: &str) -> String {
    if parent.ends_with('\\') {
        format!("{parent}{name}")
    } else {
        format!("{parent}\\{name}")
    }
}

/// 缓存/监控表的键归一：Windows 路径大小写不敏感、尾反斜杠两态——
/// 手输地址栏的 "c:\data\" 与导航产生的 "C:\data" 必须命中同一份快照/同一个
/// watcher，否则失效事件打不到真实键上，界面就会停留陈旧数据。
pub fn norm_key(path: &str) -> String {
    path.trim_end_matches('\\').to_ascii_lowercase()
}

pub fn file_name_of(path: &str) -> String {
    path.trim_end_matches('\\')
        .rsplit('\\')
        .next()
        .unwrap_or(path)
        .to_string()
}

/// 父目录；盘符根（C:\）返回 None。UNC 路径 V1 不支持（§3.4）。
pub fn parent_of(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('\\');
    let idx = trimmed.rfind('\\')?;
    if idx == 0 {
        return None;
    }
    if idx <= 2 {
        // "C:\a" 的父级是根 "C:\"
        Some(format!("{}\\", &trimmed[..2]))
    } else {
        Some(trimmed[..idx].to_string())
    }
}

/// 同卷判定 = 盘符字母相同（大小写不敏感）。V1 仅本地盘（§6.7）
pub fn is_same_volume(a: &str, b: &str) -> bool {
    let la = a.as_bytes().first().map(|c| c.to_ascii_uppercase());
    let lb = b.as_bytes().first().map(|c| c.to_ascii_uppercase());
    la.is_some() && la == lb
}

/// 目录联接/junction 判定（自 2026-11-01 审查起为全库共享工具）：reparse
/// 目录的 read_dir/metadata（跟随式）会进入目标，自引用联接（用户目录的
/// `Application Data`）即无限递归栈溢出——递归遍历/复制引擎入递归前必须过此闸。
/// 注意必须按**原始属性**判定：std 的 `Metadata::is_dir()` 对 reparse 目录恒为
/// false（symlink 语义），旧实现 `md.is_dir() && REPARSE` 在 junction 上永不
/// 成立——复制引擎的联接防护因此形同虚设（实测定位，2026-11-01 修复）
pub fn is_reparse_dir(path: &str) -> bool {
    match std::fs::symlink_metadata(to_extended(path)) {
        Ok(md) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
                let a = md.file_attributes();
                a & FILE_ATTRIBUTE_REPARSE_POINT != 0 && a & FILE_ATTRIBUTE_DIRECTORY != 0
            }
            #[cfg(not(windows))]
            {
                md.file_type().is_symlink()
            }
        }
        Err(_) => false,
    }
}

/// 同名判定：大小写折叠比较（§6.11，对齐 NTFS 折叠语义，覆盖大小写敏感卷）
pub fn same_name_ci(a: &str, b: &str) -> bool {
    a.to_uppercase() == b.to_uppercase()
}

/// "name.ext" → (name, ext)；无扩展名 → (name, "")
pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// junction 实物回归（2026-11-01）：std 语义下 symlink_metadata 的
    /// is_dir() 对 reparse 目录恒 false，旧实现 `md.is_dir() && REPARSE`
    /// 在真实联接上永不成立——复制引擎的联接环防护因此整体失效（实测
    /// 定位）；必须按原始属性判
    #[cfg(windows)]
    #[test]
    fn is_reparse_dir_detects_real_junction() {
        let tmp = std::env::temp_dir().join(format!("xdir-rp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let link = tmp.join("loop");
        let ok = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&tmp)
            .output()
            .is_ok_and(|o| o.status.success());
        if ok {
            assert!(
                is_reparse_dir(link.to_str().unwrap()),
                "junction 必须被识别为 reparse 目录"
            );
        }
        // 普通目录/文件恒 false
        assert!(!is_reparse_dir(tmp.to_str().unwrap()));
        std::fs::write(tmp.join("f.txt"), b"x").unwrap();
        assert!(!is_reparse_dir(tmp.join("f.txt").to_str().unwrap()));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn valid_names() {
        assert!(is_valid_name("a.txt"));
        assert!(is_valid_name("新建 文件夹"));
        assert!(is_valid_name(".gitignore"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("a<b"));
        assert!(!is_valid_name("trailing "));
        assert!(!is_valid_name("trailing."));
        assert!(!is_valid_name("CON"));
        assert!(!is_valid_name("con.txt"));
        assert!(!is_valid_name("LPT9"));
    }

    #[test]
    fn join_and_parent() {
        assert_eq!(join_name("C:\\", "a"), "C:\\a");
        assert_eq!(join_name("C:\\a\\b", "c.txt"), "C:\\a\\b\\c.txt");
        assert_eq!(parent_of("C:\\"), None);
        assert_eq!(parent_of("C:\\a"), Some("C:\\".to_string()));
        assert_eq!(parent_of("C:\\a\\b"), Some("C:\\a".to_string()));
        assert_eq!(file_name_of("C:\\a\\b.txt"), "b.txt");
        assert_eq!(file_name_of("C:\\"), "C:");
    }

    #[test]
    fn same_volume() {
        assert!(is_same_volume("C:\\a", "c:\\b"));
        assert!(!is_same_volume("C:\\a", "D:\\b"));
        assert!(!is_same_volume("", "D:\\b"));
    }

    #[test]
    fn case_folded_names() {
        assert!(same_name_ci("readme.md", "README.MD"));
        assert!(same_name_ci("新建文件夹", "新建文件夹"));
        assert!(!same_name_ci("a.txt", "a.txt.bak"));
    }

    #[test]
    fn split_extensions() {
        assert_eq!(split_ext("a.tar.gz"), ("a.tar", "gz"));
        assert_eq!(split_ext("noext"), ("noext", ""));
        assert_eq!(split_ext(".hidden"), (".hidden", ""));
    }

    #[test]
    fn extended_paths() {
        // 短路径原样返回
        assert_eq!(to_extended("C:\\a").to_str(), Some("C:\\a"));
        // 已带前缀不重复加
        assert_eq!(to_extended("\\\\?\\C:\\a").to_str(), Some("\\\\?\\C:\\a"));
        // 长路径加 \\?\ 前缀，正斜杠归一
        let long = format!("C:\\{}", "x".repeat(300));
        assert_eq!(
            to_extended(&long).to_str().unwrap(),
            format!("\\\\?\\C:\\{}", "x".repeat(300))
        );
        let long_fwd = format!("C:/{}", "x".repeat(300));
        assert_eq!(
            to_extended(&long_fwd).to_str().unwrap(),
            format!("\\\\?\\C:\\{}", "x".repeat(300))
        );
        // 长 UNC 走 \\?\UNC\ 形式
        let long_unc = format!("\\\\server\\share\\{}", "x".repeat(300));
        assert_eq!(
            to_extended(&long_unc).to_str().unwrap(),
            format!("\\\\?\\UNC\\server\\share\\{}", "x".repeat(300))
        );
    }
}
