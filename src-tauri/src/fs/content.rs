//! 内容搜索（2026-10-22）：在指定目录范围内做文件内容关键词匹配。
//! 设计边界：限定目录范围（无内容索引可用，全盘内容搜索不可行）；
//! 单文件 2MB 上限 + 前缀二进制嗅探 + 命中文件数/扫描数封顶 + 可取消，
//! 保证有界时间内必然返回。编码：UTF-8 优先，失败回退 GBK（中文 Windows
//! 文本常见编码，encoding_rs），仍失败按 lossy UTF-8。

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Instant;

/// 单文件读取上限：超过即跳过（内容搜索不是全文分析）
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 命中文件数上限（达到即置 truncated 收尾）
pub const MAX_FILE_RESULTS: usize = 200;
/// 每文件回显命中行数上限
pub const MAX_LINES_PER_FILE: usize = 3;
/// 扫描文件数上限（与取消标志共同防失控）
pub const MAX_SCAN: usize = 200_000;

fn skip_dirs() -> [&'static str; 2] {
    ["$recycle.bin", "system volume information"]
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContentLine {
    pub line: u32,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub lines: Vec<ContentLine>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResult {
    pub matches: Vec<ContentMatch>,
    pub scanned: usize,
    pub skipped_binary: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

impl ContentSearchResult {
    pub fn empty() -> Self {
        Self {
            matches: vec![],
            scanned: 0,
            skipped_binary: 0,
            truncated: false,
            elapsed_ms: 0,
        }
    }
}

/// 前缀式二进制嗅探：头部 8KB 含 NUL 字节即按二进制跳过
pub fn looks_binary(buf: &[u8]) -> bool {
    let head = &buf[..buf.len().min(8192)];
    head.contains(&0)
}

/// 多词 AND、大小写不敏感的行级匹配：返回至多 max_lines 条命中行（行号 1 起）
pub fn match_content(text: &str, terms_lower: &[String], max_lines: usize) -> Vec<ContentLine> {
    if terms_lower.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let lower = raw.to_lowercase();
        if terms_lower.iter().all(|t| lower.contains(t.as_str())) {
            out.push(ContentLine {
                line: (i + 1) as u32,
                text: raw.trim_end().to_string(),
            });
            if out.len() >= max_lines {
                break;
            }
        }
    }
    out
}

/// 解码文件字节：UTF-8 优先，失败回退 GBK，仍失败按 lossy UTF-8
fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
            if had_errors {
                String::from_utf8_lossy(bytes).into_owned()
            } else {
                decoded.into_owned()
            }
        }
    }
}

/// 扩展名白名单：None/空表 = 不限；列表 = 小写扩展名精确匹配
fn ext_allowed(name: &str, exts_lower: &Option<Vec<String>>) -> bool {
    match exts_lower {
        None => true,
        Some(list) if list.is_empty() => true,
        Some(list) => {
            let ext = Path::new(name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            list.contains(&ext)
        }
    }
}

/// 单文件扫描：读字节 → 嗅探二进制 → 解码 → 行匹配。命中 = Some(match)
fn scan_file(
    path: &Path,
    terms_lower: &[String],
    out: &mut ContentSearchResult,
) -> Option<ContentMatch> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return None;
    }
    if looks_binary(&buf) {
        out.skipped_binary += 1;
        return None;
    }
    let text = decode(&buf);
    let lines = match_content(&text, terms_lower, MAX_LINES_PER_FILE);
    if lines.is_empty() {
        return None;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned())?;
    let (size, mtime_ms) = match path.metadata() {
        Ok(m) => (
            m.len(),
            m.modified()
                .ok()
                .and_then(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .ok()
                        .map(|d| d.as_millis() as u64)
                })
                .unwrap_or(0),
        ),
        Err(_) => (0, 0),
    };
    Some(ContentMatch {
        path: path.to_string_lossy().into_owned(),
        name,
        size,
        mtime_ms,
        lines,
    })
}

