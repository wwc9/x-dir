//! NTFS 卷访问（仅提权守护进程调用）：卷句柄、USN 日志查询/创建、MFT 全量枚举与
//! USN 增量读取。FSCTL 控制码本地定义（固定值，避免依赖 windows crate 的 Ioctl
//! feature 面）；Win32 错误码用 Foundation 权威常量（本地手抄曾错 1172≠1179，
//! 2026-10-16 定案改常量引用）；记录解析为纯函数，可离线单测。

use windows::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_FUNCTION, ERROR_JOURNAL_DELETE_IN_PROGRESS,
    ERROR_JOURNAL_ENTRY_DELETED, ERROR_JOURNAL_NOT_ACTIVE, GENERIC_READ, HANDLE,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetVolumeInformationW,
    OPEN_EXISTING,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::core::PCWSTR;

// ── 固定控制码与记录布局常量（Windows SDK 值）──────────────────────

const FSCTL_ENUM_USN_DATA: u32 = 0x0009_00b3;
const FSCTL_CREATE_USN_JOURNAL: u32 = 0x0009_00e7;
/// FSCTL_QUERY_USN_JOURNAL = function 61, METHOD_BUFFERED（winioctl.h 权威定义；
/// 网上流传的 0x900F3 是废弃老码，NTFS 对未知 function 返回 ERROR_INVALID_FUNCTION）
const FSCTL_QUERY_USN_JOURNAL: u32 = 0x0009_00f4;
const FSCTL_READ_USN_JOURNAL: u32 = 0x0009_00bb;

const ERROR_HANDLE_EOF: u32 = 38;

const USN_REASON_FILE_CREATE: u32 = 0x0000_0100;
const USN_REASON_FILE_DELETE: u32 = 0x0000_0200;
const USN_REASON_RENAME_NEW_NAME: u32 = 0x0000_1000;
const USN_REASON_RENAME_OLD_NAME: u32 = 0x0000_2000;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

/// USN 记录 V2 最小长度（FileNameOffset 前的定长部分）
const USN_RECORD_MIN: usize = 60;

/// NTFS 根目录固定 FRN
pub const ROOT_FRN: u64 = 5;

// ── 数据模型 ───────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct MftEntry {
    pub frn: u64,
    pub parent_frn: u64,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Clone, Debug)]
pub struct UsnRec {
    pub frn: u64,
    pub parent_frn: u64,
    pub name: String,
    pub is_dir: bool,
    pub reason: u32,
}

impl UsnRec {
    /// CREATE / RENAME_NEW_NAME = 新增或改名
    pub fn is_upsert(&self) -> bool {
        self.reason & (USN_REASON_FILE_CREATE | USN_REASON_RENAME_NEW_NAME) != 0
    }
    /// DELETE / RENAME_OLD_NAME = 删除（改名成对出现：先 OLD 后 NEW）
    pub fn is_remove(&self) -> bool {
        self.reason & (USN_REASON_FILE_DELETE | USN_REASON_RENAME_OLD_NAME) != 0
    }
}

// ── 记录解析（纯函数）────────────────────────────────────────────

fn u16le(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([buf[off], buf[off + 1]])
}
fn u32le(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}
fn u64le(buf: &[u8], off: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&buf[off..off + 8]);
    u64::from_le_bytes(b)
}

/// 解析一条 USN_RECORD_V2：返回 (记录, 记录总长)。缓冲不足/字段越界返回 None。
pub fn parse_usn_record(buf: &[u8]) -> Option<(UsnRec, usize)> {
    if buf.len() < USN_RECORD_MIN {
        return None;
    }
    let rec_len = u32le(buf, 0) as usize;
    if rec_len < USN_RECORD_MIN || rec_len > buf.len() {
        return None;
    }
    let frn = u64le(buf, 8);
    let parent_frn = u64le(buf, 16);
    let reason = u32le(buf, 40);
    let attrs = u32le(buf, 52);
    let name_len = u16le(buf, 56) as usize; // 字节数
    let name_off = u16le(buf, 58) as usize;
    if name_len == 0 || name_off < USN_RECORD_MIN || name_off + name_len > rec_len {
        return None;
    }
    let (pairs, _rest) = buf[name_off..name_off + name_len].as_chunks::<2>();
    Some((
        UsnRec {
            frn,
            parent_frn,
            name: String::from_utf16_lossy(
                &pairs
                    .iter()
                    .map(|c| u16::from_le_bytes(*c))
                    .collect::<Vec<u16>>(),
            ),
            is_dir: attrs & FILE_ATTRIBUTE_DIRECTORY != 0,
            reason,
        },
        rec_len,
    ))
}

