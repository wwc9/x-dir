//! 目录监控（§6.8）：仅可见窗格挂 watcher（引用计数），事件 300ms 窗口聚合 +
//! 700ms 冷却后作为"脏标记"回调，不携带元数据。watcher 丢弃后事件线程自然退出。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

use crate::fs::path::{norm_key, to_extended};

const MAX_WATCHES: usize = 24;
const DEBOUNCE_MS: u64 = 300;
const COOLDOWN_MS: u64 = 700;
/// 持续变更下防抖窗口的硬上限：解压/拷贝大文件时事件间隔可小于单次窗口，
/// 不设上限会让刷新无限推迟
const DEBOUNCE_MAX_MS: u64 = 2_000;

pub struct WatchManager {
    entries: Mutex<HashMap<String, WatchEntry>>,
}

struct WatchEntry {
    count: u32,
    /// 保活：watcher 存活期间事件通道才不会关闭
    _watcher: RecommendedWatcher,
}

impl WatchManager {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// 同一路径重复 watch 只增加引用计数；回调在独立事件线程执行。
    /// 键经 norm_key 归一（大小写/尾反斜杠），与快照缓存键保持同一语义，
    /// 否则 invalidate 打不到真实键。
    pub fn watch<F>(&self, path: &str, on_change: F) -> Result<(), String>
    where
        F: Fn(&str) + Send + 'static,
    {
        let key = norm_key(path);
        let mut map = self.entries.lock().unwrap();
        if let Some(e) = map.get_mut(&key) {
            e.count += 1;
            return Ok(());
        }
        if map.len() >= MAX_WATCHES {
            return Err("监控数量已达上限".to_string());
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher =
            RecommendedWatcher::new(tx, Config::default()).map_err(|e| e.to_string())?;
        watcher
            .watch(Path::new(&to_extended(path)), RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        map.insert(
            key,
            WatchEntry {
                count: 1,
                _watcher: watcher,
            },
        );
        drop(map);

        // 回调收到原始显示路径（dir-changed 事件前端按原始路径匹配窗格）；
        // 引用计数与 map 键用归一化形式
        let p = path.to_string();
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MAX_MS);
                while Instant::now() < deadline
                    && rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)).is_ok()
                {}
                on_change(&p);
                std::thread::sleep(Duration::from_millis(COOLDOWN_MS));
                while rx.try_recv().is_ok() {}
            }
        });
        Ok(())
    }

    pub fn unwatch(&self, path: &str) {
        let key = norm_key(path);
        let mut map = self.entries.lock().unwrap();
        if let Some(e) = map.get_mut(&key) {
            e.count -= 1;
            if e.count == 0 {
                map.remove(&key);
            }
        }
    }

    pub fn count(&self, path: &str) -> u32 {
        self.entries
            .lock()
            .unwrap()
            .get(&norm_key(path))
            .map(|e| e.count)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("xdir-watch-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn refcount_and_events() {
        let m = WatchManager::new();
        let dir = tempdir("rc");
        let (tx, rx) = std::sync::mpsc::channel();

        m.watch(&dir, move |_| {
            let _ = tx.send(());
        })
        .unwrap();
        m.watch(&dir, |_| {}).unwrap(); // 同路径第二引用
        assert_eq!(m.count(&dir), 2);

        // 触发一次文件变更 → 聚合后回调
        std::fs::write(std::path::Path::new(&dir).join("a.txt"), "x").unwrap();
        rx.recv_timeout(Duration::from_secs(3))
            .expect("应收到脏标记回调");

        m.unwatch(&dir);
        assert_eq!(m.count(&dir), 1);
        m.unwatch(&dir);
        assert_eq!(m.count(&dir), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn watch_key_case_normalized() {
        let m = WatchManager::new();
        let dir = tempdir("case");
        let upper = dir.to_ascii_uppercase();
        m.watch(&dir, |_| {}).unwrap();
        // 大小写/尾反斜杠不同的同一目录视为同一引用
        assert_eq!(m.count(&upper), 1);
        assert_eq!(m.count(&format!("{dir}\\")), 1);
        m.unwatch(&upper);
        assert_eq!(m.count(&dir), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
