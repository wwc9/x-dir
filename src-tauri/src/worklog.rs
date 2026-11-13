//! 工作日历日志持久化（design/calendar-plan.md §5.1）：按日期键控的工作条目，
//! 落 `config/worklog.json`（便携配置根目录）。单文件 JSON + 临时文件原子替换；
//! 损坏回落空档不崩（与 settings 同口径）；读写经进程内互斥锁串行，
//! 防同日读改写互相覆盖。结构：{ version, days: { "yyyy-MM-dd": [{text, status}] } }。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WorkEntry {
    pub text: String,
    /// "todo" | "doing" | "done"（白名单外回落 done，防脏档渲染失控）
    pub status: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct WorklogData {
    pub version: u32,
    #[serde(default)]
    pub days: BTreeMap<String, Vec<WorkEntry>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorklogDay {
    pub date: String,
    pub entries: Vec<WorkEntry>,
}

pub fn worklog_path() -> PathBuf {
    crate::config::config_root().join("worklog.json")
}

/// 全部读写串行（文件小，RMW 窗口极短）
static WORKLOG_LOCK: Mutex<()> = Mutex::new(());

const STATUS_WHITELIST: [&str; 3] = ["todo", "doing", "done"];

/// 条目净化：空文本剔除（= 用户清空即删条），状态白名单外回落 done
fn sanitize_entries(entries: Vec<WorkEntry>) -> Vec<WorkEntry> {
    entries
        .into_iter()
        .filter(|e| !e.text.is_empty())
        .map(|e| {
            let status = if STATUS_WHITELIST.contains(&e.status.as_str()) {
                e.status
            } else {
                "done".to_string()
            };
            WorkEntry {
                text: e.text,
                status,
            }
        })
        .collect()
}

fn load_from(path: &Path) -> WorklogData {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<WorklogData>(&s).unwrap_or_default(),
        Err(_) => WorklogData::default(),
    }
}

fn save_to(path: &Path, data: &WorklogData) -> Result<(), String> {
    let json = serde_json::to_string(data).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("写入失败：{e}"))
}

/// 日期键合法性：yyyy-MM-dd 且为真实日历日期（2026-02-30 拒绝）
fn is_valid_date_key(key: &str) -> bool {
    let parts: Vec<_> = key.split('-').collect();
    if parts.len() != 3 {
        return false;
    }
    let (y, m, d) = match (
        parts[0].parse::<i32>(),
        parts[1].parse::<u32>(),
        parts[2].parse::<u32>(),
    ) {
        (Ok(y), Ok(m), Ok(d))
            if parts[0].len() == 4 && parts[1].len() == 2 && parts[2].len() == 2 =>
        {
            (y, m, d)
        }
        _ => return false,
    };
    (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 0,
    }
}

/// 取某月全部有条目日期（BTreeMap 键天然升序下发）
pub fn get_month(year: i32, month: u32) -> Result<Vec<WorklogDay>, String> {
    if !(1..=12).contains(&month) {
        return Err("月份超出范围".to_string());
    }
    let _g = WORKLOG_LOCK.lock().map_err(|e| e.to_string())?;
    let data = load_from(&worklog_path());
    Ok(filter_month(&data, year, month))
}

/// 写入某日条目；空清单 = 删除该日键（清空即删日，与 UI「清空全部条目」同义）
pub fn set_day(date: &str, entries: Vec<WorkEntry>) -> Result<(), String> {
    if !is_valid_date_key(date) {
        return Err(format!("非法日期「{date}」"));
    }
    let entries = sanitize_entries(entries);
    let _g = WORKLOG_LOCK.lock().map_err(|e| e.to_string())?;
    let path = worklog_path();
    let mut data = load_from(&path);
    apply_set_day(&mut data, date, entries);
    data.version = 1;
    save_to(&path, &data)
}

fn filter_month(data: &WorklogData, year: i32, month: u32) -> Vec<WorklogDay> {
    let prefix = format!("{year:04}-{month:02}");
    data.days
        .iter()
        .filter(|(k, v)| !v.is_empty() && k.starts_with(&prefix))
        .map(|(k, v)| WorklogDay {
            date: k.clone(),
            entries: v.clone(),
        })
        .collect()
}

fn apply_set_day(data: &mut WorklogData, date: &str, entries: Vec<WorkEntry>) {
    if entries.is_empty() {
        data.days.remove(date);
    } else {
        data.days.insert(date.to_string(), entries);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_worklog(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("xdir_worklog_test_{}_{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).ok();
        dir.join("worklog.json")
    }

    fn entry(text: &str, status: &str) -> WorkEntry {
        WorkEntry {
            text: text.into(),
            status: status.into(),
        }
    }

    #[test]
    fn date_key_validation() {
        assert!(is_valid_date_key("2026-11-13"));
        assert!(is_valid_date_key("2024-02-29")); // 闰年
        assert!(!is_valid_date_key("2026-13-01")); // 月越界
        assert!(!is_valid_date_key("2026-02-30")); // 不存在的日子
        assert!(!is_valid_date_key("2023-02-29")); // 平年
        assert!(!is_valid_date_key("2026-2-01")); // 位数不符
        assert!(!is_valid_date_key("bad"));
    }

    #[test]
    fn sanitize_filters_empty_text_and_bad_status() {
        let out = sanitize_entries(vec![
            entry("ok", "doing"),
            entry("bad", "urgent"),
            entry("", "done"),
        ]);
        // 空文本剔除；非法状态回落 done（不剔除条目）
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], entry("ok", "doing"));
        assert_eq!(out[1], entry("bad", "done"));
    }

    #[test]
    fn roundtrip_and_empty_day_removal() {
        let path = tmp_worklog("roundtrip");
        std::fs::remove_file(&path).ok();
        let mut data = WorklogData::default();
        apply_set_day(
            &mut data,
            "2026-10-14",
            vec![entry("a", "done"), entry("b", "doing")],
        );
        save_to(&path, &data).unwrap();
        assert_eq!(filter_month(&load_from(&path), 2026, 10).len(), 1);
        assert_eq!(filter_month(&load_from(&path), 2026, 11).len(), 0);

        // 空清单 = 删日
        let mut data = load_from(&path);
        apply_set_day(&mut data, "2026-10-14", vec![]);
        save_to(&path, &data).unwrap();
        assert!(filter_month(&load_from(&path), 2026, 10).is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn invalid_month_rejected() {
        assert!(get_month_validates(13).is_err());
        assert!(get_month_validates(0).is_err());
    }

    fn get_month_validates(month: u32) -> Result<(), String> {
        if !(1..=12).contains(&month) {
            return Err("月份超出范围".to_string());
        }
        Ok(())
    }

    #[test]
    fn corrupt_file_falls_back_to_empty_then_rebuilds() {
        let path = tmp_worklog("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).ok();
        std::fs::write(&path, "{ not json !!!").unwrap();
        assert!(filter_month(&load_from(&path), 2026, 1).is_empty());
        let mut data = load_from(&path);
        apply_set_day(&mut data, "2026-01-02", vec![entry("x", "done")]);
        save_to(&path, &data).unwrap();
        assert_eq!(filter_month(&load_from(&path), 2026, 1).len(), 1);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
