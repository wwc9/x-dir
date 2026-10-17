//! 图片批处理（右键菜单「图片处理」组，2026-10-15）：压缩 / 水印 / 格式转换 /
//! 尺寸调整 / 宫格拼图。底座 = image crate（MIT/Apache-2.0）：解码、编码、
//! 缩放与画布合成；PNG 无损优化走 oxipng（MIT），PNG8 调色板量化走 color_quant
//! （MIT/Apache-2.0；GPL 系 libimagequant 硬红线不采用），文字水印复用
//! pdf::stamp 的 ab_glyph 光栅化。全部旁写新文件不覆盖原文件；处理前先把
//! EXIF 方向烘焙进像素（转换产物不依赖查看器自动旋转，顺带抹除位置等隐私元数据）。

use std::io::Cursor;
use std::sync::atomic::AtomicBool;

use image::imageops::FilterType;
use image::{DynamicImage, ImageReader, RgbaImage};

use crate::fs::path::{file_name_of, join_name, parent_of, split_ext, to_extended};
use crate::jobs::pick::available_name;
use crate::jobs::{EmitterState, FailItem, JobProgress, is_cancelled};

/// 单批文件数上限（防病态多选拖垮串行任务槽）
pub(crate) const MAX_FILES: usize = 200;
/// 宫格拼图输入上限（4–36 张，2×2 到 6×6）
pub(crate) const MAX_MONTAGE: usize = 36;

// ────────────────────────── 选项（命令层传入，引擎存储） ──────────────────────────

/// 压缩目标：Auto = JPEG 输 JPEG@quality、PNG 输 PNG8、其余转 JPEG@quality
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CompressTarget {
    Auto,
    Jpeg,
    Png8,
    PngLossless,
}

