//! 目录快照缓存：按 path 缓存全量扫描结果，LRU 淘汰（§6.4）。
//! 锁持有期间执行回调——回调必须纯（只做切片/克隆），不得做 IO。
//! 扫描一律由调用方在**锁外**完成（needs_scan 判定 → 锁外 scan_dir →
//! insert 回填，2026-11-01 审查修复：旧 with_entries 在全局锁内做整目录
//! 扫描，冷/网络目录扫数秒期间所有窗格的列目录、watcher 失效、任务收尾
//! 的缓存失效全部排队等这一把锁）。

use std::collections::{HashMap, VecDeque};

use super::entry::FileEntry;
use super::path::norm_key;

pub struct SnapshotCache {
    max: usize,
    map: HashMap<String, Vec<FileEntry>>,
    order: VecDeque<String>,
}

impl SnapshotCache {
    pub fn new(max: usize) -> Self {
        Self {
            max,
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn touch(&mut self, path: &str) {
        let key = norm_key(path);
        self.order.retain(|p| *p != key);
        self.order.push_back(key);
        while self.map.len() > self.max {
            if let Some(evict) = self.order.pop_front() {
                self.map.remove(&evict);
            } else {
                break; // 两集合失配（理论不可达）：让出而非空转
            }
        }
    }

    pub fn invalidate(&mut self, path: &str) {
        let key = norm_key(path);
        self.map.remove(&key);
        self.order.retain(|p| *p != key);
    }

    /// 是否需要（重）扫描：未缓存或调用方强制。配合 insert 构成锁外两阶段
    pub fn needs_scan(&self, dir: &str, force_rescan: bool) -> bool {
        force_rescan || !self.map.contains_key(&norm_key(dir))
    }

    /// 锁外扫描结果回填（LRU 触达 + 超限淘汰）。并发扫描同一目录时后写
    /// 覆盖先写——内容相同，无害
    pub fn insert(&mut self, dir: &str, entries: Vec<FileEntry>) {
        self.map.insert(norm_key(dir), entries);
        self.touch(dir);
    }

    /// 对快照切片执行回调（重排/过滤不重扫盘；未缓存时回调收到空切片，
    /// 正常路径总是先经 needs_scan/insert）
    pub fn with_entries<T>(&mut self, dir: &str, f: impl FnOnce(&[FileEntry]) -> T) -> T {
        self.touch(dir);
        f(self
            .map
            .get(&norm_key(dir))
            .map(|v| v.as_slice())
            .unwrap_or(&[]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(dir: &str) -> Vec<FileEntry> {
        vec![FileEntry {
            path: format!("{dir}\\x"),
            name: "x".into(),
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
        }]
    }

    #[test]
    fn lru_evicts_oldest() {
        let mut c = SnapshotCache::new(2);
        for d in ["a", "b", "c"] {
            c.insert(d, fake(d));
        }
        assert_eq!(c.map.len(), 2);
        assert!(!c.map.contains_key("a")); // 最旧的被淘汰
        assert!(c.map.contains_key("c"));
    }

    #[test]
    fn invalidate_removes_entry() {
        let mut c = SnapshotCache::new(2);
        c.insert("a", fake("a"));
        c.invalidate("a");
        assert!(!c.map.contains_key("a"));
        assert!(!c.order.contains(&"a".to_string()));
    }

    #[test]
    fn keys_are_case_and_slash_normalized() {
        // 大小写/尾反斜杠不同的同一目录必须命中同一键（watcher 失效与快照键一致）
        let mut c = SnapshotCache::new(2);
        c.insert("C:\\Data", fake("C:\\Data"));
        c.invalidate("c:\\data\\");
        assert!(c.map.is_empty());
        c.insert("C:\\Data", fake("C:\\Data"));
        c.touch("c:\\data");
        // touch 不应把归一化后的同键挤出去
        assert_eq!(c.map.len(), 1);
    }

    #[test]
    fn needs_scan_and_insert_two_phase() {
        // 两阶段协议：needs_scan 判定 → 锁外扫描 → insert 回填 → with_entries 命中
        let mut c = SnapshotCache::new(4);
        assert!(c.needs_scan("C:\\d", false));
        assert!(c.needs_scan("C:\\d", true)); // force 恒需扫描
        c.insert("C:\\d", fake("C:\\d"));
        assert!(!c.needs_scan("c:\\d\\", false));
        let n = c.with_entries("C:\\d", |es| es.len());
        assert_eq!(n, 1);
    }
}
