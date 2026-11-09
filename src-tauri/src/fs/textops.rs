//! 文本/表格批处理：编码转换（GBK ↔ UTF-8(BOM)）、CSV 合并（同表头去重）、
//! 文本合并、压缩为 zip。解码复用预览的探测管线（BOM → UTF-8 → GB18030）。
//! 全部经任务引擎执行：逐文件进度 + 取消检查；输出一律旁写不覆盖。

use std::io::{Read, Seek, Write};
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
                reason: None,
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
                reason: None,
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
            reason: None,
        });
    }
}

// ────────────────────────── 压缩（zip / 7z / tar.gz，2026-11-08 扩展） ──────────────────────────

/// 压缩输出格式（zipFiles 命令参数）
#[derive(Clone, Debug, PartialEq)]
pub enum CreateFormat {
    /// Deflate；已压缩媒体自动 Store；条目显式带源 mtime
    Zip,
    /// LZMA2 经内嵌 7z.exe（-t7z；可选 AES-256 密码 + 加密文件名 -mhe=on）
    SevenZ,
    /// tar 流 + flate2 GzEncoder 组合（进程内流式；条目 mtime 由 tar 头自带）
    TarGz,
}

/// 已压缩媒体/归档扩展名 → Store 直存不二次压缩（jpg/mp4/zip 再压纯费 CPU，
/// 仅 zip 路径生效；7z 走 LZMA2 不区分——对不可压数据自身膨胀有限）
const STORE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "mp3", "flac", "ogg",
    "wav", "m4a", "aac", "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "zip", "7z", "rar",
    "gz", "xz", "bz2", "tar", "jar", "apk", "pdf", "docx", "docm", "xlsx", "xlsm", "pptx", "pptm",
    "epub",
];

/// 已压缩扩展名判定（纯函数）
fn is_store_ext(name: &str) -> bool {
    match name.rfind('.') {
        Some(i) if i + 1 < name.len() => {
            STORE_EXTS.contains(&name[i + 1..].to_ascii_lowercase().as_str())
        }
        _ => false,
    }
}

/// 条目 mtime（SystemTime → zip::DateTime；失败 None = 保持默认）
fn zip_mtime(meta: &std::fs::Metadata) -> Option<zip::DateTime> {
    zip::DateTime::try_from(time::OffsetDateTime::from(meta.modified().ok()?)).ok()
}