/// 转换目标格式
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ImgFormat {
    Png,
    Jpeg,
    Bmp,
    Tiff,
    Ico,
    Webp,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompressOpts {
    pub target: CompressTarget,
    /// JPEG 质量 1–100
    pub quality: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WatermarkOpts {
    /// 图片水印的贴图路径；None = 文字水印（text 生效）
    pub image_path: Option<String>,
    /// 文字水印内容（image_path 为 None 时必填，≤40 字符）
    pub text: String,
    /// true = 平铺 45°（文字）/ 平铺阵列（图片）；false = 右下角标
    pub tile: bool,
    /// 不透明度百分比 10–100
    pub opacity: u8,
    /// 水印字号 = 图像短边 / font_div（文字水印；图片水印贴图宽 = 短边 / 贴图分母）
    pub scale_div: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ImgResizeMode {
    /// value = 百分比 1–800
    Percent,
    /// value = 目标宽 px
    Width,
    /// value = 目标高 px
    Height,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResizeOpts {
    pub mode: ImgResizeMode,
    pub value: u32,
    /// true = Lanczos3 高质量；false = Triangle 快速
    pub lanczos: bool,
    /// 仅缩小：目标尺寸大于原图时保持原尺寸
    pub only_down: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConvertOpts {
    pub target: ImgFormat,
    /// JPEG/WebP 目标的质量档（1–100；其余格式忽略）
    pub quality: u8,
    /// 处理前烘焙 EXIF 方向
    pub bake_exif: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MontageFill {
    /// 裁切填满每格（正方形格）
    Cover,
    /// 完整放入，短边贴齐、长边留白
    Contain,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MontageBg {
    White,
    Black,
    Transparent,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MontageOpts {
    /// 列数 2–6
    pub cols: u32,
    /// 单元格边长 px 128–2048
    pub cell: u32,
    /// 间距 px 0–64
    pub gap: u32,
    pub fill: MontageFill,
    pub bg: MontageBg,
    /// 输出文件（前端按首图目录 + 时间戳生成；重名自动 (2) 递增）
    pub output: String,
    /// true = PNG（透明底必须）；false = JPEG 质量 90
    pub png: bool,
}

// ────────────────────────── 纯函数（cargo test 覆盖） ──────────────────────────

/// 旁写输出名：<dir>\<stem><suffix><.ext>（ext 小写化）
pub(crate) fn sibling_out(path: &str, suffix: &str, ext: &str) -> String {
    let name = file_name_of(path);
    let (stem, _) = split_ext(&name);
    let dir = parent_of(path).unwrap_or_else(|| ".".to_string());
    join_name(
        &dir,
        &format!("{stem}{suffix}.{}", ext.to_ascii_lowercase()),
    )
}

/// 扩展名 → 支持解码的格式（含仅解码的 gif）
pub(crate) fn detect_format(path: &str) -> Option<ImgFormat> {
    let name = file_name_of(path);
    let (_, ext) = split_ext(&name);
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some(ImgFormat::Png),
        "jpg" | "jpeg" => Some(ImgFormat::Jpeg),
        "bmp" => Some(ImgFormat::Bmp),
        "tif" | "tiff" => Some(ImgFormat::Tiff),
        "webp" => Some(ImgFormat::Webp),
        "ico" => Some(ImgFormat::Ico),
        _ => None,
    }
}

/// 压缩 Auto 规则的输出格式（PNG→PNG8、JPEG→JPEG、其余→JPEG）
fn compress_auto_output(path: &str) -> (CompressTarget, &'static str) {
    match detect_format(path) {
        Some(ImgFormat::Png) => (CompressTarget::Png8, "png"),
        _ => (CompressTarget::Jpeg, "jpg"),
    }
}

/// 压缩质量的合法化钳制（1–100）
fn clamp_quality(q: u8) -> u8 {
    q.clamp(1, 100)
}

/// resize 目标尺寸计算：mode 驱动一边，另一边等比（至少 1px）。
/// only_down 时目标大于原图则保持原尺寸；尺寸上限 20000px 防爆内存。
fn resize_dims(
    mode: ImgResizeMode,
    value: u32,
    only_down: bool,
    (ow, oh): (u32, u32),
) -> Option<(u32, u32)> {
    if ow == 0 || oh == 0 {
        return None;
    }
    const MAX_SIDE: u64 = 20000;
    let (mut nw, mut nh) = match mode {
        ImgResizeMode::Percent => {
            let pct = value.clamp(1, 800) as u64;
            let nw = (ow as u64 * pct / 100).max(1);
            let nh = (oh as u64 * pct / 100).max(1);
            (nw, nh)
        }
        ImgResizeMode::Width => {
            let w = value as u64;
            (w, (w * oh as u64 / ow as u64).max(1))
        }
        ImgResizeMode::Height => {
            let h = value as u64;
            ((h * ow as u64 / oh as u64).max(1), h)
        }
    };
    if nw > MAX_SIDE || nh > MAX_SIDE {
        // 等比收敛到上限内
        let scale = f64::min(MAX_SIDE as f64 / nw as f64, MAX_SIDE as f64 / nh as f64);
        nw = ((nw as f64 * scale) as u64).max(1);
        nh = ((nh as f64 * scale) as u64).max(1);
    }
    let (nw, nh) = (nw as u32, nh as u32);
    if only_down && (nw > ow || nh > oh) {
        return Some((ow, oh));
    }
    Some((nw, nh))
}

/// 宫格布局：count 张图 → cols 列网格，返回画布尺寸与每格左上角坐标。
/// 行数 = ceil(count/cols)；尾行居左不居中（Explorer 拼贴惯例）。
fn montage_layout(count: usize, cols: u32, cell: u32, gap: u32) -> ((u32, u32), Vec<(i64, i64)>) {
    let cols = cols.max(1);
    let rows = (count as u32).div_ceil(cols);
    let w = cols * cell + (cols.saturating_sub(1)) * gap;
    let h = rows * cell + (rows.saturating_sub(1)) * gap;
    let mut cells = Vec::with_capacity(count);
    for i in 0..count {
        let r = i as u32 / cols;
        let c = i as u32 % cols;
        cells.push(((c * (cell + gap)) as i64, (r * (cell + gap)) as i64));
    }
    ((w, h), cells)
}

/// EXIF Orientation 值 → 像素纠正动作（1 = 不动）
#[derive(Clone, Copy, Debug, PartialEq)]
enum ExifFix {
    None,
    FlipH,
    Rotate180,
    FlipV,
    Transpose,
    Rotate90,
    Transverse,
    Rotate270,
}

fn exif_fix(orientation: u32) -> ExifFix {
    match orientation {
        2 => ExifFix::FlipH,
        3 => ExifFix::Rotate180,
        4 => ExifFix::FlipV,
        5 => ExifFix::Transpose,
        6 => ExifFix::Rotate90,
        7 => ExifFix::Transverse,
        8 => ExifFix::Rotate270,
        _ => ExifFix::None,
    }
}

fn apply_exif_fix(img: DynamicImage, fix: ExifFix) -> DynamicImage {
    use image::imageops as ops;
    match fix {
        ExifFix::None => img,
        ExifFix::FlipH => DynamicImage::ImageRgba8(ops::flip_horizontal(&img.to_rgba8())),
        ExifFix::Rotate180 => DynamicImage::ImageRgba8(ops::rotate180(&img.to_rgba8())),
        ExifFix::FlipV => DynamicImage::ImageRgba8(ops::flip_vertical(&img.to_rgba8())),
        ExifFix::Transpose => {
            DynamicImage::ImageRgba8(ops::flip_horizontal(&ops::rotate90(&img.to_rgba8())))
        }
        ExifFix::Rotate90 => DynamicImage::ImageRgba8(ops::rotate90(&img.to_rgba8())),
        ExifFix::Transverse => {
            DynamicImage::ImageRgba8(ops::flip_vertical(&ops::rotate90(&img.to_rgba8())))
        }
        ExifFix::Rotate270 => DynamicImage::ImageRgba8(ops::rotate270(&img.to_rgba8())),
    }
}

/// 读 EXIF Orientation（无 EXIF/读失败 = 1）。只关心 JPEG/TIFF/WebP 容器。
fn read_orientation(path: &str) -> u32 {
    let Ok(file) = std::fs::File::open(to_extended(path)) else {
        return 1;
    };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file))
    else {
        return 1;
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .unwrap_or(1)
}

/// 解码 + EXIF 方向烘焙 → RGBA8
fn decode_rgba(path: &str, bake_exif: bool) -> Result<RgbaImage, String> {
    let raw = std::fs::read(to_extended(path)).map_err(|e| format!("读取失败：{e}"))?;
    let img = ImageReader::new(Cursor::new(&raw))
        .with_guessed_format()
        .map_err(|e| format!("格式识别失败：{e}"))?
        .decode()
        .map_err(|e| format!("解码失败：{e}"))?;
    let oriented = if bake_exif {
        apply_exif_fix(img, exif_fix(read_orientation(path)))
    } else {
        img
    };
    Ok(oriented.to_rgba8())
}

// ────────────────────────── 编码 ──────────────────────────

fn encode_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    // JPEG 无 alpha：先铺白底合成
    let flat = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, clamp_quality(quality));
    flat.write_with_encoder(enc)
        .map_err(|e| format!("JPEG 编码失败：{e}"))?;
    Ok(out)
}

fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img.clone())
        .write_with_encoder(image::codecs::png::PngEncoder::new(&mut out))
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    Ok(out)
}

/// PNG8：color_quant NeuQuant 调色板量化（≤256 色 + 逐色 alpha），经 png crate
/// 写 indexed PNG（PLTE+tRNS）。image crate 的 PNG 编码器不支持调色板输出。
fn encode_png8(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let pixels = img.clone().into_raw();
    let nq = color_quant::NeuQuant::new(256, 1, &pixels);
    let cmap = nq.color_map_rgba();
    let (w, h) = (img.width(), img.height());
    let mut indexed: Vec<u8> = Vec::with_capacity((w * h) as usize);
    for px in img.pixels() {
        let [r, g, b, a] = px.0;
        let idx = nq.index_of(&[r, g, b, a]);
        indexed.push(idx as u8);
    }
    let mut palette = Vec::with_capacity(cmap.len() * 3);
    let mut trns = Vec::with_capacity(cmap.len());
    for &[r, g, b, a] in cmap.as_chunks::<4>().0 {
        palette.extend_from_slice(&[r, g, b]);
        trns.push(a);
    }
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Indexed);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_palette(palette);
    enc.set_trns(trns);
    let mut writer = enc
        .write_header()
        .map_err(|e| format!("PNG8 头写入失败：{e}"))?;
    writer
        .write_image_data(&indexed)
        .map_err(|e| format!("PNG8 写入失败：{e}"))?;
    drop(writer);
    Ok(out)
}

/// PNG 无损优化：oxipng preset 2（速度/压缩比均衡）
fn optimize_png_lossless(path: &str) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(to_extended(path)).map_err(|e| format!("读取失败：{e}"))?;
    oxipng::optimize_from_memory(&raw, &oxipng::Options::from_preset(2))
        .map_err(|e| format!("PNG 优化失败：{e:?}"))
}

