//! 递归搜索与路径建议（V2 §3.2 全局搜索 / 地址栏自动补全）+ 全盘搜索。
//! 遍历不跟随 reparse point（符号链接/junction，§6.11）；结果/访问量/耗时多重封顶，
//! 防超深/超大目录拖死 UI。匹配语义统一走 [`super::matcher`]（多词 AND/通配符/路径词）。
//!
//! 取消与流式：命令层以 reqId（搜索槽位号）注册取消标志——同槽新搜索自动作废旧搜索，
//! `cancel_search` 可显式取消；遍历过程经 [`BatchSink`] 节流回吐命中批次（~100ms）。

use pinyin::{PHONETIC_SYMBOL_MAP, PINYIN_MAP};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::entry::{FileEntry, dir_entry_to_file};
use super::matcher::{Query, TypeFilter};
use super::path::{join_name, to_extended};
use super::sort::{SortDir, SortKey, SortSpec, cmp_entries, natural_cmp};

/// 窗格搜索默认结果条数上限（前端可放宽）
pub const MAX_RESULTS: usize = 500;
/// 窗格搜索遍历条目上限（到达即截断；审计客户资料常超 30 万，放宽至 100 万）
const MAX_VISITED: usize = 1_000_000;
/// 补全时单目录最多扫描的条目数（read_dir 惰性，够用）
const SUGGEST_SCAN_CAP: usize = 5000;

/// 全盘搜索默认结果上限；遍历/耗时封顶（无索引时的兜底实现，秒搜走 index 模块）
pub const MAX_RESULTS_ALL: usize = 500;
const MAX_VISITED_ALL: usize = 4_000_000;
const SEARCH_ALL_DEADLINE: Duration = Duration::from_secs(30);
/// 全盘遍历不进入的系统目录（小写比较；"System Volume Information" 本身无权限，双保险）
const SKIP_DIRS: [&str; 2] = ["$recycle.bin", "system volume information"];

/// 流式批次节流间隔与单批条数上限
const BATCH_INTERVAL: Duration = Duration::from_millis(100);
const BATCH_MAX: usize = 256;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
    /// 实际遍历的条目数（状态条"已扫描"展示；索引通道无此语义恒 0）
    pub scanned: usize,
    /// 搜索耗时（毫秒，窗格状态条展示）
    pub elapsed_ms: u64,
    /// 服务引擎："index"（NTFS 索引）| "scan"（实时遍历）
    pub engine: &'static str,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchResult {
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
    /// 实际扫描的条目数（状态条展示进度用）
    pub scanned: usize,
    pub elapsed_ms: u64,
    /// 服务引擎："index"（NTFS 索引）| "scan"（实时遍历兜底）
    pub engine: &'static str,
    /// engine = "scan" 且索引模式已开启时的回退原因（守护未运行/索引过期等），透传前端展示
    pub fallback_reason: Option<String>,
}

// ── 取消注册表（reqId = 搜索槽位号）────────────────────────────────

static SEARCH_CANCELS: OnceLock<Mutex<HashMap<u64, std::sync::Arc<AtomicBool>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<u64, std::sync::Arc<AtomicBool>>> {
    SEARCH_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 以槽位号注册取消标志；同号重复注册自动顶掉旧标志（旧搜索随之可被取消）
pub fn register_search(req_id: u64) -> std::sync::Arc<AtomicBool> {
    let flag = std::sync::Arc::new(AtomicBool::new(false));
    registry().lock().unwrap().insert(req_id, flag.clone());
    flag
}

/// 请求取消该槽位正在进行的搜索（无进行中搜索时为无害空操作）
pub fn cancel_search(req_id: u64) {
    if let Some(f) = registry().lock().unwrap().get(&req_id) {
        f.store(true, Ordering::Relaxed);
    }
}

/// 搜索结束后摘除标志（仅当槽位仍归属本次注册，防误摘后继搜索）
pub fn unregister_search(req_id: u64, mine: &std::sync::Arc<AtomicBool>) {
    let mut m = registry().lock().unwrap();
    if m.get(&req_id)
        .is_some_and(|f| std::sync::Arc::ptr_eq(f, mine))
    {
        m.remove(&req_id);
    }
}

// ── 流式批次（节流回吐命中）────────────────────────────────────────

/// 遍历过程中把命中批次经回调推给前端；100ms 节流、单批 256 条封顶。
/// 回调由命令层提供（tauri emit），本层不依赖 tauri 类型（可单测）。
pub struct BatchSink<'a> {
    emit: &'a (dyn Fn(&[FileEntry], usize) + Sync),
    last: Instant,
    pending: Vec<FileEntry>,
}

