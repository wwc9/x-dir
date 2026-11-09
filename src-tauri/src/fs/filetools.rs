//! 文件工具库（2026-11-09 功能库「工具」组）：哈希计算（MD5/SHA-1/SHA-256/
//! SHA-512，1 MiB 流式）、校验文件（GNU SUMS 格式）解析/核对、行尾转换
//! （字节级 0x0D/0x0A 重写，不改原编码）、文件分割/合并（.partNNN + .crc
//! 清单，SHA-256 完整性）、时间戳/属性批改、NTFS 硬链接/符号链接。
//! 命名/解析纯函数带单测；流式实现供任务引擎与命令层调用。

use std::io::{Read, Write};
use std::sync::atomic::AtomicBool;

use crate::fs::entry::path_exists;
use crate::fs::path::{file_name_of, join_name, parent_of, split_ext, to_extended};
use crate::jobs::pick::available_name;
use crate::jobs::{FailItem, JobProgress, is_cancelled};

/// 进度上报抽象：任务引擎用 EmitterState（100ms 节流 + 真事件），单测用
/// NullSink——让 run_* 体可以离 AppHandle 独立测试
pub(crate) trait ProgressSink {
    fn progress(&mut self, p: &JobProgress);
}

// ────────────────────────── 哈希 ──────────────────────────

/// 校验算法（md5/sha1 = 历史交付物核对惯例，sha256/sha512 = 现行安全惯例）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HashAlgo {
    Md5,
    Sha1,
    Sha256,
    Sha512,
}

impl HashAlgo {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "md5" => Some(Self::Md5),
            "sha1" => Some(Self::Sha1),
            "sha256" => Some(Self::Sha256),
            "sha512" => Some(Self::Sha512),
            _ => None,
        }
    }

    /// 摘要十六进制长度（32/40/64/128），解析 SUMS 行时反推算法
    pub fn hex_len(self) -> usize {
        match self {
            Self::Md5 => 32,
            Self::Sha1 => 40,
            Self::Sha256 => 64,
            Self::Sha512 => 128,
        }
    }

    /// 算法代号（md5/sha1/sha256/sha512，前端 Seg 与 IPC 参数同串）
    pub fn code(self) -> &'static str {
        match self {
            Self::Md5 => "md5",
            Self::Sha1 => "sha1",
            Self::Sha256 => "sha256",
            Self::Sha512 => "sha512",
        }
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0F) as usize] as char);
    }
    s
}

/// 哈希文件本体（命令层入口）
pub fn hash_file(path: &str, algo: HashAlgo) -> std::io::Result<String> {
    let mut f = std::fs::File::open(to_extended(path))?;
    hash_file_into(&mut f, algo)
}

/// SHA-256（分割/合并的完整性指纹，与校验文件同一算法口径）
pub fn sha256_hex_file(path: &str) -> std::io::Result<String> {
    hash_file(path, HashAlgo::Sha256)
}

/// digest 0.10 家族（sha1/sha2）通用的 1 MiB 喂入循环
fn feed_d10<D: sha2::Digest>(
    mut h: D,
    r: &mut impl Read,
    buf: &mut [u8],
) -> std::io::Result<Vec<u8>> {
    loop {
        let n = r.read(buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().to_vec())
}

/// digest 0.11 家族（md-5）同上（两个家族 trait 不互通，各自一档）
fn feed_d11<D: md5::Digest>(
    mut h: D,
    r: &mut impl Read,
    buf: &mut [u8],
) -> std::io::Result<Vec<u8>> {
    loop {
        let n = r.read(buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().to_vec())
}

fn hash_file_into(r: &mut impl Read, algo: HashAlgo) -> std::io::Result<String> {
    use md5::Digest as _;
    use sha2::Digest as _;
    let mut buf = vec![0u8; 1024 * 1024];
    let digest = match algo {
        HashAlgo::Md5 => feed_d11(md5::Md5::new(), r, &mut buf)?,
        HashAlgo::Sha1 => feed_d10(sha1::Sha1::new(), r, &mut buf)?,
        HashAlgo::Sha256 => feed_d10(sha2::Sha256::new(), r, &mut buf)?,
        HashAlgo::Sha512 => feed_d10(sha2::Sha512::new(), r, &mut buf)?,
    };
    Ok(hex_encode(&digest))
}

/// 单行校验核对结果（status ∈ ok/mismatch/missing/error，camelCase 下发前端）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRow {
    pub name: String,
    pub expected: String,
    /// None = 文件缺失或读取失败
    pub actual: Option<String>,
    pub status: &'static str,
}

/// 从 SUMS 文本解析（hash, name）行：GNU `hash␣␣name`（两空格分隔）、
/// 二进制模式 `hash *name`；跳过空行/#注释/哈希长度不合法的行；名称保留
/// 原文（可含空格）
pub fn parse_sums(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(sp) = line.find(' ') else {
            continue;
        };
        let (hash, rest) = line.split_at(sp);
        let hash = hash.trim();
        let name = rest.trim_start_matches(' ').trim_start_matches('*');
        // 哈希段 = 纯十六进制且长度恰为四种摘要之一；不合法即整行跳过
        let hex_ok = !hash.is_empty()
            && hash.bytes().all(|b| {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (b'A'..=b'F').contains(&b)
            })
            && [32usize, 40, 64, 128].contains(&hash.len());
        if !hex_ok || name.is_empty() {
            continue;
        }
        out.push((hash.to_ascii_lowercase(), name.to_string()));
    }
    out
}