fn encode_any(img: &RgbaImage, format: ImgFormat, quality: u8) -> Result<Vec<u8>, String> {
    match format {
        ImgFormat::Jpeg => encode_jpeg(img, quality),
        ImgFormat::Png => encode_png(img),
        ImgFormat::Webp => {
            let mut out = Vec::new();
            image::DynamicImage::ImageRgba8(img.clone())
                .write_with_encoder(image::codecs::webp::WebPEncoder::new_lossless(&mut out))
                .map_err(|e| format!("WebP 编码失败：{e}"))?;
            Ok(out)
        }
        ImgFormat::Ico => {
            // ICO 单帧上限 256px：超限等比缩到 256 内；IcoEncoder 需要 Seek
            let capped = cap_side(img, 256);
            let mut out = Vec::new();
            image::DynamicImage::ImageRgba8(capped)
                .write_with_encoder(image::codecs::ico::IcoEncoder::new(std::io::Cursor::new(
                    &mut out,
                )))
                .map_err(|e| format!("ICO 编码失败：{e}"))?;
            Ok(out)
        }
        ImgFormat::Bmp | ImgFormat::Tiff => {
            let mut out = Vec::new();
            let dyn_img = image::DynamicImage::ImageRgba8(img.clone());
            // TiffEncoder 需要 Seek，统一走 Cursor
            let result = if format == ImgFormat::Bmp {
                dyn_img.write_with_encoder(image::codecs::bmp::BmpEncoder::new(&mut out))
            } else {
                dyn_img.write_with_encoder(image::codecs::tiff::TiffEncoder::new(
                    std::io::Cursor::new(&mut out),
                ))
            };
            result.map_err(|e| format!("编码失败：{e}"))?;
            Ok(out)
        }
    }
}

