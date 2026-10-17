//! 提权索引守护（`--index-daemon`）：加载/初建各 NTFS 固定盘名表 → 持续读 USN 增量
//! → 30s 脏保存。与主程序**纯文件通信**（免服务、免注册表、免端口）：
//! - `daemon.json`   启用卷清单（主程序写入）
//! - `status.json`   状态回执（守护进程每秒写，主程序读）
//! - `daemon.heartbeat` 每秒心跳 = 存活信号（主程序按 mtime 判定）
//! - `daemon.stop`   停止请求（主程序写入，守护进程轮询退出）

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::store::{self, VolumeMeta};
use super::table::NameTable;
use super::volume::{self, ROOT_FRN, VolumeHandle};

pub const HEARTBEAT_FILE: &str = "daemon.heartbeat";
pub const STOP_FILE: &str = "daemon.stop";
pub const DAEMON_JSON: &str = "daemon.json";
pub const STATUS_JSON: &str = "status.json";
/// 心跳超过该时长视为守护进程死亡
const ALIVE_WINDOW: Duration = Duration::from_secs(10);
/// 脏表落盘间隔
const SAVE_INTERVAL: Duration = Duration::from_secs(30);
/// USN 轮询间隔
const USN_POLL: Duration = Duration::from_millis(500);

pub fn index_dir() -> PathBuf {
    match CFG_ROOT.get() {
        Some(cfg) => cfg.join("index"),
        None => crate::config::config_root().join("index"),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 守护进程是否存活（心跳文件 mtime 新鲜）
pub fn daemon_alive() -> bool {
    let p = index_dir().join(HEARTBEAT_FILE);
    match std::fs::metadata(&p).and_then(|m| m.modified()) {
        Ok(t) => t.elapsed().map(|e| e < ALIVE_WINDOW).unwrap_or(false),
        Err(_) => false,
    }
}

/// 写入停止请求（普通权限即可，文件通信不要求特权）
pub fn request_stop() {
    let dir = index_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(STOP_FILE), b"stop");
}

/// 写入守护配置：启用卷清单（主程序 enable 时调用；默认 = 全部固定 NTFS 盘）
pub fn write_daemon_config(letters: &[u8]) -> std::io::Result<()> {
    let dir = index_dir();
    std::fs::create_dir_all(&dir)?;
    let vols: Vec<String> = letters.iter().map(|l| (*l as char).to_string()).collect();
    let doc = serde_json::json!({ "volumes": vols });
    let tmp = dir.join(format!("{DAEMON_JSON}.tmp"));
    std::fs::write(&tmp, serde_json::to_string(&doc).unwrap_or_default())?;
    std::fs::rename(&tmp, dir.join(DAEMON_JSON))
}

/// 读守护配置的启用卷清单（主程序引擎选择判定用）
pub fn read_daemon_config_public() -> Vec<u8> {
    read_daemon_config()
}

fn read_daemon_config() -> Vec<u8> {
    let p = index_dir().join(DAEMON_JSON);
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("volumes").and_then(|a| a.as_array()).map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .filter_map(|s| s.chars().next())
                    .filter_map(|c| c.is_ascii_uppercase().then_some(c as u8))
                    .collect::<Vec<u8>>()
            })
        })
        .unwrap_or_default()
}

/// 主程序 enable 入口：返回当前可索引的固定 NTFS 盘
pub fn indexable_volumes() -> Vec<u8> {
    crate::commands::drives::fixed_drive_roots()
        .into_iter()
        .filter_map(|root| root.chars().next())
        .filter(|c| c.is_ascii_uppercase())
        .map(|c| c as u8)
        .filter(|l| {
            volume::volume_info(*l)
                .map(|(ntfs, _)| ntfs)
                .unwrap_or(false)
        })
        .collect()
}

// ── 状态文档 ───────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct VolStatus {
    entries: usize,
    last_sync_ms: u64,
    error: Option<String>,
}

#[derive(Default)]
struct StatusDoc {
    volumes: std::collections::BTreeMap<u8, VolStatus>,
}

fn write_status(doc: &StatusDoc) {
    let vols: serde_json::Map<String, serde_json::Value> = doc
        .volumes
        .iter()
        .map(|(l, s)| {
            (
                (*l as char).to_string(),
                serde_json::json!({
                    "entries": s.entries,
                    "lastSyncMs": s.last_sync_ms,
                    "error": s.error,
                }),
            )
        })
        .collect();
    let doc = serde_json::json!({
        "pid": std::process::id(),
        "startedAtMs": now_ms(),
        "volumes": vols,
    });
    let dir = index_dir();
    let tmp = dir.join(format!("{STATUS_JSON}.tmp"));
    if std::fs::write(&tmp, serde_json::to_string(&doc).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join(STATUS_JSON));
    }
}

