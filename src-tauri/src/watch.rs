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
        // 引用计数与 map 键用归一化形式。
        // 冷却不丢事件（2026-11-06 修订）：旧实现冷却期后 try_recv 清空积压——
        // 冷却窗口（700ms）内到达的变更被静默丢弃，极端时序（上一轮触发刚过、
        // 用户随即放入新文件）下该变更永远不产生 dir-changed，前端列表不刷。
        // 现冷却结束检查积压：有则开新一轮聚合再触发一次，变更必达
        let p = path.to_string();
        std::thread::spawn(move || {
            'outer: while rx.recv().is_ok() {
                'burst: loop {
                    let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MAX_MS);
                    while Instant::now() < deadline
                        && rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)).is_ok()
                    {
                    }
                    on_change(&p);
                    std::thread::sleep(Duration::from_millis(COOLDOWN_MS));
                    // 冷却结束：无积压回外层阻塞等新事件；有积压（消费一条
                    // 作信号）进入下一轮聚合——事件不丢、聚合仍防抖
                    if rx.try_recv().is_err() {
                        continue 'outer;
                    }
                    continue 'burst;
                }
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

    /// 冷却期内到达的变更不得丢弃（2026-11-06 修订回归）：首轮触发后的
    /// 700ms 冷却窗口内再写入，必须还有第二次回调——旧实现 try_recv 清空
    /// 积压把这类变更静默吞掉，前端列表永不刷新
    #[test]
    fn event_during_cooldown_still_fires() {
        let m = WatchManager::new();
        let dir = tempdir("cool");
        let (tx, rx) = std::sync::mpsc::channel();
        m.watch(&dir, move |_| {
            let _ = tx.send(());
        })
        .unwrap();
        let f = std::path::Path::new(&dir).join("a.txt");
        std::fs::write(&f, "1").unwrap();
        rx.recv_timeout(Duration::from_secs(3)).expect("首轮回调");
        // 冷却中段（首轮触发后约 200ms < 700ms 冷却）再写
        std::fs::write(&f, "2").unwrap();
        let second = rx.recv_timeout(Duration::from_secs(3));
        assert!(second.is_ok(), "冷却期内的变更必须再触发一次回调");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
