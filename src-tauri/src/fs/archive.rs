//! 压缩包解压（2026-11-08 三次扩展）：zip / 7z / tar / tar.gz / tgz / gz 进程内
//! 解压，rar（含分卷）/ xz / bz2 经内嵌 7-Zip 兜底引擎（fs::sevenzip）。
//! 多文件包解到 `<dest>/<包名>/` 子目录（多包互不覆盖、不散落），单文件流
//! （gz / xz / bz2）旁写内层名到 dest（重名自动 (2)）。逐条目落盘：进度按
//! 字节（解压前预扫清单求分母）、支持取消、拒绝 zip-slip 穿越条目、解压总量
//! 硬闸防高压缩比炸弹；非法条目不再静默——跳过数经 JobProgress.note 回执。
//! 加密包带密码解压（7z -p 通道），密码缺失/错误以 FailReason::Password
//! 结构化回执驱动前端弹密码框重试。

use std::io::{Read, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::path::{file_name_of, join_name, parent_of, split_ext, to_extended};
use super::sevenzip::{SevenZipError, SevenZipOutcome, password_arg, run_7z};
use crate::jobs::pick::available_name;
use crate::jobs::{FailItem, FailReason, JobProgress};

/// 解压总量上限（所有引擎共用）：恶意高压缩比包可谎报条目尺寸——进程内按
/// 实际解出字节硬闸、7z.exe 路径按清单声明尺寸预闸，超限中止防填满磁盘
const EXTRACT_TOTAL_MAX: u64 = 10 << 30;

/// 解压单包错误：人话 + 是否为密码缺失/错误（驱动前端密码重试）
type ExtractErr = (String, bool);

fn is_cancelled(c: &AtomicBool) -> bool {
    c.load(Ordering::SeqCst)
}

/// 条目名安全化（纯函数）：剥前导斜杠、反斜杠归一；含 `..` 段或盘符冒号的
/// 条目判为穿越/非法（zip-slip），返回 None 由调用方跳过并计数回执
fn safe_entry_rel(name: &str) -> Option<String> {
    let s = name.trim_start_matches('/').replace('\\', "/");
    if s.is_empty() || s.split('/').any(|seg| seg == "..") || s.contains(':') {
        return None;
    }
    Some(s)
}

/// 包名 → 包装子目录名（纯函数）：双扩展剥全链（x.tar.gz → x；x.part1.rar →
/// x——分卷首包的包装目录不带卷序号）
fn archive_stem(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let chain = [
        ".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tbz2", ".tar",
    ]
    .iter()
    .find(|suf| lower.ends_with(*suf))
    .map(|suf| name[..name.len() - suf.len()].to_string())
    .unwrap_or_else(|| split_ext(name).0.to_string());
    let mut stem = chain;
    if let Some(i) = stem.rfind(".part") {
        let n = &stem[i + 5..];
        if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) {
            stem.truncate(i);
        }
    }
    stem
}

/// 解压一批压缩包到 dest_root：按扩展名分流引擎。sz_exe = 内嵌 7z.exe 路径
/// （rar/xz/bz2 必需，None 时对应包报「未就绪」）
pub(crate) fn run_extract(
    sources: &[String],
    dest_root: &str,
    sz_exe: Option<&Path>,
    password: Option<&str>,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = sources.len() as u64;
    let mut skipped = 0u64;
    for src in sources {
        if is_cancelled(cancel) {
            if skipped > 0 {
                prog.note = Some(format!("已取消；累计跳过 {skipped} 项非法条目"));
            }
            return;
        }
        prog.current_path = src.clone();
        let name = file_name_of(src);
        let lower = name.to_ascii_lowercase();
        let r = if lower.ends_with(".zip") {
            extract_zip(src, dest_root, cancel, prog, &mut skipped)
        } else if lower.ends_with(".7z") {
            extract_7z(src, dest_root, password, cancel, prog, &mut skipped)
        } else if lower.ends_with(".tar") {
            extract_tar(src, dest_root, cancel, prog, &mut skipped)
        } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
            extract_targz(src, dest_root, cancel, prog, &mut skipped)
        } else if lower.ends_with(".gz") {
            extract_gz(src, dest_root, cancel, prog)
        } else if lower.ends_with(".rar") || lower.ends_with(".xz") || lower.ends_with(".bz2") {
            extract_via_7z(
                sz_exe,
                src,
                dest_root,
                password,
                cancel,
                prog,
                lower.ends_with(".rar"),
            )
        } else {
            Err((
                "不支持的压缩格式（zip / 7z / rar / tar / tar.gz / gz / xz / bz2）".into(),
                false,
            ))
        };
        if let Err((msg, need_pw)) = r {
            failed.push(FailItem {
                path: src.clone(),
                message: msg,
                reason: if need_pw {
                    Some(FailReason::Password)
                } else {
                    None
                },
            });
        }
        prog.done_files += 1;
        // 进度回报由外层任务引擎的 EmitterState 统一节流，这里只累计
    }
    if skipped > 0 {
        prog.note = Some(format!("已跳过 {skipped} 项非法条目（路径穿越/无法解码）"));
    }
}