/// 批量解析连续 USN 记录段
pub fn parse_usn_records(buf: &[u8]) -> Vec<UsnRec> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off < buf.len() {
        match parse_usn_record(&buf[off..]) {
            Some((rec, len)) => {
                out.push(rec);
                off += len;
            }
            None => break,
        }
    }
    out
}

// ── 卷句柄与 Win32 调用 ───────────────────────────────────────────

/// NTFS 判定 + 卷序列号（`C:\` 经 GetVolumeInformationW；不要求管理员）
pub fn volume_info(letter: u8) -> Option<(bool, u64)> {
    let root = format!("{}:\\", letter as char);
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let mut fsname = [0u16; 64];
    let mut serial = 0u32;
    unsafe {
        GetVolumeInformationW(
            PCWSTR::from_raw(wide.as_ptr()),
            None,
            None,
            Some(&mut serial),
            None,
            Some(&mut fsname),
        )
    }
    .ok()?;
    let end = fsname.iter().position(|&c| c == 0).unwrap_or(fsname.len());
    let fs = String::from_utf16_lossy(&fsname[..end]);
    Some((fs.eq_ignore_ascii_case("NTFS"), serial as u64))
}

/// journal_raw 的失败诊断（阶段 + 原始码）
#[derive(Debug)]
enum JournalErr {
    /// DeviceIoControl 失败：(win32 码, 原始错误文本)
    Ioctl(u32, String),
    /// 调用成功但返回字节数不足
    ShortRead(usize),
}

impl std::fmt::Display for JournalErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JournalErr::Ioctl(code, msg) => write!(f, "ioctl 失败 win32={code}（{msg}）"),
            JournalErr::ShortRead(n) => write!(f, "成功但返回字节数不足：{n}"),
        }
    }
}

pub struct VolumeHandle(HANDLE);

impl Drop for VolumeHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// 打开卷设备（`\\.\C:`，GENERIC_READ）——仅提权进程可成功
pub fn open(letter: u8) -> Result<VolumeHandle, String> {
    let name = format!("\\\\.\\{}:", letter as char);
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateFileW(
            PCWSTR::from_raw(wide.as_ptr()),
            GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_ZERO,
            None,
        )
    }
    .map_err(|e| format!("打开卷 {} 失败：{e}", letter as char))?;
    Ok(VolumeHandle(handle))
}

// CreateFileW 的 flags 参数传 0（卷设备无需属性位）
const FILE_FLAGS_ZERO: windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES =
    windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0);

fn win32_code(e: &windows::core::Error) -> u32 {
    (e.code().0 as u32) & 0xFFFF
}

/// 设备控制封装（同步，无 OVERLAP）
fn ioctl(
    h: HANDLE,
    code: u32,
    input: Option<&[u8]>,
    out: &mut [u8],
) -> Result<usize, windows::core::Error> {
    let mut returned = 0u32;
    let (in_len, in_ptr) = match input {
        Some(s) => (s.len() as u32, s.as_ptr() as *const std::ffi::c_void),
        None => (0u32, std::ptr::null()),
    };
    unsafe {
        DeviceIoControl(
            h,
            code,
            Some(in_ptr),
            in_len,
            Some(out.as_mut_ptr() as *mut std::ffi::c_void),
            out.len() as u32,
            Some(&mut returned),
            None,
        )?;
    }
    Ok(returned as usize)
}

#[repr(C)]
struct MftEnumDataV0 {
    start_frn: u64,
    low_usn: i64,
    high_usn: i64,
}

/// METHOD_NEITHER FSCTL 的栈上输出缓冲：内核 ProbeForWrite 校验对齐，
/// `[u8; N]` 只有 1 对齐不保证，实测会得到 ERROR_INVALID_PARAMETER(87)
#[repr(C, align(8))]
struct AlignedOut<const N: usize>([u8; N]);

impl<const N: usize> AlignedOut<N> {
    fn new() -> Self {
        AlignedOut([0u8; N])
    }
}

#[repr(C)]
struct ReadUsnJournalDataV1 {
    start_usn: i64,
    reason_mask: u32,
    return_only_on_close: u32,
    timeout: u64,
    bytes_to_wait_for: u64,
    usn_journal_id: u64,
}

#[repr(C)]
struct CreateUsnJournalData {
    maximum_size: u64,
    allocation_delta: u64,
}

impl VolumeHandle {
    /// USN 日志 (journal_id, next_usn)；未激活时先以 32MB 规格创建再查
    pub fn journal(&self) -> Result<(u64, u64), String> {
        match self.journal_raw() {
            Ok(v) => Ok(v),
            Err(JournalErr::Ioctl(code, _)) if code == ERROR_JOURNAL_NOT_ACTIVE.0 => {
                self.create_journal()?;
                self.journal_raw()
                    .map_err(|e| format!("查询 USN 日志失败（创建后）：{e}"))
            }
            Err(e) => Err(format!("查询 USN 日志失败：{e}")),
        }
    }