impl<'a> BatchSink<'a> {
    pub fn new(emit: &'a (dyn Fn(&[FileEntry], usize) + Sync)) -> Self {
        Self {
            emit,
            last: Instant::now() - BATCH_INTERVAL, // 首批立即发出（体感延迟最低）
            pending: Vec::new(),
        }
    }

    pub fn push(&mut self, e: FileEntry, scanned: usize) {
        self.pending.push(e);
        if self.pending.len() >= BATCH_MAX || self.last.elapsed() >= BATCH_INTERVAL {
            self.flush(scanned);
        }
    }

    pub fn flush(&mut self, scanned: usize) {
        if self.pending.is_empty() {
            return;
        }
        (self.emit)(&self.pending, scanned);
        self.pending.clear();
        self.last = Instant::now();
    }
}

// ── 拼音匹配（matcher 模块的实现后端）────────────────────────────

/// 拼音包含匹配（多音字 DP）：名称每个汉字贡献其任一读音（initials_only 时取各读音
/// 首字母），非汉字贡献 ASCII 小写原字符；query 是任一拼接结果的子串即命中。
/// states 的 bit k = 当前字符边界处可延续出"以 query[..k] 结尾"的匹配，k=0 恒真
/// （子串可从任意位置重新开始）。查询 ≤63 字节走零分配位图快版（扫描热路径），
/// 更长回落 Vec 版本，两版语义逐位一致。
pub fn pinyin_contains_chars(
    name: impl Iterator<Item = char>,
    query: &str,
    initials_only: bool,
) -> bool {
    let q = query.as_bytes();
    if q.len() <= 63 {
        pinyin_contains_chars_fast(name, q, initials_only)
    } else {
        pinyin_contains_chars_vec(name, q, initials_only)
    }
}

/// 位图快版（语义同 Vec 版）：活跃前缀长度集存 u64，读音候选在栈上展开，
/// 无堆分配——索引扫描对掩码漏网条目逐条调用，分配开销曾占扫描耗时大头。
fn pinyin_contains_chars_fast(
    name: impl Iterator<Item = char>,
    q: &[u8],
    initials_only: bool,
) -> bool {
    let t = pinyin_tables();
    let qlen = q.len() as u32;
    let mut states: u64 = 1; // bit0 恒真
    let mut fallback_buf = [0u8; 8]; // 非汉字候选的复用栈缓冲（每次迭代覆写）
    for c in name {
        // 本字符候选读音：汉字查预编译平铺段（静态切片），非汉字回落 ASCII 小写
        let mut cands: [&[u8]; 8] = [&[]; 8];
        let mut n = 0usize;
        let cp = c as u32;
        let off = if (0x4E00..=0x9FFF).contains(&cp) {
            Some(cp as usize - 0x4E00)
        } else if (0x3400..=0x4DBF).contains(&cp) {
            Some(cp as usize - 0x3400 + (0x9FFF - 0x4E00 + 1))
        } else {
            None
        };
        if let Some(off) = off {
            let idx = t.lookup[off];
            if idx != u32::MAX {
                let (start, len) = t.spans[idx as usize];
                let mut p = start as usize;
                let end = p + len as usize;
                while p < end && n < cands.len() {
                    let rl = t.plain[p] as usize;
                    if rl > 0 {
                        cands[n] = &t.plain[p + 1..p + 1 + rl];
                        n += 1;
                    }
                    p += 1 + rl;
                }
            }
        }
        if n == 0 {
            // 非汉字：ASCII 小写原字符（与 Vec 版 to_ascii_lowercase 一致）
            let lc = c.to_ascii_lowercase();
            let tmp_len = { &*lc.encode_utf8(&mut fallback_buf) }.len();
            cands[0] = &fallback_buf[..tmp_len];
            n = 1;
        }
        let mut next: u64 = 1;
        let mut s = states;
        while s != 0 {
            let k = s.trailing_zeros();
            s &= s - 1;
            for cand in &cands[..n] {
                // initials_only：候选取首字母（读音首字节，拼音恒 ASCII）
                let bytes: &[u8] = if initials_only { &cand[..1] } else { cand };
                let mut k2 = k;
                let mut matched = true;
                for &b in bytes {
                    if k2 == qlen {
                        break; // 查询在读音中途耗尽 = 命中
                    }
                    if b == q[k2 as usize] {
                        k2 += 1;
                    } else {
                        matched = false;
                        break;
                    }
                }
                if !matched {
                    continue;
                }
                if k2 == qlen {
                    return true; // 查询恰好耗尽 = 完整命中
                }
                next |= 1 << k2;
            }
        }
        states = next;
    }
    false
}

