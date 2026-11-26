//! 便携化配置根目录（§6.9）：优先 exe 旁，不可写时降级 %APPDATA%\x-dir。

use serde_json::Value;
use std::path::{Path, PathBuf};

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

/// 原子写 JSON：临时文件 + rename（§6.9）。settings.json 历史上四处直写
/// （save_settings / shot_save_prefs / cliphist_save_size / winstate 补丁），
/// 写入中途断电即全档损坏且无备份——统一收敛到本函数与下方两个助手
pub fn atomic_write_json(p: &Path, v: &Value) -> Result<(), String> {
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("写入失败：{e}"))
}

/// settings.json 专用原子写（root 可注入供 cargo test）：写前把磁盘上**能解析**
/// 的旧档快照到 settings.json.bak——bak 恒为最近一份好档（当前档损坏/缺失时
/// 不动 bak，防坏档把好备份顶掉）；快照 best-effort，失败不阻断主写
pub fn write_settings_doc_at(root: &Path, v: &Value) -> Result<(), String> {
    let p = root.join("settings.json");
    let bak = p.with_extension("json.bak");
    if let Ok(s) = std::fs::read_to_string(&p)
        && serde_json::from_str::<Value>(&s).is_ok()
    {
        let tmp = bak.with_extension("bak.tmp");
        if std::fs::write(&tmp, &s).is_ok() {
            let _ = std::fs::rename(&tmp, &bak);
        }
    }
    atomic_write_json(&p, v)
}

pub fn write_settings_doc(v: &Value) -> Result<(), String> {
    write_settings_doc_at(&config_root(), v)
}

/// 读 settings.json（root 可注入供 cargo test），主档缺失或损坏时自动从
/// settings.json.bak 自愈：bak 可解析则原子回写主档（修复 best-effort，失败
/// 不影响本次返回）。回写意味着「用户删 settings.json 想重置」会被 bak 复活
/// 一次——可接受的取舍：损坏丢全档远比误复活一次重
pub fn load_settings_doc_at(root: &Path) -> Option<Value> {
    let p = root.join("settings.json");
    if let Ok(s) = std::fs::read_to_string(&p)
        && let Ok(v) = serde_json::from_str::<Value>(&s)
    {
        return Some(v);
    }
    let bak = p.with_extension("json.bak");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&bak).ok()?).ok()?;
    let _ = atomic_write_json(&p, &v);
    Some(v)
}

pub fn load_settings_doc() -> Option<Value> {
    load_settings_doc_at(&config_root())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_strips_path_chars() {
        assert_eq!(sanitize_name("a/b\\c:d"), "abcd");
        assert_eq!(sanitize_name("  "), "未命名");
        assert_eq!(sanitize_name(" 我的工作区 "), "我的工作区");
    }

    fn tmp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("xdir_cfgdoc_{tag}_{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn cleanup(root: &Path) {
        std::fs::remove_dir_all(root).ok();
    }

    fn main_of(root: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(root.join("settings.json")).unwrap()).unwrap()
    }

    fn bak_of(root: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(root.join("settings.json.bak")).unwrap())
            .unwrap()
    }

    #[test]
    fn write_snapshots_previous_good_doc_to_bak() {
        let root = tmp_root("bak");
        write_settings_doc_at(&root, &json!({"v": 1})).unwrap();
        // 首写无旧档 → 无 bak
        assert!(!root.join("settings.json.bak").exists());
        write_settings_doc_at(&root, &json!({"v": 2})).unwrap();
        assert_eq!(main_of(&root), json!({"v": 2}));
        assert_eq!(bak_of(&root), json!({"v": 1}));
        cleanup(&root);
    }

    #[test]
    fn corrupt_previous_leaves_bak_untouched() {
        let root = tmp_root("corruptbak");
        write_settings_doc_at(&root, &json!({"v": 1})).unwrap();
        write_settings_doc_at(&root, &json!({"v": 2})).unwrap();
        // 主档被外部改坏后再写：坏档不得顶掉好备份
        std::fs::write(root.join("settings.json"), "not json").unwrap();
        write_settings_doc_at(&root, &json!({"v": 3})).unwrap();
        assert_eq!(main_of(&root), json!({"v": 3}));
        assert_eq!(bak_of(&root), json!({"v": 1}));
        cleanup(&root);
    }

    #[test]
    fn load_recovers_from_bak_and_repairs_main() {
        let root = tmp_root("recover");
        write_settings_doc_at(&root, &json!({"v": 1})).unwrap();
        write_settings_doc_at(&root, &json!({"v": 2})).unwrap();
        std::fs::write(root.join("settings.json"), "{broken").unwrap();
        assert_eq!(load_settings_doc_at(&root), Some(json!({"v": 1})));
        // 主档已被修复为 bak 内容
        assert_eq!(main_of(&root), json!({"v": 1}));
        cleanup(&root);
    }

    #[test]
    fn load_recovers_when_main_missing_but_bak_exists() {
        let root = tmp_root("missing");
        write_settings_doc_at(&root, &json!({"v": 1})).unwrap();
        write_settings_doc_at(&root, &json!({"v": 2})).unwrap();
        std::fs::remove_file(root.join("settings.json")).unwrap();
        assert_eq!(load_settings_doc_at(&root), Some(json!({"v": 1})));
        assert_eq!(main_of(&root), json!({"v": 1}));
        cleanup(&root);
    }

    #[test]
    fn load_missing_everything_is_none() {
        let root = tmp_root("none");
        assert_eq!(load_settings_doc_at(&root), None);
        cleanup(&root);
    }
}
