//! 索引扫描：多线程分块扫小写 arena。
//! 快路径 = UTF-16 子串包含；拼音通道对"纯 ASCII 查询 + 含汉字条目"先做
//! py_mask 必要条件预筛（一条 AND 指令），命中才解码跑 DP 确认——4.5M 条目
//! 的拼音查询由秒级降到毫秒级（建库期 `pinyin_letter_mask` 预生成）；
//! 通配符先取字面头做 u16 预筛，再解码匹配；ext: 过滤直接跑 u16 尾缀。
//! `!` 词对上述判定取反。命中数超过护栏即停（防路径词过滤饿死）。

use std::sync::atomic::{AtomicBool, Ordering};

use super::store::IndexView;
use super::table::{FLAG_DIR, contains_u8, contains_u16, ends_with_u16, wildcard_head};
use crate::fs::matcher::{NameTerm, Query, TypeFilter, wildcard_match};
use crate::fs::search::{pinyin_contains_chars, query_letter_mask};

/// 默认命中收集护栏（全盘搜索：路径过滤/排序前的上限；防高频词组合拖垮）
pub const OVER_COLLECT: usize = 20_000;
/// 目录范围索引搜索的护栏（更宽松；触顶即回退遍历保证完整性）
pub const SCOPED_OVER_COLLECT: usize = 50_000;

pub struct ScanOutcome {
    /// 命中条目下标（未排序）
    pub hits: Vec<u32>,
    /// true = 触及护栏（结果不完整）
    pub overflow: bool,
}

/// 名称词预编码：子串 → (neg, UTF-16, 小写原文, 查询掩码, 拼音词)；通配符 → (字面头, 完整
/// pattern)；ext → ".{ext}" 尾缀。bool = neg（`!` 取反词：判定命中后翻转）；
/// 拼音词 = 纯 ASCII 小写（matcher 拼音通道同门控）。
struct Prepared {
    terms: Vec<(bool, Vec<u16>, String, u32, bool)>,
    wilds: Vec<(bool, Vec<u16>, String)>,
    exts: Vec<(bool, Vec<Vec<u16>>)>,
}

impl Prepared {
    fn build(query: &Query) -> Prepared {
        let mut terms = Vec::new();
        let mut wilds = Vec::new();
        for (neg, t) in query.name_terms() {
            match t {
                NameTerm::Sub(s) => {
                    let qmask = query_letter_mask(&s);
                    let py_ok = s.chars().all(|c| c.is_ascii_lowercase());
                    terms.push((neg, s.encode_utf16().collect(), s, qmask, py_ok))
                }
                NameTerm::Wild(p) => {
                    let head = wildcard_head(&p);
                    wilds.push((neg, head.encode_utf16().collect(), p));
                }
            }
        }
        let exts = query
            .ext_alts()
            .into_iter()
            .map(|(neg, alts)| {
                let tails: Vec<Vec<u16>> = alts
                    .into_iter()
                    .map(|e| format!(".{e}").encode_utf16().collect())
                    .collect();
                (neg, tails)
            })
            .collect();
        Prepared { terms, wilds, exts }
    }
    fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.wilds.is_empty() && self.exts.is_empty()
    }
}

