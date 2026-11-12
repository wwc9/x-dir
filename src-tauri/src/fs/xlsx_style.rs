//! Excel 样式迁移（2026-11-12 Excel 合并/拆分数据通道增强）：calamine 0.38
//! `worksheet_style()` 读出每格 `Style`（字体/填充/边框/对齐/数字格式码，
//! 仅 XLSX/XLSM 源），映射为 rust_xlsxwriter `Format` 写出——数据级合并/拆分
//! 不再丢表头加粗、货币/日期格式、填充与边框。映射在两端枚举名一一对应的
//! 子集内做等价迁移；罕见码（灰色图案填充/斜线边框/主题色）降级为主题默认。
//! Format 按样式指纹缓存：同一张表数千格往往共享十几个样式，避免重复建 Format。

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use calamine::{Data, Style};
use rust_xlsxwriter::Format;

/// calamine Color → rust_xlsxwriter 0xRRGGBB（alpha 恒不透明，单元格级无透明概念）
fn rgb(c: &calamine::Color) -> rust_xlsxwriter::Color {
    rust_xlsxwriter::Color::RGB(c.to_argb() & 0xFF_FFFF)
}

/// calamine 枚举未实现 Hash（#[non_exhaustive]），指纹用判别式哈希
fn disc<T>(v: &T) -> std::mem::Discriminant<T> {
    std::mem::discriminant(v)
}

/// 边框样式等价映射（两端枚举变体一一对应）
fn border(b: calamine::BorderStyle) -> Option<rust_xlsxwriter::FormatBorder> {
    use calamine::BorderStyle as B;
    use rust_xlsxwriter::FormatBorder as W;
    match b {
        B::None => None,
        B::Thin => Some(W::Thin),
        B::Medium => Some(W::Medium),
        B::Thick => Some(W::Thick),
        B::Double => Some(W::Double),
        B::Hair => Some(W::Hair),
        B::Dashed => Some(W::Dashed),
        B::Dotted => Some(W::Dotted),
        B::MediumDashed => Some(W::MediumDashed),
        B::DashDot => Some(W::DashDot),
        B::MediumDashDot => Some(W::MediumDashDot),
        B::DashDotDot => Some(W::DashDotDot),
        B::MediumDashDotDot => Some(W::MediumDashDotDot),
        B::SlantDashDot => Some(W::SlantDashDot),
        _ => None,
    }
}

fn align_h(h: calamine::HorizontalAlignment) -> Option<rust_xlsxwriter::FormatAlign> {
    use calamine::HorizontalAlignment as H;
    use rust_xlsxwriter::FormatAlign as W;
    match h {
        H::Left => Some(W::Left),
        H::Center | H::CenterContinuous => Some(W::CenterAcross),
        H::Right => Some(W::Right),
        H::Justify => Some(W::Justify),
        H::Distributed => Some(W::Distributed),
        H::Fill => Some(W::Fill),
        H::General => None,
        _ => None,
    }
}

fn align_v(v: calamine::VerticalAlignment) -> Option<rust_xlsxwriter::FormatAlign> {
    use calamine::VerticalAlignment as V;
    use rust_xlsxwriter::FormatAlign as W;
    match v {
        V::Top => Some(W::Top),
        V::Center => Some(W::VerticalCenter),
        V::Bottom => Some(W::Bottom),
        V::Justify => Some(W::VerticalJustify),
        V::Distributed => Some(W::VerticalDistributed),
        _ => None,
    }
}
/// 文字旋转：calamine 原始 spec 值（1-90 逆时针 / 91-180 顺时针 / 堆叠）
/// → rust_xlsxwriter 口径（正 = 逆时针、负 = 顺时针、270 = 竖排堆叠）
fn rotation(r: calamine::TextRotation) -> Option<i16> {
    match r {
        calamine::TextRotation::None => None,
        calamine::TextRotation::Stacked => Some(270),
        calamine::TextRotation::Degrees(0) => None,
        calamine::TextRotation::Degrees(d) if d <= 90 => Some(d as i16),
        calamine::TextRotation::Degrees(d) => Some(-(180 - d.min(180) as i16)),
        _ => None,
    }
}

fn underline(u: calamine::UnderlineStyle) -> Option<rust_xlsxwriter::FormatUnderline> {
    use calamine::UnderlineStyle as U;
    use rust_xlsxwriter::FormatUnderline as W;
    match u {
        U::Single => Some(W::Single),
        U::Double => Some(W::Double),
        U::SingleAccounting => Some(W::SingleAccounting),
        U::DoubleAccounting => Some(W::DoubleAccounting),
        U::None => None,
        _ => None,
    }
}

