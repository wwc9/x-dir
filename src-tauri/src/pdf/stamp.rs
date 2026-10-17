//! 水印文字 → 位图 → PDF 叠层：
//! 1. 运行时读系统字体（msyh.ttc → simhei → simsun → arial 回退链，不打包字体避免再分发问题）
//! 2. ab_glyph 排版 + 自带光栅化（逐像素覆盖率回调，免额外光栅化依赖）
//! 3. lopdf 写入 DeviceRGB 恒色 + DeviceGray SMask 的 Image XObject，
//!    每页追加 `q /WmGs gs 旋转平移 cm 缩放平移 cm /WmIm Do Q` 内容流（45° 对角居中）

use ab_glyph::{Font, FontVec, ScaleFont};
use lopdf::{Dictionary, Object, ObjectId, Stream, content::Content, dictionary};

/// 深灰水印色（RGB 恒值，可见度由 SMask 决定），与 pdf/mod.rs 的 STAMP_GRAY 一致
const STAMP_GRAY: u8 = 64;

pub struct StampBitmap {
    pub width: u32,
    pub height: u32,
    /// DeviceRGB 三通道恒色（width*height*3）
    pub rgb: Vec<u8>,
    /// DeviceGray 覆盖率（width*height）
    pub alpha: Vec<u8>,
}

/// 系统中文字体加载（TTC 取 index 0）
pub fn load_cjk_font() -> Option<FontVec> {
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
    for f in [
        "Fonts\\msyh.ttc",
        "Fonts\\simhei.ttf",
        "Fonts\\simsun.ttc",
        "Fonts\\arial.ttf",
    ] {
        let path = std::path::Path::new(&windir).join(f);
        if let Ok(font) = std::fs::read(&path).and_then(|data| {
            FontVec::try_from_vec_and_index(data, 0).map_err(|_| std::io::Error::other("font"))
        }) {
            return Some(font);
        }
    }
    None
}

/// 单行文字光栅化：RGB 恒色平面 + 抗锯齿覆盖率平面
pub fn rasterize_text(font: &FontVec, text: &str, px: f32) -> StampBitmap {
    let scaled = font.as_scaled(px);
    let mut pen = 0f32;
    let mut min_x = f32::MAX;
    let mut max_x = f32::MIN;
    let mut min_y = f32::MAX;
    let mut max_y = f32::MIN;
    let mut placed: Vec<(ab_glyph::Glyph, ab_glyph::Rect)> = Vec::new();
    for ch in text.chars() {
        let mut g = scaled.scaled_glyph(ch);
        g.position = ab_glyph::point(pen, scaled.ascent());
        pen += scaled.h_advance(g.id);
        if let Some(outline) = scaled.outline_glyph(g.clone()) {
            let b = outline.px_bounds();
            min_x = min_x.min(b.min.x);
            max_x = max_x.max(b.max.x);
            min_y = min_y.min(b.min.y);
            max_y = max_y.max(b.max.y);
            placed.push((g, b));
        }
    }
    if placed.is_empty() {
        return StampBitmap {
            width: 1,
            height: 1,
            rgb: vec![STAMP_GRAY, STAMP_GRAY, STAMP_GRAY],
            alpha: vec![0],
        };
    }
    let width = ((max_x - min_x).ceil() as usize).max(1);
    let height = ((max_y - min_y).ceil() as usize).max(1);
    let mut cov = vec![0f32; width * height];
    for (g, b) in &placed {
        let Some(outline) = scaled.outline_glyph(g.clone()) else {
            continue;
        };
        let ox = b.min.x as i64;
        let oy = b.min.y as i64;
        outline.draw(|x, y, c| {
            let ax = x as i64 + ox;
            let ay = y as i64 + oy;
            if ax >= 0 && ay >= 0 {
                let (ux, uy) = (ax as usize, ay as usize);
                if ux < width && uy < height {
                    let idx = uy * width + ux;
                    cov[idx] += c;
                }
            }
        });
    }
    let alpha = cov
        .into_iter()
        .map(|c| (c.clamp(0.0, 1.0) * 255.0) as u8)
        .collect();
    StampBitmap {
        width: width as u32,
        height: height as u32,
        rgb: vec![STAMP_GRAY; (width * height) * 3],
        alpha,
    }
}

/// 整份文档每页叠水印（共享一个 Image XObject）
pub fn stamp_document(doc: &mut lopdf::Document, bm: &StampBitmap) -> Result<(), String> {
    let img_id = add_image_xobject(doc, bm)?;
    let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
    for page_id in page_ids {
        stamp_page(doc, page_id, img_id, bm)?;
    }
    Ok(())
}

fn add_image_xobject(doc: &mut lopdf::Document, bm: &StampBitmap) -> Result<ObjectId, String> {
    let smask_id = doc.add_object(Object::Stream(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => bm.width as i64,
            "Height" => bm.height as i64,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
            "Filter" => "FlateDecode",
        },
        super::zlib(&bm.alpha),
    )));
    let img = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => bm.width as i64,
            "Height" => bm.height as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "Filter" => "FlateDecode",
            "SMask" => Object::Reference(smask_id),
        },
        super::zlib(&bm.rgb),
    );
    Ok(doc.add_object(Object::Stream(img)))
}

