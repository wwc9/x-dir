//! 文本/表格批处理：编码转换（GBK ↔ UTF-8(BOM)）、CSV 合并（同表头去重）、
//! 文本合并、压缩为 zip。解码复用预览的探测管线（BOM → UTF-8 → GB18030）。
//! 全部经任务引擎执行：逐文件进度 + 取消检查；输出一律旁写不覆盖。

use std::io::{Cursor, Seek, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use zip::write::SimpleFileOptions;

use crate::fs::path::{file_name_of, join_name, parent_of, to_extended};
use crate::jobs::{EmitterState, FailItem, JobProgress, is_cancelled};

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

fn stem_of(path: &str) -> String {
    let name = file_name_of(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name,
    }
}

/// 文本解码（统一走预览的探测管线：BOM → UTF-8 → GB18030）
fn decode_any(bytes: &[u8]) -> String {
    crate::commands::preview::decode_text(bytes).1
}

// ────────────────────────── 编码转换 ──────────────────────────

/// 目标编码（utf8bom = 带 BOM 的 UTF-8，Excel 双击直开不乱码）
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EncTarget {
    Utf8Bom,
    Utf8,
    Gbk,
}

impl EncTarget {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "utf8bom" => Some(Self::Utf8Bom),
            "utf8" => Some(Self::Utf8),
            "gbk" => Some(Self::Gbk),
            _ => None,
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Self::Utf8Bom => "_utf8bom",
            Self::Utf8 => "_utf8",
            Self::Gbk => "_gbk",
        }
    }

    fn encode(self, text: &str) -> Vec<u8> {
        match self {
            Self::Utf8Bom => {
                let mut v = UTF8_BOM.to_vec();
                v.extend_from_slice(text.as_bytes());
                v
            }
            Self::Utf8 => text.as_bytes().to_vec(),
            Self::Gbk => encoding_rs::GBK.encode(text).0.into_owned(),
        }
    }
}

/// 编码转换：按目标编码重编码，旁写 "<stem><后缀>.<ext>"（已存在自动改名）
pub(crate) fn run_convert_encoding(
    paths: &[String],
    target: EncTarget,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        let result = (|| -> Result<(), String> {
            let bytes = std::fs::read(to_extended(p)).map_err(|e| e.to_string())?;
            if crate::commands::preview::sniff_binary(&bytes) {
                return Err("二进制文件，跳过".into());
            }
            let text = decode_any(&bytes);
            let ext = Path::new(p)
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| format!(".{s}"))
                .unwrap_or_default();
            let dir = parent_of(p).unwrap_or_else(|| ".".into());
            let target_path = crate::jobs::pick::available_name(&join_name(
                &dir,
                &format!("{}{}{}", stem_of(p), target.suffix(), ext),
            ));
            std::fs::write(to_extended(&target_path), target.encode(&text))
                .map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

// ────────────────────────── 合并（CSV / 文本） ──────────────────────────

/// 按行拆分（\r\n / \n 归一；去掉行尾 \r）
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// CSV 合并纯逻辑：首文件首个非空行 = 表头；后续文件首个非空行若与表头一致则跳过。
/// 返回（表头, 各文件行列表）。
fn merge_csv_lines(decoded: &[String]) -> (String, Vec<String>) {
    let mut header = String::new();
    let mut rows: Vec<String> = Vec::new();
    for text in decoded {
        let lines = split_lines(text);
        let mut body = lines.as_slice();
        // 取首个非空行
        let first = body.iter().position(|l| !l.trim().is_empty());
        if let Some(i) = first {
            if header.is_empty() {
                header = body[i].to_string();
                body = &body[i + 1..];
            } else if body[i] == header {
                body = &body[i + 1..];
            }
        }
        for l in body {
            if l.trim().is_empty() {
                continue;
            }
            rows.push(l.to_string());
        }
    }
    (header, rows)
}

pub(crate) fn merge_documents(
    paths: &[String],
    output: &str,
    plain_concat: bool,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let mut decoded: Vec<String> = Vec::new();
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        let r = std::fs::read(to_extended(p))
            .map(|b| decode_any(&b))
            .map_err(|e| e.to_string());
        match r {
            Ok(text) => decoded.push(text),
            Err(e) => failed.push(FailItem {
                path: p.clone(),
                message: e,
            }),
        }
        prog.done_files += 1;
        em.progress(prog);
    }
    if is_cancelled(cancel) {
        return;
    }
    let merged = if plain_concat {
        decoded.join("\r\n\r\n")
    } else {
        let (header, rows) = merge_csv_lines(&decoded);
        let mut all = Vec::with_capacity(rows.len() + 1);
        if !header.is_empty() {
            all.push(header);
        }
        all.extend(rows);
        all.join("\r\n")
    };
    let mut bytes = UTF8_BOM.to_vec();
    bytes.extend_from_slice(merged.as_bytes());
    if let Err(e) = std::fs::write(to_extended(output), bytes) {
        failed.push(FailItem {
            path: output.to_string(),
            message: e.to_string(),
        });
    }
}

// ────────────────────────── 压缩为 zip ──────────────────────────

/// 递归写入一个源（文件 = 顶层条目；文件夹 = 顶层目录 + 内部相对路径）
fn add_path_to_zip<W: Write + Seek>(
    out: &mut zip::ZipWriter<W>,
    path: &str,
    arc_name: &str,
    files: &mut u64,
    failed: &mut Vec<FailItem>,
) {
    let full = to_extended(path);
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(m) => m,
        Err(e) => {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
            });
            return;
        }
    };
    if meta.is_dir() {
        let dir_arc = format!("{arc_name}/");
        if let Err(e) = out.add_directory(dir_arc.clone(), SimpleFileOptions::default()) {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
            });
            return;
        }
        let Ok(rd) = std::fs::read_dir(&full) else {
            failed.push(FailItem {
                path: path.to_string(),
                message: "目录枚举失败".into(),
            });
            return;
        };
        let mut children: Vec<String> = rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        children.sort();
        for name in children {
            let child = join_name(path, &name);
            add_path_to_zip(out, &child, &format!("{dir_arc}{name}"), files, failed);
        }
        return;
    }
    let mut f = match std::fs::File::open(&full) {
        Ok(f) => f,
        Err(e) => {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
            });
            return;
        }
    };
    if let Err(e) = out.start_file(
        arc_name,
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    ) {
        failed.push(FailItem {
            path: path.to_string(),
            message: e.to_string(),
        });
        return;
    }
    match std::io::copy(&mut f, out) {
        Ok(_) => *files += 1,
        Err(e) => failed.push(FailItem {
            path: path.to_string(),
            message: e.to_string(),
        }),
    }
}

