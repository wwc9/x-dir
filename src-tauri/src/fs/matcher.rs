//! 搜索查询匹配器（遍历与 NTFS 索引两引擎共用语义）：
//! - 空格分隔多词 = AND（每词独立命中）；双引号短语 = 含空格的字面子串（不做通配符/拼音）
//! - 词含 `*` `?` → 通配符匹配（全名，大小写不敏感；`*` 任意串、`?` 单字符）
//! - 词含 `\` 或 `/` → 完整路径子串匹配（"/" 归一为 "\"，如 `财务/2025`）
//! - 词前 `!` → 排除（对该词的命中取反；适用于名称/路径/属性过滤词，如 `!旧` `!ext:tmp`）
//! - 属性过滤词（前缀大小写不敏感，`;` 分隔候选取 OR）：
//!   `ext:jpg;png` 扩展名（前导点可省）；`size:>100mb` 体积（`>` `>=` `<` `<=`、精确值、
//!   `A..B` / `A-B` 区间；单位 b/kb/mb/gb/tb）；`dm:today` 修改时间（today/yesterday/
//!   thisweek/lastweek/thismonth/lastmonth/thisyear/lastyear/last\<N\>days，或绝对日期
//!   2025 / 2025-06 / 2025-06-01，支持比较前缀与 `A..B` 区间，按本地时区对齐自然日）
//! - 其余 → 大小写不敏感子串；纯 ASCII 小写字母词对含汉字名称额外做两路拼音匹配：
//!   无声调全拼（多音字含全部读音）+ 拼音首字母（多音字取第一读音，"wdzl" ↔ "我的资料"）。
//!   2026-10-16 定案：首字母通道与 type-ahead 同用 `pinyin_initials` 语义——索引引擎
//!   预生成首字母 arena 做 contains 精确判定（免 DP），全拼通道走 py_mask 预筛 + DP。
//!
//! 命中语义 = 全部名称词命中名称 AND 全部路径词命中完整路径 AND 全部属性词通过
//! AND 类型过滤通过；`!` 词对其归属维度取反。只给路径词时全部名称命中（按路径圈定范围）。

use super::entry::FileEntry;
use super::search::{pinyin_contains_chars, pinyin_initials};

/// 结果类型过滤（"只搜文件夹" / "只搜文件"）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypeFilter {
    All,
    Files,
    Dirs,
}

impl TypeFilter {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("files") => TypeFilter::Files,
            Some("dirs") => TypeFilter::Dirs,
            _ => TypeFilter::All,
        }
    }
    pub fn allows(&self, is_dir: bool) -> bool {
        match self {
            TypeFilter::All => true,
            TypeFilter::Files => !is_dir,
            TypeFilter::Dirs => is_dir,
        }
    }
}

/// 名称词模式（均为小写形式；索引扫描需要逐词分派：子串走 u16 快路径，通配符解码后匹配）
#[derive(Clone, Debug)]
pub enum NameTerm {
    /// 普通子串（含拼音通道）
    Sub(String),
    /// 通配符模式（`*` `?`；不做拼音匹配）
    Wild(String),
}

#[derive(Clone, Debug)]
enum Term {
    Name {
        t: NameTerm,
        neg: bool,
    },
    /// 完整路径子串（小写、`\` 归一）
    Path {
        p: String,
        neg: bool,
    },
}

// ── 属性过滤（ext / size / dm）─────────────────────────────────────

/// 开区间端哨兵（无上界）
const OPEN: u64 = u64::MAX;

/// 一个属性词：`;` 候选取 OR，词前 `!` 整体取反
#[derive(Clone, Debug)]
struct AltSet<T> {
    neg: bool,
    alts: Vec<T>,
}

/// 体积区间 `[lo, hi)`（字节）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SizeRange {
    lo: u64,
    hi: u64,
}

/// 修改时间区间 `[from_ms, to_ms)`（Unix 毫秒；to_ms = OPEN 表示无上界）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DateRange {
    from_ms: u64,
    to_ms: u64,
}

/// 属性过滤集合：全部词通过（词内 OR、词间 AND）
#[derive(Clone, Debug, Default)]
pub struct AttrFilter {
    exts: Vec<AltSet<String>>,
    sizes: Vec<AltSet<SizeRange>>,
    dates: Vec<AltSet<DateRange>>,
}