/// Vec 版（查询 >63 字节时的回落路径；原始实现）
fn pinyin_contains_chars_vec(
    name: impl Iterator<Item = char>,
    q: &[u8],
    initials_only: bool,
) -> bool {
    let mut states = vec![true];
    for c in name {
        let mut next = vec![false; q.len() + 1];
        next[0] = true;
        // 本字符的候选读音（去声调、去重）
        let mut cands: Vec<String> = Vec::new();
        if let Some(list) = hanzi_readings(c) {
            for r in list.split(',') {
                let plain = plain_reading(r);
                let item = if initials_only {
                    plain.chars().next().map(String::from).unwrap_or_default()
                } else {
                    plain
                };
                if !item.is_empty() && !cands.contains(&item) {
                    cands.push(item);
                }
            }
        }
        if cands.is_empty() {
            cands.push(c.to_ascii_lowercase().to_string());
        }
        for (k, active) in states.iter().enumerate() {
            if !active {
                continue;
            }
            for r in &cands {
                let mut k2 = k;
                let mut ok = true;
                for b in r.as_bytes() {
                    if k2 == q.len() {
                        break;
                    }
                    if *b == q[k2] {
                        k2 += 1;
                    } else {
                        ok = false;
                        break;
                    }
                }
                if !ok {
                    continue;
                }
                if k2 == q.len() {
                    return true; // query 恰好耗尽 = 完整命中
                }
                next[k2] = true;
            }
        }
        states = next;
    }
    false
}

/// 汉字的全部读音（逗号分隔，带声调）；非汉字返回 None。
/// CJK 两区段走 [`pinyin_tables`] 直接寻址，区段外回落二分（语义与 PINYIN_MAP 一致）。
fn hanzi_readings(c: char) -> Option<&'static str> {
    let t = pinyin_tables();
    let cp = c as u32;
    let off = if (0x4E00..=0x9FFF).contains(&cp) {
        Some(cp - 0x4E00)
    } else if (0x3400..=0x4DBF).contains(&cp) {
        Some(cp - 0x3400 + (0x9FFF - 0x4E00 + 1))
    } else {
        None
    };
    if let Some(off) = off {
        let idx = t.lookup[off as usize];
        return if idx == u32::MAX {
            None
        } else {
            Some(PINYIN_MAP[idx as usize].1)
        };
    }
    PINYIN_MAP
        .binary_search_by_key(&c, |&(k, _)| k)
        .ok()
        .map(|i| PINYIN_MAP[i].1)
}

/// 拼音查表加速层（OnceLock 预编译）：CJK 码点直接索引 + 每字去声调读音平铺。
/// 索引扫描拼音通道逐字逐读音访问，二分（读音表 + 声调表）曾占漏网条目的大头，
/// 预编译后查询路径全程 O(1) 寻址 + 静态切片，零二分零分配。
struct PinyinTables {
    /// CJK 区段内码点偏移 → PINYIN_MAP 下标（u32::MAX = 无读音）
    lookup: Vec<u32>,
    /// 平铺的去声调读音：每字各读音按 [len][bytes] 顺次拼接
    plain: Vec<u8>,
    /// PINYIN_MAP 下标 → plain 中的 (起点, 总长)
    spans: Vec<(u32, u32)>,
}

fn pinyin_tables() -> &'static PinyinTables {
    static TABLES: OnceLock<PinyinTables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let span = (0x9FFF - 0x4E00 + 1 + 0x4DBF - 0x3400 + 1) as usize;
        let mut lookup = vec![u32::MAX; span];
        let mut plain = Vec::with_capacity(PINYIN_MAP.len() * 8);
        let mut spans = Vec::with_capacity(PINYIN_MAP.len());
        for (i, &(ch, readings)) in PINYIN_MAP.iter().enumerate() {
            let cp = ch as u32;
            let off = if (0x4E00..=0x9FFF).contains(&cp) {
                cp - 0x4E00
            } else if (0x3400..=0x4DBF).contains(&cp) {
                cp - 0x3400 + (0x9FFF - 0x4E00 + 1)
            } else {
                spans.push((0, 0));
                continue;
            };
            lookup[off as usize] = i as u32;
            let start = plain.len() as u32;
            for r in readings.split(',') {
                let stripped = plain_reading(r);
                let bytes = stripped.as_bytes();
                if bytes.is_empty() {
                    continue;
                }
                plain.push(bytes.len() as u8);
                plain.extend_from_slice(bytes);
            }
            let len = plain.len() as u32 - start;
            spans.push((start, len));
        }
        PinyinTables {
            lookup,
            plain,
            spans,
        }
    })
}

/// 读音去声调（"wǒ" → "wo"）：PHONETIC_SYMBOL_MAP 命中的字符替换为去数字符号
fn plain_reading(r: &str) -> String {
    r.chars()
        .map(
            |c| match PHONETIC_SYMBOL_MAP.binary_search_by_key(&c, |&(k, _)| k) {
                Ok(i) => PHONETIC_SYMBOL_MAP[i]
                    .1
                    .chars()
                    .filter(|d| !d.is_ascii_digit())
                    .collect::<String>(),
                Err(_) => c.to_string(),
            },
        )
        .collect()
}

