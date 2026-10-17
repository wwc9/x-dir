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