impl AttrFilter {
    fn is_empty(&self) -> bool {
        self.exts.is_empty() && self.sizes.is_empty() && self.dates.is_empty()
    }

    /// 扩展名命中：名称小写尾部 `.{ext}`（"a.b.jpg" 的扩展名是 jpg；"jpgx" 不误命中）
    fn ext_hit(name_lower: &str, ext: &str) -> bool {
        name_lower.len() > ext.len() + 1
            && name_lower.ends_with(ext)
            && name_lower.as_bytes()[name_lower.len() - ext.len() - 1] == b'.'
    }

    /// 名称层判定（扩展名词；调用方在匹配名称时先行过滤，索引引擎可直接跑在小写名表上）
    fn allows_name(&self, name_lower: &str) -> bool {
        self.exts.iter().all(|a| {
            let hit = a.alts.iter().any(|e| Self::ext_hit(name_lower, e));
            hit != a.neg
        })
    }

    /// 元数据层判定（体积 + 修改时间；调用方需先备好 FileEntry）
    fn allows_meta(&self, e: &FileEntry) -> bool {
        self.sizes.iter().all(|a| {
            let hit = a.alts.iter().any(|r| r.lo <= e.size && e.size < r.hi);
            hit != a.neg
        }) && self.dates.iter().all(|a| {
            let hit = a
                .alts
                .iter()
                .any(|r| r.from_ms <= e.mtime_ms && e.mtime_ms < r.to_ms);
            hit != a.neg
        })
    }
}

// ── 「现在」上下文（dm: 日期词的锚点）──────────────────────────────

/// now_ms = Unix 毫秒；offset_ms = 本地时区相对 UTC 的偏移（本地毫秒 − UTC 毫秒）。
/// 测试注入固定值保证可复现；生产经 [`NowCtx::detect`] 读取系统本地时间。
#[derive(Clone, Copy, Debug)]
pub struct NowCtx {
    pub now_ms: u64,
    pub offset_ms: i64,
}

impl NowCtx {
    /// 测试/无时区场景：UTC
    #[cfg(test)]
    pub fn utc(now_ms: u64) -> Self {
        Self {
            now_ms,
            offset_ms: 0,
        }
    }

    /// 生产：系统时钟 + GetLocalTime 推算时区偏移
    pub fn detect() -> Self {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Self {
            now_ms,
            offset_ms: local_utc_offset_ms(now_ms),
        }
    }

    /// mtime（Unix ms）→ 本地日序数（1970-01-01 = 0）
    fn local_day(&self, ms: u64) -> i64 {
        (ms as i64 + self.offset_ms).div_euclid(86_400_000)
    }

    fn today(&self) -> i64 {
        self.local_day(self.now_ms)
    }

    /// 本地日序数 → Unix ms 区间 [当日 0 点, 次日 0 点)
    fn day_bounds(&self, day: i64) -> (u64, u64) {
        (
            (day * 86_400_000 - self.offset_ms) as u64,
            ((day + 1) * 86_400_000 - self.offset_ms) as u64,
        )
    }

    fn local_ymd(&self) -> (i64, u32, u32) {
        civil_from_days(self.today())
    }

    /// 本地年/月首日序数（m 越界自动进退位）
    fn month_day(&self, y: i64, m: i64) -> i64 {
        let (y2, m2) = if m < 1 {
            (y - 1, m + 12)
        } else if m > 12 {
            (y + 1, m - 12)
        } else {
            (y, m)
        };
        days_from_civil(y2, m2 as u32, 1)
    }

    fn day_range(&self, day: i64) -> DateRange {
        let (f, t) = self.day_bounds(day);
        DateRange {
            from_ms: f,
            to_ms: t,
        }
    }

    fn span_range(&self, from_day: i64, to_day_excl: i64) -> DateRange {
        DateRange {
            from_ms: self.day_bounds(from_day).0,
            to_ms: self.day_bounds(to_day_excl).0,
        }
    }
}