/// 主程序读取状态回执（None = 无有效状态）
pub fn read_status() -> Option<serde_json::Value> {
    let s = std::fs::read_to_string(index_dir().join(STATUS_JSON)).ok()?;
    serde_json::from_str(&s).ok()
}

// ── 卷工作器 ───────────────────────────────────────────────────────

struct VolumeState {
    letter: u8,
    table: NameTable,
    journal_id: u64,
    next_usn: u64,
    serial: u64,
    dirty: bool,
    last_saved_ms: u64,
    error: Option<String>,
}

impl VolumeState {
    fn save(&mut self) {
        if !self.dirty {
            return;
        }
        let meta = VolumeMeta {
            volume_serial: self.serial,
            journal_id: self.journal_id,
            next_usn: self.next_usn,
        };
        match store::save(&index_dir(), self.letter, &self.table, meta) {
            Ok(()) => {
                self.dirty = false;
                self.last_saved_ms = now_ms();
            }
            Err(e) => eprintln!("[x-dir-daemon] 保存 {} 索引失败：{e}", self.letter as char),
        }
    }
}

/// 初建或续载一张名表；返回 (表, journal_id, next_usn)
fn load_or_build(
    letter: u8,
    serial: u64,
    vol: &VolumeHandle,
) -> Result<(NameTable, u64, u64), String> {
    let dir = index_dir();
    // 1) 续载：卷序列一致才可信
    if let Ok(view) = store::IndexView::open(&store::index_path(&dir, letter))
        && view.header.volume_serial == serial
    {
        let stored_id = view.header.journal_id;
        let stored_next = view.header.next_usn;
        // 2) 日志仍连续 → 直接续跑增量
        match vol.journal() {
            Ok((live_id, _)) if live_id == stored_id => {
                let table = NameTable::from_parts(
                    view.entries().to_vec(),
                    view.names().to_vec(),
                    view.lower().to_vec(),
                    view.initials().to_vec(),
                    view.header.root_frn,
                );
                eprintln!("[x-dir-daemon] {} 续载 {} 条", letter as char, table.len());
                return Ok((table, stored_id, stored_next));
            }
            _ => eprintln!("[x-dir-daemon] {} USN 日志变更，全量重建", letter as char),
        }
    }
    // 3) 全量重建：MFT 枚举（秒级）+ 日志位点
    let entries = vol.enum_mft()?;
    let (journal_id, next_usn) = vol.journal()?;
    let mut table = NameTable::new(ROOT_FRN);
    for e in entries {
        table.upsert(e.frn, e.parent_frn, &e.name, e.is_dir);
    }
    eprintln!("[x-dir-daemon] {} 初建 {} 条", letter as char, table.len());
    Ok((table, journal_id, next_usn))
}

fn apply_usn(table: &mut NameTable, recs: &[volume::UsnRec]) -> bool {
    let mut dirty = false;
    for rec in recs {
        // 改名成对出现（OLD → NEW）：先删后增，表内等价原位改名
        if rec.is_remove() {
            table.remove(rec.frn);
            dirty = true;
        }
        if rec.is_upsert() {
            table.upsert(rec.frn, rec.parent_frn, &rec.name, rec.is_dir);
            dirty = true;
        }
    }
    dirty
}

fn run_volume(
    letter: u8,
    status: Arc<Mutex<StatusDoc>>,
    stop: Arc<AtomicBool>,
) -> Option<VolumeState> {
    let (ntfs, serial) = match volume::volume_info(letter) {
        Some(v) => v,
        None => {
            set_err(&status, letter, "卷不可用");
            return None;
        }
    };
    if !ntfs {
        set_err(&status, letter, "非 NTFS 卷不支持索引");
        return None;
    }
    let vol = match volume::open(letter) {
        Ok(v) => v,
        Err(e) => {
            set_err(&status, letter, &e);
            return None;
        }
    };
    let (table, mut journal_id, mut next_usn) = match load_or_build(letter, serial, &vol) {
        Ok(v) => v,
        Err(e) => {
            set_err(&status, letter, &e);
            return None;
        }
    };
    let mut state = VolumeState {
        letter,
        table,
        journal_id,
        next_usn,
        serial,
        dirty: true, // 初建/续载后先落一次盘
        last_saved_ms: 0,
        error: None,
    };
    let mut last_sync = now_ms();
    loop {
        if stop.load(Ordering::Relaxed) {
            state.save();
            return Some(state);
        }
        match vol.read_usn(journal_id, next_usn) {
            Ok((next, recs)) => {
                if apply_usn(&mut state.table, &recs) {
                    state.dirty = true;
                }
                next_usn = next;
                state.next_usn = next;
                last_sync = now_ms();
                state.journal_id = journal_id;
            }
            Err(e) if e == "JOURNAL_RESET" => {
                // 日志被删建：全量重建后继续
                match load_or_build(letter, serial, &vol) {
                    Ok((t, id, n)) => {
                        state.table = t;
                        journal_id = id;
                        next_usn = n;
                        state.journal_id = id;
                        state.next_usn = n;
                        state.dirty = true;
                    }
                    Err(e) => {
                        set_err(&status, letter, &e);
                        return Some(state);
                    }
                }
            }
            Err(e) => {
                set_err(&status, letter, &e);
                return Some(state);
            }
        }
        // 脏表定期落盘（含初建/续载后的首次保存）
        if state.dirty
            && now_ms().saturating_sub(state.last_saved_ms) >= SAVE_INTERVAL.as_millis() as u64
        {
            state.save();
        }
        let mut st = status.lock().unwrap();
        st.volumes.insert(
            letter,
            VolStatus {
                entries: state.table.len(),
                last_sync_ms: last_sync,
                error: state.error.clone(),
            },
        );
        drop(st);
        if stop.load(Ordering::Relaxed) {
            state.save();
            return Some(state);
        }
        std::thread::sleep(USN_POLL);
    }
}