/// 递归写入一个源到 zip 流（文件 = 顶层条目；文件夹 = 顶层目录 + 内部相对路径）。
/// 返回 true = 已取消（调用方停止整包并清半成品）。条目显式带源 mtime（修复
/// 1980 纪元）；已压缩扩展名 Store；64KB 分块拷贝 = 单大文件内可取消 +
/// done_bytes 细粒度
#[allow(clippy::too_many_arguments)] // 递归树遍历语义完整口径，不宜拆
fn add_path_to_zip<W: Write + Seek>(
    out: &mut zip::ZipWriter<W>,
    path: &str,
    arc_name: &str,
    files: &mut u64,
    password: Option<&str>,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    failed: &mut Vec<FailItem>,
) -> bool {
    let full = to_extended(path);
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(m) => m,
        Err(e) => {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
                reason: None,
            });
            return false;
        }
    };
    // 目录联接/junction 静默不入包（2026-11-01）：std 的 is_dir() 对 reparse
    // 目录恒 false（symlink 语义），会掉到下方文件分支白报一条 open 失败；
    // 按原始属性识别跳过——联接无法被 zip 表达，用户目录压缩场景多为系统噪声
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
        let attrs = meta.file_attributes();
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 && attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
            return false;
        }
    }
    if meta.is_dir() {
        let dir_arc = format!("{arc_name}/");
        if let Err(e) = out.add_directory(dir_arc.clone(), SimpleFileOptions::default()) {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
                reason: None,
            });
            return false;
        }
        let Ok(rd) = std::fs::read_dir(&full) else {
            failed.push(FailItem {
                path: path.to_string(),
                message: "目录枚举失败".into(),
                reason: None,
            });
            return false;
        };
        let mut children: Vec<String> = rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        children.sort();
        for name in children {
            if is_cancelled(cancel) {
                return true;
            }
            let child = join_name(path, &name);
            if add_path_to_zip(
                out,
                &child,
                &format!("{dir_arc}{name}"),
                files,
                password,
                cancel,
                prog,
                failed,
            ) {
                return true;
            }
        }
        return false;
    }
    let mut f = match std::fs::File::open(&full) {
        Ok(f) => f,
        Err(e) => {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
                reason: None,
            });
            return false;
        }
    };
    let method = if is_store_ext(&file_name_of(path)) {
        zip::CompressionMethod::Stored
    } else {
        zip::CompressionMethod::Deflated
    };
    // 密码 = WinZip AES-256（AE-2）：接收方需 7-Zip/WinRAR/好压等支持 AES zip
    // 的解压工具（Windows 自带解压本就不支持任何加密 zip）
    let opt: zip::write::FileOptions<'_, ()> = match (zip_mtime(&meta), password) {
        (Some(dt), Some(pw)) => SimpleFileOptions::default()
            .compression_method(method)
            .with_aes_encryption(zip::AesMode::Aes256, pw)
            .last_modified_time(dt),
        (Some(dt), None) => SimpleFileOptions::default()
            .compression_method(method)
            .last_modified_time(dt),
        (None, Some(pw)) => SimpleFileOptions::default()
            .compression_method(method)
            .with_aes_encryption(zip::AesMode::Aes256, pw),
        (None, None) => SimpleFileOptions::default().compression_method(method),
    };
    if let Err(e) = out.start_file(arc_name, opt) {
        failed.push(FailItem {
            path: path.to_string(),
            message: e.to_string(),
            reason: None,
        });
        return false;
    }
    // 64KB 分块：取消即时生效（旧 io::copy 一锤子大文件中途不可停）+ 字节进度
    let mut buf = [0u8; 64 * 1024];
    loop {
        if is_cancelled(cancel) {
            return true;
        }
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if let Err(e) = out.write_all(&buf[..n]) {
                    failed.push(FailItem {
                        path: path.to_string(),
                        message: e.to_string(),
                        reason: None,
                    });
                    let _ = e;
                    return false;
                }
                prog.done_bytes += n as u64;
            }
            Err(e) => {
                failed.push(FailItem {
                    path: path.to_string(),
                    message: e.to_string(),
                    reason: None,
                });
                return false;
            }
        }
    }
    *files += 1;
    false
}

/// 压缩一批源为 zip：文件平铺、文件夹递归含顶层目录；输出 output（覆盖语义
/// 由对话框内联冲突校验 + Rust 端 reject 兜底）。流式写 `<output>.tmp` 成功后
/// 原子改名；取消/失败清掉半成品。预扫源字节求进度分母
pub(crate) fn run_zip(
    paths: &[String],
    output: &str,
    password: Option<&str>,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let mut total_bytes = 0u64;
    for p in paths {
        crate::jobs::walk_stats(p, &mut 0u64, &mut total_bytes);
    }
    prog.total_bytes = total_bytes;
    let tmp = format!("{output}.tmp");
    let file = match std::fs::File::create(to_extended(&tmp)) {
        Ok(f) => f,
        Err(e) => {
            failed.push(FailItem {
                path: output.to_string(),
                message: e.to_string(),
                reason: None,
            });
            return;
        }
    };
    let mut out = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let mut done = 0u64;
    let mut cancelled = false;
    for p in paths {
        if is_cancelled(cancel) {
            cancelled = true;
            break;
        }
        prog.current_path = p.clone();
        cancelled = add_path_to_zip(
            &mut out,
            p,
            &file_name_of(p),
            &mut done,
            password,
            cancel,
            prog,
            failed,
        );
        if cancelled {
            break;
        }
        prog.done_files += 1;
        em.progress(prog);
    }
    let finish = if cancelled {
        Err("cancelled".to_string())
    } else {
        out.finish().map(|_| ()).map_err(|e| e.to_string())
    };
    match finish {
        Ok(()) => {
            if let Err(e) = std::fs::rename(to_extended(&tmp), to_extended(output)) {
                failed.push(FailItem {
                    path: output.to_string(),
                    message: e.to_string(),
                    reason: None,
                });
                let _ = std::fs::remove_file(to_extended(&tmp));
            }
        }
        Err(_) => {
            // 取消或收尾失败：半成品清除，既有输出不受影响（out 已被 finish 消费）
            let _ = std::fs::remove_file(to_extended(&tmp));
        }
    }
}