/// 本地时区偏移（本地毫秒 − UTC 毫秒）：GetLocalTime 与同一瞬间 UTC 差值
fn local_utc_offset_ms(now_ms: u64) -> i64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetLocalTime;
        let st = unsafe { GetLocalTime() };
        let local_ms = days_from_civil(st.wYear as i64, st.wMonth as u32, st.wDay as u32)
            * 86_400_000
            + st.wHour as i64 * 3_600_000
            + st.wMinute as i64 * 60_000
            + st.wSecond as i64 * 1000
            + st.wMilliseconds as i64;
        local_ms - (now_ms as i64)
    }
    #[cfg(not(windows))]
    {
        let _ = now_ms;
        0
    }
}

/// (y, m, d) → 自 1970-01-01 的天数（Howard Hinnant days_from_civil，纯历法无时区）
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 自 1970-01-01 的天数 → (y, m, d)（days_from_civil 逆变换）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 星期一=0 的星期几（1970-01-01 是周四=3）
fn weekday_monday0(day: i64) -> i64 {
    (day + 3).rem_euclid(7)
}

// ── 属性词解析 ─────────────────────────────────────────────────────

/// "1.5mb" → 字节数（单位 b/kb/mb/gb/tb 或单字母 k/m/g/t，无单位 = 字节）
fn parse_size_num(s: &str) -> Option<u64> {
    let s = s.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let mult: u64 = match unit.to_lowercase().as_str() {
        "" | "b" => 1,
        "k" | "kb" => 1024,
        "m" | "mb" => 1024 * 1024,
        "g" | "gb" => 1024 * 1024 * 1024,
        "t" | "tb" => 1024u64 * 1024 * 1024 * 1024,
        _ => return None,
    };
    let n: f64 = num.trim().parse().ok()?;
    (n >= 0.0).then_some((n * mult as f64) as u64)
}

/// 体积规格：`>N` `>=N` `<N` `<=N` `=N` 精确 `N`、`A..B` / `A-B` 区间
fn parse_size_spec(s: &str) -> Option<SizeRange> {
    let s = s.trim();
    if let Some(v) = s.strip_prefix(">=") {
        let n = parse_size_num(v)?;
        return Some(SizeRange { lo: n, hi: OPEN });
    }
    if let Some(v) = s.strip_prefix("<=") {
        let n = parse_size_num(v)?;
        return Some(SizeRange {
            lo: 0,
            hi: n.saturating_add(1),
        });
    }
    if let Some(v) = s.strip_prefix('>') {
        let n = parse_size_num(v)?;
        return Some(SizeRange {
            lo: n.saturating_add(1),
            hi: OPEN,
        });
    }
    if let Some(v) = s.strip_prefix('<') {
        let n = parse_size_num(v)?;
        return Some(SizeRange { lo: 0, hi: n });
    }
    if let Some(v) = s.strip_prefix('=') {
        let n = parse_size_num(v)?;
        return Some(SizeRange {
            lo: n,
            hi: n.saturating_add(1),
        });
    }
    if let Some((a, b)) = s.split_once("..") {
        let lo = if a.is_empty() { 0 } else { parse_size_num(a)? };
        let hi = if b.is_empty() {
            OPEN
        } else {
            parse_size_num(b)?
        };
        return Some(SizeRange { lo, hi: hi.max(lo) });
    }
    if let Some((a, b)) = s.split_once('-') {
        let lo = parse_size_num(a)?;
        let hi = parse_size_num(b)?;
        return Some(SizeRange { lo, hi: hi.max(lo) });
    }
    let n = parse_size_num(s)?;
    Some(SizeRange {
        lo: n,
        hi: n.saturating_add(1),
    })
}

/// 绝对日期词 → Unix ms 区间 [起点, 终点)：`2025` / `2025-06` / `2025-06-01`（`-` 或 `/` 分隔）
fn date_point(s: &str, ctx: &NowCtx) -> Option<DateRange> {
    let parts: Vec<i64> = s
        .split(['-', '/'])
        .map(|p| p.trim().parse().ok())
        .collect::<Option<_>>()?;
    let (y, m, d) = match parts.as_slice() {
        [y] => (*y, 1, 1),
        [y, m] if (1..=12).contains(m) => (*y, *m as u32, 1),
        [y, m, d] if (1..=12).contains(m) && (1..=31).contains(d) => (*y, *m as u32, *d as u32),
        _ => return None,
    };
    let day = days_from_civil(y, m, d);
    Some(match parts.len() {
        1 => ctx.span_range(day, ctx.month_day(y + 1, 1)),
        2 => ctx.span_range(day, ctx.month_day(y, m as i64 + 1)),
        _ => ctx.day_range(day),
    })
}