/// 名称的拼音首字母匹配串（首字母跳转 type-ahead 用）：ASCII 保留小写原字符，
/// 汉字取首选读音去声调后的首字母（多音字取第一读音，如 重→"z"）。不含汉字
/// 返回 None——前端回落名称前缀匹配，纯 ASCII 名称不产生额外 IPC 载荷。
/// 例："forge请下这个txt文件" → "forgeqxzgtxtwj"，敲 "qxzg" 即可跳到。
pub fn pinyin_initials(name: &str) -> Option<String> {
    let mut out = String::with_capacity(name.len());
    let mut has_hanzi = false;
    for c in name.chars() {
        if c.is_ascii() {
            // 快路径：纯 ASCII 名称占绝大多数，避免逐字符二分 PINYIN_MAP
            out.push(c.to_ascii_lowercase());
        } else if let Some(readings) = hanzi_readings(c) {
            has_hanzi = true;
            let first = readings.split(',').next().unwrap_or("");
            if let Some(init) = plain_reading(first).chars().next() {
                out.push(init);
            }
        } else {
            out.extend(c.to_lowercase());
        }
    }
    has_hanzi.then_some(out)
}

/// 拼音字母集掩码（索引扫描预筛用）：名称每个字符贡献其全部读音（去声调）与
/// 透传原文的字节集合——bit 0..25 = 'a'..'z'，bit 26 = 其他任意字节（通配位）。
/// 不含汉字返回 0（纯 ASCII 名称走 u16 子串快路径，无需拼音通道）。
///
/// 语义 = DP 必要条件：`pinyin_contains_chars` 命中时查询的每个字节必然被
/// 某个字符的某读音/透传消耗，故 `query_mask & !entry_mask != 0 → 必不命中`，
/// 可安全淘汰；反之仅代表可能命中，仍需 DP 确认（掩码集合无顺序信息）。
/// 查询侧掩码：与条目侧同一位布局，但不做"含汉字才有效"门控——ASCII 查询词
/// 按字节直接进集（数字/符号落通配位 bit 26）。配 [`pinyin_letter_mask`] 使用：
/// `query_mask & !entry_mask != 0` 即可判定 DP 必不命中。
pub fn query_letter_mask(q: &str) -> u32 {
    let mut mask = 0u32;
    for c in q.chars() {
        let lower: String = c.to_lowercase().collect();
        for b in lower.bytes() {
            mask |= if b.is_ascii_lowercase() {
                1 << (b - b'a')
            } else {
                1 << 26
            };
        }
    }
    mask
}

pub fn pinyin_letter_mask(name: &str) -> u32 {
    fn feed_letters(mask: &mut u32, bytes: impl Iterator<Item = u8>, wild: bool) {
        for b in bytes {
            if b.is_ascii_lowercase() {
                *mask |= 1 << (b - b'a');
            } else if wild {
                *mask |= 1 << 26; // 非拼音字节的透传（数字/符号等）——通配位
            }
        }
    }
    let mut mask = 0u32;
    let mut has_hanzi = false;
    for c in name.chars() {
        if let Some(readings) = hanzi_readings(c) {
            has_hanzi = true;
            for r in readings.split(',') {
                feed_letters(&mut mask, plain_reading(r).bytes(), false);
            }
        } else {
            let lower: String = c.to_lowercase().collect();
            feed_letters(&mut mask, lower.bytes(), true);
        }
    }
    if has_hanzi { mask } else { 0 }
}

// ── 全盘搜索（多 worker 共享目录队列）──────────────────────────────

struct WorkQueue {
    dirs: Mutex<VecDeque<String>>,
    idle: Condvar,
    active: AtomicUsize,
}