/// 等比缩到最长边 ≤ cap（已达标则原样克隆返回）
fn cap_side(img: &RgbaImage, cap: u32) -> RgbaImage {
    let (w, h) = (img.width(), img.height());
    let long = w.max(h);
    if long <= cap || long == 0 {
        return img.clone();
    }
    let scale = cap as f64 / long as f64;
    let nw = ((w as f64 * scale) as u32).max(1);
    let nh = ((h as f64 * scale) as u32).max(1);
    image::imageops::resize(img, nw, nh, FilterType::Lanczos3)
}

fn write_out(path: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(to_extended(path), bytes).map_err(|e| format!("写入失败：{e}"))
}

// ────────────────────────── 任务执行（引擎串行槽内跑） ──────────────────────────

fn finish_one(
    p: &str,
    result: Result<(), String>,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    if let Err(e) = result {
        failed.push(FailItem {
            path: p.to_string(),
            message: e,
        });
    }
    prog.done_files += 1;
    em.progress(prog);
}

pub(crate) fn run_compress(
    paths: &[String],
    opts: &CompressOpts,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        let (target, ext) = match opts.target {
            CompressTarget::Auto => compress_auto_output(p),
            CompressTarget::Jpeg => (CompressTarget::Jpeg, "jpg"),
            CompressTarget::Png8 => (CompressTarget::Png8, "png"),
            CompressTarget::PngLossless => (CompressTarget::PngLossless, "png"),
        };
        let out = available_name(&sibling_out(p, "_压缩", ext));
        let result = (|| -> Result<(), String> {
            let bytes = match target {
                CompressTarget::PngLossless => optimize_png_lossless(p)?,
                CompressTarget::Png8 => encode_png8(&decode_rgba(p, true)?)?,
                _ => encode_jpeg(&decode_rgba(p, true)?, opts.quality)?,
            };
            write_out(&out, &bytes)
        })();
        finish_one(p, result, prog, em, failed);
    }
}

pub(crate) fn run_watermark(
    paths: &[String],
    opts: &WatermarkOpts,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    // 文字水印：字体与位图一次光栅化，全批共用（同 PDF 水印）
    let text_tile: Option<RgbaImage> = if opts.image_path.is_none() {
        let Some(font) = crate::pdf::stamp::load_cjk_font() else {
            failed.push(FailItem {
                path: "-".into(),
                message: "未找到可用的系统字体（msyh/simhei/simsun/arial）".into(),
            });
            return;
        };
        // 字号基准 96px 光栅化，贴图时按短边比例缩放
        let bmp = crate::pdf::stamp::rasterize_text(&font, &opts.text, 96.0);
        Some(rgba_from_stamp(&bmp, [64, 64, 64], opts.opacity))
    } else {
        None
    };
    // 图片水印：贴图一次解码（失败逐文件回报）
    let logo_tile: Option<Result<RgbaImage, String>> =
        opts.image_path.as_ref().map(|lp| decode_rgba(lp, false));
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        // 输出保持原格式；不认识的扩展名退 PNG
        let name = file_name_of(p);
        let (_, src_ext) = split_ext(&name);
        let ext = match src_ext.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => "jpg",
            "png" => "png",
            "webp" => "webp",
            "bmp" => "bmp",
            "tif" | "tiff" => "tiff",
            _ => "png",
        };
        let out = available_name(&sibling_out(p, "_水印", ext));
        let result = (|| -> Result<(), String> {
            let img = decode_rgba(p, true)?;
            let tile = match (&text_tile, &logo_tile) {
                (Some(t), _) => scale_tile(t, opts.scale_div, img.width().min(img.height())),
                (None, Some(Ok(l))) => scale_tile(l, opts.scale_div, img.width().min(img.height())),
                (None, Some(Err(e))) => return Err(e.clone()),
                (None, None) => return Err("水印内容为空".into()),
            };
            let stamped = if opts.tile {
                stamp_tiled(&img, &tile)
            } else {
                stamp_corner(&img, &tile)
            };
            write_out(
                &out,
                &encode_any(&stamped, detect_format(p).unwrap_or(ImgFormat::Png), 90)?,
            )
        })();
        finish_one(p, result, prog, em, failed);
    }
}

