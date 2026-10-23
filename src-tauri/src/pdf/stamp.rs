//! 水印文字引擎（2026-10-22 参数化改造）：
//! 1. 运行时读系统字体（楷体 simkai / 黑体 simhei / 仿宋 simfang / 等线 Deng，
//!    缺失回退 msyh → simhei → simsun → arial；不打包字体避免再分发问题）
//! 2. ab_glyph 排版 + 自带光栅化（逐像素覆盖率），RGB 恒色平面颜色可选（8 色）；
//!    PDF 路径按位图量自适应 2–4× 超采样（小字 4× ≈ 288 DPI），避免
//!    1px ≈ 1pt 位图图层在放大/打印时发糊，cm 绘制时除回物理尺寸
//! 3. lopdf 写入 DeviceRGB + DeviceGray SMask 的 Image XObject，逐页追加内容流：
//!    九宫格位置（边距偏移）或对角线（±45° 居中，缩放对角 0.8）；
//!    透明度经 ExtGState ca（0–10 → 0–1.0）
//! 4. 文字模板支持占位符：[原文件名] [原文件夹名] [页码] [页面标签] [日期时间]，
//!    页码渲染格式与日期格式可配；页面范围 全部/奇数/偶数
//! 5. 位图按文字内容缓存：无占位符的水印整份文档只光栅化一次

use ab_glyph::{Font, FontVec, ScaleFont};
use lopdf::{Dictionary, Object, ObjectId, Stream, content::Content, dictionary};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// 位图缓存上限（条）。带占位符的水印逐页产生不同文字，放任累积会
/// 随文档页数无限增长；满员即清空，命中主要收益在"同一文字批量多文件"
/// 与"无占位符整档一次"两个场景
const BITMAP_CACHE_CAP: usize = 4;

/// 单目录收集/页面遍历的通用护栏在调用方；本模块按文字缓存位图
static BITMAP_CACHE: OnceLock<Mutex<HashMap<String, StampBitmap>>> = OnceLock::new();

fn bitmap_cache() -> &'static Mutex<HashMap<String, StampBitmap>> {
    BITMAP_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// ── 位置：九宫格 + 对角线 ──
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WmPos {
    LeftTop,
    MidTop,
    RightTop,
    LeftMid,
    Center,
    RightMid,
    LeftBottom,
    MidBottom,
    RightBottom,
    DiagMain,
    DiagReverse,
}

impl WmPos {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "left-top" => Self::LeftTop,
            "mid-top" => Self::MidTop,
            "right-top" => Self::RightTop,
            "left-mid" => Self::LeftMid,
            "center" => Self::Center,
            "right-mid" => Self::RightMid,
            "left-bottom" => Self::LeftBottom,
            "mid-bottom" => Self::MidBottom,
            "right-bottom" => Self::RightBottom,
            "diag-main" => Self::DiagMain,
            "diag-reverse" => Self::DiagReverse,
            _ => return None,
        })
    }
}

// ── 页面范围 ──
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WmRange {
    All,
    Odd,
    Even,
}

impl WmRange {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "all" => Self::All,
            "odd" => Self::Odd,
            "even" => Self::Even,
            _ => return None,
        })
    }
    /// 页码 1 起算：奇数页 = 第 1/3/5… 页
    pub fn hits(self, page: u32) -> bool {
        match self {
            Self::All => true,
            Self::Odd => page % 2 == 1,
            Self::Even => page.is_multiple_of(2),
        }
    }
}

// ── 页码占位符渲染格式 ──
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WmNumFmt {
    Plain,
    Dash,
    Cn,
    Frac,
    CnFrac,
}

impl WmNumFmt {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "plain" => Self::Plain,
            "dash" => Self::Dash,
            "cn" => Self::Cn,
            "frac" => Self::Frac,
            "cnfrac" => Self::CnFrac,
            _ => return None,
        })
    }
    pub fn render(self, page: u32, total: u32) -> String {
        match self {
            Self::Plain => page.to_string(),
            Self::Dash => format!("-{page}-"),
            Self::Cn => format!("第{page}页"),
            Self::Frac => format!("{page}/{total}"),
            Self::CnFrac => format!("第{page}页/共{total}页"),
        }
    }
}

