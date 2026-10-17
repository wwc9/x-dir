//! 目录分析工具：重复文件查找（SHA-256 内容指纹）、目录体积统计、双文件夹比较。
//! 同步扫描、跑在 Tauri 异步命令线程（不占主线程）；一律跳过符号链接/目录联接
//! （Windows 下 junction 的 file_type().is_symlink() = true），防环防重复计数。

use std::collections::HashMap;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::path::file_name_of;

/// 扫描规模上限（防病态目录树把会话拖死）
const MAX_FILES: usize = 200_000;
/// 全量哈希的文件数上限（大体积组才值得算；超出即停止新增指纹，已算的不回滚）
const MAX_HASH_FILES: usize = 20_000;
/// 返回的重复组上限（按可节省字节降序截断）
const MAX_GROUPS: usize = 500;

fn walk_files(dir: &str, out: &mut Vec<String>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        if out.len() >= cap {
            return;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let p = entry.path().to_string_lossy().into_owned();
        if ft.is_dir() {
            walk_files(&p, out, cap);
        } else {
            out.push(p);
        }
    }
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = std::io::Read::read(&mut f, &mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub hash: String,
    pub size: u64,
    pub paths: Vec<String>,
}

/// 重复文件：按体积粗分 → 同体积组做 SHA-256 指纹 → 同指纹且 >1 份成组；
/// 按可节省字节降序，截断 MAX_GROUPS。0 字节文件不算重复（处处都是）。
pub fn find_duplicates(root: &str) -> Vec<DupGroup> {
    let mut files = Vec::new();
    walk_files(root, &mut files, MAX_FILES);
    let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
    for p in files {
        if let Ok(m) = std::fs::metadata(&p)
            && m.len() > 0
        {
            by_size.entry(m.len()).or_default().push(p);
        }
    }
    let mut by_hash: HashMap<(u64, String), Vec<String>> = HashMap::new();
    let mut hashed = 0usize;
    for (size, group) in by_size {
        if group.len() < 2 {
            continue;
        }
        for p in group {
            if hashed >= MAX_HASH_FILES {
                break;
            }
            hashed += 1;
            if let Ok(h) = sha256_of(Path::new(&p)) {
                by_hash.entry((size, h)).or_default().push(p);
            }
        }
    }
    let mut groups: Vec<DupGroup> = by_hash
        .into_iter()
        .filter(|(_, ps)| ps.len() > 1)
        .map(|((size, hash), mut paths)| {
            paths.sort();
            DupGroup { hash, size, paths }
        })
        .collect();
    groups.sort_by(|a, b| {
        let waste = |g: &DupGroup| g.size * (g.paths.len() as u64 - 1);
        waste(b).cmp(&waste(a))
    });
    groups.truncate(MAX_GROUPS);
    groups
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirSizeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub files: u64,
}

/// 目录体积：列出 dir 的直接子项（文件夹递归计体积与文件数，文件单计），按体积降序
pub fn dir_sizes(dir: &str) -> Vec<DirSizeEntry> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let p = entry.path().to_string_lossy().into_owned();
        if ft.is_dir() {
            let mut files = Vec::new();
            walk_files(&p, &mut files, MAX_FILES);
            let size = files
                .iter()
                .filter_map(|f| std::fs::metadata(f).ok())
                .map(|m| m.len())
                .sum();
            out.push(DirSizeEntry {
                name: file_name_of(&p),
                path: p,
                is_dir: true,
                size,
                files: files.len() as u64,
            });
        } else if let Ok(m) = std::fs::metadata(&p) {
            out.push(DirSizeEntry {
                name: file_name_of(&p),
                path: p,
                is_dir: false,
                size: m.len(),
                files: 1,
            });
        }
    }
    out.sort_by_key(|r| std::cmp::Reverse(r.size));
    out
}

/// 空文件/空文件夹扫描结果：0 字节文件与无子项的目录分列返回
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmptyScan {
    pub empty_files: Vec<String>,
    pub empty_dirs: Vec<String>,
    pub scanned: u64,
}