/// StampBitmap（RGB 恒色 + 覆盖率平面）→ RGBA 贴图（水印色 + 覆盖率×不透明度）
fn rgba_from_stamp(
    bmp: &crate::pdf::stamp::StampBitmap,
    [r, g, b]: [u8; 3],
    opacity_pct: u8,
) -> RgbaImage {
    let op = opacity_pct.clamp(1, 100) as u16;
    let mut out = RgbaImage::new(bmp.width.max(1), bmp.height.max(1));
    for (i, px) in out.pixels_mut().enumerate() {
        let cover = bmp.alpha.get(i).copied().unwrap_or(0) as u16;
        px.0 = [r, g, b, ((cover * op) / 100).min(255) as u8];
    }
    out
}

/// 贴图缩放（文字与图片贴图统一口径）：最长边 → 短边/scale_div（下限 16px）
fn scale_tile(tile: &RgbaImage, scale_div: u32, min_side: u32) -> RgbaImage {
    let target = (min_side / scale_div.max(1)).max(16);
    let (tw, th) = (tile.width().max(1), tile.height().max(1));
    let long = tw.max(th) as f64;
    let k = target as f64 / long;
    let nw = ((tw as f64 * k) as u32).max(16);
    let nh = ((th as f64 * k) as u32).max(16);
    image::imageops::resize(tile, nw, nh, FilterType::Lanczos3)
}

/// 平铺 45°：贴图旋转后以半错位网格铺满画布
fn stamp_tiled(img: &RgbaImage, tile: &RgbaImage) -> RgbaImage {
    let rotated = rotate_tile_45(tile);
    let (iw, ih) = (img.width() as i64, img.height() as i64);
    let (tw, th) = (rotated.width() as i64, rotated.height() as i64);
    let mut out = img.clone();
    if tw == 0 || th == 0 {
        return out;
    }
    // 步距 = 贴图尺寸（相邻不重叠留一倍空隙），奇数行错位半格
    let step_x = tw + tw / 2;
    let step_y = th + th / 2;
    let mut row = 0i64;
    let mut y = -(th / 2);
    while y < ih {
        let mut x = -(tw / 2) + if row % 2 == 1 { step_x / 2 } else { 0 };
        while x < iw {
            overlay_at(&mut out, &rotated, x, y);
            x += step_x;
        }
        y += step_y;
        row += 1;
    }
    out
}

/// 贴图旋转 45°（image crate 无任意角旋转）：外接方形画布 + 逆映射双线性采样，
/// 采样出界 = 透明
fn rotate_tile_45(tile: &RgbaImage) -> RgbaImage {
    const SIN45: f64 = std::f64::consts::FRAC_1_SQRT_2;
    let (tw, th) = (tile.width() as f64, tile.height() as f64);
    let diag = (tw * tw + th * th).sqrt();
    let ow = (diag.ceil() as u32).max(1);
    let oh = ow;
    let mut out = RgbaImage::new(ow, oh);
    let (ocx, ocy) = (ow as f64 / 2.0, oh as f64 / 2.0);
    for oy in 0..oh {
        for ox in 0..ow {
            let dx = ox as f64 + 0.5 - ocx;
            let dy = oy as f64 + 0.5 - ocy;
            // 逆旋转 -45°：源坐标绕贴图中心取值
            let sx = SIN45 * dx + SIN45 * dy + tw / 2.0 - 0.5;
            let sy = -SIN45 * dx + SIN45 * dy + th / 2.0 - 0.5;
            out.put_pixel(ox, oy, bilinear(tile, sx, sy));
        }
    }
    out
}