/// 取消：静默收尾（已落盘条目保留，与复制引擎同语义）；累计跳过数写回执
fn cancelled_exit(skipped: u64, prog: &mut JobProgress) {
    if skipped > 0 {
        prog.note = Some(format!("已取消；解压前累计跳过 {skipped} 项非法条目"));
    }
}

// ────────────────────────── zip（进程内） ──────────────────────────

/// zip：逐条目落盘；central directory 预扫求总解压字节（进度分母）
fn extract_zip(
    src: &str,
    dest_root: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    skipped: &mut u64,
) -> Result<(), ExtractErr> {
    let f = std::fs::File::open(to_extended(src)).map_err(|e| (format!("打开失败：{e}"), false))?;
    let mut ar = zip::ZipArchive::new(f).map_err(|e| (format!("zip 解析失败：{e}"), false))?;
    // 预扫 central directory：声明尺寸求和（进度分母；实际闸仍按拷贝字节）
    let mut declared: u64 = 0;
    for i in 0..ar.len() {
        if let Ok(e) = ar.by_index_raw(i) {
            declared += e.size();
        }
    }
    prog.total_bytes = prog.total_bytes.saturating_add(declared);
    let out_dir = available_name(&join_name(dest_root, &archive_stem(&file_name_of(src))));
    std::fs::create_dir_all(to_extended(&out_dir))
        .map_err(|e| (format!("创建目录失败：{e}"), false))?;
    let mut total: u64 = 0;
    for i in 0..ar.len() {
        if is_cancelled(cancel) {
            cancelled_exit(*skipped, prog);
            return Ok(());
        }
        let mut entry = ar.by_index(i).map_err(|e| (e.to_string(), false))?;
        // 名字解码复用预览管线（GBK 包不乱码）；非法条目跳过计数回执
        let Some(rel) = safe_entry_rel(&crate::commands::preview::decode_entry_name(
            entry.name_raw(),
        )) else {
            *skipped += 1;
            continue;
        };
        let target = join_name(&out_dir, &rel);
        if entry.is_dir() {
            std::fs::create_dir_all(to_extended(&target)).map_err(|e| (e.to_string(), false))?;
            continue;
        }
        if let Some(par) = parent_of(&target) {
            std::fs::create_dir_all(to_extended(&par)).map_err(|e| (e.to_string(), false))?;
        }
        let mut out =
            std::fs::File::create(to_extended(&target)).map_err(|e| (e.to_string(), false))?;
        // 解压总量硬闸：条目可谎报尺寸，按实际拷贝字节计（take 到限额即截断，
        // 拷满 = 超限，中止整包）
        let limit = EXTRACT_TOTAL_MAX - total;
        let copied = std::io::copy(&mut (&mut entry).take(limit), &mut out)
            .map_err(|e| (format!("{rel}：{e}"), false))?;
        if copied >= limit {
            return Err((
                format!("解压总量超出上限（{} GiB）", EXTRACT_TOTAL_MAX >> 30),
                false,
            ));
        }
        total += copied;
        prog.done_bytes += copied;
    }
    Ok(())
}