/// 递归遍历 root 做内容搜索：命中文件数/扫描数封顶、可取消。
/// root 为单文件时直接对它匹配（前端传具体文件也成立）。
pub fn search_content(
    root: &str,
    terms_lower: &[String],
    exts_lower: Option<Vec<String>>,
    cancel: &Arc<AtomicBool>,
) -> ContentSearchResult {
    let started = Instant::now();
    let cancelled = || cancel.load(Ordering::Relaxed);
    let mut out = ContentSearchResult::empty();
    let root_path = Path::new(root);
    if !root_path.exists() || terms_lower.is_empty() {
        out.elapsed_ms = started.elapsed().as_millis() as u64;
        return out;
    }
    if root_path.is_file() {
        out.scanned = 1;
        if let Some(m) = scan_file(root_path, terms_lower, &mut out) {
            out.matches.push(m);
        }
        out.elapsed_ms = started.elapsed().as_millis() as u64;
        return out;
    }
    let mut stack = vec![root_path.to_path_buf()];
    'outer: while let Some(dir) = stack.pop() {
        if cancelled() || out.matches.len() >= MAX_FILE_RESULTS || out.scanned >= MAX_SCAN {
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            if cancelled() || out.matches.len() >= MAX_FILE_RESULTS || out.scanned >= MAX_SCAN {
                break 'outer;
            }
            let Ok(ft) = entry.file_type() else { continue };
            let name_lower = entry.file_name().to_string_lossy().to_lowercase();
            if ft.is_dir() {
                if !skip_dirs().contains(&name_lower.as_str()) {
                    stack.push(entry.path());
                }
                continue;
            }
            out.scanned += 1;
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_FILE_BYTES || !ext_allowed(&name_lower, &exts_lower) {
                continue;
            }
            if let Some(m) = scan_file(&entry.path(), terms_lower, &mut out) {
                out.matches.push(m);
                if out.matches.len() >= MAX_FILE_RESULTS {
                    out.truncated = true;
                    break 'outer;
                }
            }
        }
    }
    out.truncated = out.truncated || cancelled() || out.scanned >= MAX_SCAN;
    out.elapsed_ms = started.elapsed().as_millis() as u64;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_lowercase()).collect()
    }

    #[test]
    fn multi_term_and_case_insensitive() {
        let lines = match_content(
            "Hello World\nfoo BAR hello baz\nnothing",
            &terms(&["hello", "bar"]),
            10,
        );
        // 多词 AND：单行需同时包含两词（大小写不敏感），第二行命中
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].line, 2);
        assert_eq!(lines[0].text, "foo BAR hello baz");
    }

    #[test]
    fn max_lines_cap() {
        let text = "hit\nhit\nhit\nhit";
        let lines = match_content(text, &terms(&["hit"]), 3);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2].line, 3);
    }

    #[test]
    fn empty_terms_no_match() {
        assert!(match_content("anything", &[], 10).is_empty());
    }

    #[test]
    fn binary_sniff() {
        assert!(looks_binary(&[b'a', 0, b'b']));
        assert!(!looks_binary(b"plain text file"));
        assert!(!looks_binary(&[]));
    }

    #[test]
    fn ext_allow_list() {
        let list = Some(vec!["txt".into(), "md".into()]);
        assert!(ext_allowed("a.TXT", &list));
        assert!(ext_allowed("b.md", &list));
        assert!(!ext_allowed("c.rs", &list));
        assert!(ext_allowed("noext", &None));
        assert!(ext_allowed("noext", &Some(vec![])));
    }

    #[test]
    fn search_scoped_dir_with_skip_and_cap() {
        let dir = std::env::temp_dir().join(format!("xdir-content-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "needle here\nother").unwrap();
        fs::write(dir.join("sub").join("b.log"), "has needle too").unwrap();
        fs::write(dir.join("bin.dat"), [b'x', 0, b'y']).unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let out = search_content(
            dir.to_str().unwrap(),
            &terms(&["needle"]),
            Some(vec!["txt".into(), "log".into()]),
            &cancel,
        );
        assert_eq!(out.matches.len(), 2);
        assert_eq!(out.skipped_binary, 0, "扩展名白名单外的 bin.dat 不读入");
        assert!(!out.truncated);
        assert!(out.matches.iter().any(|m| m.name == "a.txt"));

        // 无扩展名限制：bin.dat 被嗅探为二进制跳过
        let out = search_content(dir.to_str().unwrap(), &terms(&["needle"]), None, &cancel);
        assert_eq!(out.matches.len(), 2);
        assert_eq!(out.skipped_binary, 1);

        // 单文件范围
        let out = search_content(
            dir.join("a.txt").to_str().unwrap(),
            &terms(&["needle"]),
            None,
            &cancel,
        );
        assert_eq!(out.matches.len(), 1);

        // 取消即中断（结果允许为空，但不得 panic）
        let cancel = Arc::new(AtomicBool::new(true));
        let out = search_content(dir.to_str().unwrap(), &terms(&["needle"]), None, &cancel);
        assert!(out.matches.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
