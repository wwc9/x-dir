//! 便携化配置根目录（§6.9）：优先 exe 旁，不可写时降级 %APPDATA%\x-dir。

use std::path::PathBuf;

pub fn config_root() -> PathBuf {
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        let cfg = dir.join("config");
        if std::fs::create_dir_all(&cfg).is_ok() {
            return cfg;
        }
    }
    // 降级链末段不允许 panic：APPDATA 缺失（沙箱/服务上下文）或不可写时落到
    // 临时目录，配置退化为会话级——启动期 panic 会因 panic=abort 直接退进程
    let fallback = match std::env::var("APPDATA") {
        Ok(a) => PathBuf::from(a).join("x-dir").join("config"),
        Err(_) => std::env::temp_dir().join("x-dir").join("config"),
    };
    match std::fs::create_dir_all(&fallback) {
        Ok(()) => fallback,
        Err(_) => std::env::temp_dir(),
    }
}

pub fn workspaces_dir() -> PathBuf {
    let d = config_root().join("workspaces");
    std::fs::create_dir_all(&d).ok();
    d
}

/// 工作区名 → 文件名安全字符串
pub fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let t = cleaned.trim();
    if t.is_empty() {
        "未命名".to_string()
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_path_chars() {
        assert_eq!(sanitize_name("a/b\\c:d"), "abcd");
        assert_eq!(sanitize_name("  "), "未命名");
        assert_eq!(sanitize_name(" 我的工作区 "), "我的工作区");
    }
}