// ── 日期占位符渲染格式 ──
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WmDtFmt {
    Cn,
    Slash,
    Dash,
}

impl WmDtFmt {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "cn" => Self::Cn,
            "slash" => Self::Slash,
            "dash" => Self::Dash,
            _ => return None,
        })
    }
    pub fn render(self, y: i64, m: u32, d: u32) -> String {
        match self {
            Self::Cn => format!("{y}年{m:02}月{d:02}日"),
            Self::Slash => format!("{y}/{m:02}/{d:02}"),
            Self::Dash => format!("{y}-{m:02}-{d:02}"),
        }
    }
}

/// 天数（自 UNIX 纪元）→ (年, 月, 日)：Howard Hinnant civil_from_days
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

/// 当前本机日期（UTC 近似，水印用途足够）
pub fn today() -> (i64, u32, u32) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    civil_from_days((secs / 86_400) as i64)
}

/// 当前日期按格式渲染
pub fn today_formatted(fmt: WmDtFmt) -> String {
    let (y, m, d) = today();
    fmt.render(y, m, d)
}
// ── 选项（命令层解析字符串码后装配）──
#[derive(Clone, Debug, PartialEq)]
pub struct WatermarkOpts {
    pub text: String,
    /// 输出文件名模板（不含扩展名）：支持 [原文件名] [原文件夹名] [日期时间]，
    /// 默认 "[原文件名]-水印" → 底稿A-水印.pdf
    pub out_name: String,
    /// kaiti | heiti | fangsong | dengxian
    pub font_name: String,
    /// 5–99（像素 ≈ 磅）
    pub font_size: u32,
    pub rgb: [u8; 3],
    pub pos: WmPos,
    /// 0–10（10 = 不透明）
    pub transparency: u8,
    /// 边距（像素 ≈ 磅）
    pub margin: u32,
    pub range: WmRange,
    pub num_fmt: WmNumFmt,
    pub dt_fmt: WmDtFmt,
}

/// 8 色板（与 V2 标签色同源的取值，黑/白/灰为中性色）
pub fn parse_color(code: &str) -> [u8; 3] {
    match code {
        "gray" => [136, 136, 136],
        "red" => [201, 56, 64],
        "white" => [255, 255, 255],
        "green" => [35, 131, 76],
        "yellow" => [154, 124, 10],
        "blue" => [53, 116, 240],
        "purple" => [125, 100, 216],
        _ => [0, 0, 0], // black
    }
}

#[derive(Clone)]
pub struct StampBitmap {
    pub width: u32,
    pub height: u32,
    /// 像素密度（位图像素 / 物理磅）：超采样倍率。绘制物理宽(pt) = width / scale；
    /// 图片水印 1:1 贴图恒为 1
    pub scale: f32,
    /// DeviceRGB 三通道恒色（width*height*3）
    pub rgb: Vec<u8>,
    /// DeviceGray 覆盖率（width*height）
    pub alpha: Vec<u8>,
}

/// 按优先级加载系统字体（prefer = Fonts 目录下的字体文件名，如 "simkai.ttf"）；
/// prefer 全部缺失时回退 msyh → simhei → simsun → arial。Arc 共享免克隆。
pub fn load_font(prefer: &[&str]) -> Option<Arc<FontVec>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<FontVec>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
    let mut candidates: Vec<String> = prefer.iter().map(|f| format!("Fonts\\{f}")).collect();
    for f in [
        "Fonts\\msyh.ttc",
        "Fonts\\simhei.ttf",
        "Fonts\\simsun.ttc",
        "Fonts\\arial.ttf",
    ] {
        candidates.push(f.to_string());
    }
    for f in candidates {
        if let Some(hit) = cache.lock().unwrap().get(&f) {
            return Some(Arc::clone(hit));
        }
        let path = std::path::Path::new(&windir).join(&f);
        if let Ok(data) = std::fs::read(&path)
            && let Ok(font) =
                FontVec::try_from_vec_and_index(data, 0).map_err(|_| std::io::Error::other("font"))
        {
            let arc = Arc::new(font);
            cache.lock().unwrap().insert(f, Arc::clone(&arc));
            return Some(arc);
        }
    }
    None
}

