//! 解除占用（2026-11-01）：找出占用目标文件的进程，并可远程关闭这些句柄。
//! Windows 没有"谁开着这个文件"的官方 API——handle.exe / Unlocker 同款做法：
//! NtQuerySystemInformation(SystemExtendedHandleInformation) 枚举全系统句柄表，
//! 逐个 DuplicateHandle 到本进程后按 FileIndex（卷序列号 + 文件索引，同一文件
//! 的所有打开句柄同值）比对，免路径归一化；释放 = DUPLICATE_CLOSE_SOURCE 远程关闭。

use serde::Serialize;

/// 占用进程（pid + 进程名）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LockingProcess {
    pub pid: u32,
    /// 进程映像名（如 WINWORD.EXE）；取不到时为 "PID <pid>"
    pub name: String,
}

/// 单个路径的占用进程清单（顺序与查询入参一致）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileLocks {
    pub path: String,
    pub lockers: Vec<LockingProcess>,
    /// true = 扫描超时被截断（病态句柄卡死枚举），结果可能不全
    pub truncated: bool,
}

/// 解除占用结果：closed = 已远程关闭的句柄数；remaining = 仍占用的进程
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseLocksResult {
    pub closed: u32,
    pub remaining: Vec<LockingProcess>,
    /// true = 关闭前的扫描超时被截断，可能仍有未关到的占用句柄
    pub truncated: bool,
}

/// 查询一批路径的占用进程（排除本应用自身：自身句柄不可远程关闭——
/// 关了会让运行中的内部状态悬空，归因也不该指向自己）
#[cfg(windows)]
pub fn find_locks(paths: &[String]) -> Vec<FileLocks> {
    let self_pid = std::process::id();
    paths
        .iter()
        .map(|p| {
            let (lockers, truncated) = imp::lockers_of(p, self_pid);
            FileLocks {
                path: p.clone(),
                lockers,
                truncated,
            }
        })
        .collect()
}

/// 远程关闭指向 path 的全部句柄（占用者收到句柄失效，可能丢失未保存内容——
/// 由前端对话框明确告知后再调用）
#[cfg(windows)]
pub fn release_locks(path: &str) -> ReleaseLocksResult {
    imp::release_core(path, std::process::id())
}

#[cfg(not(windows))]
pub fn find_locks(paths: &[String]) -> Vec<FileLocks> {
    paths
        .iter()
        .map(|p| FileLocks {
            path: p.clone(),
            lockers: vec![],
            truncated: false,
        })
        .collect()
}