/// 并行遍历所有根：worker 从共享队列领目录、把子目录压回队列；
/// 结果满 / 遍历满 / 超时 / 槽位被取消 任一条件触发全局停止。
pub fn search_all(
    roots: &[String],
    query: &Query,
    type_filter: TypeFilter,
    max_results: usize,
    cancel: &AtomicBool,
    sink: Option<&Mutex<BatchSink<'_>>>,
) -> GlobalSearchResult {
    let start = Instant::now();
    let out = Mutex::new(Vec::<FileEntry>::new());
    let visited = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let cancelled = || cancel.load(Ordering::Relaxed);
    let queue = WorkQueue {
        dirs: Mutex::new(
            roots
                .iter()
                .map(|r| {
                    let r = r.trim_end_matches('\\');
                    if r.ends_with(':') {
                        format!("{r}\\") // 盘符根必须带反斜杠，"E:" 是驱动器相对路径
                    } else {
                        r.to_string()
                    }
                })
                .collect(),
        ),
        idle: Condvar::new(),
        active: AtomicUsize::new(0),
    };

    std::thread::scope(|scope| {
        for _ in 0..(roots.len() * 4).clamp(1, 12) {
            scope.spawn(|| {
                loop {
                    // 领一个目录；队列空且无人在忙 = 遍历完成
                    let dir = {
                        let mut q = queue.dirs.lock().unwrap();
                        loop {
                            if cancelled() {
                                queue.idle.notify_all();
                                return;
                            }
                            if let Some(d) = q.pop_back() {
                                queue.active.fetch_add(1, Ordering::Relaxed);
                                break d;
                            }
                            if queue.active.load(Ordering::Relaxed) == 0 {
                                // 唤醒所有同伴一起退出：最后一个空手 worker 返回后，
                                // 仍在 condvar 上等待的 worker 会永远睡眠（错过终局判定）
                                queue.idle.notify_all();
                                return;
                            }
                            q = queue.idle.wait(q).unwrap();
                        }
                    };

                    let mut pushed = false;
                    if let Ok(rd) = std::fs::read_dir(to_extended(&dir)) {
                        for entry in rd.flatten() {
                            let v = visited.fetch_add(1, Ordering::Relaxed) + 1;
                            if v > MAX_VISITED_ALL
                                || v & 1023 == 0 && start.elapsed() > SEARCH_ALL_DEADLINE
                            {
                                stop.store(true, Ordering::Relaxed);
                            }
                            if stop.load(Ordering::Relaxed) || cancelled() {
                                break;
                            }
                            // 符号链接/junction：不跟随、不入结果（§6.11）
                            if entry.file_type().is_ok_and(|t| t.is_symlink()) {
                                continue;
                            }
                            let name = entry.file_name().to_string_lossy().into_owned();
                            let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
                            if type_filter.allows(is_dir) {
                                let name_lower = name.to_lowercase();
                                // 属性过滤分层：ext 在名称层先行淘汰，size/dm 在元数据就绪后判定
                                if query.attr_allows_name(&name_lower)
                                    && query.match_name(&name, &name_lower)
                                {
                                    let path_ok = !query.has_path_terms() || {
                                        let p = join_name(&dir, &name).to_lowercase();
                                        query.match_path(&p)
                                    };
                                    if path_ok
                                        && let Some(e) = dir_entry_to_file(&dir, &entry)
                                        && query.attr_allows_meta(&e)
                                    {
                                        let mut o = out.lock().unwrap();
                                        o.push(e.clone());
                                        if let Some(sink) = sink {
                                            sink.lock().unwrap().push(e, v);
                                        }
                                        if o.len() >= max_results {
                                            stop.store(true, Ordering::Relaxed);
                                        }
                                    }
                                }
                            }
                            if is_dir {
                                let lower = name.to_lowercase();
                                if !SKIP_DIRS.contains(&lower.as_str()) {
                                    queue.dirs.lock().unwrap().push_back(join_name(&dir, &name));
                                    pushed = true;
                                }
                            }
                        }
                    }
                    queue.active.fetch_sub(1, Ordering::Relaxed);
                    if pushed {
                        queue.idle.notify_all();
                    }
                }
            });
        }
    });
    if let Some(sink) = sink {
        sink.lock().unwrap().flush(visited.load(Ordering::Relaxed));
    }

    let mut entries = out.into_inner().unwrap();
    let sort = SortSpec {
        key: SortKey::Name,
        dir: SortDir::Asc,
    };
    entries.sort_by(|a, b| cmp_entries(a, b, &sort));
    GlobalSearchResult {
        entries,
        truncated: stop.load(Ordering::Relaxed),
        scanned: visited.load(Ordering::Relaxed),
        elapsed_ms: start.elapsed().as_millis() as u64,
        engine: "scan",
        fallback_reason: None,
    }
}