/// 修改时间规格：关键字 / 绝对日期 / 比较前缀 / `A..B` 区间（本地时区自然日对齐）
fn parse_date_spec(s: &str, ctx: &NowCtx) -> Option<DateRange> {
    let s = s.trim().to_lowercase();
    let today = ctx.today();
    let kw = match s.as_str() {
        "today" => Some(ctx.day_range(today)),
        "yesterday" => Some(ctx.day_range(today - 1)),
        "thisweek" => {
            let mon = today - weekday_monday0(today);
            Some(ctx.span_range(mon, today + 1))
        }
        "lastweek" => {
            let mon = today - weekday_monday0(today);
            Some(ctx.span_range(mon - 7, mon))
        }
        "thismonth" => {
            let (y, m, _) = ctx.local_ymd();
            Some(ctx.span_range(ctx.month_day(y, m as i64), ctx.month_day(y, m as i64 + 1)))
        }
        "lastmonth" => {
            let (y, m, _) = ctx.local_ymd();
            Some(ctx.span_range(ctx.month_day(y, m as i64 - 1), ctx.month_day(y, m as i64)))
        }
        "thisyear" => {
            let (y, _, _) = ctx.local_ymd();
            Some(ctx.span_range(ctx.month_day(y, 1), ctx.month_day(y + 1, 1)))
        }
        "lastyear" => {
            let (y, _, _) = ctx.local_ymd();
            Some(ctx.span_range(ctx.month_day(y - 1, 1), ctx.month_day(y, 1)))
        }
        _ => {
            // last<N>days：含今天的近 N 天（天对齐）
            s.strip_prefix("last")
                .and_then(|v| v.strip_suffix("days"))
                .and_then(|n| n.parse::<i64>().ok())
                .filter(|n| *n >= 1)
                .map(|n| ctx.span_range(today - n + 1, today + 1))
        }
    };
    if let Some(r) = kw {
        return Some(r);
    }
    if let Some((a, b)) = s.split_once("..") {
        let from = if a.is_empty() {
            0
        } else {
            date_point(a, ctx)?.from_ms
        };
        let to = if b.is_empty() {
            OPEN
        } else {
            date_point(b, ctx)?.to_ms
        };
        return Some(DateRange {
            from_ms: from,
            to_ms: to,
        });
    }
    for op in [">=", "<=", ">", "<"] {
        if let Some(v) = s.strip_prefix(op) {
            let p = date_point(v, ctx)?;
            return Some(match op {
                ">" => DateRange {
                    from_ms: p.to_ms,
                    to_ms: OPEN,
                },
                ">=" => DateRange {
                    from_ms: p.from_ms,
                    to_ms: OPEN,
                },
                "<" => DateRange {
                    from_ms: 0,
                    to_ms: p.from_ms,
                },
                _ => DateRange {
                    from_ms: 0,
                    to_ms: p.to_ms,
                },
            });
        }
    }
    date_point(&s, ctx)
}

// ── 查询 ───────────────────────────────────────────────────────────