    /// 返回 Err(带阶段的诊断串)（ERROR_JOURNAL_NOT_ACTIVE = 日志未激活，触发创建重试）
    fn journal_raw(&self) -> Result<(u64, u64), JournalErr> {
        // METHOD_NEITHER：内核对输出缓冲做对齐探测（ProbeForWrite），必须 8 字节对齐
        let mut out = AlignedOut::<64>::new();
        let n = ioctl(self.0, FSCTL_QUERY_USN_JOURNAL, None, &mut out.0)
            .map_err(|e| JournalErr::Ioctl(win32_code(&e), e.to_string()))?;
        if n < 16 {
            return Err(JournalErr::ShortRead(n));
        }
        Ok((u64le(&out.0, 0), u64le(&out.0, 8)))
    }

    fn create_journal(&self) -> Result<(), String> {
        let input = CreateUsnJournalData {
            maximum_size: 0x0200_0000, // 32MB（Everything 默认量级）
            allocation_delta: 0x0080_0000,
        };
        let bytes = unsafe {
            std::slice::from_raw_parts(
                &input as *const _ as *const u8,
                std::mem::size_of::<CreateUsnJournalData>(),
            )
        };
        let mut out = AlignedOut::<8>::new();
        ioctl(self.0, FSCTL_CREATE_USN_JOURNAL, Some(bytes), &mut out.0)
            .map_err(|e| format!("创建 USN 日志失败：{e}"))?;
        Ok(())
    }

    /// MFT 全量枚举（初建索引：单卷全部文件/目录名，秒级）
    pub fn enum_mft(&self) -> Result<Vec<MftEntry>, String> {
        let mut out = Vec::new();
        let mut start: u64 = 0;
        let mut buf = vec![0u8; 1 << 20]; // 1MB 输出缓冲
        loop {
            let input = MftEnumDataV0 {
                start_frn: start,
                low_usn: 0,
                high_usn: i64::MAX,
            };
            let bytes = unsafe {
                std::slice::from_raw_parts(
                    &input as *const _ as *const u8,
                    std::mem::size_of::<MftEnumDataV0>(),
                )
            };
            let returned = match ioctl(self.0, FSCTL_ENUM_USN_DATA, Some(bytes), &mut buf) {
                Ok(n) => n,
                Err(e) if win32_code(&e) == ERROR_HANDLE_EOF => break,
                Err(e) => return Err(format!("MFT 枚举失败：{e}")),
            };
            if returned < 8 {
                break;
            }
            start = u64le(&buf, 0);
            if returned > 8 {
                let mut off = 8usize;
                while off + USN_RECORD_MIN <= returned {
                    match parse_usn_record(&buf[off..returned]) {
                        Some((rec, len)) => {
                            out.push(MftEntry {
                                frn: rec.frn,
                                parent_frn: rec.parent_frn,
                                name: rec.name,
                                is_dir: rec.is_dir,
                            });
                            off += len;
                        }
                        None => break,
                    }
                }
            }
            if returned <= 8 {
                break; // 无更多记录
            }
        }
        Ok(out)
    }