/// 空文件/空文件夹扫描：递归遍历（跳过符号链接），
/// 文件按字节数 == 0 判空；目录按 read_dir 无子项判字面空
/// （只含空子目录的父目录不算，语义直观且删除时不会误带走未勾选项）
pub fn scan_empty(root: &str) -> EmptyScan {
    fn walk(dir: &str, root: &str, out: &mut EmptyScan) {
        if out.scanned >= MAX_FILES as u64 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut child_count = 0u64;
        for entry in rd.flatten() {
            if out.scanned >= MAX_FILES as u64 {
                return;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                child_count += 1;
                continue;
            }
            child_count += 1;
            let p = entry.path().to_string_lossy().into_owned();
            if ft.is_dir() {
                out.scanned += 1;
                walk(&p, root, out);
            } else if let Ok(m) = std::fs::metadata(&p) {
                out.scanned += 1;
                if m.len() == 0 {
                    out.empty_files.push(p);
                }
            }
        }
        // 顶层根目录自身不计入空目录判定（用户选它就是要清理它内部）
        if child_count == 0 && dir != root {
            out.empty_dirs.push(dir.to_string());
        }
    }
    let mut out = EmptyScan {
        empty_files: vec![],
        empty_dirs: vec![],
        scanned: 0,
    };
    walk(root, root, &mut out);
    out.empty_files.sort();
    out.empty_dirs.sort();
    out
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RelItem {
    pub rel: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub a_only: Vec<RelItem>,
    pub b_only: Vec<RelItem>,
    /// 两侧同名但类型不同 / 体积或修改时间不同（目录仅在类型冲突时计入）
    pub differ: Vec<RelItem>,
    pub same: u64,
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn collect_rel(root: &str, map: &mut HashMap<String, RelItem>) {
    fn walk(dir: &str, rel_prefix: &str, map: &mut HashMap<String, RelItem>) {
        if map.len() >= MAX_FILES {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() || map.len() >= MAX_FILES {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if rel_prefix.is_empty() {
                name
            } else {
                format!("{rel_prefix}/{name}")
            };
            let p = entry.path().to_string_lossy().into_owned();
            if ft.is_dir() {
                map.insert(
                    rel.clone(),
                    RelItem {
                        rel: rel.clone(),
                        is_dir: true,
                        size: 0,
                        mtime_ms: 0,
                    },
                );
                walk(&p, &rel, map);
            } else if let Ok(m) = std::fs::metadata(&p) {
                map.insert(
                    rel.clone(),
                    RelItem {
                        rel,
                        is_dir: false,
                        size: m.len(),
                        mtime_ms: mtime_ms(Path::new(&p)),
                    },
                );
            }
        }
    }
    walk(root, "", map);
}

/// 双文件夹比较（相对路径对齐）：a_only/b_only = 一侧独有（目录整棵计一项），
/// differ = 两侧同名但类型/体积/修改时间不同，same = 完全一致的文件数
pub fn compare_dirs(a: &str, b: &str) -> CompareResult {
    let mut amap = HashMap::new();
    collect_rel(a, &mut amap);
    let mut bmap = HashMap::new();
    collect_rel(b, &mut bmap);
    let mut res = CompareResult {
        a_only: vec![],
        b_only: vec![],
        differ: vec![],
        same: 0,
    };
    for (rel, ai) in &amap {
        match bmap.get(rel) {
            None => res.a_only.push(ai.clone()),
            Some(bi) => {
                if ai.is_dir && bi.is_dir {
                    res.same += 1;
                } else if ai.is_dir != bi.is_dir || ai.size != bi.size || ai.mtime_ms != bi.mtime_ms
                {
                    res.differ.push(ai.clone());
                } else {
                    res.same += 1;
                }
            }
        }
    }
    for (rel, bi) in &bmap {
        if !amap.contains_key(rel) {
            res.b_only.push(bi.clone());
        }
    }
    let by_rel = |x: &RelItem, y: &RelItem| x.rel.cmp(&y.rel);
    res.a_only.sort_by(by_rel);
    res.b_only.sort_by(by_rel);
    res.differ.sort_by(by_rel);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    fn tempdir() -> String {
        let d = std::env::temp_dir().join(format!(
            "xdir-analyze-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn duplicates_grouped_by_content() {
        let dir = tempdir();
        std::fs::write(join(&dir, "a.bin"), b"same").unwrap();
        std::fs::write(join(&dir, "b.bin"), b"same").unwrap();
        std::fs::write(join(&dir, "c.bin"), b"diff!").unwrap();
        // 0 字节文件不参与
        std::fs::write(join(&dir, "empty"), b"").unwrap();
        let mut sub = dir.clone();
        sub.push_str("\\sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(join(&sub, "d.bin"), b"same").unwrap();
        let groups = find_duplicates(&dir);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].size, 4);
        assert_eq!(groups[0].paths.len(), 3);
    }

    #[test]
    fn dir_sizes_lists_children_desc() {
        let dir = tempdir();
        let big = join(&dir, "big");
        std::fs::create_dir_all(&big).unwrap();
        std::fs::write(join(&big, "x.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(join(&dir, "top.bin"), vec![0u8; 10]).unwrap();
        let rows = dir_sizes(&dir);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "big");
        assert!(rows[0].is_dir);
        assert_eq!(rows[0].size, 100);
        assert_eq!(rows[0].files, 1);
        assert_eq!(rows[1].name, "top.bin");
        assert!(!rows[1].is_dir);
    }

    #[test]
    fn compare_dirs_classifies_and_differs() {
        let a = tempdir();
        let b = tempdir();
        std::fs::write(join(&a, "only_a.txt"), b"1").unwrap();
        std::fs::write(join(&b, "only_b.txt"), b"2").unwrap();
        std::fs::write(join(&a, "same.txt"), b"same").unwrap();
        std::fs::write(join(&b, "same.txt"), b"same").unwrap();
        std::fs::write(join(&a, "diff.txt"), b"AAA").unwrap();
        std::fs::write(join(&b, "diff.txt"), b"BBBB").unwrap();
        // 固定 mtime：same.txt 两侧一致（判 same），diff.txt 也一致（纯体积判 differ），
        // 避免测试机写盘时序造成偶发
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000);
        for p in [
            join(&a, "same.txt"),
            join(&b, "same.txt"),
            join(&a, "diff.txt"),
            join(&b, "diff.txt"),
        ] {
            std::fs::File::options()
                .write(true)
                .open(&p)
                .unwrap()
                .set_modified(t)
                .unwrap();
        }
        let r = compare_dirs(&a, &b);
        assert_eq!(r.a_only.len(), 1);
        assert_eq!(r.a_only[0].rel, "only_a.txt");
        assert_eq!(r.b_only.len(), 1);
        assert_eq!(r.b_only[0].rel, "only_b.txt");
        assert_eq!(r.differ.len(), 1);
        assert_eq!(r.differ[0].rel, "diff.txt");
        assert_eq!(r.same, 1);
    }

    #[test]
    fn scan_empty_finds_zero_files_and_literal_empty_dirs() {
        let dir = tempdir();
        // 空文件两个（根 + 子目录）、非空文件一个
        std::fs::write(join(&dir, "e1.txt"), b"").unwrap();
        let sub = join(&dir, "sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(join(&sub, "e2.bin"), b"").unwrap();
        std::fs::write(join(&sub, "full.txt"), b"x").unwrap();
        // 字面空目录
        std::fs::create_dir_all(join(&dir, "void")).unwrap();
        // 只含空子目录的父目录 ≠ 空目录
        let outer = join(&dir, "outer");
        std::fs::create_dir_all(join(&outer, "inner")).unwrap();
        let r = scan_empty(&dir);
        assert_eq!(
            r.empty_files,
            vec![join(&dir, "e1.txt"), join(&sub, "e2.bin")]
        );
        assert_eq!(
            r.empty_dirs,
            vec![join(&dir, "outer\\inner"), join(&dir, "void")]
        );
        assert!(r.scanned >= 6);
    }

    fn join(dir: &str, name: &str) -> String {
        crate::fs::path::join_name(dir, name)
    }
}