/// 空白切词，双引号内不切（引号字符保留在词里，由解析分支剥壳）。
/// 未闭合引号 = 剩余整体一词（按普通词处理）。
fn split_ws_respect_quotes(q: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for c in q.chars() {
        if c == '"' {
            in_quote = !in_quote;
            cur.push(c);
        } else if c.is_whitespace() && !in_quote {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[derive(Clone, Debug, Default)]
pub struct Query {
    terms: Vec<Term>,
    attr: AttrFilter,
}

impl Query {
    /// 解析查询串：trim 后按空白切词。空查询（无词且无属性词）is_empty()=true。
    pub fn parse(q: &str) -> Query {
        Self::parse_with_now(q, &NowCtx::detect())
    }

    pub fn parse_with_now(q: &str, ctx: &NowCtx) -> Query {
        let mut terms = Vec::new();
        let mut attr = AttrFilter::default();
        for w in split_ws_respect_quotes(q) {
            let w = w.as_str();
            // 双引号短语 = 含空格的字面子串（含 * ? 也按字面，不做通配符/拼音）
            if w.len() >= 2 && w.starts_with('"') && w.ends_with('"') {
                let inner = w[1..w.len() - 1].to_lowercase();
                if !inner.is_empty() {
                    terms.push(Term::Name {
                        t: NameTerm::Sub(inner),
                        neg: false,
                    });
                }
                continue;
            }
            let (neg, word) = match w.strip_prefix('!') {
                Some(rest) if !rest.is_empty() => (true, rest),
                _ => (false, w),
            };
            let lower = word.to_lowercase();
            if let Some(v) = lower
                .strip_prefix("ext:")
                .or_else(|| lower.strip_prefix("extension:"))
            {
                let alts: Vec<String> = v
                    .split(';')
                    .map(|e| e.trim().trim_start_matches('.').to_string())
                    .filter(|e| !e.is_empty())
                    .collect();
                if !alts.is_empty() {
                    attr.exts.push(AltSet { neg, alts });
                }
            } else if let Some(v) = lower
                .strip_prefix("size:")
                .or_else(|| lower.strip_prefix("filesize:"))
            {
                let alts: Vec<SizeRange> = v.split(';').filter_map(parse_size_spec).collect();
                if !alts.is_empty() {
                    attr.sizes.push(AltSet { neg, alts });
                }
            } else if let Some(v) = lower
                .strip_prefix("dm:")
                .or_else(|| lower.strip_prefix("datemodified:"))
            {
                let alts: Vec<DateRange> = v
                    .split(';')
                    .filter_map(|d| parse_date_spec(d, ctx))
                    .collect();
                if !alts.is_empty() {
                    attr.dates.push(AltSet { neg, alts });
                }
            } else if lower.contains('\\') || lower.contains('/') {
                terms.push(Term::Path {
                    p: lower.replace('/', "\\"),
                    neg,
                });
            } else if lower.contains('*') || lower.contains('?') {
                terms.push(Term::Name {
                    t: NameTerm::Wild(lower),
                    neg,
                });
            } else {
                terms.push(Term::Name {
                    t: NameTerm::Sub(lower),
                    neg,
                });
            }
        }
        Query { terms, attr }
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.attr.is_empty()
    }

    pub fn has_path_terms(&self) -> bool {
        self.terms.iter().any(|t| matches!(t, Term::Path { .. }))
    }

    /// 是否含扩展名过滤词（决定纯扩展名查询能否走索引通道——扩展名直接跑在小写名表上）
    pub fn has_ext_terms(&self) -> bool {
        !self.attr.exts.is_empty()
    }

    /// 名称词清单（含取反标记；索引扫描按词分派快/慢路径）
    pub fn name_terms(&self) -> Vec<(bool, NameTerm)> {
        self.terms
            .iter()
            .filter_map(|t| match t {
                Term::Name { t, neg } => Some((*neg, t.clone())),
                _ => None,
            })
            .collect()
    }

    /// 扩展名词清单（含取反标记；索引扫描编译为小写名表 u16 尾缀）
    pub fn ext_alts(&self) -> Vec<(bool, Vec<String>)> {
        self.attr
            .exts
            .iter()
            .map(|a| (a.neg, a.alts.clone()))
            .collect()
    }

    /// 名称层属性判定（扩展名词；与 match_name 同点调用）
    pub fn attr_allows_name(&self, name_lower: &str) -> bool {
        self.attr.allows_name(name_lower)
    }

    /// 元数据层属性判定（体积/时间词；调用方需备好 FileEntry）
    pub fn attr_allows_meta(&self, e: &FileEntry) -> bool {
        self.attr.allows_meta(e)
    }

    /// 全部名称词是否命中（无名称词 = true）。`name_lower` 由调用方提供避免重复折叠。
    pub fn match_name(&self, name: &str, name_lower: &str) -> bool {
        for t in &self.terms {
            let Term::Name { t: pat, neg } = t else {
                continue;
            };
            let hit = match pat {
                NameTerm::Sub(s) => {
                    name_lower.contains(s.as_str())
                        || (s.chars().all(|c| c.is_ascii_lowercase())
                            && name.chars().any(is_hanzi)
                            && (pinyin_contains_chars(name.chars(), s, false)
                                || pinyin_initials(name).is_some_and(|ini| ini.contains(s))))
                }
                NameTerm::Wild(p) => wildcard_match(p.as_bytes(), name_lower.as_bytes()),
            };
            if hit == *neg {
                return false;
            }
        }
        true
    }

    /// 全部路径词是否命中完整路径（无路径词 = true）。传入小写完整路径；`!` 路径词取反。
    pub fn match_path(&self, path_lower: &str) -> bool {
        self.terms.iter().all(|t| match t {
            Term::Path { p, neg } => path_lower.contains(p.as_str()) != *neg,
            _ => true,
        })
    }
}

fn is_hanzi(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}')
}

/// 通配符匹配（贪心 + 回溯，单 `*` 记忆回退点；text 为小写字节）
pub fn wildcard_match(pat: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while t < text.len() {
        if p < pat.len() && (pat[p] == b'?' || pat[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pat.len() && pat[p] == b'*' {
            star = p;
            mark = t;
            p += 1;
        } else if star != usize::MAX {
            p = star + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pat.len() && pat[p] == b'*' {
        p += 1;
    }
    p == pat.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 固定"现在"：2026-10-16（周五）12:00 UTC
    fn ctx() -> NowCtx {
        NowCtx::utc(day_ms(2026, 10, 16) + 12 * 3_600_000)
    }

    fn day_ms(y: i64, m: u32, d: u32) -> u64 {
        (days_from_civil(y, m, d) * 86_400_000) as u64
    }

    fn name_hit(q: &str, name: &str) -> bool {
        let parsed = Query::parse_with_now(q, &ctx());
        parsed.match_name(name, &name.to_lowercase())
    }

    fn entry(size: u64, mtime_ms: u64) -> FileEntry {
        FileEntry {
            name: "a.bin".into(),
            path: "C:\\a.bin".into(),
            is_dir: false,
            size,
            mtime_ms,
            ctime_ms: 0,
            attrs: crate::fs::entry::FileAttrs {
                hidden: false,
                system: false,
                readonly: false,
            },
            py: None,
        }
    }

    #[test]
    fn parse_classifies_terms() {
        let q = Query::parse("报表 财务/2025 wd*.xlsx");
        assert_eq!(q.terms.len(), 3);
        assert!(q.has_path_terms());
        // 空白查询
        assert!(Query::parse("   ").is_empty());
        // 名称词/路径词分派：2 个名称词 + 1 个路径词
        assert_eq!(q.name_terms().len(), 2);
    }

    #[test]
    fn multi_term_is_and() {
        let q = Query::parse("2026 报表");
        assert!(q.match_name("2026年度报表.xlsx", "2026年度报表.xlsx"));
        assert!(!q.match_name("2026年度.xlsx", "2026年度.xlsx"));
        assert!(!q.match_name("年度报表.xlsx", "年度报表.xlsx"));
    }

    #[test]
    fn wildcard_star_and_question() {
        // 通配符按 Everything 语义 = 全名匹配（非子串）
        let q = Query::parse("*.xlsx");
        assert!(q.match_name("预算表.XLSX", "预算表.xlsx"));
        assert!(!q.match_name("预算表.pdf", "预算表.pdf"));
        assert!(!q.match_name("预算表.xlsx.bak", "预算表.xlsx.bak"));
        let q = Query::parse("report-??26");
        assert!(q.match_name("report-2026", "report-2026"));
        assert!(!q.match_name("report-2026.txt", "report-2026.txt"));
        assert!(!q.match_name("report-12026", "report-12026"));
        // 通配符词不做拼音
        let q = Query::parse("wd*");
        assert!(!q.match_name("我的资料", "我的资料"));
    }

    #[test]
    fn quoted_phrase_is_literal() {
        // 短语含空格不切词，字面子串命中
        assert!(name_hit("\"报表 2026\"", "2026年度报表 2026版.docx"));
        assert!(!name_hit("\"报表 2026\"", "2026年度报表2026版.docx"));
        // 短语内通配符按字面
        assert!(!name_hit("\"a*b\"", "axxb"));
        // 引号破坏：不成对的引号按普通词
        assert!(name_hit("\"abc", "\"abc"));
    }

    #[test]
    fn negation_excludes() {
        // 名称排除
        assert!(!name_hit("报表 !旧", "报表-旧版.xlsx"));
        assert!(name_hit("报表 !旧", "报表-新版.xlsx"));
        // 排除词含拼音命中（排除"我的资料"的拼音 wdzl）
        assert!(!name_hit("!wdzl", "我的资料.docx"));
        assert!(name_hit("!wdzl", "预算表.xlsx"));
        // 路径排除
        let q = Query::parse("log !C:/Windows");
        assert!(q.match_path("d:\\app\\run.log"));
        assert!(!q.match_path("c:\\windows\\win.log"));
    }

    #[test]
    fn ext_filter() {
        let q = Query::parse("ext:jpg;pdf");
        assert!(q.attr_allows_name("照片.jpg"));
        assert!(q.attr_allows_name("报告.pdf"));
        assert!(!q.attr_allows_name("照片.png"));
        assert!(!q.attr_allows_name("照片.jpgx"));
        assert!(!q.attr_allows_name("jpg"));
        // 前导点可省写、大小写不敏感
        let q = Query::parse("ext:.PNG");
        assert!(q.attr_allows_name("照片.png"));
        // 取反
        let q = Query::parse("!ext:tmp;log");
        assert!(!q.attr_allows_name("a.tmp"));
        assert!(q.attr_allows_name("a.xlsx"));
        // 纯扩展名查询非空（索引通道门槛）
        assert!(!Query::parse("ext:jpg").is_empty());
        assert!(Query::parse("ext:").is_empty());
        assert!(Query::parse("ext:jpg").has_ext_terms());
    }

    #[test]
    fn size_filter() {
        let mb = 1024 * 1024;
        let q = Query::parse("size:>10mb");
        assert!(q.attr_allows_meta(&entry(10 * mb + 1, 0)));
        assert!(!q.attr_allows_meta(&entry(10 * mb, 0)));
        let q = Query::parse("size:1mb..10mb");
        assert!(q.attr_allows_meta(&entry(mb, 0)));
        assert!(!q.attr_allows_meta(&entry(10 * mb, 0)));
        let q = Query::parse("size:1mb-10mb");
        assert!(q.attr_allows_meta(&entry(5 * mb, 0)));
        let q = Query::parse("size:100");
        assert!(q.attr_allows_meta(&entry(100, 0)));
        assert!(!q.attr_allows_meta(&entry(101, 0)));
        let q = Query::parse("size:<2k");
        assert!(q.attr_allows_meta(&entry(2047, 0)));
        assert!(!q.attr_allows_meta(&entry(2048, 0)));
        let q = Query::parse("size:>=1.5mb");
        assert!(q.attr_allows_meta(&entry(mb + mb / 2, 0)));
        // 取反
        let q = Query::parse("!size:>1gb");
        assert!(!q.attr_allows_meta(&entry(2 * 1024 * mb, 0)));
        assert!(q.attr_allows_meta(&entry(100, 0)));
    }

    #[test]
    fn date_filter_keywords() {
        let c = ctx();
        let today_ms = c.day_bounds(c.today()).0 + 3_600_000;
        let q = Query::parse_with_now("dm:today", &c);
        assert!(q.attr_allows_meta(&entry(0, today_ms)));
        assert!(!q.attr_allows_meta(&entry(0, today_ms - 86_400_000)));
        let q = Query::parse_with_now("dm:yesterday", &c);
        assert!(q.attr_allows_meta(&entry(0, today_ms - 86_400_000)));
        let q = Query::parse_with_now("dm:last7days", &c);
        assert!(q.attr_allows_meta(&entry(0, today_ms - 6 * 86_400_000)));
        assert!(!q.attr_allows_meta(&entry(0, today_ms - 7 * 86_400_000)));
        // 本周（周一为一周起点；2026-10-16 是周五，周一 = 10-12）
        let q = Query::parse_with_now("dm:thisweek", &c);
        let monday = day_ms(2026, 10, 12) + 1_800_000;
        assert!(q.attr_allows_meta(&entry(0, monday)));
        assert!(!q.attr_allows_meta(&entry(0, monday - 86_400_000)));
        // 大小写不敏感
        let q = Query::parse_with_now("DM:Today", &c);
        assert!(q.attr_allows_meta(&entry(0, today_ms)));
    }

    #[test]
    fn date_filter_absolute_and_ranges() {
        let c = ctx();
        let q = Query::parse_with_now("dm:2025", &c);
        assert!(q.attr_allows_meta(&entry(0, day_ms(2025, 6, 1))));
        assert!(!q.attr_allows_meta(&entry(0, day_ms(2024, 6, 1))));
        let q = Query::parse_with_now("dm:2025-06", &c);
        assert!(q.attr_allows_meta(&entry(0, day_ms(2025, 6, 15))));
        assert!(!q.attr_allows_meta(&entry(0, day_ms(2025, 7, 1))));
        let q = Query::parse_with_now("dm:2025-06-15", &c);
        assert!(q.attr_allows_meta(&entry(0, day_ms(2025, 6, 15) + 50_000)));
        assert!(!q.attr_allows_meta(&entry(0, day_ms(2025, 6, 16))));
        // 区间与开放端
        let q = Query::parse_with_now("dm:2025-01..2025-06", &c);
        assert!(q.attr_allows_meta(&entry(0, day_ms(2025, 3, 1))));
        assert!(!q.attr_allows_meta(&entry(0, day_ms(2025, 7, 1))));
        let q = Query::parse_with_now("dm:2025-06..", &c);
        assert!(q.attr_allows_meta(&entry(0, c.now_ms)));
        let q = Query::parse_with_now("dm:>2025-12-31", &c);
        assert!(q.attr_allows_meta(&entry(0, day_ms(2026, 1, 2))));
        assert!(!q.attr_allows_meta(&entry(0, day_ms(2025, 12, 31))));
    }

    #[test]
    fn calendar_round_trip_and_anchor() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        for (y, m, d) in [
            (2026, 10, 16),
            (1970, 1, 1),
            (2000, 2, 29),
            (2024, 2, 29),
            (1969, 12, 31),
        ] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
        // 周几：2026-10-16 是周五（4）
        assert_eq!(weekday_monday0(days_from_civil(2026, 10, 16)), 4);
        assert_eq!(weekday_monday0(days_from_civil(2026, 10, 12)), 0);
    }

    #[test]
    fn path_terms_match_full_path_only() {
        let q = Query::parse("财务/2025");
        let path = "c:\\客户\\财务\\2025\\报表.xlsx";
        assert!(q.match_path(&path.to_lowercase()));
        assert!(!q.match_path("c:\\财务\\2024\\a.xlsx"));
        // 名称词为空 = 全部名称命中
        assert!(q.match_name("任意", "任意"));
        // 混合：名称词 + 路径词都要过
        let q = Query::parse("报表 财务\\2025");
        assert!(q.match_name("报表.xlsx", "报表.xlsx") && q.match_path(path));
        assert!(!q.match_name("底稿.xlsx", "底稿.xlsx") && q.match_path(path));
    }

    #[test]
    fn pinyin_channel_unchanged() {
        let q = Query::parse("wdzl");
        assert!(q.match_name("我的资料", "我的资料"));
        assert!(q.match_name("我的资料.docx", "我的资料.docx"));
        // 多音字
        let q = Query::parse("zhongqing");
        assert!(q.match_name("重庆方案", "重庆方案"));
        // 纯中文走子串
        let q = Query::parse("资料");
        assert!(q.match_name("我的资料", "我的资料"));
        // 拼音不误命中无汉字名称
        let q = Query::parse("zpsc");
        assert!(!q.match_name("photos", "photos"));
    }

    #[test]
    fn type_filter() {
        assert!(TypeFilter::parse(None).allows(true) && TypeFilter::parse(None).allows(false));
        assert!(TypeFilter::parse(Some("files")).allows(false));
        assert!(!TypeFilter::parse(Some("files")).allows(true));
        assert!(TypeFilter::parse(Some("dirs")).allows(true));
        assert!(!TypeFilter::parse(Some("dirs")).allows(false));
        assert!(TypeFilter::parse(Some("nonsense")).allows(true));
    }

    #[test]
    fn wildcard_implementation_edge_cases() {
        assert!(wildcard_match(b"*", b"anything"));
        assert!(wildcard_match(b"a*b*c", b"aXXbYYc"));
        assert!(wildcard_match(b"a*b*c", b"abc"));
        assert!(!wildcard_match(b"a*b*c", b"aXXbYY"));
        assert!(wildcard_match(b"??", b"ab"));
        assert!(!wildcard_match(b"??", b"a"));
        // 尾部连续 * 收敛
        assert!(wildcard_match(b"abc***", b"abc"));
        assert!(wildcard_match(b"*a*", b"ba"));
    }
}