/// 读页面 MediaBox 宽高（缺省按 letter 竖版兜底）
fn page_size(doc: &lopdf::Document, page_id: ObjectId) -> (f32, f32) {
    const DEFAULT: f32 = 612.0;
    const DEFAULT_H: f32 = 792.0;
    let Ok(Object::Dictionary(d)) = doc.get_object(page_id) else {
        return (DEFAULT, DEFAULT_H);
    };
    let Some(Object::Array(items)) = d.get(b"MediaBox").ok() else {
        return (DEFAULT, DEFAULT_H);
    };
    let nums: Vec<f32> = items
        .iter()
        .filter_map(|o| match o {
            Object::Integer(i) => Some(*i as f32),
            Object::Real(r) => Some(*r),
            _ => None,
        })
        .collect();
    if nums.len() == 4 {
        (
            (nums[2] - nums[0]).abs().max(1.0),
            (nums[3] - nums[1]).abs().max(1.0),
        )
    } else {
        (DEFAULT, DEFAULT_H)
    }
}

fn stamp_page(
    doc: &mut lopdf::Document,
    page_id: ObjectId,
    img_id: ObjectId,
    bm: &StampBitmap,
) -> Result<(), String> {
    let (w, h) = page_size(doc, page_id);
    let ext_gstate = dictionary! {
        "Type" => "ExtGState",
        "ca" => super::STAMP_ALPHA,
        "CA" => super::STAMP_ALPHA,
    };
    // 资源挂载：Resources 可能是共享引用，解析到实际字典再改
    let resources_id: Option<ObjectId> = {
        let Ok(Object::Dictionary(d)) = doc.get_object(page_id) else {
            return Err("页面不是字典".into());
        };
        match d.get(b"Resources") {
            Ok(Object::Reference(r)) => Some(*r),
            _ => None,
        }
    };
    if let Some(rid) = resources_id {
        let res = doc
            .get_object_mut(rid)
            .map_err(|e| e.to_string())?
            .as_dict_mut()
            .map_err(|e| e.to_string())?;
        set_xobject_and_gs(res, img_id, ext_gstate);
    } else {
        let page = doc
            .get_object_mut(page_id)
            .map_err(|e| e.to_string())?
            .as_dict_mut()
            .map_err(|e| e.to_string())?;
        let existing = page.get(b"Resources").ok().cloned();
        match existing {
            Some(Object::Dictionary(res)) => {
                let mut res = res;
                set_xobject_and_gs(&mut res, img_id, ext_gstate);
                let page = doc
                    .get_object_mut(page_id)
                    .map_err(|e| e.to_string())?
                    .as_dict_mut()
                    .map_err(|e| e.to_string())?;
                page.set("Resources", Object::Dictionary(res));
            }
            _ => {
                let mut res = Dictionary::new();
                set_xobject_and_gs(&mut res, img_id, ext_gstate);
                page.set("Resources", Object::Dictionary(res));
            }
        }
    }

    // 内容流：外层 cm = 平移到页心 + 旋转 45°；内层 cm = 图片缩放并中心对齐原点
    let diag = (w * w + h * h).sqrt();
    let disp_w = diag * 0.8;
    let disp_h = disp_w * bm.height as f32 / bm.width.max(1) as f32;
    let (sin, cos) = (45f32.to_radians().sin(), 45f32.to_radians().cos());
    let content = Content {
        operations: vec![
            lopdf::content::Operation::new("q", vec![]),
            lopdf::content::Operation::new("gs", vec![Object::Name("WmGs".into())]),
            lopdf::content::Operation::new(
                "cm",
                vec![
                    Object::Real(cos),
                    Object::Real(sin),
                    Object::Real(-sin),
                    Object::Real(cos),
                    Object::Real(w / 2.0),
                    Object::Real(h / 2.0),
                ],
            ),
            lopdf::content::Operation::new(
                "cm",
                vec![
                    Object::Real(disp_w),
                    Object::Real(0.0),
                    Object::Real(0.0),
                    Object::Real(disp_h),
                    Object::Real(-disp_w / 2.0),
                    Object::Real(-disp_h / 2.0),
                ],
            ),
            lopdf::content::Operation::new("Do", vec![Object::Name("WmIm".into())]),
            lopdf::content::Operation::new("Q", vec![]),
        ],
    };
    let encoded = content.encode().map_err(|e| e.to_string())?;
    let stream = Stream::new(
        dictionary! {
            "Filter" => "FlateDecode",
        },
        super::zlib(&encoded),
    );
    let stream_id = doc.add_object(Object::Stream(stream));

    // /Contents 追加：引用 → 数组[原…, 新]；原数组 → 追加
    let page = doc
        .get_object_mut(page_id)
        .map_err(|e| e.to_string())?
        .as_dict_mut()
        .map_err(|e| e.to_string())?;
    let mut ids: Vec<Object> = match page.get(b"Contents") {
        Ok(Object::Reference(r)) => vec![Object::Reference(*r)],
        Ok(Object::Array(items)) => items.clone(),
        _ => vec![],
    };
    ids.push(Object::Reference(stream_id));
    page.set("Contents", Object::Array(ids));
    Ok(())
}

fn set_xobject_and_gs(res: &mut Dictionary, img_id: ObjectId, ext_gstate: Dictionary) {
    let mut xobjs = match res.get(b"XObject") {
        Ok(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };
    xobjs.set("WmIm", Object::Reference(img_id));
    res.set("XObject", Object::Dictionary(xobjs));
    let mut gs = match res.get(b"ExtGState") {
        Ok(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };
    gs.set("WmGs", Object::Dictionary(ext_gstate));
    res.set("ExtGState", Object::Dictionary(gs));
}
