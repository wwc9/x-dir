//! Excel numFmt 渲染（2026-11-11 表格预览增强）：calamine 0.38 起可经
//! `worksheet_style()` 读每个单元格的数字格式码（StyleRange → Style →
//! NumberFormat.format_code，仅 XLSX/XLSM 支持），但 calamine 只给原始值
//! 不做格式化（issue #424）。本模块把「值 + 格式码」渲染成 Excel 显示文本：
//! 修复小数位过长（0.00/#,##0.00 等截位）、百分数（0.0819 → 8.19%）、
//! 千分位、货币字面量、General 11 位有效数截断（Excel 同口径）。
//!
//! 覆盖范围 = 真实表格 95% 场景的格式码子集：数值（0/#/?/./, 占位）、
//! 百分数、日期时间（y/m/d/h/s + AM/PM，含 m 的月/分钟消歧）、科学计数
//! （E+00）、引号字面量、[货币-locale] 前缀、正负分区（; 分隔，负区渲染
//! 绝对值由分区内字面量表达括号/负号）。分数 [DBNum] 等罕见码回落 General。

use calamine::Data;

/// 单元格显示文本：值 + 数字格式码 → Excel 显示字符串。code = None 或
/// General 码走 General 渲染（浮点按 11 位有效数截断，不再输出
/// -2191.50375371322 这类全精度尾巴）。
pub fn display_for(data: &Data, code: Option<&str>) -> String {
    let raw = match data {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Data::Error(e) => e.to_string(),
        Data::DateTime(dt) => match code {
            // 有格式码按码渲染（yyyy/m/d 等文件自身口径）；无码回落 ISO 口径
            Some(c) if !is_general(c) => render_datetime(dt.as_f64(), c),
            _ => crate::fs::xlsx::format_datetime(dt),
        },
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Int(i) => match code {
            Some(c) if !is_general(c) => render_num(*i as f64, c),
            _ => i.to_string(),
        },
        Data::Float(f) => match code {
            Some(c) if !is_general(c) => render_num(*f, c),
            _ => general_float(*f),
        },
    };
    raw.replace("\r\n", "\n").replace(['\r', '\n', '\t'], " ")
}

/// General 码判定：空 / General / GENERAL（Excel「常规」；其余一律按码渲染）
fn is_general(code: &str) -> bool {
    let c = code.trim();
    c.is_empty() || c.eq_ignore_ascii_case("general")
}

/// Excel General 浮点（11 位有效数截断 + 尾零去除 + 大数/极小数科学计数）。
/// 修复 Rust {} 全精度输出（0.0819348994483414 这类长尾）。
pub fn general_float(f: f64) -> String {
    if f == 0.0 {
        return "0".into();
    }
    let a = f.abs();
    // Excel General：|v| ≥ 1e11 或 |v| < 1e-4（非零）转科学计数（尾数 5 位小数）
    if a >= 1e11 || a < 1e-4 {
        let s = format!("{:.5e}", f); // 形如 "-1.23450e15"
        // 归一为 Excel 形态：1.23450E+15（指数至少 2 位、显式符号）
        let (mant, exp) = s.split_once('e').unwrap_or((s.as_str(), "0"));
        let ev: i32 = exp.parse().unwrap_or(0);
        return format!("{mant}E{ev:+03}");
    }
    if f.fract() == 0.0 && a < 1e11 {
        return format!("{}", f as i64);
    }
    // 11 位有效数对应的小数位 = 11 - 整数位位数（log10 下取整 + 1，分数段
    // 为 0/负：0.0819… → int_digits = -1 → 12 位小数）
    let int_digits = a.log10().floor() as i32 + 1;
    let prec = (11 - int_digits).clamp(0, 15) as usize;
    let mut s = format!("{f:.prec$}");
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    s
}

// ── 格式码解析 ──

/// 分区切分（引号/方括号内的 ';' 不切）：1 = 全值；2 = 正;负（负区渲染绝对
/// 值，正负号由分区内字面量表达）；3 = 正;负;零；第 4 区 = 文本（数值不用）
fn split_sections(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut in_bracket = false;
    for ch in code.chars() {
        match ch {
            '"' => {
                in_quote = !in_quote;
                cur.push(ch);
            }
            '[' if !in_quote => {
                in_bracket = true;
                cur.push(ch);
            }
            ']' if !in_quote => {
                in_bracket = false;
                cur.push(ch);
            }
            ';' if !in_quote && !in_bracket => {
                out.push(std::mem::take(&mut cur));
            }
            _ => cur.push(ch),
        }
    }
    out.push(cur);
    out
}