/// 递归写入一个源到 tar 流（镜像 add_path_to_zip：目录递归、mtime 由
/// set_metadata_from_path 自带、64KB 分块取消 + done_bytes）。返回 true = 取消。
/// append_data 内部按名设路径并补 cksum，目录头用 EntryType::Directory + 空 payload
fn add_path_to_tar<W: Write>(
    b: &mut tar::Builder<W>,
    path: &str,
    arc_name: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    failed: &mut Vec<FailItem>,
) -> bool {
    let full = to_extended(path);
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(m) => m,
        Err(e) => {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
                reason: None,
            });
            return false;
        }
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE: u32 = 0x400;
        const DIR: u32 = 0x10;
        let attrs = meta.file_attributes();
        if attrs & REPARSE != 0 && attrs & DIR != 0 {
            return false;
        }
    }
    // mtime/模式/size 全部来自 symlink_metadata（reparse 已在上游跳过）
    let header = |size: u64, dir: bool| -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_metadata(&meta);
        h.set_size(size);
        if dir {
            h.set_entry_type(tar::EntryType::Directory);
        }
        h
    };
    if meta.is_dir() {
        let mut h = header(0, true);
        if let Err(e) = b.append_data(&mut h, format!("{arc_name}/"), std::io::empty()) {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
                reason: None,
            });
            return false;
        }
        let Ok(rd) = std::fs::read_dir(&full) else {
            failed.push(FailItem {
                path: path.to_string(),
                message: "目录枚举失败".into(),
                reason: None,
            });
            return false;
        };
        let mut children: Vec<String> = rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        children.sort();
        for name in children {
            if is_cancelled(cancel) {
                return true;
            }
            let child = join_name(path, &name);
            if add_path_to_tar(
                b,
                &child,
                &format!("{arc_name}/{name}"),
                cancel,
                prog,
                failed,
            ) {
                return true;
            }
        }
        return false;
    }
    let f = match std::fs::File::open(&full) {
        Ok(f) => f,
        Err(e) => {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
                reason: None,
            });
            return false;
        }
    };
    let mut h = header(meta.len(), false);
    let mut counted = f.take(meta.len());
    match b.append_data(&mut h, arc_name, &mut counted) {
        Ok(()) => {
            prog.done_bytes += meta.len();
            false
        }
        Err(e) => {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
                reason: None,
            });
            false
        }
    }
}

/// 压缩一批源为 tar.gz：tar::Builder 叠 flate2 GzEncoder 流式组合（进程内，
/// 不经 7z.exe——7-Zip 不产 tar.gz 组合格式）。条目 mtime 由 tar 头自带
pub(crate) fn run_zip_targz(
    paths: &[String],
    output: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let mut total_bytes = 0u64;
    for p in paths {
        crate::jobs::walk_stats(p, &mut 0u64, &mut total_bytes);
    }
    prog.total_bytes = total_bytes;
    let tmp = format!("{output}.tmp");
    let file = match std::fs::File::create(to_extended(&tmp)) {
        Ok(f) => f,
        Err(e) => {
            failed.push(FailItem {
                path: output.to_string(),
                message: e.to_string(),
                reason: None,
            });
            return;
        }
    };
    let gz = flate2::write::GzEncoder::new(
        std::io::BufWriter::new(file),
        flate2::Compression::default(),
    );
    let mut b = tar::Builder::new(gz);
    let mut cancelled = false;
    for p in paths {
        if is_cancelled(cancel) {
            cancelled = true;
            break;
        }
        prog.current_path = p.clone();
        cancelled = add_path_to_tar(&mut b, p, &file_name_of(p), cancel, prog, failed);
        if cancelled {
            break;
        }
        prog.done_files += 1;
        em.progress(prog);
    }
    let finish = if cancelled {
        Err("cancelled".to_string())
    } else {
        // into_inner 链：tar 收尾 → gzip 收尾（CRC 尾块）→ BufWriter 落盘
        b.into_inner()
            .map_err(|e| e.to_string())
            .and_then(|w| w.finish().map_err(|e| e.to_string()))
            .and_then(|w| w.into_inner().map_err(|e| e.to_string()))
            .and_then(|mut f| {
                use std::io::Write;
                f.flush().map_err(|e| e.to_string())
            })
    };
    match finish {
        Ok(()) => {
            if let Err(e) = std::fs::rename(to_extended(&tmp), to_extended(output)) {
                failed.push(FailItem {
                    path: output.to_string(),
                    message: e.to_string(),
                    reason: None,
                });
                let _ = std::fs::remove_file(to_extended(&tmp));
            }
        }
        Err(_) => {
            let _ = std::fs::remove_file(to_extended(&tmp));
        }
    }
}