/// SUMS 行格式（GNU md5sum 兼容：两空格分隔，普通文本模式）
pub fn sums_line(hash: &str, name: &str) -> String {
    format!("{hash}  {name}")
}

/// 校验文件核对：以 SUMS 文件所在目录为基准解析相对名（绝对名原样），
/// 逐项哈希比对。文件缺失 → missing；哈希不符 → mismatch；读取失败 → error
pub fn verify_sums(sums_path: &str, text: &str) -> Vec<VerifyRow> {
    let dir = parent_of(sums_path).unwrap_or_else(|| ".".into());
    parse_sums(text)
        .into_iter()
        .map(|(expected, name)| {
            let full = if name.contains(':') || name.starts_with("\\\\") {
                name.clone()
            } else {
                join_name(&dir, &name)
            };
            if !path_exists(&full) {
                return VerifyRow {
                    name,
                    expected,
                    actual: None,
                    status: "missing",
                };
            }
            // 算法按期望哈希长度反推（.md5/.sha1/.sha256/.sha512 同一套格式）
            let Some(algo) = [
                HashAlgo::Md5,
                HashAlgo::Sha1,
                HashAlgo::Sha256,
                HashAlgo::Sha512,
            ]
            .into_iter()
            .find(|a| a.hex_len() == expected.len()) else {
                return VerifyRow {
                    name,
                    expected,
                    actual: None,
                    status: "error",
                };
            };
            match hash_file(&full, algo) {
                Ok(actual) if actual.eq_ignore_ascii_case(&expected) => VerifyRow {
                    name,
                    expected,
                    actual: Some(actual),
                    status: "ok",
                },
                Ok(actual) => VerifyRow {
                    name,
                    expected,
                    actual: Some(actual),
                    status: "mismatch",
                },
                Err(_) => VerifyRow {
                    name,
                    expected,
                    actual: None,
                    status: "error",
                },
            }
        })
        .collect()
}

/// 按扩展名识别校验文件算法（sha256sums / checksums.md5 等尾缀也认）
pub fn algo_from_ext(name: &str) -> Option<HashAlgo> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "md5" | "md5sums" => Some(HashAlgo::Md5),
        "sha1" | "sha1sums" => Some(HashAlgo::Sha1),
        "sha256" | "sha256sums" => Some(HashAlgo::Sha256),
        "sha512" | "sha512sums" => Some(HashAlgo::Sha512),
        _ => None,
    }
}

// ────────────────────────── 行尾转换 ──────────────────────────

/// 目标行尾（crlf = Windows，lf = Unix）；字节级重写不改编码——GBK 双字节
/// 第二字节 ≥ 0x40、UTF-8 续字节 ≥ 0x80，均不会撞上 0x0D/0x0A，可安全按字节处理
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eol {
    Crlf,
    Lf,
}