#[cfg(not(windows))]
pub fn release_locks(_path: &str) -> ReleaseLocksResult {
    ReleaseLocksResult {
        closed: 0,
        remaining: vec![],
        truncated: false,
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::{BTreeMap, HashMap, VecDeque};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    use super::{LockingProcess, ReleaseLocksResult};
    use crate::fs::path::to_extended;
    use windows::Wdk::System::SystemInformation::{
        NtQuerySystemInformation, SYSTEM_INFORMATION_CLASS,
    };
    use windows::Win32::Foundation::{
        CloseHandle, DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE,
        STATUS_INFO_LENGTH_MISMATCH,
    };
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK,
        GetFileInformationByHandle, GetFileType, OPEN_EXISTING,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows::core::{PCWSTR, PWSTR};

    /// SystemExtendedHandleInformation（windows crate 未收录该枚举值）
    const SYSTEM_EXTENDED_HANDLE_INFORMATION: SYSTEM_INFORMATION_CLASS =
        SYSTEM_INFORMATION_CLASS(64);

    /// ntdll 未公开结构 SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX（x64 布局）
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub(super) struct HandleEntryEx {
        _object: *mut core::ffi::c_void,
        unique_process_id: usize,
        handle_value: usize,
        _granted_access: u32,
        _creator_back_trace_index: u16,
        object_type_index: u16,
        _handle_attributes: u32,
        _reserved: u32,
    }

    /// 文件身份：卷序列号 + 文件索引（同一文件的所有打开句柄同值）
    #[derive(Clone, Copy, PartialEq, Eq)]
    struct FileId {
        volume: u32,
        index: u64,
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// 全系统句柄表快照；INFO_LENGTH_MISMATCH 时按需求长度翻倍重查
    fn query_handle_table() -> Option<Vec<u8>> {
        let mut len = 1usize << 20; // 全系统句柄 10 万+，1MB 起步
        for _ in 0..8 {
            let mut buf = vec![0u8; len];
            let mut ret = 0u32;
            let st = unsafe {
                NtQuerySystemInformation(
                    SYSTEM_EXTENDED_HANDLE_INFORMATION,
                    buf.as_mut_ptr().cast(),
                    len as u32,
                    &mut ret,
                )
            };
            if st.is_ok() {
                buf.truncate(ret as usize);
                return Some(buf);
            }
            if st.0 != STATUS_INFO_LENGTH_MISMATCH.0 {
                return None;
            }
            len = (ret as usize).max(len * 2).min(1 << 27);
        }
        None
    }

    /// 表头（条目数 + 保留）各 8 字节，条目数组紧随；截断返回 None
    fn entries_of(buf: &[u8]) -> Option<&[HandleEntryEx]> {
        const HEADER: usize = 16;
        let stride = std::mem::size_of::<HandleEntryEx>();
        if buf.len() < HEADER {
            return None;
        }
        let n = usize::from_ne_bytes(buf[..8].try_into().ok()?);
        if (buf.len() - HEADER) / stride < n {
            return None;
        }
        Some(unsafe {
            std::slice::from_raw_parts(buf.as_ptr().add(HEADER) as *const HandleEntryEx, n)
        })
    }

    /// 只读属性方式打开（与占用锁兼容：READ_ATTRIBUTES 不属写访问，
    /// Word 的"拒绝写共享"挡不住它）；FILE_FLAG_BACKUP_SEMANTICS 使目录同样可开
    fn open_read_attributes(path: &str) -> Option<HANDLE> {
        let w = wide(&to_extended(path));
        let h = unsafe {
            CreateFileW(
                PCWSTR(w.as_ptr()),
                FILE_READ_ATTRIBUTES.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
        };
        h.ok()
    }

    fn file_id(h: HANDLE) -> Option<FileId> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(h, &mut info) }.is_err() {
            return None;
        }
        Some(FileId {
            volume: info.dwVolumeSerialNumber,
            index: (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64,
        })
    }

    /// 借探针句柄在句柄表里的自身条目取「文件」类型索引（免解析类型总表；
    /// 取不到时回落为不过滤，靠 FileId 比对兜底）
    fn find_type_index_of(buf: &[u8], probe: HANDLE) -> Option<u16> {
        let self_pid = std::process::id() as usize;
        for e in entries_of(buf)? {
            if e.unique_process_id == self_pid && e.handle_value == probe.0 as usize {
                return Some(e.object_type_index);
            }
        }
        None
    }

    fn open_for_dup(pid: u32) -> Option<HANDLE> {
        unsafe {
            OpenProcess(
                PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            )
            .ok()
        }
    }

    /// 把外部句柄复制进本进程（只为查询身份，查完即关）
    fn duplicate_into(src_proc: HANDLE, handle_value: usize) -> Option<HANDLE> {
        let mut dup = HANDLE::default();
        unsafe {
            DuplicateHandle(
                src_proc,
                HANDLE(handle_value as *mut _),
                GetCurrentProcess(),
                &mut dup,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
        }
        .ok()?;
        Some(dup)
    }

    /// 进程映像名；取不到（系统/提权进程）回落 "PID <pid>"
    pub(super) fn process_name(pid: u32) -> String {
        let Ok(h) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
            return format!("PID {pid}");
        };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let r = unsafe {
            QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
        };
        unsafe {
            let _ = CloseHandle(h);
        }
        if r.is_err() || len == 0 {
            return format!("PID {pid}");
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string()
    }

    /// 扫描预算：病态句柄（挂起的网络/设备句柄）单次查询可卡数十秒
    /// （2026-11-01 实测 33s），超预算即返回已得部分 + truncated 标记
    const SCAN_BUDGET: Duration = Duration::from_secs(5);

    enum ScanMsg {
        Match(u32, usize),
        Fin,
    }

    /// 扫描计划：目标 FileId + 「文件」类型索引 + 按进程分桶的句柄表
    pub(super) struct ScanPlan {
        id: FileId,
        _file_type: Option<u16>,
        /// pid → 句柄值列表（已排除 exclude_pid 与非文件类型）
        pub(super) by_pid: BTreeMap<u32, Vec<usize>>,
    }

    pub(super) fn build_plan(path: &str, exclude_pid: u32) -> Option<ScanPlan> {
        // 探针必须在句柄表快照**之前**开：借它在快照里的自身条目取「文件」
        // 类型索引（先查表后开探针 = 探针不在快照内，类型过滤失效，退化成
        // 全量句柄逐一复制，秒级起步；2026-11-01 修复）
        let probe = open_read_attributes(path)?;
        let id = file_id(probe)?;
        let buf = query_handle_table()?;
        let entries = entries_of(buf.as_slice())?;
        let file_type = find_type_index_of(&buf, probe);
        unsafe {
            let _ = CloseHandle(probe);
        }
        let mut by_pid: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
        for e in entries {
            let pid = e.unique_process_id as u32;
            if pid == exclude_pid {
                continue;
            }
            if let Some(ft) = file_type
                && e.object_type_index != ft
            {
                continue;
            }
            by_pid.entry(pid).or_default().push(e.handle_value);
        }
        Some(ScanPlan {
            id,
            _file_type: file_type,
            by_pid,
        })
    }

    /// 单 worker：从共享队列逐 pid 消费，逐句柄复制 → GetFileType → FileId 比对。
    /// 只碰磁盘文件：对象类型 "File" 同样涵盖命名管道/设备，对挂着未决读的
    /// 同步管道查信息会永久阻塞（handle.exe 类工具的经典坑）；GetFileType
    /// 只读内核缓存的设备类型，非阻塞可安全先判
    /// 单 pid 扫描：返回该进程内指向目标的句柄值（worker 与单测共用的确定性原语）。
    /// 只碰磁盘文件：对象类型 "File" 同样涵盖命名管道/设备，对挂着未决读的
    /// 同步管道查信息会永久阻塞（handle.exe 类工具的经典坑）；GetFileType
    /// 只读内核缓存的设备类型，非阻塞可安全先判
    pub(super) fn scan_pid(plan: &ScanPlan, pid: u32) -> Vec<usize> {
        let mut out = Vec::new();
        let Some(hvs) = plan.by_pid.get(&pid) else {
            return out;
        };
        let Some(ph) = open_for_dup(pid) else {
            return out;
        };
        for &hv in hvs {
            let Some(dup) = duplicate_into(ph, hv) else {
                continue;
            };
            let matched =
                unsafe { GetFileType(dup) } == FILE_TYPE_DISK && file_id(dup) == Some(plan.id);
            unsafe {
                let _ = CloseHandle(dup);
            }
            if matched {
                out.push(hv);
            }
        }
        unsafe {
            let _ = CloseHandle(ph);
        }
        out
    }

    /// 单 worker：从共享队列逐 pid 消费 scan_pid；接收方按预算返回后见 stop 退出
    fn scan_worker(
        plan: Arc<ScanPlan>,
        queue: Arc<Mutex<VecDeque<u32>>>,
        stop: Arc<AtomicBool>,
        tx: mpsc::Sender<ScanMsg>,
    ) {
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let next = queue.lock().map(|mut q| q.pop_front()).unwrap_or(None);
            let Some(pid) = next else { break };
            for hv in scan_pid(&plan, pid) {
                if tx.send(ScanMsg::Match(pid, hv)).is_err() {
                    break; // 接收方已按预算返回，本 pid 剩余命中丢弃即可
                }
            }
        }
        let _ = tx.send(ScanMsg::Fin);
    }

    /// 并行扫描全系统句柄表，收集指向 path 的 (pid, 句柄值)；返回 (命中, 是否
    /// 超预算截断)。exclude_pid = 0 表示不排除（单测用：占用者恰是本进程）。
    /// 卡死的 worker 不 join：病态句柄上的 syscall 不可中断，主线程按预算先行
    /// 返回并置 stop 标志，worker 醒来后自行退出（有界泄漏，handle.exe 同款取舍）
    pub(super) fn scan_lockers(path: &str, exclude_pid: u32) -> (Vec<(u32, usize)>, bool) {
        let Some(plan) = build_plan(path, exclude_pid) else {
            return (vec![], false); // 无法建立身份（打不开/表查询失败）→ 无占用信息
        };
        let plan = Arc::new(plan);
        let queue = Arc::new(Mutex::new(
            plan.by_pid.keys().copied().collect::<VecDeque<u32>>(),
        ));
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<ScanMsg>();
        let n_workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(1, 8)
            .min(plan.by_pid.len().max(1));
        for _ in 0..n_workers {
            let plan = Arc::clone(&plan);
            let queue = Arc::clone(&queue);
            let stop = Arc::clone(&stop);
            let tx = tx.clone();
            std::thread::spawn(move || scan_worker(plan, queue, stop, tx));
        }
        drop(tx); // 主发送端丢弃后，worker 全部退出即 Disconnected
        let start = std::time::Instant::now();
        let mut matches = Vec::new();
        let mut fins = 0usize;
        let truncated = loop {
            let remain = SCAN_BUDGET.saturating_sub(start.elapsed());
            if remain.is_zero() {
                break true;
            }
            match rx.recv_timeout(remain) {
                Ok(ScanMsg::Match(pid, hv)) => matches.push((pid, hv)),
                Ok(ScanMsg::Fin) => {
                    fins += 1;
                    if fins == n_workers {
                        break false;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break true,
                Err(mpsc::RecvTimeoutError::Disconnected) => break fins != n_workers,
            }
        };
        if truncated {
            stop.store(true, Ordering::Relaxed);
        }
        (matches, truncated)
    }

    /// 诊断基准（bench 模块用）：完整扫描一个无占用文件的耗时分解
    #[cfg(all(test, windows))]
    pub(super) fn imp_bench_scan(path: &str) {
        let t0 = std::time::Instant::now();
        let probe = open_read_attributes(path).expect("probe");
        let t1 = std::time::Instant::now();
        let buf = query_handle_table().expect("table");
        let t2 = std::time::Instant::now();
        let entries = entries_of(buf.as_slice()).expect("entries");
        let ft = find_type_index_of(&buf, probe).expect("type index");
        unsafe {
            let _ = CloseHandle(probe);
        };
        let t3 = std::time::Instant::now();
        let mut typed = 0usize;
        let mut dup_ok = 0usize;
        let mut dup_fail = 0usize;
        let mut disk = 0usize;
        let mut gfi_n = 0u32;
        let mut gfi_total = std::time::Duration::ZERO;
        let mut slow_n = 0u32;
        let mut slow_total = std::time::Duration::ZERO;
        let mut slow_worst = std::time::Duration::ZERO;
        let mut procs: HashMap<u32, Option<HANDLE>> = HashMap::new();
        let mut open_fail: Vec<u32> = Vec::new();
        for e in entries {
            if e.object_type_index != ft {
                continue;
            }
            typed += 1;
            let pid = e.unique_process_id as u32;
            let ph = *procs.entry(pid).or_insert_with(|| {
                let r = open_for_dup(pid);
                if r.is_none() {
                    open_fail.push(pid);
                }
                r
            });
            let Some(ph) = ph else { continue };
            let Some(dup) = duplicate_into(ph, e.handle_value) else {
                dup_fail += 1;
                continue;
            };
            dup_ok += 1;
            if unsafe { GetFileType(dup) } == FILE_TYPE_DISK {
                disk += 1;
                let tg = std::time::Instant::now();
                let _ = file_id(dup);
                let d = tg.elapsed();
                gfi_total += d;
                gfi_n += 1;
                if d > std::time::Duration::from_millis(5) {
                    slow_n += 1;
                    slow_total += d;
                    if slow_worst.as_secs() < d.as_secs() {
                        slow_worst = d;
                    }
                }
            }
            unsafe {
                let _ = CloseHandle(dup);
            }
        }
        for ph in procs.into_values().flatten() {
            unsafe {
                let _ = CloseHandle(ph);
            }
        }
        let t4 = std::time::Instant::now();
        println!(
            "probe {:?} | table {:?} | parse {:?} | loop {:?}",
            t1 - t0,
            t2 - t1,
            t3 - t2,
            t4 - t3
        );
        println!(
            "typed(file) {typed}, dup_ok {dup_ok}, dup_fail {dup_fail}, disk {disk}, open_fail_pids {}",
            open_fail.len()
        );
        println!(
            "gfi {gfi_n} calls, total {:?}, avg {:?}",
            gfi_total,
            gfi_total / gfi_n.max(1)
        );
        println!(
            "slow(>5ms) {slow_n} calls, total {:?}, worst {:?}",
            slow_total, slow_worst
        );
    }

    /// 诊断基准（bench 模块用）：句柄表规模与 (pid, object) 去重对数
    #[cfg(all(test, windows))]
    pub(super) fn imp_bench_table() {
        let t0 = std::time::Instant::now();
        let buf = query_handle_table().expect("table");
        println!("query: {:?}, {} bytes", t0.elapsed(), buf.len());
        let entries = entries_of(buf.as_slice()).expect("entries");
        let mut uniq: HashMap<usize, std::collections::HashSet<usize>> = HashMap::new();
        let mut total_objects = 0usize;
        for e in entries {
            let s = uniq.entry(e.unique_process_id).or_default();
            if s.insert(e._object as usize) {
                total_objects += 1;
            }
        }
        println!("entries: {}", entries.len());
        println!(
            "pids: {}, unique(pid,object) pairs: {}",
            uniq.len(),
            total_objects
        );
    }

    pub(super) fn lockers_of(path: &str, exclude_pid: u32) -> (Vec<LockingProcess>, bool) {
        let (matches, truncated) = scan_lockers(path, exclude_pid);
        let mut seen: BTreeMap<u32, String> = BTreeMap::new();
        for (pid, _) in matches {
            seen.entry(pid).or_insert_with(|| process_name(pid));
        }
        (
            seen.into_iter()
                .map(|(pid, name)| LockingProcess { pid, name })
                .collect(),
            truncated,
        )
    }

    /// 远程关闭指向 path 的全部句柄（DUPLICATE_CLOSE_SOURCE）；关不掉的进程入 remaining
    /// 对已命中的 (pid, 句柄值) 逐个远程关闭（worker 与单测共用的确定性原语）；
    /// 关不掉的进程以名字入 remaining
    pub(super) fn close_matches(
        matches: &[(u32, usize)],
        remaining: &mut BTreeMap<u32, String>,
    ) -> u32 {
        let mut closed = 0u32;
        let mut procs: HashMap<u32, Option<HANDLE>> = HashMap::new();
        for &(pid, hv) in matches {
            let ph = *procs.entry(pid).or_insert_with(|| open_for_dup(pid));
            let Some(ph) = ph else {
                remaining.entry(pid).or_insert_with(|| process_name(pid));
                continue;
            };
            // 目标进程/句柄参数按文档传空：DUPLICATE_CLOSE_SOURCE 只关源句柄
            let ok = unsafe {
                DuplicateHandle(
                    ph,
                    HANDLE(hv as *mut _),
                    HANDLE(std::ptr::null_mut()),
                    std::ptr::null_mut(),
                    0,
                    false,
                    DUPLICATE_CLOSE_SOURCE,
                )
            }
            .is_ok();
            if ok {
                closed += 1;
            } else {
                remaining.entry(pid).or_insert_with(|| process_name(pid));
            }
        }
        for ph in procs.into_values().flatten() {
            unsafe {
                let _ = CloseHandle(ph);
            }
        }
        closed
    }

    /// 远程关闭指向 path 的全部句柄（DUPLICATE_CLOSE_SOURCE）；关不掉的进程入 remaining
    pub(super) fn release_core(path: &str, exclude_pid: u32) -> ReleaseLocksResult {
        let (matches, truncated) = scan_lockers(path, exclude_pid);
        let mut remaining: BTreeMap<u32, String> = BTreeMap::new();
        let closed = close_matches(&matches, &mut remaining);
        ReleaseLocksResult {
            closed,
            remaining: remaining
                .into_iter()
                .map(|(pid, name)| LockingProcess { pid, name })
                .collect(),
            truncated,
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;

    use super::ReleaseLocksResult;
    use std::collections::BTreeMap;

    use super::imp::{
        HandleEntryEx, build_plan, close_matches, lockers_of, process_name, release_core, scan_pid,
    };
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, OPEN_EXISTING,
    };
    use windows::core::PCWSTR;

    #[test]
    fn handle_entry_layout_x64() {
        // ntdll SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX 的 x64 布局（8+8+8+4+2+2+4+4）
        assert_eq!(std::mem::size_of::<HandleEntryEx>(), 40);
    }

    /// 端到端：本进程锁文件（Word 同款拒绝写共享）→ 扫描命中本进程 →
    /// 远程关闭句柄 → 文件立即可删（证明句柄真的被关掉了）
    #[test]
    fn finds_and_releases_locked_handle() {
        let tmp = std::env::temp_dir().join(format!("xdir-lock-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("occupied.doc");
        let mut w = std::fs::File::create(&f).unwrap();
        w.write_all(b"x").unwrap();
        w.sync_all().unwrap();
        drop(w);
        let path = f.to_str().unwrap().to_string();

        let wide: Vec<u16> = f.as_os_str().encode_wide().chain(Some(0)).collect();
        let h = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                GENERIC_READ.0,
                FILE_SHARE_READ, // 只许他人读 = 拒绝写/删（Word 同款锁法）
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .unwrap();

        // 全链路确定性验证（不走全系统并行扫描——本机存在病态句柄时预算截断
        // 会让调度型断言抖动）：分桶计划（含「文件」类型过滤验证）→ 单 pid
        // 扫描 → 远程关闭 → 文件立即可删
        let plan = build_plan(&path, 0).expect("扫描计划构建成功");
        let my = std::process::id();
        assert!(
            plan.by_pid.contains_key(&my),
            "自身句柄应进入文件类型分桶（类型索引探针生效）"
        );
        let hvs = scan_pid(&plan, my);
        assert_eq!(
            hvs.len(),
            1,
            "本进程恰持有一个指向目标的句柄: actual {hvs:?}"
        );
        // 进程名解析（lockers_of 的名字来源同源）；不在此断言全系统扫描命中
        // 自身——并行 worker 撞上病态句柄时按预算截断，调度型断言会抖动
        assert!(process_name(my).ends_with(".exe"));

        let mut remaining = BTreeMap::new();
        let closed = close_matches(&[(my, hvs[0])], &mut remaining);
        assert_eq!(closed, 1, "应关闭我们持有的锁句柄");
        assert!(remaining.is_empty(), "actual: {remaining:?}");

        // 句柄被远程关闭：不 CloseHandle(h)（已失效），文件此刻应可直接删除
        let _ = h;
        std::fs::remove_file(&f).expect("句柄已解除，删除应成功");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    /// 无占用文件：扫描空结果、释放零动作
    #[test]
    fn unlocked_file_has_no_lockers() {
        let tmp = std::env::temp_dir().join(format!("xdir-nolock-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("free.txt");
        std::fs::write(&f, b"x").unwrap();
        let path = f.to_str().unwrap().to_string();
        assert!(lockers_of(&path, 0).0.is_empty());
        let ReleaseLocksResult {
            closed,
            remaining,
            truncated: _,
        } = release_core(&path, 0);
        assert_eq!((closed, remaining.len()), (0, 0));
        std::fs::remove_file(&f).unwrap();
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}

#[cfg(all(test, windows))]
mod bench {
    use super::imp::{imp_bench_scan, imp_bench_table};

    /// 全系统句柄表规模基准（#[ignore]，诊断用：cargo test -- --ignored --nocapture）
    #[test]
    #[ignore]
    fn handle_table_size() {
        imp_bench_table();
    }

    #[test]
    #[ignore]
    fn scan_cost() {
        let tmp = std::env::temp_dir().join("xdir-bench.txt");
        std::fs::write(&tmp, b"x").unwrap();
        imp_bench_scan(tmp.to_str().unwrap());
        let _ = std::fs::remove_file(&tmp);
    }
}
