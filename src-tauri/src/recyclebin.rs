//! 回收站虚拟页（2026-11-25 用户需求）：直读各盘 `$Recycle.Bin\<SID>\$I*`
//! 元数据文件（无需 COM/IShellFolder 枚举），还原 = `$R` 数据体移回原路径，
//! 永久删除 = 删 `$R`。本用户 SID 的桶可读，其他 SID 的桶被 ACL 挡住自然跳过。
//!
//! $I 文件格式（Vista 起）：
//!   +0  u32  固定头 2
//!   +4  u32  版本（1 = Win Vista~8.x 固定长名 / 2 = Win10+ 带长度前缀）
//!   +8  u64  原文件字节数
//!   +16 u64  删除时刻（FILETIME，UTC 100ns）
//!   +24     v1: 520 字节定长 UTF-16 名（260 wchar，NUL 止）
//!           v2: u32 名长（wchar 数，含 NUL）+ UTF-16 名
//! `$R` 文件与 `$I` 同名前缀（$Ixxxx.ext → $Rxxxx.ext），即被删数据本体。

use serde::{Deserialize, Serialize};

use crate::fs::path::{join_name, to_extended};

/// 单条回收站条目（IPC camelCase；restore 命令原样回传反序列化）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecycleEntry {
    /// 原文件名（展示名）
    pub name: String,
    /// 原完整路径（还原目标；原位置列展示）
    pub orig_path: String,
    /// $I 元数据文件路径（定位/删除配对用）
    pub i_path: String,
    /// $R 数据本体路径（还原源 / 永久删除对象）
    pub r_path: String,
    pub is_dir: bool,
    /// 原字节数（$I 头记录）
    pub size: u64,
    /// 删除时刻（Unix ms）
    pub deleted_ms: i64,
}

/// 还原/清空结果：成功数 + 逐项失败（人话 message）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleOpResult {
    pub ok: usize,
    pub failed: Vec<FailItem>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FailItem {
    pub path: String,
    pub message: String,
}

/// 列表护栏：异常桶（海量垃圾 $I）不拖死整页
const MAX_ENTRIES: usize = 2000;
/// 还原/删除批量护栏
const MAX_OPS: usize = 2000;

/// 解析 $I 元数据字节（纯函数，配 cargo test）。真实文件头 = u64 魔数 2
/// （+4..+8 恒 0——trash crate 与资源管理器实删样本均如此，无独立版本字段）；
/// v2（Win10+）= +24 u32 名长（wchar 数含 NUL）+ 名字，v1（Vista~8.x）=
/// +24 定长 520 字节名。两者按「名长合法性」判别：+24 的 u32 若是 v1 名字的
/// 前两个 wchar 拼合（ANSI 首字母 ≈0x4x、CJK ≈0x4E00+），数值必然远超
/// 「剩余字节可容纳的 wchar 数」→ 落 v1 分支；真实名长必然 ≤ 剩余字节数。
/// 无法识别返回 None。
pub fn parse_i_file(bytes: &[u8]) -> Option<(String, u64, i64)> {
    if bytes.len() < 24 {
        return None;
    }
    let header = u64::from_le_bytes(bytes[0..8].try_into().ok()?);
    if header != 2 {
        return None;
    }
    let size = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let filetime = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
    // v2 尝试：名长字段必须能被完整容纳（len 含 NUL，≥2）
    let name_v2 = if bytes.len() >= 28 {
        let len = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
        if len >= 2 && len <= (bytes.len() - 28) / 2 && bytes.len() >= 28 + len * 2 {
            read_wide_nul(&bytes[28..28 + len * 2])
        } else {
            None
        }
    } else {
        None
    };
    let name = match name_v2 {
        Some(n) if !n.is_empty() => n,
        _ => {
            // v1：定长 520 字节（260 wchar）NUL 止
            if bytes.len() < 24 + 520 {
                return None;
            }
            read_wide_nul(&bytes[24..24 + 520])?
        }
    };
    if name.is_empty() {
        return None;
    }
    Some((name, size, filetime_to_unix_ms(filetime)))
}

