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
    /// 分类 id（设置内定义；None = 未分类。旧档缺字段自动回落，不迁移）
    #[serde(default)]
    pub category: Option<String>,
    /// 定期任务模板 id（生成式实例溯源；None = 手动条目，生成引擎据此防重）
    #[serde(default, rename = "gen")]
    pub gen_id: Option<String>,
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
                category: e.category,
                gen_id: e.gen_id,
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
    rotate_if_changed(&path);
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

/// 自动备份轮换（2026-11-13 增强批）：内容变化落盘前，当前档拷进 .bak.1，
/// 旧 .bak.1→.bak.2→.bak.3 逐级顺移（保留最近 3 份历史）；内容与 .bak.1
/// 相同（重复保存）时不轮换，防无谓 churn。
const BACKUP_COPIES: u32 = 3;

fn rotate_backups(path: &Path) {
    for i in (1..=BACKUP_COPIES).rev() {
        let from = if i == 1 {
            path.to_path_buf()
        } else {
            path.with_extension(format!("json.bak.{}", i - 1))
        };
        let to = path.with_extension(format!("json.bak.{}", i));
        if from.exists() {
            let _ = std::fs::copy(&from, &to);
        }
    }
}

/// 内容有变化才轮换备份（与 .bak.1 比对，重复保存不 churn）
fn rotate_if_changed(path: &Path) {
    let cur = std::fs::read_to_string(path).unwrap_or_default();
    let bak1 = std::fs::read_to_string(path.with_extension("json.bak.1")).unwrap_or_default();
    if cur != bak1 {
        rotate_backups(path);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorklogHit {
    pub date: String,
    pub index: usize,
    pub text: String,
    pub status: String,
    pub category: Option<String>,
}

/// 搜索核心（路径注入，生产与测试同源）：大小写不敏感子串；纯 ASCII 字母
/// 数字查询额外走拼音首字母通道（复用 fs::search::pinyin_initials，搜
/// "dh" 命中「电话会议」）。category = Some 时按分类过滤。命中上限 200。
fn search_core(path: &Path, query: &str, category: Option<&str>) -> Vec<WorklogHit> {
    let q = query.trim().to_lowercase();
    let mut hits = Vec::new();
    if q.is_empty() {
        return hits;
    }
    let ascii_q = q.chars().all(|c| c.is_ascii_alphanumeric());
    let data = load_from(path);
    for (date, list) in &data.days {
        for (i, e) in list.iter().enumerate() {
            if e.text.is_empty() {
                continue;
            }
            if category.is_some_and(|cat| e.category.as_deref() != Some(cat)) {
                continue;
            }
            let matched = e.text.to_lowercase().contains(&q)
                || (ascii_q
                    && crate::fs::search::pinyin_initials(&e.text)
                        .is_some_and(|py| py.to_lowercase().contains(&q)));
            if matched {
                hits.push(WorklogHit {
                    date: date.clone(),
                    index: i,
                    text: e.text.clone(),
                    status: e.status.clone(),
                    category: e.category.clone(),
                });
                if hits.len() >= 200 {
                    return hits;
                }
            }
        }
    }
    hits
}

/// 全量搜索（生产入口：worklog_path + 锁）
pub fn search(query: &str, category: Option<&str>) -> Result<Vec<WorklogHit>, String> {
    let _g = WORKLOG_LOCK.lock().map_err(|e| e.to_string())?;
    Ok(search_core(&worklog_path(), query, category))
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
            category: None,
            gen_id: None,
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
    fn backup_rotation_keeps_recent_history() {
        let path = tmp_worklog("backup");
        std::fs::remove_file(&path).ok();
        let mut data = WorklogData::default();
        apply_set_day(&mut data, "2026-10-14", vec![entry("v1", "done")]);
        data.version = 1;
        save_to(&path, &data).unwrap();
        assert!(!path.with_extension("json.bak.1").exists()); // 首次写入无历史
        let mut data = load_from(&path);
        apply_set_day(&mut data, "2026-10-14", vec![entry("v2", "done")]);
        rotate_if_changed(&path);
        save_to(&path, &data).unwrap();
        assert!(
            std::fs::read_to_string(path.with_extension("json.bak.1"))
                .unwrap()
                .contains("v1")
        );
        assert!(std::fs::read_to_string(&path).unwrap().contains("v2"));
        let mut data = load_from(&path);
        apply_set_day(&mut data, "2026-10-14", vec![entry("v3", "done")]);
        rotate_if_changed(&path);
        save_to(&path, &data).unwrap();
        assert!(
            std::fs::read_to_string(path.with_extension("json.bak.2"))
                .unwrap()
                .contains("v1")
        );
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn search_matches_substring_pinyin_and_category() {
        let path = tmp_worklog("search");
        std::fs::remove_file(&path).ok();
        let mut data = WorklogData::default();
        apply_set_day(
            &mut data,
            "2026-10-12",
            vec![
                WorkEntry {
                    text: "电话会议确认期初余额".into(),
                    status: "done".into(),
                    category: Some("work".into()),
                    gen_id: None,
                },
                WorkEntry {
                    text: "回复邮件".into(),
                    status: "todo".into(),
                    category: None,
                    gen_id: None,
                },
            ],
        );
        apply_set_day(
            &mut data,
            "2026-11-13",
            vec![WorkEntry {
                text: "日历功能方案评审".into(),
                status: "doing".into(),
                category: Some("work".into()),
                gen_id: None,
            }],
        );
        save_to(&path, &data).unwrap();
        // 子串
        let hits = search_core(&path, "会议", None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].date, "2026-10-12");
        // 拼音首字母
        let hits = search_core(&path, "dhhy", None);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].text.contains("电话会议"));
        // 分类过滤
        let hits = search_core(&path, "会议", Some("work"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].category.as_deref(), Some("work"));
        // 空查询 = 空
        assert!(search_core(&path, "  ", None).is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
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