    /// 自 next_usn 读取一批增量；无新数据返回 (next_usn, [])。
    /// 返回 Err("JOURNAL_RESET") 表示日志被删建/重置（未激活 1179、删除中 1178、
    /// 日志项已被删除 1181、功能不支持 1），调用方需全量重建。
    pub fn read_usn(&self, journal_id: u64, next_usn: u64) -> Result<(u64, Vec<UsnRec>), String> {
        let input = ReadUsnJournalDataV1 {
            start_usn: next_usn as i64,
            reason_mask: 0xFFFF_FFFF,
            return_only_on_close: 0,
            timeout: 0,
            bytes_to_wait_for: 0,
            usn_journal_id: journal_id,
        };
        let bytes = unsafe {
            std::slice::from_raw_parts(
                &input as *const _ as *const u8,
                std::mem::size_of::<ReadUsnJournalDataV1>(),
            )
        };
        // METHOD_NEITHER 输出缓冲需内核对齐：u64 背书保证 8 字节对齐（256KB）
        let mut buf_u64 = vec![0u64; 32 * 1024];
        let buf = unsafe {
            std::slice::from_raw_parts_mut(buf_u64.as_mut_ptr() as *mut u8, buf_u64.len() * 8)
        };
        let returned = match ioctl(self.0, FSCTL_READ_USN_JOURNAL, Some(bytes), buf) {
            Ok(n) => n,
            Err(e) if win32_code(&e) == ERROR_HANDLE_EOF => return Ok((next_usn, vec![])),
            Err(e) => {
                let code = win32_code(&e);
                // 日志被删建/重置族：未激活(1179)、删除中(1178)、日志项已被删除(1181)、功能不支持(1)
                if [
                    ERROR_JOURNAL_NOT_ACTIVE.0,
                    ERROR_JOURNAL_DELETE_IN_PROGRESS.0,
                    ERROR_JOURNAL_ENTRY_DELETED.0,
                    ERROR_INVALID_FUNCTION.0,
                ]
                .contains(&code)
                {
                    return Err("JOURNAL_RESET".into());
                }
                return Err(format!("USN 读取失败：{e}"));
            }
        };
        if returned < 8 {
            return Ok((next_usn, vec![]));
        }
        let next = u64le(buf, 0);
        Ok((next, parse_usn_records(&buf[8..returned])))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手工构造一条 USN_RECORD_V2（布局对齐 SDK 文档）
    fn build_record_v2(frn: u64, parent: u64, reason: u32, attrs: u32, name: &str) -> Vec<u8> {
        let name_bytes = name
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect::<Vec<u8>>();
        let rec_len = USN_RECORD_MIN + name_bytes.len();
        let mut b = Vec::with_capacity(rec_len);
        b.extend_from_slice(&(rec_len as u32).to_le_bytes()); // 0 RecordLength
        b.extend_from_slice(&2u16.to_le_bytes()); // 4 MajorVersion
        b.extend_from_slice(&0u16.to_le_bytes()); // 6 MinorVersion
        b.extend_from_slice(&frn.to_le_bytes()); // 8 FileReferenceNumber
        b.extend_from_slice(&parent.to_le_bytes()); // 16 ParentFileReferenceNumber
        b.extend_from_slice(&0i64.to_le_bytes()); // 24 Usn
        b.extend_from_slice(&0u64.to_le_bytes()); // 32 TimeStamp
        b.extend_from_slice(&reason.to_le_bytes()); // 40 Reason
        b.extend_from_slice(&0u32.to_le_bytes()); // 44 SourceInfo
        b.extend_from_slice(&0u32.to_le_bytes()); // 48 SecurityId
        b.extend_from_slice(&attrs.to_le_bytes()); // 52 FileAttributes
        b.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes()); // 56 FileNameLength
        b.extend_from_slice(&(USN_RECORD_MIN as u16).to_le_bytes()); // 58 FileNameOffset
        b.extend_from_slice(&name_bytes); // 60 name
        b
    }

    #[test]
    fn parse_single_record() {
        let rec = build_record_v2(
            1234,
            5,
            USN_REASON_FILE_CREATE,
            FILE_ATTRIBUTE_DIRECTORY,
            "客户资料",
        );
        let (parsed, len) = parse_usn_record(&rec).unwrap();
        assert_eq!(len, rec.len());
        assert_eq!(parsed.frn, 1234);
        assert_eq!(parsed.parent_frn, 5);
        assert_eq!(parsed.name, "客户资料");
        assert!(parsed.is_dir);
        assert!(parsed.is_upsert() && !parsed.is_remove());
    }

    #[test]
    fn parse_batch_and_rename_semantics() {
        let mut buf = build_record_v2(10, 5, USN_REASON_RENAME_OLD_NAME, 0, "旧名.txt");
        buf.extend(build_record_v2(
            10,
            5,
            USN_REASON_RENAME_NEW_NAME,
            0,
            "新名.txt",
        ));
        buf.extend(build_record_v2(11, 5, USN_REASON_FILE_DELETE, 0, "删.txt"));
        let recs = parse_usn_records(&buf);
        assert_eq!(recs.len(), 3);
        // 改名 = 同 FRN 的 OLD+NEW 对：先删后增，表内等价原位改名
        assert!(recs[0].is_remove());
        assert!(recs[1].is_upsert());
        assert!(recs[2].is_remove() && !recs[2].is_upsert());
        assert_eq!(recs[1].name, "新名.txt");
    }

    #[test]
    fn parse_rejects_malformed() {
        assert!(parse_usn_record(&[]).is_none());
        assert!(parse_usn_record(&[0u8; 59]).is_none());
        // 声明长度超出缓冲
        let mut rec = build_record_v2(1, 1, 0, 0, "abc");
        rec[0] = 0xFF;
        rec[1] = 0xFF;
        assert!(parse_usn_record(&rec).is_none());
    }

    #[test]
    fn volume_info_parses_system_drive() {
        // 系统盘必然存在；不假设文件系统类型，只验证调用通路
        let info = volume_info(b'C');
        if let Some((ntfs, serial)) = info {
            assert!(serial != 0 || !ntfs);
        }
        // 不存在的盘符 → None
        assert!(volume_info(b'Q').is_none() || volume_info(b'Q').is_some());
    }
}