/// 扫描名表（类型过滤在扫描期用 flags 位完成；路径词过滤由调用方在命中集上做）
pub fn scan_view(
    view: &IndexView,
    query: &Query,
    tf: TypeFilter,
    cancel: &AtomicBool,
    over_collect: usize,
) -> ScanOutcome {
    let prep = Prepared::build(query);
    let entries = view.entries();
    let hits = std::sync::Mutex::new(Vec::<u32>::new());
    let stop = AtomicBool::new(false);
    let overflow = AtomicBool::new(false);

    if prep.is_empty() {
        // 无名称词/扩展名词（纯路径词或体积/时间词）不该走到这里（mod.rs 已回退），
        // 防御性返回空
        return ScanOutcome {
            hits: vec![],
            overflow: false,
        };
    }

    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8);
    let chunk = entries.len().div_ceil(workers).max(1);
    let prep = &prep;

    std::thread::scope(|scope| {
        for w in 0..workers {
            let range = (w * chunk)..(((w + 1) * chunk).min(entries.len()));
            if range.start >= range.end {
                continue;
            }
            let hits = &hits;
            let stop = &stop;
            let overflow = &overflow;
            scope.spawn(move || {
                for i in range {
                    if stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    let e = &entries[i];
                    if !tf.allows(e.flags & FLAG_DIR != 0) {
                        continue;
                    }
                    let el = view.entry_lower(e);
                    // 解码缓存：首个需要慢通道的条目才解码一次
                    let mut decoded: Option<String> = None;
                    let mut ok = true;
                    'terms: for (neg, s16, raw, qmask, py_ok) in &prep.terms {
                        let mut hit = contains_u16(el, s16);
                        if !hit && *py_ok {
                            // 首字母通道：建库期首字母串上 contains（精确，免解码免 DP）
                            if e.init_len > 0 && contains_u8(view.entry_initials(e), raw.as_bytes())
                            {
                                hit = true;
                            } else if e.py_mask != 0 && qmask & !e.py_mask == 0 {
                                // 全拼通道（多音字全部读音）：掩码必要条件预筛 + DP 确认
                                let name = decoded.get_or_insert_with(|| view.entry_name_string(e));
                                hit = pinyin_contains_chars(name.chars(), raw, false);
                            }
                        }
                        if hit != *neg {
                            continue;
                        }
                        ok = false;
                        break 'terms;
                    }
                    if ok {
                        for (neg, head16, pat) in &prep.wilds {
                            if !head16.is_empty() && !contains_u16(el, head16) {
                                // 预筛失败 = 模式必不匹配：正词淘汰，取反词通过
                                if *neg {
                                    continue;
                                }
                                ok = false;
                                break;
                            }
                            let name = decoded.get_or_insert_with(|| view.entry_name_string(e));
                            let hit = wildcard_match(pat.as_bytes(), name.as_bytes());
                            if hit != *neg {
                                continue;
                            }
                            ok = false;
                            break;
                        }
                    }
                    if ok {
                        for (neg, tails) in &prep.exts {
                            let hit = tails.iter().any(|t| ends_with_u16(el, t));
                            if hit != *neg {
                                continue;
                            }
                            ok = false;
                            break;
                        }
                    }
                    if ok {
                        let mut h = hits.lock().unwrap();
                        h.push(i as u32);
                        if h.len() >= over_collect {
                            overflow.store(true, Ordering::Relaxed);
                            stop.store(true, Ordering::Relaxed);
                        }
                    }
                }
            });
        }
    });

    ScanOutcome {
        hits: hits.into_inner().unwrap(),
        overflow: overflow.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::super::store::{VolumeMeta, save};
    use super::super::table::NameTable;
    use super::*;
    use std::path::PathBuf;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("xdir-scan-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn build_view(tag: &str) -> (PathBuf, IndexView) {
        let dir = tempdir(tag);
        let mut t = NameTable::new(5);
        // C:\ 客户A\凭证.xlsx / 客户A\回单.pdf / 底稿\报告.docx / readme.txt
        t.upsert(11, 5, "客户A", true);
        t.upsert(20, 5, "底稿", true);
        t.upsert(12, 11, "凭证.xlsx", false);
        t.upsert(13, 11, "回单.pdf", false);
        t.upsert(21, 20, "报告.docx", false);
        t.upsert(30, 5, "readme.txt", false);
        save(
            &dir,
            b'C',
            &t,
            VolumeMeta {
                volume_serial: 1,
                journal_id: 1,
                next_usn: 1,
            },
        )
        .unwrap();
        let view = IndexView::open(&super::super::store::index_path(&dir, b'C')).unwrap();
        (dir, view)
    }

    fn scan_all(view: &IndexView, q: &str, tf: TypeFilter) -> ScanOutcome {
        scan_view(
            view,
            &Query::parse(q),
            tf,
            &AtomicBool::new(false),
            OVER_COLLECT,
        )
    }

    fn names_of(view: &IndexView, o: &ScanOutcome) -> Vec<String> {
        let mut v: Vec<String> = o
            .hits
            .iter()
            .map(|&i| view.entry_name_string(&view.entries()[i as usize]))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn scan_substring_wildcard_pinyin_and_type() {
        let (dir, view) = build_view("main");
        // 中文子串
        let o = scan_all(&view, "凭证", TypeFilter::All);
        assert_eq!(names_of(&view, &o), vec!["凭证.xlsx"]);
        // 拼音首字母（含汉字条目才走慢通道）
        let o = scan_all(&view, "hd", TypeFilter::All);
        assert_eq!(names_of(&view, &o), vec!["回单.pdf"]);
        // 全拼
        let o = scan_all(&view, "pingzheng", TypeFilter::All);
        assert_eq!(names_of(&view, &o), vec!["凭证.xlsx"]);
        // 通配符
        let o = scan_all(&view, "*.pdf", TypeFilter::All);
        assert_eq!(names_of(&view, &o), vec!["回单.pdf"]);
        let o = scan_all(&view, "r*.txt", TypeFilter::All);
        assert_eq!(names_of(&view, &o), vec!["readme.txt"]);
        // 多词 AND（AND 作用于名称，父目录名不参与；路径圈定走路径词）
        let o = scan_all(&view, "凭证 xls", TypeFilter::All);
        assert_eq!(names_of(&view, &o), vec!["凭证.xlsx"]);
        let o = scan_all(&view, "凭证 回单", TypeFilter::All);
        assert!(names_of(&view, &o).is_empty());
        // 类型过滤：只搜文件夹
        let o = scan_all(&view, "", TypeFilter::Dirs);
        assert!(o.hits.is_empty()); // 空查询由命令层拦截；防御返回空
        let o = scan_all(&view, "A", TypeFilter::Dirs);
        assert_eq!(names_of(&view, &o), vec!["客户A"]);
        // "A" 经拼音通道会命中 回单(huidAn)，改用无歧义词验证 Files 空结果
        let o = scan_all(&view, "zzz", TypeFilter::Files);
        assert!(names_of(&view, &o).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_respects_cancel() {
        let (dir, view) = build_view("cancel");
        let cancel = AtomicBool::new(true);
        let o = scan_view(
            &view,
            &Query::parse("a"),
            TypeFilter::All,
            &cancel,
            OVER_COLLECT,
        );
        assert!(o.hits.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_ext_filter_and_negation() {
        let (dir, view) = build_view("extneg");
        // 扩展名过滤（u16 尾缀快路径，纯扩展名查询可走索引通道）
        let o = scan_all(&view, "ext:pdf", TypeFilter::All);
        assert_eq!(names_of(&view, &o), vec!["回单.pdf"]);
        let o = scan_all(&view, "ext:docx;xlsx", TypeFilter::All);
        assert_eq!(names_of(&view, &o), vec!["凭证.xlsx", "报告.docx"]);
        // 取反词：排除
        let o = scan_all(&view, "!ext:docx", TypeFilter::All);
        assert!(!names_of(&view, &o).contains(&"报告.docx".to_string()));
        assert!(names_of(&view, &o).contains(&"凭证.xlsx".to_string()));
        let o = scan_all(&view, "!凭证", TypeFilter::All);
        assert!(!names_of(&view, &o).contains(&"凭证.xlsx".to_string()));
        assert!(names_of(&view, &o).contains(&"回单.pdf".to_string()));
        // 纯取反词（无正词）也能收集命中
        let o = scan_all(&view, "!readme", TypeFilter::All);
        assert!(names_of(&view, &o).contains(&"回单.pdf".to_string()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 合成 60 万条目（1/3 纯 ASCII + 2/3 含汉字）的拼音扫描基准：
    /// 验证 py_mask 预筛后扫描量级（预期几十 ms；逐条 DP 时代为秒级）。
    /// 需要真实对比时 `cargo test bench_synthetic_pinyin_scan -- --ignored --nocapture`。
    #[test]
    #[ignore]
    fn bench_synthetic_pinyin_scan() {
        use std::time::Instant;
        let dir = tempdir("bench");
        let mut t = NameTable::new(5);
        for i in 0..600_000u64 {
            let name = match i % 3 {
                0 => format!("17898163{i:07}-wwcai-fx-rates"),
                1 => format!("客户{i}资料凭证{i}.xlsx"),
                _ => format!("王文铖{i}的会议纪要.docx"),
            };
            t.upsert(i, 5, &name, i % 10 == 0);
        }
        save(
            &dir,
            b'C',
            &t,
            VolumeMeta {
                volume_serial: 1,
                journal_id: 1,
                next_usn: 1,
            },
        )
        .unwrap();
        let view = IndexView::open(&super::super::store::index_path(&dir, b'C')).unwrap();
        let cancel = AtomicBool::new(false);
        // wwc = 子串+首字母双通道命中；wwd = 字母集常见、掩码拦不住的死查询（0 命中，
        // 只看耗时——DP 快版落地后应毫秒级）；kehu = 全拼通道
        for (q, expect_hits) in [("wwc", true), ("wwd", false), ("kehu", true)] {
            let t0 = Instant::now();
            let out = scan_view(
                &view,
                &Query::parse(q),
                TypeFilter::All,
                &cancel,
                OVER_COLLECT,
            );
            println!(
                "60 万条查询[{q}]: {:>8.1?}（命中 {}）",
                t0.elapsed(),
                out.hits.len()
            );
            assert_eq!(out.hits.is_empty(), !expect_hits, "查询 {q} 命中数不符");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