/// 深度优先遍历（迭代栈），收集匹配项；文件夹在前、名称自然排序
pub fn search_tree(
    root: &str,
    query: &Query,
    type_filter: TypeFilter,
    max_results: usize,
    cancel: &AtomicBool,
    mut sink: Option<&mut BatchSink<'_>>,
) -> SearchResult {
    let start = Instant::now();
    let mut out: Vec<FileEntry> = Vec::new();
    let mut truncated = false;
    let mut visited = 0usize;
    let mut stack: VecDeque<String> = VecDeque::from([root.to_string()]);
    'outer: while let Some(dir) = stack.pop_back() {
        if cancel.load(Ordering::Relaxed) {
            truncated = true;
            break;
        }
        let Ok(rd) = std::fs::read_dir(to_extended(&dir)) else {
            continue;
        };
        for entry in rd.flatten() {
            visited += 1;
            if visited > MAX_VISITED {
                truncated = true;
                break 'outer;
            }
            // 符号链接/junction：不跟随、不入结果（§6.11）
            if entry.file_type().is_ok_and(|t| t.is_symlink()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = join_name(&dir, &name);
            let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
            if type_filter.allows(is_dir) {
                let name_lower = name.to_lowercase();
                // 属性过滤分层：ext 在名称层先行淘汰，size/dm 在元数据就绪后判定
                if query.attr_allows_name(&name_lower) && query.match_name(&name, &name_lower) {
                    let path_ok = !query.has_path_terms() || {
                        let p = path.to_lowercase();
                        query.match_path(&p)
                    };
                    if path_ok
                        && let Some(e) = dir_entry_to_file(&dir, &entry)
                        && query.attr_allows_meta(&e)
                    {
                        out.push(e.clone());
                        if let Some(sink) = sink.as_deref_mut() {
                            sink.push(e, visited);
                        }
                        if out.len() >= max_results {
                            truncated = true;
                            break 'outer;
                        }
                    }
                }
            }
            if is_dir {
                stack.push_back(path);
            }
        }
    }
    if let Some(sink) = sink {
        sink.flush(visited);
    }
    let sort = SortSpec {
        key: SortKey::Name,
        dir: SortDir::Asc,
    };
    out.sort_by(|a, b| cmp_entries(a, b, &sort));
    SearchResult {
        entries: out,
        truncated,
        scanned: visited,
        elapsed_ms: start.elapsed().as_millis() as u64,
        engine: "scan",
    }
}