/// UTF-16LE NUL 止串；非法编码返回 None
fn read_wide_nul(buf: &[u8]) -> Option<String> {
    let chars: Vec<u16> = buf
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    let end = chars.iter().position(|&c| c == 0).unwrap_or(chars.len());
    if end == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&chars[..end]))
}

/// FILETIME（1601-01-01 起 100ns）→ Unix 毫秒
pub fn filetime_to_unix_ms(ft: u64) -> i64 {
    (ft / 10_000) as i64 - 11_644_473_600_000
}

/// 枚举全部逻辑盘根的回收站条目（本用户可读的桶；无 $Recycle.Bin 的盘跳过）
pub fn list_entries() -> Vec<RecycleEntry> {
    let mut out = Vec::new();
    for root in crate::commands::drives::logical_roots() {
        let bin_root = join_name(&root, "$Recycle.Bin");
        let rd = match std::fs::read_dir(to_extended(&bin_root)) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        // 逐 SID 桶；其他用户的桶 readdir 可见但内容 ACL 拒读——逐文件失败即跳
        for sid in rd.flatten() {
            let sid_dir = match sid.path().to_str() {
                Some(p) => p.to_string(),
                None => continue,
            };
            let files = match std::fs::read_dir(to_extended(&sid_dir)) {
                Ok(f) => f,
                Err(_) => continue,
            };
            for f in files.flatten() {
                if out.len() >= MAX_ENTRIES {
                    return out;
                }
                let fname = match f.file_name().to_str() {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                // $I 前缀 + 至少 4 字符随机段
                if !fname.to_ascii_uppercase().starts_with("$I") || fname.len() < 6 {
                    continue;
                }
                let bytes = match std::fs::read(to_extended(&f.path().to_string_lossy())) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                // $I 的「名」字段即原完整路径
                let Some((orig_path, size, deleted_ms)) = parse_i_file(&bytes) else {
                    continue;
                };
                let i_path = f.path().to_string_lossy().to_string();
                let r_path = format!("{}\\$R{}", sid_dir, fname.get(2..).unwrap_or_default());
                let is_dir = std::fs::metadata(to_extended(&r_path))
                    .map(|m| m.is_dir())
                    .unwrap_or(false);
                out.push(RecycleEntry {
                    name: crate::fs::path::file_name_of(&orig_path),
                    orig_path,
                    i_path,
                    r_path,
                    is_dir,
                    size,
                    deleted_ms,
                });
            }
        }
    }
    out
}

/// 还原一批条目：$R 移回原路径（原父目录缺失则逐级补建；原名被占则
/// `名 (2).ext` 递增旁写，绝不覆盖）。返回成功数与失败清单。
pub fn restore_entries(items: &[RecycleEntry]) -> RecycleOpResult {
    let mut ok = 0usize;
    let mut failed = Vec::new();
    for it in items.iter().take(MAX_OPS) {
        match restore_one(it) {
            Ok(()) => ok += 1,
            Err(e) => failed.push(FailItem {
                path: it.orig_path.clone(),
                message: e,
            }),
        }
    }
    RecycleOpResult { ok, failed }
}

fn restore_one(it: &RecycleEntry) -> Result<(), String> {
    if std::fs::metadata(to_extended(&it.r_path)).is_err() {
        return Err("回收站中已找不到该条目的数据".into());
    }
    let orig = &it.orig_path;
    let Some(parent) = crate::fs::path::parent_of(orig) else {
        return Err(format!("原路径无效：{orig}"));
    };
    // 原父目录可能已随删除链消失：逐级补建（还原到原位置语义）
    if let Err(e) = std::fs::create_dir_all(to_extended(&parent)) {
        return Err(format!("无法重建原位置 {parent}：{e}"));
    }
    // 原名被占：同目录旁写 (2) 递增（任务引擎 available_name 同语义）
    let dest = if crate::fs::entry::path_exists(orig) {
        crate::jobs::pick::available_name(orig)
    } else {
        orig.clone()
    };
    std::fs::rename(to_extended(&it.r_path), to_extended(&dest))
        .map_err(|e| format!("还原失败：{e}"))?;
    // $I 元数据同步清理（数据已离桶）
    let _ = std::fs::remove_file(to_extended(&it.i_path));
    Ok(())
}

/// 永久删除一批 $R（文件/目录递归）。返回成功数与失败清单。
pub fn delete_permanent(r_paths: &[String]) -> RecycleOpResult {
    let mut ok = 0usize;
    let mut failed = Vec::new();
    for p in r_paths.iter().take(MAX_OPS) {
        let r = match std::fs::metadata(to_extended(p)) {
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(to_extended(p)),
            Ok(_) => std::fs::remove_file(to_extended(p)),
            Err(_) => Ok(()), // 已不存在 = 视为成功（幂等清空）
        };
        match r {
            Ok(()) => ok += 1,
            Err(e) => failed.push(FailItem {
                path: p.clone(),
                message: format!("删除失败：{e}"),
            }),
        }
    }
    RecycleOpResult { ok, failed }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_v2_i_file() {
        // 真实 Win10+ $I（trash crate / 资源管理器实删样本一致）：
        // header u64=2 → size u64 → filetime u64 → u32 名长（含 NUL）→ 名字
        let name = r"C:\Users\PRIME\AppData\Local\Temp\x\blat.txt";
        let mut b = Vec::new();
        b.extend_from_slice(&2u64.to_le_bytes());
        b.extend_from_slice(&4u64.to_le_bytes());
        b.extend_from_slice(&133_500_000_000_000_000u64.to_le_bytes());
        let w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        b.extend_from_slice(&(w.len() as u32).to_le_bytes());
        for c in &w {
            b.extend_from_slice(&c.to_le_bytes());
        }
        let (n, size, ms) = parse_i_file(&b).expect("v2 可解析");
        assert_eq!(n, name);
        assert_eq!(size, 4);
        assert_eq!(
            ms,
            (133_500_000_000_000_000u64 / 10_000) as i64 - 11_644_473_600_000
        );
    }

    #[test]
    fn parse_v1_i_file_fixed_name() {
        // Vista $I：header u64=2 → size → filetime → 定长 520 字节名。
        // 名字首两 wchar 拼成的 u32（"no" ≈ 0x6F6E）远超剩余容量 → 落 v1 分支
        let mut b = Vec::new();
        b.extend_from_slice(&2u64.to_le_bytes());
        b.extend_from_slice(&7u64.to_le_bytes());
        b.extend_from_slice(&0u64.to_le_bytes());
        let mut w: Vec<u16> = "notes.txt".encode_utf16().collect();
        w.resize(260, 0); // 定长槽，NUL 止
        for c in &w {
            b.extend_from_slice(&c.to_le_bytes());
        }
        let (n, size, _ms) = parse_i_file(&b).expect("v1 可解析");
        assert_eq!(n, "notes.txt");
        assert_eq!(size, 7);
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_i_file(&[]).is_none());
        assert!(parse_i_file(&[0u8; 24]).is_none()); // header 0
        // 未知魔数（u64 ≠ 2）
        let mut b = Vec::new();
        b.extend_from_slice(&9u64.to_le_bytes());
        b.extend_from_slice(&[0u8; 16]);
        assert!(parse_i_file(&b).is_none());
        // v2 名长谎报越界 → v1 槽也不足（总长 28 < 544）→ None
        let mut b2 = Vec::new();
        b2.extend_from_slice(&2u64.to_le_bytes());
        b2.extend_from_slice(&[0u8; 16]);
        b2.extend_from_slice(&9999u32.to_le_bytes());
        assert!(parse_i_file(&b2).is_none());
        // 名字空段（len=1 只含 NUL）→ v2 过滤 → v1 槽不足 → None
        let mut b3 = Vec::new();
        b3.extend_from_slice(&2u64.to_le_bytes());
        b3.extend_from_slice(&[0u8; 16]);
        b3.extend_from_slice(&1u32.to_le_bytes());
        b3.extend_from_slice(&0u16.to_le_bytes());
        assert!(parse_i_file(&b3).is_none());
    }

    #[test]
    fn filetime_epoch_math() {
        // 0 = 1601-01-01 → 负 Unix ms（约 -11644473600000）
        assert_eq!(filetime_to_unix_ms(0), -11_644_473_600_000);
        // 116444736000000000 ×100ns = 1970-01-01
        assert_eq!(filetime_to_unix_ms(116_444_736_000_000_000), 0);
    }
}