/// 双线性采样（出界透明；直通 alpha 的边缘混黑对半透明水印无感）
fn bilinear(img: &RgbaImage, x: f64, y: f64) -> image::Rgba<u8> {
    let (w, h) = (img.width() as i64, img.height() as i64);
    if x < -1.0 || y < -1.0 || x > w as f64 || y > h as f64 {
        return image::Rgba([0, 0, 0, 0]);
    }
    let x0 = x.floor() as i64;
    let y0 = y.floor() as i64;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let sample = |xx: i64, yy: i64| -> [f64; 4] {
        if xx < 0 || yy < 0 || xx >= w || yy >= h {
            [0.0; 4]
        } else {
            let p = img.get_pixel(xx as u32, yy as u32).0;
            [p[0] as f64, p[1] as f64, p[2] as f64, p[3] as f64]
        }
    };
    let c00 = sample(x0, y0);
    let c10 = sample(x0 + 1, y0);
    let c01 = sample(x0, y0 + 1);
    let c11 = sample(x0 + 1, y0 + 1);
    let mut px = [0u8; 4];
    for i in 0..4 {
        let top = c00[i] * (1.0 - fx) + c10[i] * fx;
        let bot = c01[i] * (1.0 - fx) + c11[i] * fx;
        px[i] = (top * (1.0 - fy) + bot * fy).round().clamp(0.0, 255.0) as u8;
    }
    image::Rgba(px)
}

/// 右下角标：留 min_side/20 边距
fn stamp_corner(img: &RgbaImage, tile: &RgbaImage) -> RgbaImage {
    let mut out = img.clone();
    let margin = (img.width().min(img.height()) / 20).max(4) as i64;
    let x = img.width() as i64 - tile.width() as i64 - margin;
    let y = img.height() as i64 - tile.height() as i64 - margin;
    overlay_at(&mut out, tile, x.max(0), y.max(0));
    out
}

/// alpha 混合贴图到 (x,y)（超出画布裁剪；src-over 语义）
fn overlay_at(canvas: &mut RgbaImage, tile: &RgbaImage, x: i64, y: i64) {
    let (cw, ch) = (canvas.width() as i64, canvas.height() as i64);
    for sy in 0..tile.height() as i64 {
        let cy = y + sy;
        if cy < 0 || cy >= ch {
            continue;
        }
        for tx in 0..tile.width() as i64 {
            let cx = x + tx;
            if cx < 0 || cx >= cw {
                continue;
            }
            let src = tile.get_pixel(tx as u32, sy as u32);
            if src.0[3] == 0 {
                continue;
            }
            let dst = canvas.get_pixel_mut(cx as u32, cy as u32);
            blend_px(dst, src);
        }
    }
}

/// 单像素 src-over（8bit 通道近似：a = sa + da(1-sa)）
fn blend_px(dst: &mut image::Rgba<u8>, src: &image::Rgba<u8>) {
    let (sr, sg, sb, sa) = (
        src.0[0] as u32,
        src.0[1] as u32,
        src.0[2] as u32,
        src.0[3] as u32,
    );
    let (dr, dg, db, da) = (
        dst.0[0] as u32,
        dst.0[1] as u32,
        dst.0[2] as u32,
        dst.0[3] as u32,
    );
    let out_a = sa * 255 + da * (255 - sa);
    let mix = |s: u32, d: u32| -> u8 {
        // 全透明叠加（sa=da=0）除零 → 0；checked_div 同时满足 clippy manual_checked_div
        (s * sa * 255 + d * da * (255 - sa))
            .checked_div(out_a)
            .unwrap_or(0)
            .min(255) as u8
    };
    dst.0 = [
        mix(sr, dr),
        mix(sg, dg),
        mix(sb, db),
        (out_a / 255).min(255) as u8,
    ];
}

pub(crate) fn run_convert(
    paths: &[String],
    opts: &ConvertOpts,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let ext = match opts.target {
        ImgFormat::Png => "png",
        ImgFormat::Jpeg => "jpg",
        ImgFormat::Bmp => "bmp",
        ImgFormat::Tiff => "tiff",
        ImgFormat::Ico => "ico",
        ImgFormat::Webp => "webp",
    };
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        let out = available_name(&sibling_out(p, "_转换", ext));
        let result = (|| -> Result<(), String> {
            let img = decode_rgba(p, opts.bake_exif)?;
            write_out(&out, &encode_any(&img, opts.target, opts.quality)?)
        })();
        finish_one(p, result, prog, em, failed);
    }
}

pub(crate) fn run_resize(
    paths: &[String],
    opts: &ResizeOpts,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let filter = if opts.lanczos {
        FilterType::Lanczos3
    } else {
        FilterType::Triangle
    };
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        // 输出保持原格式（不认识的扩展名退 PNG）
        let name = file_name_of(p);
        let (_, src_ext) = split_ext(&name);
        let ext = match src_ext.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => "jpg",
            "png" => "png",
            "webp" => "webp",
            "bmp" => "bmp",
            "tif" | "tiff" => "tiff",
            _ => "png",
        };
        let out = available_name(&sibling_out(p, "_缩放", ext));
        let result = (|| -> Result<(), String> {
            let img = decode_rgba(p, true)?;
            let (nw, nh) = resize_dims(
                opts.mode,
                opts.value,
                opts.only_down,
                (img.width(), img.height()),
            )
            .ok_or("原图尺寸无效")?;
            let resized = image::imageops::resize(&img, nw, nh, filter);
            let format = detect_format(p).unwrap_or(ImgFormat::Png);
            let bytes = match format {
                ImgFormat::Jpeg => encode_jpeg(&resized, 90)?,
                other => encode_any(&resized, other, 90)?,
            };
            write_out(&out, &bytes)
        })();
        finish_one(p, result, prog, em, failed);
    }
}