/// 单行文字光栅化（1 像素 = 1 单位；图片水印 1:1 贴图用）
pub fn rasterize_text(font: &FontVec, text: &str, px: f32, rgb: [u8; 3]) -> StampBitmap {
    rasterize_at(font, text, px, rgb, 1.0)
}

/// 按 ss 倍超采样光栅化：位图像素 = 物理尺寸(pt) × ss。PDF 水印用——
/// 位图图层若按 1px ≈ 1pt（约 72 DPI）绘制，放大/打印即发糊；
/// 高密度光栅化后 cm 除回物理尺寸，视觉锐度随 ss 提升
fn rasterize_ss(font: &FontVec, text: &str, pt: f32, rgb: [u8; 3], ss: f32) -> StampBitmap {
    rasterize_at(font, text, pt * ss, rgb, ss)
}

fn rasterize_at(font: &FontVec, text: &str, px: f32, rgb: [u8; 3], scale: f32) -> StampBitmap {
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
            scale,
            rgb: vec![rgb[0], rgb[1], rgb[2]],
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
        // draw 回调给的是 px_bounds 内 0 基像素索引；缓冲原点是全局 min，
        // 偏移量 = 该字形 bounds 相对全局 min（四舍五入对齐像素网格）
        let ox = (b.min.x - min_x).round() as i64;
        let oy = (b.min.y - min_y).round() as i64;
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
        scale,
        rgb: vec![rgb[0], rgb[1], rgb[2]]
            .into_iter()
            .flat_map(|c| std::iter::repeat_n(c, width * height))
            .collect(),
        alpha,
    }
}

/// 文字模板渲染：占位符替换（页码格式 / 日期格式在调用方装配）
pub fn render_text(
    template: &str,
    file_stem: &str,
    folder_name: &str,
    page_text: &str,
    label: &str,
    datetime: &str,
) -> String {
    template
        .replace("[原文件名]", file_stem)
        .replace("[原文件夹名]", folder_name)
        .replace("[页码]", page_text)
        .replace("[页面标签]", label)
        .replace("[日期时间]", datetime)
}

/// 整份文档逐页叠水印：页面范围过滤 + 逐页占位符渲染 + 位图缓存
pub fn stamp_document_ex(
    doc: &mut lopdf::Document,
    opts: &WatermarkOpts,
    file_stem: &str,
    folder_name: &str,
) -> Result<(), String> {
    let prefer: &[&str] = match opts.font_name.as_str() {
        "kaiti" => &["simkai.ttf"],
        "heiti" => &["simhei.ttf"],
        "fangsong" => &["simfang.ttf"],
        "dengxian" => &["Deng.ttf", "Dengb.ttf"],
        _ => &[],
    };
    let font =
        load_font(prefer).ok_or("未找到可用的系统字体（simkai/simhei/simfang/Deng/msyh）")?;
    let total = doc.get_pages().len() as u32;
    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    let (ty, tm, td) = today();
    let datetime = opts.dt_fmt.render(ty, tm, td);
    let folder = folder_name.to_string();
    let stem = file_stem.to_string();
    let style = opts.clone();

    for (page_no, page_id) in pages {
        if !opts.range.hits(page_no) {
            continue;
        }
        // 页面标签 v1：未解析 /PageLabels 时回落页码
        let label = page_no.to_string();
        let page_text = opts.num_fmt.render(page_no, total);
        let text = render_text(&opts.text, &stem, &folder, &page_text, &label, &datetime);
        let bitmap = {
            let mut cache = bitmap_cache().lock().unwrap();
            // 键含样式参数：同文字不同字体/字号/颜色的两次任务不得串用位图
            let key = format!(
                "{}|{}|{:?}|{}",
                opts.font_name, opts.font_size, opts.rgb, text
            );
            match cache.get(&key) {
                Some(bm) => bm.clone(),
                None => {
                    // 超采样档位按基准像素量自适应（小字 4× ≈ 288 DPI 打印级，
                    // 大字长字降档防内存膨胀），满员清空防跨任务无限累积
                    let base_px =
                        text.chars().count() as f32 * opts.font_size as f32 * opts.font_size as f32;
                    let ss = if base_px <= 100_000.0 {
                        4.0
                    } else if base_px <= 500_000.0 {
                        3.0
                    } else if base_px <= 2_000_000.0 {
                        2.0
                    } else {
                        1.0
                    };
                    let bm = rasterize_ss(&font, &text, opts.font_size as f32, opts.rgb, ss);
                    if cache.len() >= BITMAP_CACHE_CAP {
                        cache.clear();
                    }
                    cache.insert(key, bm.clone());
                    bm
                }
            }
        };
        match opts.pos {
            WmPos::DiagMain | WmPos::DiagReverse => {
                stamp_page_diag(doc, page_id, &bitmap, opts)?;
            }
            grid => {
                let (w, h) = page_size(doc, page_id);
                let margin = style.margin as f32;
                // 绘制物理尺寸 = 位图尺寸 / 超采样倍率
                let bw = bitmap.width as f32 / bitmap.scale;
                let bh = bitmap.height as f32 / bitmap.scale;
                let x = match grid {
                    WmPos::LeftTop | WmPos::LeftMid | WmPos::LeftBottom => margin,
                    WmPos::MidTop | WmPos::Center | WmPos::MidBottom => ((w - bw) / 2.0).max(0.0),
                    _ => (w - bw - margin).max(0.0),
                };
                let y = match grid {
                    WmPos::LeftTop | WmPos::MidTop | WmPos::RightTop => (h - bh - margin).max(0.0),
                    WmPos::LeftMid | WmPos::Center | WmPos::RightMid => ((h - bh) / 2.0).max(0.0),
                    _ => margin,
                };
                stamp_page_at(doc, page_id, &bitmap, opts, x, y)?;
            }
        }
    }
    Ok(())
}