/// 码分类：日期 / 时间 / 文本(@) / 数值
#[derive(PartialEq)]
enum Kind {
    Date,
    Time,
    Text,
    Num,
}

/// 码内核（去引号字面量与 [..] 括注后的占位字符流）+ 字面量前后缀提取
struct ParsedCode {
    kind: Kind,
    /// 数值段占位流（0 # ? . , % E+/- 的连续占位区）
    core: String,
    /// 字面量 token（按出现序：货币符号 / 引号文本）；渲染时占位流位置输出数值
    lits: Vec<(bool, String)>, // (before_num, text)
    dec: usize,
    group: bool,
    pct: u32,
    sci: bool,
    parens: bool,
}

/// 解析单分区：词法扫描（引号字面量 / [货币-xx] 括注 / 占位流 / E+00）。
/// 字面量按位置分前后两桶：占位流之前的在数值前输出、之后的在后输出
/// （"yyyy-mm-dd" 的 '-'、"0.00\"元\"" 的「元」、"(#,##0.00)" 的括号）
fn parse_section(sec: &str) -> ParsedCode {
    fn flush(p: &mut ParsedCode, lit: &mut String, before: bool) {
        if !lit.is_empty() {
            p.lits.push((before, std::mem::take(lit)));
        }
    }
    let chars: Vec<char> = sec.chars().collect();
    let mut p = ParsedCode {
        kind: Kind::Num,
        core: String::new(),
        lits: Vec::new(),
        dec: 0,
        group: false,
        pct: 0,
        sci: false,
        parens: false,
    };
    let mut lit = String::new();
    let mut in_quote = false;
    let mut i = 0;
    let mut seen_placeholder = false;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '"' => {
                if in_quote {
                    flush(&mut p, &mut lit, !seen_placeholder);
                }
                in_quote = !in_quote;
            }
            '[' if !in_quote => {
                // [货币-locale] 取货币符号；[Red]/[条件] 忽略
                let mut body = String::new();
                i += 1;
                while i < chars.len() && chars[i] != ']' {
                    body.push(chars[i]);
                    i += 1;
                }
                flush(&mut p, &mut lit, !seen_placeholder);
                if let Some(sym) = body.strip_prefix('$') {
                    let sym = sym.split('-').next().unwrap_or(sym);
                    p.lits.push((!seen_placeholder, sym.to_string()));
                }
                if body.contains('(') {
                    p.parens = true;
                }
            }
            '\\' if !in_quote => {
                // 反斜杠转义的单字符字面量（如 \-）
                i += 1;
                if i < chars.len() {
                    p.lits.push((!seen_placeholder, chars[i].to_string()));
                }
            }
            _ if in_quote => lit.push(ch),
            '@' => {
                flush(&mut p, &mut lit, !seen_placeholder);
                p.kind = Kind::Text;
                seen_placeholder = true;
            }
            'y' | 'Y' | 'd' | 'D' => {
                flush(&mut p, &mut lit, !seen_placeholder);
                p.kind = Kind::Date;
                p.core.push(ch.to_ascii_lowercase());
                seen_placeholder = true;
            }
            'h' | 'H' | 's' | 'S' => {
                flush(&mut p, &mut lit, !seen_placeholder);
                if p.kind != Kind::Date {
                    p.kind = Kind::Time;
                }
                p.core.push(ch.to_ascii_lowercase());
                seen_placeholder = true;
            }
            'm' | 'M' => {
                flush(&mut p, &mut lit, !seen_placeholder);
                // m 消歧：前邻 h = 分钟、后邻 s = 分钟，否则月份
                let prev = p.core.chars().last();
                let next = chars.get(i + 1).copied();
                let as_min = matches!(prev, Some('h')) || matches!(next, Some('s') | Some('S'));
                p.core.push(if as_min { 'i' } else { 'm' });
                seen_placeholder = true;
            }
            '%' => {
                flush(&mut p, &mut lit, !seen_placeholder);
                p.pct += 1;
                seen_placeholder = true;
            }
            'E' | 'e' if matches!(chars.get(i + 1), Some('+') | Some('-')) => {
                flush(&mut p, &mut lit, !seen_placeholder);
                p.sci = true;
                seen_placeholder = true;
                i += 1; // 跳过 +/-（指数符号渲染时按值重生成）
            }
            '0' | '#' | '?' | '.' | ',' if !in_quote => {
                flush(&mut p, &mut lit, !seen_placeholder);
                if ch == ',' {
                    // 占位间逗号 = 千分位；前置逗号（千倍缩放）不支持，忽略
                    if !p.core.is_empty() {
                        p.group = true;
                    }
                } else {
                    p.core.push(ch);
                    if p.core.contains('.') && ch == '0' {
                        p.dec += 1;
                    }
                }
                seen_placeholder = true;
            }
            '(' if !in_quote => {
                flush(&mut p, &mut lit, !seen_placeholder);
                p.parens = true;
                p.lits.push((true, "(".into()));
                seen_placeholder = false;
            }
            ')' if !in_quote => {
                flush(&mut p, &mut lit, false);
                p.parens = true;
                p.lits.push((false, ")".into()));
            }
            '+' | '-' if !in_quote && p.sci => {}
            '+' | '-' if !in_quote => lit.push(ch),
            c if !in_quote => {
                if c.is_whitespace() {
                    flush(&mut p, &mut lit, !seen_placeholder);
                    p.lits.push((!seen_placeholder, " ".into()));
                } else {
                    lit.push(c);
                }
            }
            _ => {}
        }
        i += 1;
    }
    flush(&mut p, &mut lit, true);
    p
}