/// 经内嵌 7z.exe 压缩为 7z（LZMA2）：清单预扫源字节求分母 → `-bsp1` 百分比
/// 映射 done_bytes；可选 AES-256 密码（-p）+ 加密文件名（-mhe=on）。
/// 半成品写 `<output>.tmp`（-t7z 显式定格式，扩展名无关），成功原子改名
#[allow(clippy::too_many_arguments)] // 引擎参数表 = 任务语义完整口径，不宜拆
pub(crate) fn run_zip_7z(
    paths: &[String],
    output: &str,
    password: Option<&str>,
    encrypt_header: bool,
    exe: &Path,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let mut total_bytes = 0u64;
    for p in paths {
        crate::jobs::walk_stats(p, &mut 0u64, &mut total_bytes);
    }
    prog.total_bytes = total_bytes;
    let tmp = format!("{output}.tmp");
    let mut args: Vec<String> = vec![
        "a".into(),
        "-t7z".into(),
        "-bso0".into(),
        "-bsp1".into(),
        tmp.clone(),
    ];
    if let Some(pw) = password {
        args.push(format!("-p{pw}"));
        if encrypt_header {
            args.push("-mhe=on".into());
        }
    }
    args.extend(paths.iter().cloned());
    let base = prog.done_bytes;
    let on_progress = |p: u8| {
        if total_bytes > 0 {
            prog.done_bytes = base + (total_bytes * p as u64) / 100;
        }
    };
    match crate::fs::sevenzip::run_7z(exe, &args, cancel, on_progress) {
        Ok((crate::fs::sevenzip::SevenZipOutcome::Ok, _)) => {
            if let Err(e) = std::fs::rename(to_extended(&tmp), to_extended(output)) {
                failed.push(FailItem {
                    path: output.to_string(),
                    message: e.to_string(),
                    reason: None,
                });
                let _ = std::fs::remove_file(to_extended(&tmp));
            }
        }
        Ok((crate::fs::sevenzip::SevenZipOutcome::Warning(m), _)) => {
            failed.push(FailItem {
                path: output.to_string(),
                message: m,
                reason: None,
            });
            let _ = std::fs::remove_file(to_extended(&tmp));
        }
        Ok((crate::fs::sevenzip::SevenZipOutcome::NeedPassword, _)) => {
            failed.push(FailItem {
                path: output.to_string(),
                message: "需要密码".into(),
                reason: Some(crate::jobs::FailReason::Password),
            });
            let _ = std::fs::remove_file(to_extended(&tmp));
        }
        Ok((crate::fs::sevenzip::SevenZipOutcome::Failed(m), _)) => {
            failed.push(FailItem {
                path: output.to_string(),
                message: m,
                reason: None,
            });
            let _ = std::fs::remove_file(to_extended(&tmp));
        }
        Err(crate::fs::sevenzip::SevenZipError::Cancelled) => {
            let _ = std::fs::remove_file(to_extended(&tmp));
        }
        Err(crate::fs::sevenzip::SevenZipError::Failed(m)) => {
            failed.push(FailItem {
                path: output.to_string(),
                message: m,
                reason: None,
            });
            let _ = std::fs::remove_file(to_extended(&tmp));
        }
    }
}

/// 压缩总入口（任务引擎 ZipFiles 分发）：按格式分流三个引擎
#[allow(clippy::too_many_arguments)] // 引擎参数表 = 任务语义完整口径，不宜拆
pub(crate) fn run_create(
    paths: &[String],
    output: &str,
    format: &CreateFormat,
    password: Option<&str>,
    encrypt_header: bool,
    sz_exe: Option<&Path>,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    match format {
        CreateFormat::Zip => run_zip(paths, output, password, cancel, prog, em, failed),
        CreateFormat::TarGz => run_zip_targz(paths, output, cancel, prog, em, failed),
        CreateFormat::SevenZ => match sz_exe {
            Some(exe) => run_zip_7z(
                paths,
                output,
                password,
                encrypt_header,
                exe,
                cancel,
                prog,
                failed,
            ),
            None => failed.push(FailItem {
                path: output.to_string(),
                message: "内嵌 7-Zip 未就绪（7z 格式需要）：运行 tools/get-7zip.ps1 下载".into(),
                reason: None,
            }),
        },
    }
}