/// 九宫格位置：内容流 q gs cm(缩放到位图物理尺寸,平移) Do Q（cm 缩放 =
/// 位图 w×h 除以超采样倍率；Image Do 画在 1×1 单位正方形，必须显式缩放）
fn stamp_page_at(
    doc: &mut lopdf::Document,
    page_id: ObjectId,
    bm: &StampBitmap,
    opts: &WatermarkOpts,
    x: f32,
    y: f32,
) -> Result<(), String> {
    // 绘制物理尺寸 = 位图尺寸 / 超采样倍率
    let bw = bm.width as f32 / bm.scale;
    let bh = bm.height as f32 / bm.scale;
    let img_id = add_image_xobject(doc, bm)?;
    let alpha = opts.transparency as f32 / 10.0;
    let ext_gstate = dictionary! {
        "Type" => "ExtGState",
        "ca" => Object::Real(alpha),
        "CA" => Object::Real(alpha),
    };
    mount_resources(doc, page_id, img_id, ext_gstate)?;
    let content = Content {
        operations: vec![
            lopdf::content::Operation::new("q", vec![]),
            lopdf::content::Operation::new("gs", vec![Object::Name("WmGs".into())]),
            // Image XObject 画在 1×1 单位正方形，cm 必须缩放到位图实际尺寸
            //（1px ≈ 1pt），否则只渲染出 1pt 的点
            lopdf::content::Operation::new(
                "cm",
                vec![
                    Object::Real(bw),
                    Object::Real(0.0),
                    Object::Real(0.0),
                    Object::Real(bh),
                    Object::Real(x),
                    Object::Real(y),
                ],
            ),
            lopdf::content::Operation::new("Do", vec![Object::Name("WmIm".into())]),
            lopdf::content::Operation::new("Q", vec![]),
        ],
    };
    append_content_stream(doc, page_id, &content)
}