/// 数值段渲染：绝对值按小数位/千分位分组
fn render_num_part(v: f64, dec: usize, group: bool) -> String {
    let s = format!("{v:.dec$}");
    if !group {
        return s;
    }
    let (int, frac) = match s.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (s.as_str(), None),
    };
    let neg = int.starts_with('-');
    let digits = if neg { &int[1..] } else { int };
    let mut g = String::new();
    for (k, c) in digits.chars().enumerate() {
        if k > 0 && (digits.len() - k) % 3 == 0 {
            g.push(',');
        }
        g.push(c);
    }
    let mut out = if neg { "-".to_string() } else { String::new() };
    out.push_str(&g);
    if let Some(fr) = frac {
        out.push('.');
        out.push_str(fr);
    }
    out
}

/// 百分数渲染：值 × 100^pct 后按码渲染，'%' 字面量随 token 序输出
fn render_percent_like(v: f64, p: &ParsedCode) -> String {
    let scaled = v * 100f64.powi(p.pct as i32);
    let (num_body, _) = split_num_tokens(&p.core);
    let dec = p.dec;
    let mut out = String::new();
    for (before, text) in &p.lits {
        if *before {
            out.push_str(text);
        }
    }
    let abs = scaled.abs();
    let mut num = render_num_part(abs, dec, p.group);
    if p.sci {
        num = sci_form(abs, dec);
    }
    out.push_str(&num);
    out.push_str(&"%".repeat(p.pct as usize));
    for (before, text) in &p.lits {
        if !*before {
            out.push_str(text);
        }
    }
    let _ = num_body;
    out
}

/// 占位流 → 数值小数位（'.' 之后计 0/#/?）与分组标志已在 parse 阶段落定；
/// split 仅用于 E 科学的尾数位推断
fn split_num_tokens(core: &str) -> (String, ()) {
    (core.to_string(), ())
}

/// 科学计数：尾数按 E 前小数位、指数显式符号 + 至少 2 位
fn sci_form(v: f64, dec: usize) -> String {
    let s = format!("{v:.dec$e}");
    // Rust "1.23e15" → Excel "1.23E+15"
    match s.split_once('e') {
        Some((m, e)) => {
            let ev: i32 = e.parse().unwrap_or(0);
            format!("{m}E{ev:+03}")
        }
        None => s,
    }
}