/// 读取 zip 成员名清单（测试用）
#[cfg(test)]
fn zip_names(data: &[u8]) -> Vec<String> {
    use std::io::Cursor;
    use zip::ZipArchive;
    let mut arc = ZipArchive::new(Cursor::new(data)).unwrap();
    (0..arc.len())
        .map(|i| arc.by_index(i).unwrap().name().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn zip_skips_junction_loop() {
        // 行为锁定：junction 不入包且不产生失败项（std 语义下其 is_dir()=false
        // 会掉进文件分支白报 open 失败；联接无法被 zip 表达，静默跳过）
        let tmp = std::env::temp_dir().join(format!("xdir-zip-junc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("d")).unwrap();
        std::fs::write(tmp.join("d/inner.txt"), b"hello").unwrap();
        #[cfg(windows)]
        {
            // 自引用联接（用户目录 Application Data 同款拓扑）
            let ok = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(tmp.join("loop"))
                .arg(&tmp)
                .output()
                .is_ok_and(|o| o.status.success());
            if !ok {
                let _ = std::fs::remove_dir_all(&tmp);
                return; // 环境不允许建联接：跳过
            }
        }
        let mut buf = Cursor::new(Vec::new());
        let mut out = zip::ZipWriter::new(&mut buf);
        let mut n = 0;
        let mut failed = Vec::new();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut prog = crate::jobs::JobProgress {
            job_id: 0,
            phase: "running",
            total_files: 0,
            done_files: 0,
            total_bytes: 0,
            done_bytes: 0,
            current_path: String::new(),
            note: None,
        };
        add_path_to_zip(
            &mut out,
            tmp.to_str().unwrap(),
            "root",
            &mut n,
            None,
            &cancel,
            &mut prog,
            &mut failed,
        );
        out.finish().unwrap();
        assert!(failed.is_empty());
        let names = zip_names(&buf.into_inner());
        // 联接不入包，真实内容完整
        assert!(!names.iter().any(|s| s.contains("loop")));
        assert!(names.iter().any(|s| s.contains("inner.txt")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

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

    /// 加密 zip E2E（依赖内嵌 7z.exe，缺失跳过）：进程内 AES-256 写 →
    /// 真 7z.exe 对密码解出内容、错密码失败、清单报 AES-256
    #[test]
    fn zip_aes_password_roundtrip_with_7z() {
        let Some(exe) = crate::fs::sevenzip::sevenzip_exe_dev() else {
            eprintln!("skip: 内嵌 7-Zip 未下载（tools/get-7zip.ps1）");
            return;
        };
        let dir = std::env::temp_dir().join(format!("xdir-zipaes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("enc.zip");
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut out = zip::ZipWriter::new(f);
        let mut n = 0;
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut prog = crate::jobs::JobProgress {
            job_id: 0,
            phase: "running",
            total_files: 0,
            done_files: 0,
            total_bytes: 0,
            done_bytes: 0,
            current_path: String::new(),
            note: None,
        };
        let mut failed: Vec<FailItem> = Vec::new();
        let src = dir.join("机密.txt");
        std::fs::write(&src, b"top-secret").unwrap();
        assert!(!add_path_to_zip(
            &mut out,
            src.to_str().unwrap(),
            "机密.txt",
            &mut n,
            Some("pw123"),
            &cancel,
            &mut prog,
            &mut failed,
        ));
        out.finish().unwrap();
        assert!(failed.is_empty());

        let args = |v: Vec<&str>| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // 清单报 AES-256
        let (outcome, listing) = crate::fs::sevenzip::run_7z(
            &exe,
            &args(vec!["l", "-ba", "-slt", "-p", zip_path.to_str().unwrap()]),
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(outcome, crate::fs::sevenzip::SevenZipOutcome::Ok);
        assert!(listing.iter().any(|l| l.contains("AES-256")));
        assert!(listing.iter().any(|l| l.starts_with("Path = ")));
        // 对密码解出内容
        let outdir = dir.join("out");
        std::fs::create_dir_all(&outdir).unwrap();
        let (outcome, _) = crate::fs::sevenzip::run_7z(
            &exe,
            &args(vec![
                "x",
                zip_path.to_str().unwrap(),
                &format!("-o{}", outdir.display()),
                "-y",
                "-bso0",
                "-ppw123",
            ]),
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(outcome, crate::fs::sevenzip::SevenZipOutcome::Ok);
        assert_eq!(
            std::fs::read_to_string(outdir.join("机密.txt")).unwrap(),
            "top-secret"
        );
        // 错密码 = NeedPassword 分类
        let (outcome, _) = crate::fs::sevenzip::run_7z(
            &exe,
            &args(vec![
                "x",
                zip_path.to_str().unwrap(),
                &format!("-o{}", dir.join("out2").display()),
                "-y",
                "-bso0",
                "-pwrong",
            ]),
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(outcome, crate::fs::sevenzip::SevenZipOutcome::NeedPassword);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_ext_classification() {
        assert!(is_store_ext("a.JPG"));
        assert!(is_store_ext("视频.MP4"));
        assert!(is_store_ext("already.zip"));
        assert!(is_store_ext("report.docx")); // OOXML 容器已压缩 → Store
        assert!(is_store_ext("报告.pdf"));
        assert!(!is_store_ext("readme.md"));
        assert!(!is_store_ext("noext"));
    }

    /// tar.gz 压缩/解压往返（add_path_to_tar → GzEncoder → extract_targz）：
    /// 内容一致 + 条目 mtime 保留（秒级）
    #[test]
    fn tar_gz_roundtrip_preserves_mtime() {
        let dir = std::env::temp_dir().join(format!("xdir-tgz-{}", std::process::id()));
        let src = dir.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), b"t1").unwrap();
        let target_path = src.join("sub/b.txt");
        std::fs::write(&target_path, b"t2!").unwrap();
        let want_mtime = target_path.metadata().unwrap().modified().unwrap();

        let tgz = dir.join("t.tar.gz");
        let f = std::fs::File::create(&tgz).unwrap();
        let gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
        let mut b = tar::Builder::new(gz);
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut prog = crate::jobs::JobProgress {
            job_id: 0,
            phase: "running",
            total_files: 0,
            done_files: 0,
            total_bytes: 0,
            done_bytes: 0,
            current_path: String::new(),
            note: None,
        };
        let mut failed = Vec::new();
        assert!(!add_path_to_tar(
            &mut b,
            src.to_str().unwrap(),
            "src",
            &cancel,
            &mut prog,
            &mut failed
        ));
        b.into_inner().unwrap().finish().unwrap();
        assert!(failed.is_empty());

        let dest = dir.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let mut p2 = crate::jobs::JobProgress { ..prog };
        let mut skipped = 0u64;
        crate::fs::archive::extract_targz(
            tgz.to_str().unwrap(),
            dest.to_str().unwrap(),
            &cancel,
            &mut p2,
            &mut skipped,
        )
        .unwrap();
        assert_eq!(skipped, 0);
        let out_file = dest.join("t/src/sub/b.txt"); // 包装目录 = 包名（多包互不覆盖）
        assert_eq!(std::fs::read_to_string(&out_file).unwrap(), "t2!");
        // tar 条目 mtime 保留（秒级粒度；tar 头按秒存）
        let got_secs = out_file
            .metadata()
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert_eq!(
            got_secs,
            want_mtime
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            "tar 条目 mtime 应保留"
        );
        std::fs::remove_dir_all(&dir).ok();
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
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut prog = crate::jobs::JobProgress {
            job_id: 0,
            phase: "running",
            total_files: 0,
            done_files: 0,
            total_bytes: 0,
            done_bytes: 0,
            current_path: String::new(),
            note: None,
        };
        let dir = tmp.join("sub");
        add_path_to_zip(
            &mut out,
            dir.to_str().unwrap(),
            "sub",
            &mut n,
            None,
            &cancel,
            &mut prog,
            &mut failed,
        );
        out.finish().unwrap();
        assert!(failed.is_empty());
        let names = zip_names(&buf.into_inner());
        assert_eq!(names, vec!["sub/", "sub/b.txt"]);
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