/// 样式指纹：Style 未实现 Hash（#[non_exhaustive] 结构体），对参与映射的
/// 全部字段手写哈希；未参与映射的字段（protection/family 等）不入指纹
pub fn style_key(style: &Style) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    if let Some(f) = &style.font {
        "f".hash(&mut h);
        f.name.hash(&mut h);
        f.size.map(|s| s.to_bits()).hash(&mut h);
        disc(&f.weight).hash(&mut h);
        disc(&f.style).hash(&mut h);
        disc(&f.underline).hash(&mut h);
        f.strikethrough.hash(&mut h);
        f.color.as_ref().map(|c| c.to_argb()).hash(&mut h);
    }
    if let Some(fl) = &style.fill {
        "l".hash(&mut h);
        disc(&fl.pattern).hash(&mut h);
        fl.foreground_color
            .as_ref()
            .map(|c| c.to_argb())
            .hash(&mut h);
        fl.background_color
            .as_ref()
            .map(|c| c.to_argb())
            .hash(&mut h);
    }
    if let Some(b) = &style.borders {
        "b".hash(&mut h);
        for side in [
            &b.left,
            &b.right,
            &b.top,
            &b.bottom,
            &b.diagonal_down,
            &b.diagonal_up,
        ] {
            disc(&side.style).hash(&mut h);
            side.color.as_ref().map(|c| c.to_argb()).hash(&mut h);
        }
    }
    if let Some(a) = &style.alignment {
        "a".hash(&mut h);
        disc(&a.horizontal).hash(&mut h);
        disc(&a.vertical).hash(&mut h);
        match &a.text_rotation {
            calamine::TextRotation::None => 0u8.hash(&mut h),
            calamine::TextRotation::Stacked => 255u8.hash(&mut h),
            calamine::TextRotation::Degrees(d) => d.hash(&mut h),
            _ => 1u8.hash(&mut h),
        }
        a.wrap_text.hash(&mut h);
        a.indent.hash(&mut h);
        a.shrink_to_fit.hash(&mut h);
    }
    if let Some(nf) = &style.number_format {
        "n".hash(&mut h);
        nf.format_code.hash(&mut h);
    }
    h.finish()
}

/// 样式 → Format；样式不含任何可见属性时返回 None（写出时不挂格式，
/// 与无样式源（xls/ods）输出一致）
pub fn style_to_format(style: &Style) -> Option<Format> {
    let mut f = Format::new();
    let mut any = false;
    if let Some(font) = &style.font {
        if let Some(name) = &font.name {
            f = f.set_font_name(name.as_str());
            any = true;
        }
        if let Some(size) = font.size {
            f = f.set_font_size(size);
            any = true;
        }
        if font.weight == calamine::FontWeight::Bold {
            f = f.set_bold();
            any = true;
        }
        if font.style == calamine::FontStyle::Italic {
            f = f.set_italic();
            any = true;
        }
        if let Some(u) = underline(font.underline) {
            f = f.set_underline(u);
            any = true;
        }
        if font.strikethrough {
            f = f.set_font_strikethrough();
            any = true;
        }
        if let Some(c) = &font.color {
            f = f.set_font_color(rgb(c));
            any = true;
        }
    }
    if let Some(fill) = &style.fill {
        // 仅迁移纯色填充；灰色图案填充降级为主题默认（极少见）
        if fill.pattern == calamine::FillPattern::Solid {
            let c = fill
                .foreground_color
                .as_ref()
                .or(fill.background_color.as_ref());
            if let Some(c) = c {
                f = f.set_background_color(rgb(c));
                any = true;
            }
        }
    }
    if let Some(b) = &style.borders {
        // 单边迁移：四边风格 + 颜色（方法作函数指针，四侧共用一套逻辑）
        type BorderSetter = fn(Format, rust_xlsxwriter::FormatBorder) -> Format;
        type ColorSetter = fn(Format, rust_xlsxwriter::Color) -> Format;
        let sides: [(&calamine::Border, BorderSetter, ColorSetter); 4] = [
            (
                &b.left,
                Format::set_border_left,
                Format::set_border_left_color,
            ),
            (
                &b.right,
                Format::set_border_right,
                Format::set_border_right_color,
            ),
            (&b.top, Format::set_border_top, Format::set_border_top_color),
            (
                &b.bottom,
                Format::set_border_bottom,
                Format::set_border_bottom_color,
            ),
        ];
        for (side, set_style, set_color) in sides {
            if let Some(bs) = border(side.style) {
                f = match &side.color {
                    Some(c) => set_color(set_style(f, bs), rgb(c)),
                    None => set_style(f, bs),
                };
                any = true;
            }
        }
    }
    if let Some(a) = &style.alignment {
        if let Some(h) = align_h(a.horizontal) {
            f = f.set_align(h);
            any = true;
        }
        if let Some(v) = align_v(a.vertical) {
            f = f.set_align(v);
            any = true;
        }
        if let Some(r) = rotation(a.text_rotation) {
            f = f.set_rotation(r);
            any = true;
        }
        if a.wrap_text {
            f = f.set_text_wrap();
            any = true;
        }
        if let Some(i) = a.indent
            && i > 0
        {
            f = f.set_indent(i);
            any = true;
        }
        if a.shrink_to_fit {
            f = f.set_shrink();
            any = true;
        }
    }
    if let Some(nf) = &style.number_format {
        let code = nf.format_code.trim();
        if !code.is_empty() && !code.eq_ignore_ascii_case("general") {
            f = f.set_num_format(code);
            any = true;
        }
    }
    any.then_some(f)
}

