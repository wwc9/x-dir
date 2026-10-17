//! 目录快照缓存：按 path 缓存全量扫描结果，LRU 淘汰（§6.4）。
//! 锁持有期间执行回调——回调必须纯（只做切片/克隆），不得做 IO。

use std::collections::{HashMap, VecDeque};
use std::io;

use super::entry::{FileEntry, scan_dir};
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
            }
        }
    }

    pub fn invalidate(&mut self, path: &str) {
        let key = norm_key(path);
        self.map.remove(&key);
        self.order.retain(|p| *p != key);
    }

    /// 未缓存时触发扫描，随后对快照切片执行回调（重排/过滤不重扫盘）
    pub fn with_entries<T>(
        &mut self,
        dir: &str,
        force_rescan: bool,
        f: impl FnOnce(&[FileEntry]) -> T,
    ) -> io::Result<T> {
        let key = norm_key(dir);
        if force_rescan || !self.map.contains_key(&key) {
            let entries = scan_dir(dir)?;
            self.map.insert(key.clone(), entries);
        }
        self.touch(&key);
        Ok(f(&self.map[&key]))
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
            c.map.insert(d.into(), fake(d));
            c.touch(d);
        }
        assert_eq!(c.map.len(), 2);
        assert!(!c.map.contains_key("a")); // 最旧的被淘汰
        assert!(c.map.contains_key("c"));
    }

    #[test]
    fn invalidate_removes_entry() {
        let mut c = SnapshotCache::new(2);
        c.map.insert("a".into(), fake("a"));
        c.order.push_back("a".into());
        c.invalidate("a");
        assert!(!c.map.contains_key("a"));
        assert!(!c.order.contains(&"a".to_string()));
    }

    #[test]
    fn keys_are_case_and_slash_normalized() {
        // 大小写/尾反斜杠不同的同一目录必须命中同一键（watcher 失效与快照键一致）
        let mut c = SnapshotCache::new(2);
        c.map.insert(norm_key("C:\\Data"), fake("C:\\Data"));
        c.order.push_back(norm_key("C:\\Data"));
        c.invalidate("c:\\data\\");
        assert!(c.map.is_empty());
        c.map.insert(norm_key("C:\\Data"), fake("C:\\Data"));
        c.touch("c:\\data");
        // touch 不应把归一化后的同键挤出去
        assert_eq!(c.map.len(), 1);
    }
}