// ────────────────────────── 7z（进程内） ──────────────────────────

/// sevenz-rust 错误 → 解压错误：密码/加密关键词分类为「需要密码」（前端凭
/// reason 码弹密码框重试）
fn classify_7zlib_err(msg: String) -> ExtractErr {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("password") || lower.contains("encrypted") {
        ("需要密码".into(), true)
    } else {
        (format!("7z 解析失败：{msg}"), false)
    }
}

/// 7z：逐条目落盘（与 zip 同一净化与限额口径）。绝不整包 `decompress_file`：
/// sevenz-rust 0.6 的默认落盘是裸 `dest.join(entry.name())`，`..\` 或绝对路径
/// 条目可写到 out_dir 之外任意位置（zip-slip，2026-11-01 审查修复）。
/// 两遍开包：第一遍仅读头求总字节（回调不读 reader 即不解码），第二遍解压。
/// 取消以 Err 中止（0.6.1 的 folder 循环忽略回调 Ok(false)，无法温和停止），
/// 闭包标志位区分「取消」与「真失败」，出口翻译回静默取消
fn extract_7z(
    src: &str,
    dest_root: &str,
    password: Option<&str>,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    skipped: &mut u64,
) -> Result<(), ExtractErr> {
    let pw = sevenz_rust::Password::from(password.unwrap_or(""));
    // 第一遍：清单预扫（进度分母；头加密包开包即失败 → 需要密码）
    let mut declared: u64 = 0;
    {
        let mut r = sevenz_rust::SevenZReader::open(to_extended(src), pw.clone())
            .map_err(|e| classify_7zlib_err(e.to_string()))?;
        r.for_each_entries(|entry, _reader| {
            declared += entry.size();
            Ok(true)
        })
        .map_err(|e| classify_7zlib_err(e.to_string()))?;
    }
    prog.total_bytes = prog.total_bytes.saturating_add(declared);
    let out_dir = available_name(&join_name(dest_root, &archive_stem(&file_name_of(src))));
    std::fs::create_dir_all(to_extended(&out_dir))
        .map_err(|e| (format!("创建目录失败：{e}"), false))?;
    let mut total: u64 = 0;
    let mut cancelled_out = false;
    let mut buf = [0u8; 64 * 1024];
    let mut r = sevenz_rust::SevenZReader::open(to_extended(src), pw)
        .map_err(|e| classify_7zlib_err(e.to_string()))?;
    let result = r
        .for_each_entries(|entry, reader| {
            if is_cancelled(cancel) {
                cancelled_out = true;
                return Err(sevenz_rust::Error::other("cancelled"));
            }
            // 与 zip 同源的净化：穿越/非法条目跳过计数回执
            let Some(rel) = safe_entry_rel(entry.name()) else {
                *skipped += 1;
                return Ok(true);
            };
            let target = join_name(&out_dir, &rel);
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
        Err(_) if cancelled_out => {
            cancelled_exit(*skipped, prog);
            Ok(())
        }
        Err(msg) => {
            let lower = msg.to_ascii_lowercase();
            if lower.contains("password") || lower.contains("encrypted") {
                Err(("需要密码".into(), true))
            } else if lower.contains("上限") {
                Err((msg, false))
            } else {
                Err((format!("7z 解压失败：{msg}"), false))
            }
        }
    }
}

// ────────────────────────── tar / tar.gz（进程内） ──────────────────────────

/// tar 流解包（tar 与 tar.gz 共用主体）：逐条目净化落盘；符号/硬链接条目跳过
/// （Windows 解压场景无意义，计数回执）；流式无分母（进度按 done_bytes 增长）
fn extract_tar_stream<R: Read>(
    src: &str,
    reader: R,
    dest_root: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    skipped: &mut u64,
) -> Result<(), ExtractErr> {
    let out_dir = available_name(&join_name(dest_root, &archive_stem(&file_name_of(src))));
    std::fs::create_dir_all(to_extended(&out_dir))
        .map_err(|e| (format!("创建目录失败：{e}"), false))?;
    let mut ar = tar::Archive::new(reader);
    let entries = ar
        .entries()
        .map_err(|e| (format!("tar 解析失败：{e}"), false))?;
    let mut total: u64 = 0;
    for entry in entries {
        if is_cancelled(cancel) {
            cancelled_exit(*skipped, prog);
            return Ok(());
        }
        let entry = entry.map_err(|e| (format!("tar 条目读取失败：{e}"), false))?;
        let raw_path = entry
            .path()
            .map_err(|e| (format!("tar 条目名读取失败：{e}"), false))?
            .to_string_lossy()
            .into_owned();
        let Some(rel) = safe_entry_rel(&raw_path) else {
            *skipped += 1;
            continue;
        };
        let target = join_name(&out_dir, &rel);
        match entry.header().entry_type() {
            tar::EntryType::Directory => {
                std::fs::create_dir_all(to_extended(&target))
                    .map_err(|e| (e.to_string(), false))?;
            }
            tar::EntryType::Regular => {
                if let Some(par) = parent_of(&target) {
                    std::fs::create_dir_all(to_extended(&par))
                        .map_err(|e| (e.to_string(), false))?;
                }
                let mut out = std::fs::File::create(to_extended(&target))
                    .map_err(|e| (e.to_string(), false))?;
                let limit = EXTRACT_TOTAL_MAX - total;
                let copied = std::io::copy(&mut entry.take(limit), &mut out)
                    .map_err(|e| (format!("{rel}：{e}"), false))?;
                if copied >= limit {
                    return Err((
                        format!("解压总量超出上限（{} GiB）", EXTRACT_TOTAL_MAX >> 30),
                        false,
                    ));
                }
                total += copied;
                prog.done_bytes += copied;
            }
            // symlink / hardlink / pax 等不落盘（Windows 语义弱），计数回执
            _ => *skipped += 1,
        }
    }
    Ok(())
}

fn extract_tar(
    src: &str,
    dest_root: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    skipped: &mut u64,
) -> Result<(), ExtractErr> {
    let f = std::fs::File::open(to_extended(src)).map_err(|e| (format!("打开失败：{e}"), false))?;
    extract_tar_stream(
        src,
        std::io::BufReader::new(f),
        dest_root,
        cancel,
        prog,
        skipped,
    )
}

fn extract_targz(
    src: &str,
    dest_root: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    skipped: &mut u64,
) -> Result<(), ExtractErr> {
    let f = std::fs::File::open(to_extended(src)).map_err(|e| (format!("打开失败：{e}"), false))?;
    let dec = flate2::read::GzDecoder::new(std::io::BufReader::new(f));
    extract_tar_stream(src, dec, dest_root, cancel, prog, skipped)
}

// ────────────────────────── gz 单文件（进程内） ──────────────────────────

/// gz 单文件旁写：内层名取 FNAME 头（复用预览管线），旁写到 dest（重名 (2)）；
/// 总字节 = ISIZE（进度分母）
fn extract_gz(
    src: &str,
    dest_root: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
) -> Result<(), ExtractErr> {
    let mut f =
        std::fs::File::open(to_extended(src)).map_err(|e| (format!("打开失败：{e}"), false))?;
    let len = f.metadata().map_err(|e| (e.to_string(), false))?.len();
    if len < 18 {
        return Err(("gzip 文件过小".into(), false));
    }
    let mut header = [0u8; 1024];
    let n = f.read(&mut header).map_err(|e| (e.to_string(), false))?;
    use std::io::{Seek, SeekFrom};
    f.seek(SeekFrom::End(-4))
        .map_err(|e| (e.to_string(), false))?;
    let mut tail = [0u8; 4];
    f.read_exact(&mut tail)
        .map_err(|e| (e.to_string(), false))?;
    let (inner, declared) =
        crate::commands::preview::gz_probe(&header[..n], tail, &file_name_of(src))
            .map_err(|e| (e, false))?;
    prog.total_bytes = prog.total_bytes.saturating_add(declared);
    let Some(rel) = safe_entry_rel(&inner) else {
        return Err(("内层文件名非法".into(), false));
    };
    let target = available_name(&join_name(dest_root, &rel));
    let mut out =
        std::fs::File::create(to_extended(&target)).map_err(|e| (e.to_string(), false))?;
    f.seek(SeekFrom::Start(0))
        .map_err(|e| (e.to_string(), false))?;
    let mut dec = flate2::read::GzDecoder::new(f);
    let mut buf = [0u8; 64 * 1024];
    let mut copied: u64 = 0;
    loop {
        if is_cancelled(cancel) {
            // 半成品删除（旁写单文件无「保留部分」语义）
            let _ = std::fs::remove_file(to_extended(&target));
            return Ok(());
        }
        let n = dec.read(&mut buf).map_err(|e| (e.to_string(), false))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .map_err(|e| (e.to_string(), false))?;
        copied += n as u64;
        if copied > EXTRACT_TOTAL_MAX {
            let _ = std::fs::remove_file(to_extended(&target));
            return Err((
                format!("解压总量超出上限（{} GiB）", EXTRACT_TOTAL_MAX >> 30),
                false,
            ));
        }
    }
    prog.done_bytes += copied;
    Ok(())
}

// ────────────────────────── rar / xz / bz2（内嵌 7z.exe） ──────────────────────────

/// 7z.exe 清单 -ba -slt 块解析（纯函数）：文件条目 Size 求和（目录不计）。
/// lines = `l -ba -slt -p<pwd> <src>` 的 stdout 行集（-ba 只输出条目块，
/// 不含压缩包自身块）。单文件流（xz/bz2）的条目无名，内层名按 7-Zip 落盘
/// 规则取压缩包名去扩展（archive_stem），不依赖清单
fn parse_listing(lines: &[String]) -> u64 {
    let mut total = 0u64;
    let mut is_folder = false;
    for l in lines {
        if let Some(v) = l.strip_prefix("Folder = ") {
            is_folder = v.trim() == "+";
        } else if let Some(v) = l.strip_prefix("Size = ")
            && !is_folder
        {
            total += v.trim().parse::<u64>().unwrap_or(0);
        }
    }
    total
}

/// 内嵌 7-Zip 路径（rar 多文件 / xz / bz2 单文件流）。清单预扫（进度分母 +
/// 密码预检）→ 解包；单文件流解到临时包装目录后旁写内层名（available_name
/// 防覆盖）。取消：多文件包已落盘保留，单文件流清临时目录
fn extract_via_7z(
    sz_exe: Option<&Path>,
    src: &str,
    dest_root: &str,
    password: Option<&str>,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    multifile: bool,
) -> Result<(), ExtractErr> {
    let Some(exe) = sz_exe else {
        return Err((
            "内嵌 7-Zip 未就绪（rar/xz/bz2 解压需要）：运行 tools/get-7zip.ps1 下载".into(),
            false,
        ));
    };
    let pw = password_arg(password);
    // ① 清单预扫：声明总字节（进度分母）+ 密码预检
    let list_args = vec![
        "l".into(),
        "-ba".into(),
        "-slt".into(),
        pw.clone(),
        src.to_string(),
    ];
    let (outcome, lines) = run_7z(exe, &list_args, cancel, |_| {}).map_err(|e| match e {
        SevenZipError::Cancelled => (String::new(), false), // 上层不区分，取消在出口静默
        SevenZipError::Failed(m) => (m, false),
    })?;
    match outcome {
        SevenZipOutcome::Ok | SevenZipOutcome::Warning(_) => {}
        SevenZipOutcome::NeedPassword => return Err(("需要密码".into(), true)),
        SevenZipOutcome::Failed(m) => return Err((format!("7z 清单失败：{m}"), false)),
    }
    let declared = parse_listing(&lines);
    prog.total_bytes = prog.total_bytes.saturating_add(declared);
    if declared > EXTRACT_TOTAL_MAX {
        return Err((
            format!("解压总量超出上限（{} GiB）", EXTRACT_TOTAL_MAX >> 30),
            false,
        ));
    }
    let stem = archive_stem(&file_name_of(src));
    let base = prog.done_bytes;
    // 百分比 → 字节映射（清单无声明尺寸时不映射，done_bytes 维持基线）
    let on_progress = |p: u8| {
        if declared > 0 {
            prog.done_bytes = base + (declared * p as u64) / 100;
        }
    };
    // ② 解包
    if multifile {
        let out_dir = available_name(&join_name(dest_root, &stem));
        std::fs::create_dir_all(to_extended(&out_dir))
            .map_err(|e| (format!("创建目录失败：{e}"), false))?;
        let xargs = vec![
            "x".into(),
            src.to_string(),
            format!("-o{}", to_extended(&out_dir).display()),
            "-y".into(),
            "-bso0".into(),
            "-bsp1".into(),
            pw,
        ];
        match run_7z(exe, &xargs, cancel, on_progress) {
            Ok((SevenZipOutcome::Ok, _)) => Ok(()),
            Ok((SevenZipOutcome::Warning(m), _)) => Err((format!("部分条目未解出：{m}"), false)),
            Ok((SevenZipOutcome::NeedPassword, _)) => Err(("需要密码".into(), true)),
            Ok((SevenZipOutcome::Failed(m), _)) => Err((m, false)),
            Err(SevenZipError::Cancelled) => Ok(()),
            Err(SevenZipError::Failed(m)) => Err((m, false)),
        }
    } else {
        // 单文件流（xz/bz2）：解到临时包装目录 → 内层名旁写 → 清目录
        let wrapper = available_name(&join_name(dest_root, &format!("{stem}.xdirtmp")));
        std::fs::create_dir_all(to_extended(&wrapper))
            .map_err(|e| (format!("创建目录失败：{e}"), false))?;
        let xargs = vec![
            "x".into(),
            src.to_string(),
            format!("-o{}", to_extended(&wrapper).display()),
            "-y".into(),
            "-bso0".into(),
            "-bsp1".into(),
            pw,
        ];
        let r = run_7z(exe, &xargs, cancel, on_progress);
        let cleanup = |w: &str| {
            std::fs::remove_dir_all(to_extended(w)).ok();
        };
        match r {
            Ok((SevenZipOutcome::Ok, _)) => {}
            Ok((SevenZipOutcome::Warning(m), _)) | Ok((SevenZipOutcome::Failed(m), _)) => {
                cleanup(&wrapper);
                return Err((m, false));
            }
            Ok((SevenZipOutcome::NeedPassword, _)) => {
                cleanup(&wrapper);
                return Err(("需要密码".into(), true));
            }
            Err(SevenZipError::Cancelled) => {
                cleanup(&wrapper);
                return Ok(());
            }
            Err(SevenZipError::Failed(m)) => {
                cleanup(&wrapper);
                return Err((m, false));
            }
        }
        // 7-Zip 对单文件流落盘名 = 压缩包名去扩展（实测 x -o 行为），与清单无关
        let inner_rel = safe_entry_rel(&stem).ok_or_else(|| {
            cleanup(&wrapper);
            ("内层文件名非法".into(), false)
        })?;
        let src_file = join_name(&wrapper, &inner_rel);
        let target = available_name(&join_name(dest_root, &inner_rel));
        std::fs::rename(to_extended(&src_file), to_extended(&target))
            .map_err(|e| (format!("旁写失败：{e}"), false))?;
        cleanup(&wrapper);
        Ok(())
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
            note: None,
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
    fn archive_stem_strips_full_chains() {
        assert_eq!(archive_stem("x.tar.gz"), "x");
        assert_eq!(archive_stem("x.tgz"), "x");
        assert_eq!(archive_stem("包.tar"), "包");
        assert_eq!(archive_stem("x.part1.rar"), "x");
        assert_eq!(archive_stem("x.part12.rar"), "x");
        assert_eq!(archive_stem("x.rar"), "x");
        assert_eq!(archive_stem("y.zip"), "y");
        assert_eq!(archive_stem("数据.csv.gz"), "数据.csv");
    }

    #[test]
    fn listing_parse_sums_files_skips_dirs() {
        let lines: Vec<String> = [
            "Path = a.txt",
            "Folder = -",
            "Size = 100",
            "",
            "Path = sub",
            "Folder = +",
            "Size = 0",
            "",
            "Path = sub/b.txt",
            "Folder = -",
            "Size = 234",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(parse_listing(&lines), 334);
    }

    #[test]
    fn extract_zip_lays_entries_and_skips_evil() {
        let dir = tempdir();
        let zip_path = join_name(&dir, "t.zip");
        write_probe_zip(&zip_path);
        let mut p = prog();
        let mut skipped = 0u64;
        extract_zip(
            &zip_path,
            &dir,
            &AtomicBool::new(false),
            &mut p,
            &mut skipped,
        )
        .unwrap();
        let out = join_name(&dir, "t");
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
        assert_eq!(skipped, 1); // 非法条目计数回执
        // 预扫分母 = 全部声明尺寸（含被跳过的非法条目 4B）
        assert_eq!(p.total_bytes, 14);
    }

    #[test]
    fn extract_tar_and_gz_roundtrip() {
        let dir = tempdir();
        let src_dir = join_name(&dir, "src");
        std::fs::create_dir_all(to_extended(&join_name(&src_dir, "sub"))).unwrap();
        std::fs::write(to_extended(&join_name(&src_dir, "a.txt")), "t1").unwrap();
        std::fs::write(to_extended(&join_name(&src_dir, "sub/b.txt")), "t2!").unwrap();
        // 打 tar（tar crate 写入）
        let tar_path = join_name(&dir, "t.tar");
        {
            let f = std::fs::File::create(to_extended(&tar_path)).unwrap();
            let mut b = tar::Builder::new(f);
            b.append_dir_all("t", to_extended(&src_dir)).unwrap();
            b.into_inner().unwrap();
        }
        // 打 tar.gz（flate2 包一层）
        let tgz_path = join_name(&dir, "t.tgz");
        {
            let f = std::fs::File::create(to_extended(&tgz_path)).unwrap();
            let enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
            let mut b = tar::Builder::new(enc);
            b.append_dir_all("t", to_extended(&src_dir)).unwrap();
            b.into_inner().unwrap();
        }
        // 打 gz 单文件
        let gz_path = join_name(&dir, "数据.csv.gz");
        {
            let f = std::fs::File::create(to_extended(&gz_path)).unwrap();
            let mut enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
            enc.write_all(b"1,2,3").unwrap();
            enc.finish().unwrap();
        }
        let mut p = prog();
        let mut skipped = 0u64;
        extract_tar(
            &tar_path,
            &dir,
            &AtomicBool::new(false),
            &mut p,
            &mut skipped,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(to_extended(&join_name(&dir, "t/t/a.txt"))).unwrap(),
            "t1"
        );
        let mut p2 = prog();
        extract_targz(
            &tgz_path,
            &dir,
            &AtomicBool::new(false),
            &mut p2,
            &mut skipped,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(to_extended(&join_name(&dir, "t (2)/t/sub/b.txt"))).unwrap(),
            "t2!"
        );
        // gz 单文件旁写内层名（数据.csv.gz → 数据.csv）
        let mut p3 = prog();
        extract_gz(&gz_path, &dir, &AtomicBool::new(false), &mut p3).unwrap();
        assert_eq!(
            std::fs::read_to_string(to_extended(&join_name(&dir, "数据.csv"))).unwrap(),
            "1,2,3"
        );
        assert_eq!(p3.total_bytes, 5); // ISIZE 分母
    }

    /// 引擎 E2E（依赖 src-tauri/binaries/7z.exe，缺失时跳过）：rar 路由的
    /// 7z.exe 桥（造 7z 包冒充路由目标不可行——7z.exe 不写 rar；用 xz 单文件
    /// 流与 rar 包装目录语义分别验证：xz 旁写内层名 + 错误密码 NeedPassword）
    #[test]
    fn extract_via_7z_single_stream_and_password() {
        let dir = tempdir();
        let payload = join_name(&dir, "数据.csv");
        std::fs::write(to_extended(&payload), "x,y\n1,2").unwrap();
        let xz_path = join_name(&dir, "数据.csv.xz");
        // xz 编码走 7z.exe（内嵌）；7z.exe 缺失则整测试跳过
        let Some(exe) = crate::fs::sevenzip::sevenzip_exe_dev() else {
            eprintln!("skip: 内嵌 7-Zip 未下载（tools/get-7zip.ps1）");
            return;
        };
        let aargs = |v: Vec<&str>| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        run_7z(
            &exe,
            &aargs(vec!["a", xz_path.as_str(), payload.as_str(), "-bso0"]),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let mut p = prog();
        extract_via_7z(
            Some(&exe),
            xz_path.as_str(),
            &dir,
            None,
            &AtomicBool::new(false),
            &mut p,
            false,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(to_extended(&join_name(&dir, "数据.csv"))).unwrap(),
            "x,y\n1,2"
        );
        // 清单预扫分母已入账（payload 共 7 字节）
        assert_eq!(p.total_bytes, 7);
        // 错误密码 → NeedPassword（造加密 7z 包再带错密码解压）
        let enc = join_name(&dir, "enc.7z");
        run_7z(
            &exe,
            &aargs(vec![
                "a",
                enc.as_str(),
                payload.as_str(),
                "-psecret",
                "-mhe=on",
                "-bso0",
            ]),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let mut p4 = prog();
        let r = extract_via_7z(
            Some(&exe),
            enc.as_str(),
            &dir,
            Some("wrongpw"),
            &AtomicBool::new(false),
            &mut p4,
            true,
        );
        let (msg, need_pw) = r.unwrap_err();
        assert!(need_pw, "应分类为需要密码：{msg}");
        assert_eq!(msg, "需要密码");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn run_extract_rejects_unknown_ext() {
        let dir = tempdir();
        let src = join_name(&dir, "x.rar"); // rar 路由但无 7z.exe → 未就绪错误
        std::fs::write(to_extended(&src), b"?").unwrap();
        let mut p = prog();
        let mut failed = Vec::new();
        run_extract(
            std::slice::from_ref(&src),
            &dir,
            None,
            None,
            &AtomicBool::new(false),
            &mut p,
            &mut failed,
        );
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].path, src);
        assert!(failed[0].message.contains("内嵌 7-Zip"));
    }

    #[test]
    fn run_extract_cancel_is_silent() {
        let dir = tempdir();
        let src = join_name(&dir, "t.zip");
        write_probe_zip(&src);
        let mut p = prog();
        let mut failed = Vec::new();
        let cancel = AtomicBool::new(true);
        run_extract(&[src], &dir, None, None, &cancel, &mut p, &mut failed);
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
        let mut p = prog();
        let mut skipped = 0u64;
        extract_7z(
            &sz,
            &dir,
            None,
            &AtomicBool::new(false),
            &mut p,
            &mut skipped,
        )
        .unwrap();
        let out = join_name(&dir, "t");
        assert_eq!(
            std::fs::read_to_string(to_extended(&join_name(&out, "a.txt"))).unwrap(),
            "seven"
        );
        // 穿越条目既不落在包目录内，也不逃逸到 dest_root
        assert!(!path_exists(&join_name(&out, "evil.txt")));
        assert!(!path_exists(&join_name(&dir, "evil.txt")));
        assert_eq!(skipped, 1);
        assert_eq!(p.total_bytes, 10); // 清单预扫分母 = 全部声明尺寸（含跳过的 evil 5B）
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
        let mut p = prog();
        let mut skipped = 0u64;
        extract_7z(
            &sz,
            &dir,
            None,
            &AtomicBool::new(true),
            &mut p,
            &mut skipped,
        )
        .unwrap();
    }
}