/// 数值渲染（含分区选择：负值走第 2 分区渲染绝对值；括号由分区内字面量携带）
pub fn render_num(v: f64, code: &str) -> String {
    let sections = split_sections(code);
    let neg = v < 0.0;
    let sec = match sections.len() {
        0 | 1 => sections.first().map(|s| (s, v)),
        2 => {
            if neg {
                sections.get(1).map(|s| (s, v.abs()))
            } else {
                sections.first().map(|s| (s, v))
            }
        }
        _ => {
            if neg {
                sections.get(1).map(|s| (s, v.abs()))
            } else if v == 0.0 {
                sections.get(2).map(|s| (s, 0.0))
            } else {
                sections.first().map(|s| (s, v))
            }
        }
    };
    let Some((sec_str, val)) = sec else {
        return general_float(v);
    };
    let p = parse_section(sec_str);
    if p.kind == Kind::Text {
        return general_float(val);
    }
    if p.kind == Kind::Date || p.kind == Kind::Time {
        return render_datetime(val, sec_str);
    }
    if p.pct > 0 {
        let mut out = render_percent_like(val, &p);
        if neg && sections.len() == 1 {
            out = format!("-{out}");
        }
        return out;
    }
    let mut out = String::new();
    for (before, text) in &p.lits {
        if *before {
            out.push_str(text);
        }
    }
    let abs = val.abs();
    let mut num = render_num_part(abs, p.dec, p.group);
    if p.sci {
        num = sci_form(abs, p.dec);
    }
    out.push_str(&num);
    for (before, text) in &p.lits {
        if !*before {
            out.push_str(text);
        }
    }
    // 括号已由分区内 '(' ')' 字面量按位携带（负区），此处不再二次包裹
    if neg && sections.len() <= 1 {
        out = format!("-{out}");
    }
    out
}

/// Excel 序列数 → (年, 月, 日, 时, 分, 秒)。1900 日期系统：序列 1 = 1900-01-01；
/// 序列 60 = 不存在的 1900-02-29（历史闰年 bug），<61 段按 1899-12-31 基准平移。
fn excel_ymd_hms(serial: f64) -> (i64, u32, u32, u32, u32, u32) {
    let serial = serial.max(0.0);
    let days = serial.floor() as i64;
    let frac = serial - serial.floor();
    let unix_days = if days < 61 {
        days - 25_568
    } else {
        days - 25_569
    };
    // Hinnant civil-from-days（unix 天 → 公历）
    let z = unix_days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let yy = if m <= 2 { y + 1 } else { y };
    let total_secs = (frac * 86_400.0).round() as i64;
    let h = (total_secs / 3600) as u32;
    let mi = ((total_secs % 3600) / 60) as u32;
    let s = (total_secs % 60) as u32;
    (yy, m, d, h, mi, s)
}