impl Eol {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "crlf" => Some(Self::Crlf),
            "lf" => Some(Self::Lf),
            _ => None,
        }
    }

    /// 旁写后缀（_crlf / _lf）
    pub fn suffix(self) -> &'static str {
        match self {
            Self::Crlf => "_crlf",
            Self::Lf => "_lf",
        }
    }

    fn newline(self) -> &'static [u8] {
        match self {
            Self::Crlf => b"\r\n",
            Self::Lf => b"\n",
        }
    }
}

/// 字节级行尾归一：CR、LF、CRLF 混行统一改写为目标行尾，其余字节原样
pub fn transform_eol(bytes: &[u8], to: Eol) -> Vec<u8> {
    let nl = to.newline();
    let mut out = Vec::with_capacity(bytes.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            0x0D => {
                if bytes.get(i + 1) == Some(&0x0A) {
                    i += 2;
                } else {
                    i += 1;
                }
                out.extend_from_slice(nl);
            }
            0x0A => {
                out.extend_from_slice(nl);
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

/// 行尾转换任务体（旁写 <stem><后缀>.<ext>，已存在自动改名；二进制文件跳过）
pub(crate) fn run_convert_eol(
    paths: &[String],
    to: Eol,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut impl ProgressSink,
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
            let out = transform_eol(&bytes, to);
            let name = file_name_of(p);
            let (stem, ext) = split_ext(&name);
            let ext = if ext.is_empty() {
                String::new()
            } else {
                format!(".{ext}")
            };
            let dir = parent_of(p).unwrap_or_else(|| ".".into());
            let target =
                available_name(&join_name(&dir, &format!("{}{}{}", stem, to.suffix(), ext)));
            std::fs::write(to_extended(&target), out).map_err(|e| e.to_string())
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

// ────────────────────────── 分割 / 合并 ──────────────────────────

/// 分割部件名：`video.mp4` + 序号 2 + 宽 3 → `video.mp4.part002`
pub fn part_name(base: &str, idx: usize, digits: usize) -> String {
    format!("{base}.part{:0width$}", idx, width = digits)
}

/// 反解部件名 → (基底全名, 序号)；`video.mp4.part002` → ("video.mp4", 2)。
/// 序号位数任意（3 位惯例、超 999 件自动扩位）
pub fn parse_part_name(name: &str) -> Option<(String, usize)> {
    let marker = ".part";
    let pos = name.rfind(marker)?;
    let digits = &name[pos + marker.len()..];
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let idx: usize = digits.parse().ok()?;
    Some((name[..pos].to_string(), idx))
}

/// 序号宽度：≥3 位（`part001` 惯例），超 999 件按十进制位数扩展
pub fn part_digits(count: usize) -> usize {
    let mut d = 1;
    let mut n = count;
    while n >= 10 {
        n /= 10;
        d += 1;
    }
    d.max(3)
}

/// .crc 清单：# 注释头（总 SHA-256）+ SUMS 两空格行（各部件 SHA-256），
/// 复用 parse_sums 解析，GNU 工具也能直接读部件行
pub fn crc_manifest(total_sha256: &str, parts: &[(String, String)]) -> String {
    let mut s = String::from("# X-Dir 文件分割清单\n");
    s.push_str(&format!("# total-sha256: {total_sha256}\n"));
    for (name, hash) in parts {
        s.push_str(&sums_line(hash, name));
        s.push('\n');
    }
    s
}

/// 从清单文本读总 SHA-256（# total-sha256: 行；无则 None）
pub fn crc_total_of(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("# total-sha256:") {
            let v = rest.trim();
            if !v.is_empty() {
                return Some(v.to_ascii_lowercase());
            }
        }
    }
    None
}

/// 分割任务体：流式切块（1 MiB 读缓冲），逐部件 SHA-256 + 总 SHA-256，
/// 完成后旁写 `<base>.crc` 清单。部件/清单名经 available_name 防覆盖残留
pub(crate) fn run_split_file(
    path: &str,
    part_bytes: u64,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut impl ProgressSink,
    failed: &mut Vec<FailItem>,
) {
    let dir = parent_of(path).unwrap_or_else(|| ".".into());
    let base = file_name_of(path);
    let r = (|| -> Result<(), String> {
        let mut src = std::fs::File::open(to_extended(path)).map_err(|e| e.to_string())?;
        let total_len = src.metadata().map_err(|e| e.to_string())?.len();
        if total_len == 0 {
            return Err("空文件无需分割".into());
        }
        let count = total_len.div_ceil(part_bytes) as usize;
        let digits = part_digits(count);
        prog.total_files = count as u64 + 1;
        prog.total_bytes = total_len;
        use sha2::Digest as _;
        let mut total_hash = sha2::Sha256::new();
        let mut part_rows: Vec<(String, String)> = Vec::with_capacity(count);
        let mut buf = vec![0u8; 1024 * 1024];
        for idx in 1..=count {
            if is_cancelled(cancel) {
                return Err("已取消".into());
            }
            prog.current_path = part_name(&base, idx, digits);
            let target = available_name(&join_name(&dir, prog.current_path.as_str()));
            let mut out = std::fs::File::create(to_extended(&target)).map_err(|e| e.to_string())?;
            let mut part_hash = sha2::Sha256::new();
            let mut remain = part_bytes;
            while remain > 0 {
                let want = remain.min(buf.len() as u64) as usize;
                let n = src.read(&mut buf[..want]).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                part_hash.update(&buf[..n]);
                total_hash.update(&buf[..n]);
                remain -= n as u64;
                prog.done_bytes += n as u64;
            }
            out.flush().map_err(|e| e.to_string())?;
            part_rows.push((file_name_of(&target), hex_encode(&part_hash.finalize())));
            prog.done_files += 1;
            em.progress(prog);
        }
        if is_cancelled(cancel) {
            return Err("已取消".into());
        }
        prog.current_path = format!("{base}.crc");
        let total_hex = hex_encode(&total_hash.finalize());
        let crc_path = available_name(&join_name(&dir, &format!("{base}.crc")));
        std::fs::write(
            to_extended(&crc_path),
            crc_manifest(&total_hex, &part_rows).into_bytes(),
        )
        .map_err(|e| e.to_string())?;
        prog.done_files += 1;
        em.progress(prog);
        Ok(())
    })();
    if let Err(e) = r {
        failed.push(FailItem {
            path: path.to_string(),
            message: e,
            reason: None,
        });
    }
}

/// 合并任务体：选中项反解部件 → 按基底分组建序 → 邻接性校验 →
/// （有 .crc 时）逐部件 SHA-256 验签 → 流式重组 → 总 SHA-256 复核。
/// 输出名 = 基底名；冲突时 `<stem>_合并.<ext>`，再冲突 available_name 兜底
pub(crate) fn run_combine_parts(
    paths: &[String],
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut impl ProgressSink,
    failed: &mut Vec<FailItem>,
) {
    let r = (|| -> Result<(), String> {
        // 收集部件，按基底名分组（.crc 清单可一并入选中项）
        let mut groups: std::collections::BTreeMap<String, Vec<(usize, String)>> =
            std::collections::BTreeMap::new();
        let mut crc_text: Option<String> = None;
        for p in paths {
            if !path_exists(p) {
                return Err(format!("文件不存在：{}", file_name_of(p)));
            }
            let name = file_name_of(p);
            if let Some((base, idx)) = parse_part_name(&name) {
                groups.entry(base).or_default().push((idx, p.clone()));
            } else if name.to_ascii_lowercase().ends_with(".crc") {
                crc_text = Some(std::fs::read_to_string(to_extended(p)))
                    .transpose()
                    .map_err(|e| e.to_string())?;
            }
        }
        let (base, mut parts): (String, Vec<(usize, String)>) = groups
            .into_iter()
            .max_by_key(|(_, v)| v.len())
            .ok_or_else(|| "未选中有效的分割部件（须形如 名称.part001）".to_string())?;
        parts.sort_by_key(|(idx, _)| *idx);
        // 序号 1..=n 连续（缺件提前失败，不产出残缺文件）
        for (i, (idx, _)) in parts.iter().enumerate() {
            if *idx != i + 1 {
                return Err(format!("部件序号不连续：缺 {}（找到 {}）", i + 1, idx));
            }
        }
        let dir = parent_of(&parts[0].1).unwrap_or_else(|| ".".into());
        // 邻目录 .crc 清单（选中 .crc 或基底同名 .crc 皆可）
        let manifest_text = crc_text.clone().or_else(|| {
            let p = join_name(&dir, &format!("{base}.crc"));
            path_exists(&p)
                .then(|| std::fs::read_to_string(to_extended(&p)).ok())
                .flatten()
        });
        // 逐部件验签（有清单时）
        if let Some(text) = &manifest_text {
            let rows = parse_sums(text);
            prog.total_files = parts.len() as u64;
            prog.total_bytes = 0;
            for (idx, p) in &parts {
                if is_cancelled(cancel) {
                    return Err("已取消".into());
                }
                prog.current_path = file_name_of(p);
                let want = rows
                    .iter()
                    .find(|(_h, n)| {
                        n.eq_ignore_ascii_case(&file_name_of(p))
                            || parse_part_name(n).map(|(b, i2)| b == base && i2 == *idx)
                                == Some(true)
                    })
                    .map(|(h, _)| h.clone());
                if let Some(want) = want {
                    let got = sha256_hex_file(p).map_err(|e| e.to_string())?;
                    if !got.eq_ignore_ascii_case(&want) {
                        return Err(format!(
                            "部件 {} 校验不符，已中止合并（文件可能损坏）",
                            file_name_of(p)
                        ));
                    }
                }
                prog.done_files += 1;
                em.progress(prog);
            }
        }
        // 重组：基底名；冲突 → <stem>_合并.<ext> → available_name 兜底
        let out_first = join_name(&dir, &base);
        let output = if !path_exists(&out_first) {
            out_first
        } else {
            let (stem, ext) = split_ext(&base);
            let ext = if ext.is_empty() {
                String::new()
            } else {
                format!(".{ext}")
            };
            let merged = format!("{stem}_合并{ext}");
            let cand = join_name(&dir, &merged);
            if !path_exists(&cand) {
                cand
            } else {
                available_name(&cand)
            }
        };
        prog.total_files = parts.len() as u64 + 1;
        prog.total_bytes = parts
            .iter()
            .filter_map(|(_, p)| std::fs::metadata(to_extended(p)).ok())
            .map(|m| m.len())
            .sum();
        prog.current_path = file_name_of(&output);
        let mut out = std::fs::File::create(to_extended(&output)).map_err(|e| e.to_string())?;
        use sha2::Digest as _;
        let mut total_hash = sha2::Sha256::new();
        let mut buf = vec![0u8; 1024 * 1024];
        for (_, p) in &parts {
            if is_cancelled(cancel) {
                return Err("已取消".into());
            }
            let mut f = std::fs::File::open(to_extended(p)).map_err(|e| e.to_string())?;
            loop {
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                total_hash.update(&buf[..n]);
                prog.done_bytes += n as u64;
            }
            prog.done_files += 1;
            em.progress(prog);
        }
        out.flush().map_err(|e| e.to_string())?;
        // 总校验复核（清单在时）：不符 → 文件保留 + 失败回执提示
        if let Some(text) = &manifest_text
            && let Some(want) = crc_total_of(text)
        {
            let got = hex_encode(&total_hash.finalize());
            if !got.eq_ignore_ascii_case(&want) {
                failed.push(FailItem {
                    path: output.clone(),
                    message: "合并完成但总 SHA-256 不符，文件可能损坏（请重取源件）".into(),
                    reason: None,
                });
                return Ok(());
            }
        }
        prog.current_path = String::new();
        prog.note = Some(format!("输出 {}", file_name_of(&output)));
        Ok(())
    })();
    if let Err(e) = r {
        failed.push(FailItem {
            path: String::new(),
            message: e,
            reason: None,
        });
    }
}

// ────────────────────────── 时间戳 / 属性 ──────────────────────────

/// 批改时间戳/属性（None = 保持该项不动）。毫秒时间戳（负数 = 1970 前，罕见但合法）
pub fn set_file_meta(
    path: &str,
    mtime_ms: Option<i64>,
    atime_ms: Option<i64>,
    readonly: Option<bool>,
    hidden: Option<bool>,
) -> Result<(), String> {
    let ext = to_extended(path);
    if mtime_ms.is_some() || atime_ms.is_some() {
        // filetime（MIT/Apache-2.0，notify 同源依赖）：目录/文件通吃，
        // Windows 下经 FILE_FLAG_BACKUP_SEMANTICS 开句柄
        let to_ft = |ms: i64| {
            filetime::FileTime::from_unix_time(
                ms.div_euclid(1000),
                (ms.rem_euclid(1000) * 1_000_000) as u32,
            )
        };
        if let Some(ms) = mtime_ms {
            filetime::set_file_mtime(&ext, to_ft(ms)).map_err(|e| e.to_string())?;
        }
        if let Some(ms) = atime_ms {
            filetime::set_file_atime(&ext, to_ft(ms)).map_err(|e| e.to_string())?;
        }
    }
    if let Some(ro) = readonly {
        let md = std::fs::metadata(&ext).map_err(|e| e.to_string())?;
        let mut perm = md.permissions();
        perm.set_readonly(ro);
        std::fs::set_permissions(&ext, perm).map_err(|e| e.to_string())?;
    }
    if let Some(hid) = hidden {
        set_hidden_bit(&ext, hid)?;
    }
    Ok(())
}

/// 隐藏属性位（Windows 专属；其余平台不支持即报错）
#[cfg(windows)]
fn set_hidden_bit(path: &std::path::Path, hidden: bool) -> Result<(), String> {
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_HIDDEN, FILE_FLAGS_AND_ATTRIBUTES, GetFileAttributesW, SetFileAttributesW,
    };
    use windows::core::HSTRING;
    let wide = HSTRING::from(path.as_os_str());
    unsafe {
        // windows 0.62：GetFileAttributesW 失败返回 INVALID_FILE_ATTRIBUTES
        //（u32::MAX），SetFileAttributesW 才是 Result
        let cur = GetFileAttributesW(&wide);
        if cur == u32::MAX {
            return Err("读取文件属性失败".into());
        }
        let next = if hidden {
            FILE_FLAGS_AND_ATTRIBUTES(cur | FILE_ATTRIBUTE_HIDDEN.0)
        } else {
            FILE_FLAGS_AND_ATTRIBUTES(cur & !FILE_ATTRIBUTE_HIDDEN.0)
        };
        SetFileAttributesW(&wide, next).map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
fn set_hidden_bit(_path: &std::path::Path, _hidden: bool) -> Result<(), String> {
    Err("当前平台不支持隐藏属性".into())
}

// ────────────────────────── NTFS 链接 ──────────────────────────

/// 同目录旁建链接：硬链接（同卷文件）/ 符号链接（文件或文件夹，需管理员或
/// 开发者模式）。返回新链接路径；命名 `<stem>_硬链接|_符号链接.<ext>`，
/// 冲突 available_name 兜底
#[cfg(windows)]
pub fn create_sibling_link(path: &str, hard: bool) -> std::io::Result<String> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let ext = to_extended(path);
    let md = std::fs::metadata(&ext)?;
    if hard && md.is_dir() {
        return Err(std::io::Error::other(
            "文件夹不能创建硬链接（可用符号链接）",
        ));
    }
    let name = file_name_of(path);
    let (stem, e) = split_ext(&name);
    let tag = if hard { "_硬链接" } else { "_符号链接" };
    let new_name = if e.is_empty() {
        format!("{stem}{tag}")
    } else {
        format!("{stem}{tag}.{e}")
    };
    let dir = parent_of(path).unwrap_or_else(|| ".".into());
    let target = available_name(&join_name(&dir, &new_name));
    let target_ext = to_extended(&target);
    if hard {
        std::fs::hard_link(&ext, &target_ext)?;
    } else if md.is_dir() {
        symlink_dir(&ext, &target_ext)?;
    } else {
        symlink_file(&ext, &target_ext)?;
    }
    Ok(target)
}

#[cfg(not(windows))]
pub fn create_sibling_link(_path: &str, _hard: bool) -> std::io::Result<String> {
    Err(std::io::Error::other("当前平台不支持 NTFS 链接"))
}

// ────────────────────────── 单测 ──────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct NullSink;
    impl ProgressSink for NullSink {
        fn progress(&mut self, _p: &JobProgress) {}
    }

    fn tempdir(tag: &str) -> String {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "xdir-ft-{tag}-{}-{}",
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

    #[test]
    fn hash_algo_known_vectors() {
        // RFC 1321/3174/6231 标准向量
        assert_eq!(
            hash_file_into(&mut "".as_bytes(), HashAlgo::Md5).unwrap(),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        assert_eq!(
            hash_file_into(&mut "abc".as_bytes(), HashAlgo::Sha1).unwrap(),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hash_file_into(&mut "abc".as_bytes(), HashAlgo::Sha256).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(HashAlgo::Sha512.hex_len(), 128);
    }

    #[test]
    fn sums_parse_and_format_roundtrip() {
        let text = "# comment\n\
                    d41d8cd98f00b204e9800998ecf8427e  a.txt\n\
                    ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad *带 空格 名.pdf\n\
                    短哈希 not-a-hash  skip.txt\n\n\
                    ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  upper.TXT\n";
        let rows = parse_sums(text);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].0, "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(rows[0].1, "a.txt");
        assert_eq!(rows[1].1, "带 空格 名.pdf"); // * 前缀剥掉、内部空格保留
        assert_eq!(rows[2].0, "f".repeat(64));
        let line = sums_line(&rows[0].0, "a.txt");
        assert_eq!(line, "d41d8cd98f00b204e9800998ecf8427e  a.txt");
    }

    #[test]
    fn verify_sums_reports_ok_mismatch_missing() {
        let dir = tempdir("verify");
        std::fs::write(join_name(&dir, "good.txt"), b"hello").unwrap();
        std::fs::write(join_name(&dir, "bad.txt"), b"tampered").unwrap();
        // good = SHA-256("hello")；bad 写成不匹配值；gone.txt 不存在
        let good = hash_file(&join_name(&dir, "good.txt"), HashAlgo::Sha256).unwrap();
        let sums = format!(
            "{good}  good.txt\n{:064x}  bad.txt\n{:064x}  gone.txt\n",
            0xdead_beefu64, 0xbeef_deafu64
        );
        let rows = verify_sums(&join_name(&dir, "sums.sha256"), &sums);
        assert_eq!(rows[0].status, "ok");
        assert_eq!(rows[1].status, "mismatch");
        assert_eq!(rows[2].status, "missing");
    }

    #[test]
    fn algo_from_ext_matches() {
        assert_eq!(algo_from_ext("SUMS.md5"), Some(HashAlgo::Md5));
        assert_eq!(algo_from_ext("sha256sums"), Some(HashAlgo::Sha256));
        assert_eq!(algo_from_ext("a.SHA1"), Some(HashAlgo::Sha1));
        assert_eq!(algo_from_ext("readme.txt"), None);
    }

    #[test]
    fn eol_transform_unifies_all_three() {
        let mixed = b"a\r\nb\nc\rd"; // CRLF / LF / CR 三态混行
        assert_eq!(transform_eol(mixed, Eol::Crlf), b"a\r\nb\r\nc\r\nd");
        assert_eq!(transform_eol(mixed, Eol::Lf), b"a\nb\nc\nd");
        // 多字节 UTF-8（0xE4 0xB8 0xAD）原样通过；末尾无换行不补
        let zh = "中文".as_bytes();
        assert_eq!(transform_eol(zh, Eol::Crlf), zh);
    }

    #[test]
    fn part_name_roundtrip_and_digits() {
        assert_eq!(part_name("video.mp4", 2, 3), "video.mp4.part002");
        assert_eq!(part_digits(999), 3);
        assert_eq!(part_digits(1000), 4);
        assert_eq!(
            parse_part_name("video.mp4.part002"),
            Some(("video.mp4".into(), 2))
        );
        assert_eq!(
            parse_part_name("video.mp4.part00042"),
            Some(("video.mp4".into(), 42))
        );
        assert_eq!(parse_part_name("video.mp4"), None);
        assert_eq!(parse_part_name("a.partx"), None);
        assert_eq!(parse_part_name("a.part"), None);
    }

    #[test]
    fn crc_manifest_roundtrip() {
        let m = crc_manifest(&"ab".repeat(32), &[("x.part001".into(), "cd".repeat(32))]);
        assert_eq!(crc_total_of(&m).unwrap(), "ab".repeat(32));
        assert_eq!(parse_sums(&m).len(), 1);
        assert_eq!(crc_total_of("# 没有总校验\n"), None);
    }

    #[test]
    fn split_then_combine_roundtrip_with_crc() {
        let dir = tempdir("split");
        let src = join_name(&dir, "doc.bin");
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &data).unwrap();

        let cancel = AtomicBool::new(false);
        let mut em = NullSink;
        let mut prog = prog();
        let mut failed = Vec::new();
        run_split_file(&src, 100, &cancel, &mut prog, &mut em, &mut failed);
        assert!(failed.is_empty(), "split failed: {:?}", failed);
        let parts: Vec<String> = (1..=10)
            .map(|i| join_name(&dir, &part_name("doc.bin", i, 3)))
            .collect();
        for p in &parts {
            assert!(path_exists(p), "missing part {p}");
        }
        let crc = join_name(&dir, "doc.bin.crc");
        assert!(path_exists(&crc));

        // 合并（选中全部部件；清单自动从邻目录读取并验签）
        let mut failed2 = Vec::new();
        run_combine_parts(&parts, &cancel, &mut prog, &mut em, &mut failed2);
        assert!(failed2.is_empty(), "combine failed: {:?}", failed2);
        let merged = std::fs::read(&src).unwrap();
        assert_eq!(merged, data);
    }

    #[test]
    fn combine_aborts_on_corrupt_part() {
        let dir = tempdir("corrupt");
        let src = join_name(&dir, "doc.bin");
        std::fs::write(&src, [0xABu8; 250]).unwrap();
        let cancel = AtomicBool::new(false);
        let mut em = NullSink;
        let mut prog = prog();
        let mut failed = Vec::new();
        run_split_file(&src, 100, &cancel, &mut prog, &mut em, &mut failed);
        assert!(failed.is_empty());
        // 篡改 part002 一个字节
        let p2 = join_name(&dir, "doc.bin.part002");
        let mut bytes = std::fs::read(&p2).unwrap();
        bytes[0] ^= 0xFF;
        std::fs::write(&p2, &bytes).unwrap();
        let parts: Vec<String> = (1..=3)
            .map(|i| join_name(&dir, &part_name("doc.bin", i, 3)))
            .collect();
        let mut failed2 = Vec::new();
        run_combine_parts(&parts, &cancel, &mut prog, &mut em, &mut failed2);
        assert!(
            failed2.iter().any(|f| f.message.contains("校验不符")),
            "expect checksum abort, got {:?}",
            failed2
        );
    }

    #[test]
    fn combine_requires_contiguous_parts() {
        let dir = tempdir("gap");
        // 只造 part001/part003，缺 002
        std::fs::write(join_name(&dir, "a.part001"), b"1").unwrap();
        std::fs::write(join_name(&dir, "a.part003"), b"3").unwrap();
        let cancel = AtomicBool::new(false);
        let mut em = NullSink;
        let mut prog = prog();
        let mut failed = Vec::new();
        run_combine_parts(
            &[join_name(&dir, "a.part001"), join_name(&dir, "a.part003")],
            &cancel,
            &mut prog,
            &mut em,
            &mut failed,
        );
        assert!(
            failed.iter().any(|f| f.message.contains("序号不连续")),
            "expect gap abort, got {:?}",
            failed
        );
    }

    #[test]
    fn set_meta_readonly_and_times() {
        let dir = tempdir("meta");
        let p = join_name(&dir, "t.txt");
        std::fs::write(&p, b"x").unwrap();
        set_file_meta(&p, Some(1_000_000_000_000), None, Some(true), None).unwrap();
        let md = std::fs::metadata(to_extended(&p)).unwrap();
        assert!(md.permissions().readonly());
        let mtime = md.modified().unwrap();
        let ms = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert_eq!(ms, 1_000_000_000_000);
        set_file_meta(&p, None, None, Some(false), None).unwrap();
        assert!(
            !std::fs::metadata(to_extended(&p))
                .unwrap()
                .permissions()
                .readonly()
        );
    }

    #[test]
    fn link_sibling_names_and_readonly_conflict() {
        let dir = tempdir("link");
        let p = join_name(&dir, "note.txt");
        std::fs::write(&p, b"x").unwrap();
        let link = create_sibling_link(&p, true).unwrap();
        assert!(link.ends_with("note_硬链接.txt"));
        assert_eq!(std::fs::read(to_extended(&link)).unwrap(), b"x");
        // 同名再建 → available_name 递增
        let link2 = create_sibling_link(&p, true).unwrap();
        assert!(link2.ends_with("note_硬链接 (2).txt"));
        let d = join_name(&dir, "sub");
        std::fs::create_dir_all(&d).unwrap();
        assert!(create_sibling_link(&d, true).is_err()); // 目录硬链接拒绝
    }
}