fn set_err(status: &Mutex<StatusDoc>, letter: u8, msg: &str) {
    eprintln!("[x-dir-daemon] {}: {msg}", letter as char);
    let mut st = status.lock().unwrap();
    st.volumes.insert(
        letter,
        VolStatus {
            entries: 0,
            last_sync_ms: 0,
            error: Some(msg.to_string()),
        },
    );
}

/// 守护进程的配置根：主程序经 `--index-daemon <config_root>` 显式传入。
/// 守护 exe 是主程序的副本（避免常驻锁死 target 产物），exe 旁推导会指错位置。
static CFG_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// 守护进程主循环（不返回）
pub fn run() -> ! {
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--index-daemon")
        && let Some(cfg) = args.get(pos + 1)
    {
        let _ = CFG_ROOT.set(PathBuf::from(cfg));
    }
    // 单例护栏：心跳存活 = 已有守护在跑，静默退出（重复实例会互相覆盖索引文件）
    if daemon_alive() {
        eprintln!("[x-dir-daemon] 已有实例运行，退出");
        std::process::exit(0);
    }
    let dir = index_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::remove_file(dir.join(STOP_FILE));
    let letters = {
        let cfg = read_daemon_config();
        if cfg.is_empty() {
            indexable_volumes()
        } else {
            cfg
        }
    };
    eprintln!(
        "[x-dir-daemon] 启动，pid={}，卷={}",
        std::process::id(),
        letters.iter().map(|l| *l as char).collect::<String>()
    );
    let status = Arc::new(Mutex::new(StatusDoc::default()));
    let stop = Arc::new(AtomicBool::new(false));

    // 心跳 + 停止检测线程
    {
        let status = status.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            loop {
                let _ = std::fs::write(index_dir().join(HEARTBEAT_FILE), now_ms().to_string());
                if index_dir().join(STOP_FILE).exists() {
                    stop.store(true, Ordering::Relaxed);
                    // 等卷线程收尾保存
                    std::thread::sleep(Duration::from_millis(500));
                    let st = status.lock().unwrap();
                    write_status(&st);
                    drop(st);
                    let _ = std::fs::remove_file(index_dir().join(HEARTBEAT_FILE));
                    let _ = std::fs::remove_file(index_dir().join(STOP_FILE));
                    eprintln!("[x-dir-daemon] 收到停止请求，退出");
                    std::process::exit(0);
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    }

    // 状态回执写线程（主程序每秒可见卷级进度与错误）
    {
        let status = status.clone();
        std::thread::spawn(move || {
            loop {
                let st = status.lock().unwrap();
                write_status(&st);
                drop(st);
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    }

    // 卷线程：终止后回收状态做最终保存
    let states: Arc<Mutex<Vec<VolumeState>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for letter in letters {
        let status = status.clone();
        let stop = stop.clone();
        let states = states.clone();
        handles.push(std::thread::spawn(move || {
            if let Some(s) = run_volume(letter, status, stop) {
                states.lock().unwrap().push(s);
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
    // 兜底保存（正常停止已在 run_volume 内保存过，此处幂等）；
    // 全卷失败等致命场景也要落一次状态回执，主程序据此展示错误
    for s in states.lock().unwrap().iter_mut() {
        s.save();
    }
    write_status(&status.lock().unwrap());
    let _ = std::fs::remove_file(index_dir().join(HEARTBEAT_FILE));
    eprintln!("[x-dir-daemon] 退出");
    std::process::exit(0);
}