/// 日期时间渲染：按码 token（y 年 / m 月 / i 分 / d 日 / h 时 / s 秒，连续同
/// 字符决定位数）+ AM/PM；无码回落 yyyy-mm-dd hh:mm:ss
pub fn render_datetime(serial: f64, code: &str) -> String {
    let (y, mo, d, h, mi, s) = excel_ymd_hms(serial);
    let sec = split_sections(code);
    let code = sec.first().map(|s| s.as_str()).unwrap_or(code);
    let mut lower: String = code
        .chars()
        .filter(|c| !matches!(c, '"' | '[' | ']'))
        .collect::<String>()
        .to_ascii_lowercase();
    // 12 小时制：码含 am/pm（token 先摘除，防其中的 m 被当月份解析）
    let ampm_tokens = ["am/pm", "a/p"].iter().any(|t| lower.contains(t));
    for t in ["am/pm", "a/p"] {
        lower = lower.replace(t, "");
    }
    let lower = lower.trim().to_string();
    let (h12, ap) = if ampm_tokens {
        let (hh, tag) = match h {
            0 => (12, "AM"),
            1..=11 => (h, "AM"),
            12 => (12, "PM"),
            _ => (h - 12, "PM"),
        };
        (hh, tag)
    } else {
        (h, "")
    };
    let mut out = String::new();
    let chars: Vec<char> = lower.chars().collect();
    let mut i = 0;
    // 最近一次处理的日期 token（跨过 '-' 等字面量回看，供 m 的月/分消歧）
    let mut last_tok: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        if !"ymdhis".contains(c) {
            if c != '"' {
                out.push(c);
            }
            i += 1;
            continue;
        }
        let mut run = 0;
        while i + run < chars.len() && chars[i + run] == c {
            run += 1;
        }
        // m 消歧：前 token 是 h → 分；后 token 是 s → 分
        let as_min =
            c == 'm' && (last_tok == Some('h') || chars.get(i + run).copied() == Some('s'));
        let n2 = |v: u32| format!("{v:02}");
        match c {
            'y' => {
                if run >= 3 {
                    out.push_str(&format!("{y:04}"));
                } else {
                    out.push_str(&format!("{}", y % 100));
                }
            }
            'm' => {
                if as_min {
                    out.push_str(&n2(mi));
                } else if run >= 2 {
                    out.push_str(&n2(mo));
                } else {
                    out.push_str(&mo.to_string());
                }
            }
            'i' => out.push_str(&n2(mi)),
            'd' => {
                if run >= 2 {
                    out.push_str(&n2(d));
                } else {
                    out.push_str(&d.to_string());
                }
            }
            'h' => {
                if ampm_tokens {
                    if run >= 2 {
                        out.push_str(&n2(h12));
                    } else {
                        out.push_str(&h12.to_string());
                    }
                } else if run >= 2 {
                    out.push_str(&n2(h));
                } else {
                    out.push_str(&h.to_string());
                }
            }
            's' => out.push_str(&n2(s)),
            _ => {}
        }
        last_tok = Some(if as_min { 'i' } else { c });
        i += run;
    }
    if ampm_tokens {
        out.push(' ');
        out.push_str(ap);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 百分数：0.0819… 按 0.00% → 8.19%（用户报障样例：占比列长小数）
    #[test]
    fn percent_code_scales_and_trims() {
        assert_eq!(render_num(0.0819348994483414, "0.00%"), "8.19%");
        assert_eq!(render_num(1.0, "0%"), "100%");
        assert_eq!(render_num(0.05779199748815838, "0.00%"), "5.78%");
    }

    /// 小数位截断：-2191.50375371322 按 0.00 → -2191.50（用户报障样例：金额列）
    #[test]
    fn decimal_code_trims_precision() {
        assert_eq!(render_num(-2191.50375371322, "0.00"), "-2191.50");
        assert_eq!(render_num(-2228389.327854, "#,##0.00"), "-2,228,389.33");
        assert_eq!(render_num(7636.5891, "0.0000"), "7636.5891");
    }

    /// General 浮点：11 位有效数截断 + 尾零去除 + 整数不加小数点
    #[test]
    fn general_float_trims_significand() {
        assert_eq!(general_float(0.0819348994483414), "0.081934899448");
        assert_eq!(general_float(44927.0), "44927");
        assert_eq!(general_float(-55593.6811282132), "-55593.681128");
        assert_eq!(general_float(0.5), "0.5");
    }

    /// 日期时间序列数：44927 = 2023-01-01（Excel 锚点日期）
    #[test]
    fn datetime_serial_renders_by_code() {
        assert_eq!(render_datetime(44927.0, "yyyy/m/d"), "2023/1/1");
        assert_eq!(
            render_datetime(44927.5, "yyyy-mm-dd hh:mm"),
            "2023-01-01 12:00"
        );
        assert_eq!(
            render_datetime(44927.0, "yyyy\"年\"m\"月\"d\"日\""),
            "2023年1月1日"
        );
        // AM/PM：token 摘除后 m 不再被误判
        assert_eq!(render_datetime(44927.5, "h:mm AM/PM"), "12:00 PM");
    }

    /// 负数分区：`0.00;(0.00)` 负值渲染括号（审计口径）
    #[test]
    fn negative_section_uses_parens() {
        assert_eq!(render_num(-1234.5, "0.00;(0.00)"), "(1234.50)");
        assert_eq!(render_num(1234.5, "0.00;(0.00)"), "1234.50");
    }

    /// 千分位 + 货币字面量
    #[test]
    fn grouping_and_currency_literals() {
        assert_eq!(render_num(1234567.89, "#,##0.00"), "1,234,567.89");
        assert_eq!(render_num(1234.5, "\"¥\"#,##0.00"), "¥1,234.50");
        assert_eq!(render_num(1234.5, "[$¥-804]#,##0.00"), "¥1,234.50");
        assert_eq!(render_num(1234.5, "#,##0.00\"元\""), "1,234.50元");
    }

    /// 文本码：Data::String 原样（@ 不影响字符串）；display_for 清洗换行制表符
    #[test]
    fn text_and_display_for_cleanup() {
        assert_eq!(display_for(&Data::String("a\nb".into()), Some("@")), "a b");
        assert_eq!(
            display_for(&Data::Float(0.0819348994483414,), None),
            "0.081934899448"
        );
        assert_eq!(display_for(&Data::Int(3), Some("0.00")), "3.00");
    }
}