/// 每张源表一个缓存：指纹 → Option<Format>（None = 无可见属性）
#[derive(Default)]
pub struct FormatCache {
    map: HashMap<u64, Option<Format>>,
}

impl FormatCache {
    pub fn get_or_build(&mut self, style: &Style) -> Option<&Format> {
        let key = style_key(style);
        let map = &mut self.map;
        map.entry(key)
            .or_insert_with(|| style_to_format(style))
            .as_ref()
    }
}

/// calamine 值 + 可选样式 → 写单元格。DateTime 写真实日期值（序列数直转，
/// numFmt 随样式迁移；无样式时挂通用日期码——修复旧实现日期降级为字符串），
/// 时长仍落字符串（Excel 时长码罕见且歧义大）。
pub fn write_value(
    ws: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    col: u16,
    v: &Data,
    fmt: Option<&Format>,
) {
    let _ = match v {
        Data::Empty => return,
        Data::String(s) => match fmt {
            Some(f) => ws.write_with_format(row, col, s.as_str(), f),
            None => ws.write(row, col, s.as_str()),
        },
        Data::Float(x) => match fmt {
            Some(f) => ws.write_with_format(row, col, *x, f),
            None => ws.write(row, col, *x),
        },
        Data::Int(i) => match fmt {
            Some(f) => ws.write_with_format(row, col, *i, f),
            None => ws.write(row, col, *i),
        },
        Data::Bool(b) => match fmt {
            Some(f) => ws.write_with_format(row, col, *b, f),
            None => ws.write(row, col, *b),
        },
        Data::DateTime(dt) => {
            if dt.is_duration() {
                let s = super::xlsx::format_datetime(dt);
                match fmt {
                    Some(f) => ws.write_with_format(row, col, s.as_str(), f),
                    None => ws.write(row, col, s.as_str()),
                }
            } else {
                let serial = dt.as_f64();
                match rust_xlsxwriter::ExcelDateTime::from_serial_datetime(serial) {
                    Ok(d) => match fmt {
                        Some(f) => ws.write_datetime_with_format(row, col, &d, f),
                        None => ws.write_datetime_with_format(
                            row,
                            col,
                            &d,
                            &Format::new().set_num_format("yyyy-mm-dd hh:mm:ss"),
                        ),
                    },
                    Err(_) => {
                        let s = super::xlsx::format_datetime(dt);
                        match fmt {
                            Some(f) => ws.write_with_format(row, col, s.as_str(), f),
                            None => ws.write(row, col, s.as_str()),
                        }
                    }
                }
            }
        }
        Data::DateTimeIso(s) | Data::DurationIso(s) => match fmt {
            Some(f) => ws.write_with_format(row, col, s.as_str(), f),
            None => ws.write(row, col, s.as_str()),
        },
        Data::Error(e) => {
            let s = format!("#{e:?}");
            match fmt {
                Some(f) => ws.write_with_format(row, col, s.as_str(), f),
                None => ws.write(row, col, s.as_str()),
            }
        }
    };
}