/// 压缩为 zip：文件 = 平铺条目，文件夹 = 含顶层目录递归打包；输出 output（已存在覆盖）
pub(crate) fn run_zip(
    paths: &[String],
    output: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let mut buf = Cursor::new(Vec::new());
    let mut out = zip::ZipWriter::new(&mut buf);
    let mut done = 0u64;
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        add_path_to_zip(&mut out, p, &file_name_of(p), &mut done, failed);
        prog.done_files += 1;
        em.progress(prog);
    }
    if let Err(e) = out.finish() {
        failed.push(FailItem {
            path: output.to_string(),
            message: e.to_string(),
        });
        return;
    }
    if let Err(e) = std::fs::write(to_extended(output), buf.into_inner()) {
        failed.push(FailItem {
            path: output.to_string(),
            message: e.to_string(),
        });
    }
}

/// 读取 zip 成员名清单（测试用）
#[cfg(test)]
fn zip_names(data: &[u8]) -> Vec<String> {
    use zip::ZipArchive;
    let mut arc = ZipArchive::new(Cursor::new(data)).unwrap();
    (0..arc.len())
        .map(|i| arc.by_index(i).unwrap().name().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enc_target_roundtrip_gbk_and_bom() {
        let text = "年报,底稿\n数据,2024";
        // GBK 编码后按任意目标解码回原文
        let gbk = EncTarget::Gbk.encode(text);
        assert_eq!(decode_any(&gbk), text);
        // UTF-8 BOM：解码管线剥 BOM，内容不变
        let bom = EncTarget::Utf8Bom.encode(text);
        assert!(bom.starts_with(UTF8_BOM));
        assert_eq!(decode_any(&bom), text);
        assert_eq!(EncTarget::parse("gbk"), Some(EncTarget::Gbk));
        assert_eq!(EncTarget::parse("x"), None);
        assert_eq!(EncTarget::Utf8.suffix(), "_utf8");
    }

    #[test]
    fn merge_csv_dedups_repeated_header() {
        let a = "名称,数量\n甲,1\n乙,2".to_string();
        let b = "名称,数量\n丙,3".to_string();
        let c = "品种,单价\n丁,9".to_string();
        let (header, rows) = merge_csv_lines(&[a, b, c]);
        assert_eq!(header, "名称,数量");
        // b 的表头被去掉；c 表头不同 → 作为数据行保留（不猜列，交用户审）
        assert_eq!(rows, vec!["甲,1", "乙,2", "丙,3", "品种,单价", "丁,9"]);
        // 空文件
        let (h2, r2) = merge_csv_lines(&[String::new()]);
        assert_eq!((h2.len(), r2.len()), (0, 0));
    }

    #[test]
    fn merge_csv_normalizes_crlf_and_lf() {
        let a = "h1,h2\r\nx,1".to_string();
        let b = "h1,h2\ny,2\r\n".to_string();
        let (header, rows) = merge_csv_lines(&[a, b]);
        assert_eq!(header, "h1,h2");
        assert_eq!(rows, vec!["x,1", "y,2"]);
    }

    #[test]
    fn zip_files_flat_and_nested() {
        let tmp = std::env::temp_dir().join(format!("xdir-zip-{}", std::process::id()));
        let sub = tmp.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(tmp.join("a.txt"), b"hello").unwrap();
        std::fs::write(sub.join("b.txt"), b"world").unwrap();
        let mut failed = Vec::new();
        let mut buf = Cursor::new(Vec::new());
        let mut out = zip::ZipWriter::new(&mut buf);
        let mut n = 0;
        let dir = tmp.join("sub");
        add_path_to_zip(&mut out, dir.to_str().unwrap(), "sub", &mut n, &mut failed);
        out.finish().unwrap();
        assert!(failed.is_empty());
        let names = zip_names(&buf.into_inner());
        assert_eq!(names, vec!["sub/", "sub/b.txt"]);
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