/// 子目录前缀补全：dir 下名字以 prefix 开头（大小写不敏感）的子目录完整路径
pub fn suggest_children(dir: &str, prefix: &str, limit: usize) -> Vec<String> {
    let p = prefix.to_lowercase();
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(to_extended(dir)) {
        let mut scanned = 0usize;
        for entry in rd.flatten() {
            scanned += 1;
            if scanned > SUGGEST_SCAN_CAP {
                break;
            }
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.to_lowercase().starts_with(&p) {
                out.push(join_name(dir, &name));
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    out.sort_by(|a, b| natural_cmp(a, b));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("xdir-search-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    fn no_cancel() -> AtomicBool {
        AtomicBool::new(false)
    }

    #[test]
    fn cancel_registry_slot_semantics() {
        let first = register_search(9901);
        assert!(!first.load(Ordering::Relaxed));
        // 同槽位新注册顶掉旧标志
        let second = register_search(9901);
        cancel_search(9901);
        assert!(second.load(Ordering::Relaxed));
        assert!(!first.load(Ordering::Relaxed)); // 旧标志未被翻转（新搜索不受影响）
        // unregister 只摘自己的注册
        unregister_search(9901, &first);
        assert!(cancel_flag_live(9901));
        unregister_search(9901, &second);
        assert!(!cancel_flag_live(9901));
    }

    fn cancel_flag_live(req_id: u64) -> bool {
        registry().lock().unwrap().contains_key(&req_id)
    }

    #[test]
    fn pinyin_initials_builds_prefix_string() {
        // 汉字逐个取首字母，ASCII 段保留小写原字符
        assert_eq!(
            pinyin_initials("forge请下这个txt文件").as_deref(),
            Some("forgeqxzgtxtwj")
        );
        assert_eq!(pinyin_initials("预算表.xlsx").as_deref(), Some("ysb.xlsx"));
        // 多音字取第一读音：重 → zhòng → "z"
        assert_eq!(pinyin_initials("重庆").as_deref(), Some("zq"));
        // 不含汉字 → None（前端回落名称前缀匹配）
        assert_eq!(pinyin_initials("plain-v2.txt"), None);
        assert_eq!(pinyin_initials(""), None);
    }

    fn mask_bits(mask: u32) -> Vec<char> {
        (0..26)
            .filter(|i| mask & (1 << i) != 0)
            .map(|i| (b'a' + i as u8) as char)
            .chain((mask & (1 << 26) != 0).then_some('*'))
            .collect()
    }

    /// 掩码必要条件：DP 命中 ⇒ 查询字节集 ⊆ 条目字节集（逐字验证，全拼+首字母两通道）
    fn mask_superset_holds(name: &str, query: &str) -> bool {
        let em = pinyin_letter_mask(name);
        let qm = query_letter_mask(query);
        qm & !em == 0
    }

    #[test]
    fn pinyin_letter_mask_necessary_condition() {
        // 无汉字 → 0（纯 ASCII 名称不启用拼音通道）
        assert_eq!(pinyin_letter_mask("plain-v2.txt"), 0);
        assert_eq!(pinyin_letter_mask(""), 0);
        // 全拼命中 ⇒ 掩码超集；首字母命中同理（含多音字两读音）
        for (name, query) in [
            ("我的资料", "wodeziliao"),
            ("我的资料.docx", "wdzl"),
            ("重庆方案", "zhongqing"),
            ("重庆方案", "chongqing"),
            ("重庆方案", "cq"),
            ("forge请下这个txt文件", "forgeqingxia"),
            ("forge请下这个txt文件", "qxzg"),
            ("预算表2026.xlsx", "ysb"),
            ("预算表2026.xlsx", "2026"),
        ] {
            assert!(
                mask_superset_holds(name, query),
                "掩码漏判：{name} ← {query}（bits={:?}）",
                mask_bits(pinyin_letter_mask(name))
            );
        }
        // 反例允许：掩码通过但 DP 拒绝（wdzl ⊉ photos 的字节集，直接淘汰）
        assert!(!mask_superset_holds("photos", "wdzl"));
        // 混排条目的非拼音字节（数字）走通配位
        let m = pinyin_letter_mask("预算2026.xlsx");
        assert!(m & (1 << 26) != 0 && m & (1 << (b'y' - b'a')) != 0);
    }

    /// 位图快版与 Vec 回落版语义一致（差分）：扫描热路径重写不得改变匹配结果
    #[test]
    fn pinyin_fast_matches_vec_semantics() {
        let names = [
            "我的资料",
            "我的资料.docx",
            "重庆方案",
            " forge请下这个txt文件",
            "预算表2026.xlsx",
            "photos",
            "客户A\\凭证Xlsx",
            "会议纪要-王文铖(2026版)",
        ];
        let queries = [
            "wdzl",
            "wodeziliao",
            "zq",
            "zhongqing",
            "chongqing",
            "cq",
            "qxzg",
            "qingxia",
            "ysb",
            "2026",
            "hyjy",
            "wwc",
            "zzz",
            "dz",
            "y",
        ];
        for name in names {
            for q in queries {
                for initials in [false, true] {
                    let fast = {
                        let chars = name.chars();
                        pinyin_contains_chars_fast(chars, q.as_bytes(), initials)
                    };
                    let slow = {
                        let chars = name.chars();
                        pinyin_contains_chars_vec(chars, q.as_bytes(), initials)
                    };
                    assert_eq!(
                        fast, slow,
                        "快慢版不一致：{name} ← {q}（initials={initials}）"
                    );
                }
            }
        }
    }

    #[test]
    fn batch_sink_throttles_and_flushes() {
        let count = AtomicUsize::new(0);
        let emitted_total = AtomicUsize::new(0);
        let emit = |entries: &[FileEntry], _scanned: usize| {
            count.fetch_add(1, Ordering::Relaxed);
            emitted_total.fetch_add(entries.len(), Ordering::Relaxed);
        };
        let mut sink = BatchSink::new(&emit);
        for i in 0..600 {
            let e = FileEntry {
                name: format!("f{i}.txt"),
                path: format!("C:\\t\\f{i}.txt"),
                is_dir: false,
                size: 0,
                mtime_ms: 0,
                ctime_ms: 0,
                attrs: super::super::entry::FileAttrs {
                    hidden: false,
                    system: false,
                    readonly: false,
                },
                py: None,
            };
            sink.push(e, i + 1);
        }
        // 单批 256 封顶：600 条至少触发 2 次批次
        assert!(count.load(Ordering::Relaxed) >= 2);
        sink.flush(600);
        assert_eq!(emitted_total.load(Ordering::Relaxed), 600);
    }

    #[test]
    fn search_all_walks_roots_in_parallel_and_caps() {
        let r1 = tempdir("g1");
        let r2 = tempdir("g2");
        std::fs::write(std::path::Path::new(&r1).join("预算表.xlsx"), "x").unwrap();
        std::fs::create_dir_all(std::path::Path::new(&r2).join("sub")).unwrap();
        std::fs::write(std::path::Path::new(&r2).join("sub\\会议纪要.docx"), "x").unwrap();

        let cancel = no_cancel();
        // 拼音首字母跨两个根命中
        let q = Query::parse("ysb");
        let r = search_all(
            &[r1.clone(), r2.clone()],
            &q,
            TypeFilter::All,
            100,
            &cancel,
            None,
        );
        assert_eq!(r.entries.len(), 1);
        assert!(r.entries[0].name.contains("预算"));
        assert!(!r.truncated);
        assert_eq!(r.engine, "scan");
        assert!(r.scanned >= 3);

        // 空查询全命中 → 结果封顶即截断
        let q = Query::parse("");
        let capped = search_all(
            &[r1.clone(), r2.clone()],
            &q,
            TypeFilter::All,
            2,
            &cancel,
            None,
        );
        assert_eq!(capped.entries.len(), 2);
        assert!(capped.truncated);

        // 类型过滤：只搜文件夹
        let q = Query::parse("");
        let dirs = search_all(
            &[r1.clone(), r2.clone()],
            &q,
            TypeFilter::Dirs,
            100,
            &cancel,
            None,
        );
        assert!(dirs.entries.iter().all(|e| e.is_dir));
        assert!(!dirs.entries.is_empty());

        // 槽位取消：预置取消标志后新扫描立即退出
        let slot = register_search(9902);
        cancel_search(9902);
        let q = Query::parse("a");
        let r = search_all(
            &[r1.clone(), r2.clone()],
            &q,
            TypeFilter::All,
            100,
            &slot,
            None,
        );
        unregister_search(9902, &slot);
        assert!(r.entries.is_empty());
        std::fs::remove_dir_all(&r1).unwrap();
        std::fs::remove_dir_all(&r2).unwrap();
    }

    #[test]
    fn search_walks_and_caps() {
        let root = tempdir("walk");
        std::fs::create_dir_all(std::path::Path::new(&root).join("sub\\deep")).unwrap();
        std::fs::write(std::path::Path::new(&root).join("alpha-ZEBRA.txt"), "x").unwrap();
        std::fs::write(std::path::Path::new(&root).join("sub\\beta-zebra.md"), "x").unwrap();
        std::fs::write(
            std::path::Path::new(&root).join("sub\\deep\\gamma.txt"),
            "x",
        )
        .unwrap();

        let cancel = no_cancel();
        let q = Query::parse("zebra");
        let r = search_tree(&root, &q, TypeFilter::All, 100, &cancel, None);
        assert_eq!(r.entries.len(), 2);
        assert!(
            r.entries
                .iter()
                .all(|e| e.name.to_lowercase().contains("zebra"))
        );
        assert!(!r.truncated);

        // 通配符
        let q = Query::parse("*-ZEBRA*");
        let r = search_tree(&root, &q, TypeFilter::All, 100, &cancel, None);
        assert_eq!(r.entries.len(), 2);

        // 路径词（含 \ 归入路径匹配）：sub 目录下的 zebra
        let q = Query::parse("zebra \\sub");
        let r = search_tree(&root, &q, TypeFilter::All, 100, &cancel, None);
        assert_eq!(r.entries.len(), 1);
        assert!(r.entries[0].path.contains("sub"));

        // 只搜文件夹
        let q = Query::parse("");
        let dirs = search_tree(&root, &q, TypeFilter::Dirs, 100, &cancel, None);
        assert!(dirs.entries.iter().all(|e| e.is_dir));
        assert_eq!(dirs.entries.len(), 2); // sub、deep

        // 空查询 = 全部命中 → 截断
        let capped = search_tree(&root, &q, TypeFilter::All, 2, &cancel, None);
        assert_eq!(capped.entries.len(), 2);
        assert!(capped.truncated);

        // 预置取消标志：扫描立即返回
        let slot = register_search(9903);
        cancel_search(9903);
        let r = search_tree(&root, &q, TypeFilter::All, 100, &slot, None);
        unregister_search(9903, &slot);
        assert!(r.entries.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn search_streaming_batches_reach_sink() {
        let root = tempdir("stream");
        for i in 0..10 {
            std::fs::write(
                std::path::Path::new(&root).join(format!("batch-{i}.txt")),
                "x",
            )
            .unwrap();
        }
        let total = std::sync::Arc::new(AtomicUsize::new(0));
        let total2 = total.clone();
        let emit = move |entries: &[FileEntry], _scanned: usize| {
            total2.fetch_add(entries.len(), Ordering::Relaxed);
        };
        let mut sink = BatchSink::new(&emit);
        let cancel = no_cancel();
        let q = Query::parse("batch");
        let r = search_tree(&root, &q, TypeFilter::All, 100, &cancel, Some(&mut sink));
        assert_eq!(r.entries.len(), 10);
        // 终态 flush 后批次总数 = 结果数
        assert_eq!(total.load(Ordering::Relaxed), 10);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn suggests_dir_children_by_prefix() {
        let root = tempdir("sugg");
        for name in ["Code", "Code2", "Docs", "code-old"] {
            std::fs::create_dir_all(std::path::Path::new(&root).join(name)).unwrap();
        }
        std::fs::write(std::path::Path::new(&root).join("codefile.txt"), "x").unwrap();
        let out = suggest_children(&root, "code", 10);
        assert_eq!(out.len(), 3); // 文件不算，三个目录（大小写不敏感）
        assert!(out.iter().all(|p| p.starts_with(&root)));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