pub(crate) fn run_montage(
    paths: &[String],
    opts: &MontageOpts,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let ((cw, ch), cells) = montage_layout(paths.len(), opts.cols, opts.cell, opts.gap);
    let mut canvas = RgbaImage::new(cw.max(1), ch.max(1));
    // 底色
    let bg = match opts.bg {
        MontageBg::White => [255, 255, 255, 255],
        MontageBg::Black => [0, 0, 0, 255],
        MontageBg::Transparent => [0, 0, 0, 0],
    };
    for px in canvas.pixels_mut() {
        px.0 = bg;
    }
    for (p, (x, y)) in paths.iter().zip(&cells) {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        let result = (|| -> Result<(), String> {
            let img = decode_rgba(p, true)?;
            let cell_img = match opts.fill {
                MontageFill::Cover => cover_cell(&img, opts.cell),
                MontageFill::Contain => contain_cell(&img, opts.cell, bg),
            };
            copy_cell(&mut canvas, &cell_img, *x, *y);
            Ok(())
        })();
        if let Err(e) = result {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
    if is_cancelled(cancel) {
        return;
    }
    // 底色透明或任一输入是 PNG → 输出 PNG（保透明）；否则 JPEG q90
    let bytes = if opts.png || opts.bg == MontageBg::Transparent {
        encode_png(&canvas)
    } else {
        encode_jpeg(&canvas, 90)
    };
    if let Err(e) = bytes.and_then(|b| write_out(&available_name(&opts.output), &b)) {
        failed.push(FailItem {
            path: opts.output.clone(),
            message: e,
        });
    }
}

/// cover：等比放大到填满 cell 再居中裁切
fn cover_cell(img: &RgbaImage, cell: u32) -> RgbaImage {
    let (w, h) = (img.width() as f64, img.height() as f64);
    let k = (cell as f64 / w).max(cell as f64 / h);
    let nw = ((w * k) as u32).max(cell);
    let nh = ((h * k) as u32).max(cell);
    let mut scaled = image::imageops::resize(img, nw, nh, FilterType::Lanczos3);
    let ox = (nw - cell) / 2;
    let oy = (nh - cell) / 2;
    image::imageops::crop(&mut scaled, ox, oy, cell, cell).to_image()
}

/// contain：等比缩到 cell 内，居中贴在纯色格底上
fn contain_cell(img: &RgbaImage, cell: u32, bg: [u8; 4]) -> RgbaImage {
    let mut cell_img = RgbaImage::from_pixel(cell, cell, image::Rgba(bg));
    let (w, h) = (img.width(), img.height());
    let long = w.max(h).max(1);
    let k = cell as f64 / long as f64;
    let nw = ((w as f64 * k) as u32).clamp(1, cell);
    let nh = ((h as f64 * k) as u32).clamp(1, cell);
    let scaled = image::imageops::resize(img, nw, nh, FilterType::Lanczos3);
    let ox = (cell - nw) / 2;
    let oy = (cell - nh) / 2;
    image::imageops::overlay(&mut cell_img, &scaled, ox as i64, oy as i64);
    cell_img
}

fn copy_cell(canvas: &mut RgbaImage, cell_img: &RgbaImage, x: i64, y: i64) {
    image::imageops::overlay(canvas, cell_img, x, y);
}

// ────────────────────────── 测试 ──────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sibling_out_appends_suffix_and_keeps_dir() {
        assert_eq!(
            sibling_out("E:\\a\\b\\photo.JPG", "_压缩", "jpg"),
            "E:\\a\\b\\photo_压缩.jpg"
        );
        assert_eq!(
            sibling_out("E:\\pic.png", "_转换", "webp"),
            "E:\\pic_转换.webp"
        );
    }

    #[test]
    fn detect_format_maps_known_extensions() {
        assert_eq!(detect_format("E:\\a.PNG"), Some(ImgFormat::Png));
        assert_eq!(detect_format("E:\\a.JPEG"), Some(ImgFormat::Jpeg));
        assert_eq!(detect_format("E:\\a.tif"), Some(ImgFormat::Tiff));
        assert_eq!(detect_format("E:\\a.webp"), Some(ImgFormat::Webp));
        assert_eq!(detect_format("E:\\a.exe"), None);
        assert_eq!(detect_format("E:\\无扩展名"), None);
    }

    #[test]
    fn compress_auto_routes_png_to_png8_others_to_jpeg() {
        assert_eq!(
            compress_auto_output("E:\\shot.png"),
            (CompressTarget::Png8, "png")
        );
        assert_eq!(
            compress_auto_output("E:\\photo.jpeg"),
            (CompressTarget::Jpeg, "jpg")
        );
        assert_eq!(
            compress_auto_output("E:\\icon.bmp"),
            (CompressTarget::Jpeg, "jpg")
        );
    }

    #[test]
    fn clamp_quality_bounds_1_to_100() {
        assert_eq!(clamp_quality(0), 1);
        assert_eq!(clamp_quality(75), 75);
        assert_eq!(clamp_quality(255), 100);
    }

    #[test]
    fn resize_dims_percent_scales_both_sides() {
        assert_eq!(
            resize_dims(ImgResizeMode::Percent, 50, false, (1000, 500)),
            Some((500, 250))
        );
        assert_eq!(
            resize_dims(ImgResizeMode::Percent, 300, false, (100, 10)),
            Some((300, 30))
        );
    }

    #[test]
    fn resize_dims_width_height_keep_ratio() {
        assert_eq!(
            resize_dims(ImgResizeMode::Width, 500, false, (1000, 500)),
            Some((500, 250))
        );
        assert_eq!(
            resize_dims(ImgResizeMode::Height, 100, false, (2000, 400)),
            Some((500, 100))
        );
    }

    #[test]
    fn resize_dims_only_down_never_enlarges() {
        assert_eq!(
            resize_dims(ImgResizeMode::Percent, 200, true, (100, 50)),
            Some((100, 50))
        );
        assert_eq!(
            resize_dims(ImgResizeMode::Percent, 200, false, (100, 50)),
            Some((200, 100))
        );
    }

    #[test]
    fn resize_dims_zero_input_rejected() {
        assert_eq!(
            resize_dims(ImgResizeMode::Percent, 50, false, (0, 10)),
            None
        );
    }

    #[test]
    fn montage_layout_places_cells_row_major() {
        let ((w, h), cells) = montage_layout(5, 2, 100, 10);
        // 3 行 2 列：宽 = 2*100+10，高 = 3*100+2*10
        assert_eq!((w, h), (210, 320));
        assert_eq!(cells[0], (0, 0));
        assert_eq!(cells[1], (110, 0));
        assert_eq!(cells[2], (0, 110));
        assert_eq!(cells[4], (0, 220));
    }

    #[test]
    fn montage_layout_gap_zero_is_flush() {
        let ((w, h), cells) = montage_layout(4, 4, 64, 0);
        assert_eq!((w, h), (256, 64));
        assert_eq!(cells[3], (192, 0));
    }

    #[test]
    fn exif_fix_maps_orientations() {
        assert_eq!(exif_fix(1), ExifFix::None);
        assert_eq!(exif_fix(2), ExifFix::FlipH);
        assert_eq!(exif_fix(6), ExifFix::Rotate90);
        assert_eq!(exif_fix(8), ExifFix::Rotate270);
        assert_eq!(exif_fix(99), ExifFix::None);
    }

    #[test]
    fn blend_px_src_over() {
        let mut dst = image::Rgba([255, 255, 255, 255]);
        blend_px(&mut dst, &image::Rgba([0, 0, 0, 128]));
        // 半透明黑叠白底 ≈ 中灰
        assert!(dst.0[0] > 100 && dst.0[0] < 140);
        assert_eq!(dst.0[3], 255);

        let mut transparent = image::Rgba([0, 0, 0, 0]);
        blend_px(&mut transparent, &image::Rgba([10, 20, 30, 255]));
        assert_eq!(transparent.0, [10, 20, 30, 255]);
    }

    #[test]
    fn cover_cell_crops_to_square() {
        let img = RgbaImage::from_pixel(400, 200, image::Rgba([9, 9, 9, 255]));
        let cell = cover_cell(&img, 100);
        assert_eq!((cell.width(), cell.height()), (100, 100));
    }

    #[test]
    fn contain_cell_fits_inside_and_centers() {
        let img = RgbaImage::from_pixel(400, 200, image::Rgba([9, 9, 9, 255]));
        let cell = contain_cell(&img, 100, [255, 255, 255, 255]);
        assert_eq!((cell.width(), cell.height()), (100, 100));
        // 四角是底色（图居中不满铺）
        assert_eq!(cell.get_pixel(0, 0).0, [255, 255, 255, 255]);
    }
}
