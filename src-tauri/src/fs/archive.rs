//! 压缩包解压（zip / 7z）：每个包解到 `<dest>/<包名>/` 子目录（多包互不覆盖、
//! 不散落）。zip / 7z 均逐条目落盘（进度按字节、支持取消、拒绝 zip-slip 穿越
//! 条目、解压总量硬闸防高压缩比炸弹）。

use std::io::{Read, Write as _};
use std::sync::atomic::{AtomicBool, Ordering};

use super::path::{file_name_of, join_name, parent_of, split_ext, to_extended};
use crate::jobs::pick::available_name;
use crate::jobs::{FailItem, JobProgress};

/// 解压总量上限（zip/7z 共用）：恶意高压缩比包可谎报条目尺寸，按实际解出
/// 字节硬闸，超限中止防填满磁盘（2026-11-01 安全加固）
const EXTRACT_TOTAL_MAX: u64 = 10 << 30;

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
            extract_7z(src, &out_dir, cancel, prog)
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
    let mut total: u64 = 0;
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
        // 解压总量硬闸：条目可谎报尺寸，按实际拷贝字节计（take 到限额即截断，
        // 拷满 = 超限，中止整包）
        let limit = EXTRACT_TOTAL_MAX - total;
        let copied = std::io::copy(&mut (&mut entry).take(limit), &mut out)
            .map_err(|e| format!("{rel}：{e}"))?;
        if copied >= limit {
            return Err(format!(
                "解压总量超出上限（{} GiB）",
                EXTRACT_TOTAL_MAX >> 30
            ));
        }
        total += copied;
        prog.done_bytes += copied;
    }
    Ok(())
}

/// 7z：逐条目落盘（与 zip 同一净化与限额口径）。绝不整包 `decompress_file`：
/// sevenz-rust 0.6 的默认落盘是裸 `dest.join(entry.name())`，`..\` 或绝对路径
/// 条目可写到 out_dir 之外任意位置（zip-slip，2026-11-01 审查修复——此前只有
/// zip 路径做了净化，文档却宣称两者都防）。
/// 取消以 Err 中止（0.6.1 的 folder 循环忽略回调 Ok(false)，无法温和停止），
/// 闭包标志位区分「取消」与「真失败」，出口翻译回静默取消
fn extract_7z(
    src: &str,
    out_dir: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
) -> Result<(), String> {
    std::fs::create_dir_all(to_extended(out_dir)).map_err(|e| format!("创建目录失败：{e}"))?;
    let mut r = sevenz_rust::SevenZReader::open(to_extended(src), sevenz_rust::Password::empty())
        .map_err(|e| format!("7z 解析失败：{e}"))?;
    let mut total: u64 = 0;
    let mut cancelled_out = false;
    let mut buf = [0u8; 64 * 1024];
    let result = r
        .for_each_entries(|entry, reader| {
            if is_cancelled(cancel) {
                cancelled_out = true;
                return Err(sevenz_rust::Error::other("cancelled"));
            }
            // 与 zip 同源的净化：穿越/非法条目跳过不中断
            let Some(rel) = safe_entry_rel(entry.name()) else {
                return Ok(true);
            };
            let target = join_name(out_dir, &rel);
            if entry.is_directory() {
                std::fs::create_dir_all(to_extended(&target))?;
                return Ok(true);
            }
            if let Some(par) = parent_of(&target) {
                std::fs::create_dir_all(to_extended(&par))?;
            }
            let mut out = std::io::BufWriter::new(std::fs::File::create(to_extended(&target))?);
            loop {
                let n = reader.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])?;
                total += n as u64;
                if total > EXTRACT_TOTAL_MAX {
                    return Err(sevenz_rust::Error::other(format!(
                        "解压总量超出上限（{} GiB）",
                        EXTRACT_TOTAL_MAX >> 30
                    )));
                }
                prog.done_bytes += n as u64;
            }
            out.flush()?;
            Ok(true)
        })
        .map_err(|e| e.to_string());
    match result {
        Ok(()) => Ok(()),
        // 取消 = 静默返回（与 zip 路径同语义，已落盘条目保留）
        Err(_) if cancelled_out => Ok(()),
        Err(msg) => Err(format!("7z 解压失败：{msg}")),
    }
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

    /// sevenz writer 造一个含正常条目 + 穿越条目的包（7z zip-slip 回归，
    /// 2026-11-01：旧实现整包 decompress_file 裸 join 条目名）
    #[cfg(not(target_arch = "wasm32"))]
    fn write_probe_7z(path: &std::path::Path, payload: &std::path::Path) {
        let mut w = sevenz_rust::SevenZWriter::create(path).unwrap();
        let entry = sevenz_rust::SevenZArchiveEntry::from_path(payload, "a.txt".to_string());
        w.push_archive_entry(entry, Some(std::fs::File::open(payload).unwrap()))
            .unwrap();
        let evil = sevenz_rust::SevenZArchiveEntry::from_path(payload, "../evil.txt".to_string());
        w.push_archive_entry(evil, Some(std::fs::File::open(payload).unwrap()))
            .unwrap();
        w.finish().unwrap();
    }

    #[test]
    fn extract_7z_lays_entries_and_skips_evil() {
        let dir = tempdir();
        let mk = join_name(&dir, "mk");
        std::fs::create_dir_all(to_extended(&mk)).unwrap();
        let payload = join_name(&mk, "payload.txt");
        std::fs::write(to_extended(&payload), b"seven").unwrap();
        let sz = join_name(&dir, "t.7z");
        write_probe_7z(&to_extended(&sz), &to_extended(&payload));
        let out = join_name(&dir, "t");
        let mut p = prog();
        extract_7z(&sz, &out, &AtomicBool::new(false), &mut p).unwrap();
        assert_eq!(
            std::fs::read_to_string(to_extended(&join_name(&out, "a.txt"))).unwrap(),
            "seven"
        );
        // 穿越条目既不落在包目录内，也不逃逸到 dest_root
        assert!(!path_exists(&join_name(&out, "evil.txt")));
        assert!(!path_exists(&join_name(&dir, "evil.txt")));
    }

    #[test]
    fn extract_7z_cancel_is_silent() {
        let dir = tempdir();
        let mk = join_name(&dir, "mk");
        std::fs::create_dir_all(to_extended(&mk)).unwrap();
        let payload = join_name(&mk, "payload.txt");
        std::fs::write(to_extended(&payload), b"seven").unwrap();
        let sz = join_name(&dir, "t.7z");
        write_probe_7z(&to_extended(&sz), &to_extended(&payload));
        let out = join_name(&dir, "t");
        let mut p = prog();
        extract_7z(&sz, &out, &AtomicBool::new(true), &mut p).unwrap();
    }
}
