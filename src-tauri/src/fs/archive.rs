//! 压缩包解压（zip / 7z）：每个包解到 `<dest>/<包名>/` 子目录（多包互不覆盖、
//! 不散落）。zip 逐条目落盘（进度按字节、支持取消、拒绝 zip-slip 穿越条目）；
//! 7z 走 sevenz-rust 整包解压（进度按包计）。

use std::sync::atomic::{AtomicBool, Ordering};

use super::path::{file_name_of, join_name, parent_of, split_ext, to_extended};
use crate::jobs::pick::available_name;
use crate::jobs::{FailItem, JobProgress};

fn is_cancelled(c: &AtomicBool) -> bool {
    c.load(Ordering::SeqCst)
}

/// 条目名安全化（纯函数）：剥前导斜杠、反斜杠归一；含 `..` 段或盘符冒号的
/// 条目判为穿越/非法（zip-slip），返回 None 由调用方跳过
fn safe_entry_rel(name: &str) -> Option<String> {
    let s = name.trim_start_matches('/').replace('\\', "/");
    if s.is_empty() || s.split('/').any(|seg| seg == "..") || s.contains(':') {
        return None;
    }
    Some(s)
}

/// 解压一批压缩包到 dest_root：每包一个 `<包名>/` 子目录（重名自动 (2) 递增）
pub(crate) fn run_extract(
    sources: &[String],
    dest_root: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = sources.len() as u64;
    for src in sources {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = src.clone();
        let name = file_name_of(src);
        let stem = split_ext(&name).0.to_string();
        // 目标子目录重名时 available_name 另起 (2)，绝不混写进旧目录
        let out_dir = available_name(&join_name(dest_root, &stem));
        let lower = name.to_ascii_lowercase();
        let r = if lower.ends_with(".zip") {
            extract_zip(src, &out_dir, cancel, prog)
        } else if lower.ends_with(".7z") {
            extract_7z(src, &out_dir)
        } else {
            Err("不支持的压缩格式（仅 zip / 7z）".to_string())
        };
        if let Err(msg) = r {
            failed.push(FailItem {
                path: src.clone(),
                message: msg,
            });
        }
        prog.done_files += 1;
        // 进度回报由外层任务引擎的 EmitterState 统一节流，这里只累计
    }
}

/// zip：逐条目落盘；取消时静默返回（与复制引擎同语义，已落盘条目保留）
fn extract_zip(
    src: &str,
    out_dir: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
) -> Result<(), String> {
    let f = std::fs::File::open(to_extended(src)).map_err(|e| format!("打开失败：{e}"))?;
    let mut ar = zip::ZipArchive::new(f).map_err(|e| format!("zip 解析失败：{e}"))?;
    std::fs::create_dir_all(to_extended(out_dir)).map_err(|e| format!("创建目录失败：{e}"))?;
    for i in 0..ar.len() {
        if is_cancelled(cancel) {
            return Ok(());
        }
        let mut entry = ar.by_index(i).map_err(|e| e.to_string())?;
        // 名字解码复用预览管线（GBK 包不乱码）；非法条目跳过不中断
        let Some(rel) = safe_entry_rel(&crate::commands::preview::decode_entry_name(
            entry.name_raw(),
        )) else {
            continue;
        };
        let target = join_name(out_dir, &rel);
        if entry.is_dir() {
            std::fs::create_dir_all(to_extended(&target)).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(par) = parent_of(&target) {
            std::fs::create_dir_all(to_extended(&par)).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(to_extended(&target)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("{}：{e}", rel))?;
        prog.done_bytes += entry.size();
    }
    Ok(())
}

/// 7z：sevenz-rust 整包解压（crate 内部处理目录结构与条目名）
fn extract_7z(src: &str, out_dir: &str) -> Result<(), String> {
    std::fs::create_dir_all(to_extended(out_dir)).map_err(|e| format!("创建目录失败：{e}"))?;
    sevenz_rust::decompress_file(to_extended(src), to_extended(out_dir))
        .map_err(|e| format!("7z 解压失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::entry::path_exists;
    use std::io::Write;
    use std::sync::atomic::AtomicU32;
    use zip::write::SimpleFileOptions;

    static SEQ: AtomicU32 = AtomicU32::new(0);
    fn tempdir() -> String {
        let d = std::env::temp_dir().join(format!(
            "xdir-arch-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }
    fn prog() -> JobProgress {
        JobProgress {
            job_id: 0,
            phase: "running",
            total_files: 0,
            done_files: 0,
            total_bytes: 0,
            done_bytes: 0,
            current_path: String::new(),
        }
    }

    /// zip::ZipWriter 造一个含正常条目 + 穿越条目的包
    fn write_probe_zip(path: &str) {
        let buf = std::io::Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(buf);
        let opt = SimpleFileOptions::default();
        w.start_file("a.txt", opt).unwrap();
        w.write_all(b"hello").unwrap();
        w.add_directory("sub", opt).unwrap();
        w.start_file("sub/c.txt", opt).unwrap();
        w.write_all(b"world").unwrap();
        w.start_file("../evil.txt", opt).unwrap();
        w.write_all(b"evil").unwrap();
        std::fs::write(path, w.finish().unwrap().into_inner()).unwrap();
    }

    #[test]
    fn safe_entry_rel_blocks_traversal() {
        assert_eq!(safe_entry_rel("a/b.txt").as_deref(), Some("a/b.txt"));
        assert_eq!(safe_entry_rel("/abs/x").as_deref(), Some("abs/x"));
        assert_eq!(safe_entry_rel("a\\b.txt").as_deref(), Some("a/b.txt"));
        assert_eq!(safe_entry_rel("../evil"), None);
        assert_eq!(safe_entry_rel("a/../evil"), None);
        assert_eq!(safe_entry_rel("C:evil"), None);
        assert_eq!(safe_entry_rel(""), None);
    }

    #[test]
    fn extract_zip_lays_entries_and_skips_evil() {
        let dir = tempdir();
        let zip_path = join_name(&dir, "t.zip");
        write_probe_zip(&zip_path);
        let out = join_name(&dir, "t");
        let mut p = prog();
        extract_zip(&zip_path, &out, &AtomicBool::new(false), &mut p).unwrap();
        assert_eq!(
            std::fs::read_to_string(to_extended(&join_name(&out, "a.txt"))).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(to_extended(&join_name(&out, "sub/c.txt"))).unwrap(),
            "world"
        );
        // 穿越条目既不落在包目录内，也不逃逸到 dest_root（out 的父目录）
        assert!(!path_exists(&join_name(&out, "evil.txt")));
        assert!(!path_exists(&join_name(&dir, "evil.txt")));
    }

    #[test]
    fn run_extract_rejects_unknown_ext() {
        let dir = tempdir();
        let src = join_name(&dir, "x.rar");
        std::fs::write(to_extended(&src), b"?").unwrap();
        let mut p = prog();
        let mut failed = Vec::new();
        run_extract(
            std::slice::from_ref(&src),
            &dir,
            &AtomicBool::new(false),
            &mut p,
            &mut failed,
        );
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].path, src);
    }

    #[test]
    fn run_extract_cancel_is_silent() {
        let dir = tempdir();
        let src = join_name(&dir, "t.zip");
        write_probe_zip(&src);
        let mut p = prog();
        let mut failed = Vec::new();
        let cancel = AtomicBool::new(true);
        run_extract(&[src], &dir, &cancel, &mut p, &mut failed);
        assert!(failed.is_empty());
    }
}