/// 对角线位置：±45° 旋转居中（沿对角缩放 0.8），透明度同九宫格
fn stamp_page_diag(
    doc: &mut lopdf::Document,
    page_id: ObjectId,
    bm: &StampBitmap,
    opts: &WatermarkOpts,
) -> Result<(), String> {
    let (w, h) = page_size(doc, page_id);
    let img_id = add_image_xobject(doc, bm)?;
    let alpha = opts.transparency as f32 / 10.0;
    let ext_gstate = dictionary! {
        "Type" => "ExtGState",
        "ca" => Object::Real(alpha),
        "CA" => Object::Real(alpha),
    };
    mount_resources(doc, page_id, img_id, ext_gstate)?;
    let diag = (w * w + h * h).sqrt();
    let disp_w = diag * 0.8;
    let disp_h = disp_w * bm.height as f32 / bm.width.max(1) as f32;
    let sign = if opts.pos == WmPos::DiagReverse {
        -1.0
    } else {
        1.0
    };
    let (sin, cos) = (45f32.to_radians().sin() * sign, 45f32.to_radians().cos());
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
    append_content_stream(doc, page_id, &content)
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

/// 资源挂载：Resources 可能是共享引用，解析到实际字典再改
fn mount_resources(
    doc: &mut lopdf::Document,
    page_id: ObjectId,
    img_id: ObjectId,
    ext_gstate: Dictionary,
) -> Result<(), String> {
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
    Ok(())
}

/// /Contents 追加：引用 → 数组[原…, 新]；原数组 → 追加
fn append_content_stream(
    doc: &mut lopdf::Document,
    page_id: ObjectId,
    content: &Content,
) -> Result<(), String> {
    let encoded = content.encode().map_err(|e| e.to_string())?;
    let stream = Stream::new(
        dictionary! {
            "Filter" => "FlateDecode",
        },
        super::zlib(&encoded),
    );
    let stream_id = doc.add_object(Object::Stream(stream));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_text_placeholders() {
        let out = render_text(
            "[原文件夹名]-[原文件名]-[页码]-[页面标签]-[日期时间]",
            "底稿A",
            "审计",
            "第2页",
            "2",
            "2026/10/22",
        );
        assert_eq!(out, "审计-底稿A-第2页-2-2026/10/22");
    }

    #[test]
    fn page_num_formats() {
        assert_eq!(WmNumFmt::Plain.render(3, 9), "3");
        assert_eq!(WmNumFmt::Dash.render(3, 9), "-3-");
        assert_eq!(WmNumFmt::Cn.render(3, 9), "第3页");
        assert_eq!(WmNumFmt::Frac.render(3, 9), "3/9");
        assert_eq!(WmNumFmt::CnFrac.render(3, 9), "第3页/共9页");
    }

    #[test]
    fn range_hits() {
        assert!(WmRange::All.hits(1) && WmRange::All.hits(2));
        assert!(WmRange::Odd.hits(1) && !WmRange::Odd.hits(2));
        assert!(WmRange::Even.hits(2) && !WmRange::Even.hits(3));
    }

    #[test]
    fn parse_codes() {
        assert_eq!(WmPos::parse("right-top"), Some(WmPos::RightTop));
        assert_eq!(WmPos::parse("diag-reverse"), Some(WmPos::DiagReverse));
        assert_eq!(WmPos::parse("nope"), None);
        assert_eq!(WmRange::parse("even"), Some(WmRange::Even));
        assert_eq!(WmNumFmt::parse("cnfrac"), Some(WmNumFmt::CnFrac));
        assert_eq!(WmDtFmt::parse("dash"), Some(WmDtFmt::Dash));
        assert_eq!(parse_color("red"), [201, 56, 64]);
        assert_eq!(parse_color("black"), [0, 0, 0]);
    }

    #[test]
    fn dt_formats() {
        assert_eq!(WmDtFmt::Cn.render(2026, 10, 22), "2026年10月22日");
        assert_eq!(WmDtFmt::Slash.render(2026, 10, 22), "2026/10/22");
        assert_eq!(WmDtFmt::Dash.render(2026, 10, 22), "2026-10-22");
    }

    /// 光栅化覆盖率平面必须有非零像素（文字真实画了出来）
    #[test]
    fn rasterize_produces_coverage() {
        let font = load_font(&["simhei.ttf"]).expect("测试机需有系统字体");
        let bm = rasterize_text(&font, "水印测试-1", 14.0, [0, 0, 0]);
        assert!(bm.width > 1 && bm.height > 1);
        let covered = bm.alpha.iter().filter(|&&a| a > 0).count();
        assert!(covered > 20, "覆盖率平面几乎为空：covered={covered}");
    }

    /// 端到端：造一页带文字的 PDF → 盖章 → 输出页必须新增内容流与资源，
    /// 落盘文件供人工目检（路径打印于 --nocapture）
    #[test]
    fn stamp_end_to_end_writes_stream_and_resources() {
        use lopdf::{StringFormat, content::Operation};

        let mut doc = lopdf::Document::with_version("1.5");
        let font_id = doc.add_object(Object::Dictionary(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        }));
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 24.into()]),
                Operation::new("Td", vec![100.into(), 700.into()]),
                Operation::new(
                    "Tj",
                    vec![Object::String(
                        b"Sample audit report page".to_vec(),
                        StringFormat::Literal,
                    )],
                ),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id = doc.add_object(Object::Stream(Stream::new(
            Dictionary::new(),
            content.encode().unwrap(),
        )));
        let pages_id = doc.add_object(Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Count" => 1,
        }));
        let page_id = doc.add_object(Object::Dictionary(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Contents" => content_id,
            "Resources" => Object::Dictionary(dictionary! {
                "Font" => Object::Dictionary(dictionary! { "F1" => font_id }),
            }),
        }));
        if let Object::Dictionary(d) = doc.get_object_mut(pages_id).unwrap() {
            d.set("Kids", vec![Object::Reference(page_id)]);
        }
        let catalog_id = doc.add_object(Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        }));
        doc.trailer.set("Root", catalog_id);

        let opts = WatermarkOpts {
            text: "审计底稿-第1页".into(),
            out_name: "[原文件名]-水印".into(),
            font_name: "heiti".into(),
            font_size: 14,
            rgb: [0, 0, 0],
            pos: WmPos::RightTop,
            transparency: 9,
            margin: 20,
            range: WmRange::All,
            num_fmt: WmNumFmt::Cn,
            dt_fmt: WmDtFmt::Cn,
        };
        stamp_document_ex(&mut doc, &opts, "底稿A", "审计项目组").expect("盖章应成功");

        // 结构断言：Contents 追加一条；资源挂上 WmIm / WmGs
        let page = doc.get_object(page_id).unwrap().as_dict().unwrap();
        let Object::Array(contents) = page.get(b"Contents").unwrap() else {
            panic!("Contents 应为数组");
        };
        assert_eq!(contents.len(), 2, "原内容流之后应追加水印流");
        let Object::Reference(wm_stream) = contents[1] else {
            panic!("水印流应为引用");
        };
        let Object::Stream(s) = doc.get_object(wm_stream).unwrap() else {
            panic!("水印流应为流对象");
        };
        let mut s = s.clone();
        s.decompress().expect("水印流应可解压");
        let raw = String::from_utf8_lossy(&s.content);
        assert!(raw.contains("/WmGs gs"), "应设置透明度 ExtGState：{raw}");
        assert!(raw.contains("/WmIm Do"), "应绘制水印图像：{raw}");
        // cm 必须缩放到位图实际尺寸（Image Do 画在单位正方形，
        // 缩放系数 = 1 会被渲染成 1pt 的点——回归防护）
        let toks: Vec<&str> = raw.split_whitespace().collect();
        let cm_idx = toks
            .iter()
            .position(|&t| t == "cm")
            .expect("应有 cm 变换：{raw}");
        let scale_a: f32 = toks[cm_idx - 6].parse().expect("cm 首操作数应为数字");
        assert!(
            scale_a > 5.0,
            "cm 水平缩放应等于位图宽度（pt），实际 {scale_a}"
        );

        let res = page.get(b"Resources").unwrap().as_dict().unwrap();
        let xobjs = res.get(b"XObject").unwrap().as_dict().unwrap();
        assert!(xobjs.get(b"WmIm").is_ok());
        let gs = res.get(b"ExtGState").unwrap().as_dict().unwrap();
        assert!(gs.get(b"WmGs").is_ok());

        // 落盘供目检
        let out = std::env::temp_dir().join("xdir_wm_e2e.pdf");
        doc.save(crate::fs::path::to_extended(&out.to_string_lossy()))
            .unwrap();
        println!("目检文件：{}", out.display());
        assert!(out.exists());
    }
}
