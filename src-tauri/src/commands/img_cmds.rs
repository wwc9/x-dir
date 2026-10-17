//! 图片批处理命令（右键「图片处理」组）：压缩 / 水印 / 格式转换 / 尺寸调整 /
//! 宫格拼图，全部入任务引擎（进度/取消/灵动岛回执）。校验：扩展名可解码、
//! 数量上限、水印内容与参数范围。

use tauri::{AppHandle, State};

use super::files::AppError;
use super::jobs_cmds::JobId;
use crate::AppState;
use crate::fs::entry::path_exists;
use crate::fs::path::file_name_of;
use crate::img::{
    CompressOpts, CompressTarget, ConvertOpts, ImgFormat, ImgResizeMode, MAX_FILES, MAX_MONTAGE,
    MontageBg, MontageFill, MontageOpts, ResizeOpts, WatermarkOpts,
};
use crate::jobs::JobKind;

/// 可解码图片的扩展名（gif 仅解码首帧）
fn is_img(path: &str) -> bool {
    matches!(
        file_name_of(path)
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "jpg" | "jpeg" | "png" | "bmp" | "tif" | "tiff" | "webp" | "ico" | "gif"
    )
}

fn reject_not_img(paths: &[String]) -> Result<(), AppError> {
    let bad = paths.iter().find(|p| !path_exists(p) || !is_img(p));
    match bad {
        Some(p) => Err(AppError::new(
            "E_NOT_FOUND",
            format!("文件不存在或不是可解码的图片：{}", file_name_of(p)),
        )),
        None => Ok(()),
    }
}

fn reject_batch_size(paths: &[String], max: usize, label: &str) -> Result<(), AppError> {
    if paths.is_empty() || paths.len() > max {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("{label}数量需在 1–{max} 之间"),
        ));
    }
    Ok(())
}

// 质量档合法化（1–100）
fn parse_quality(q: u8) -> Result<u8, AppError> {
    if !(1..=100).contains(&q) {
        return Err(AppError::new("E_INVALID_NAME", "质量需在 1–100 之间"));
    }
    Ok(q)
}

#[tauri::command]
pub fn img_compress(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    // 0 = Auto（JPEG→JPEG / PNG→PNG8 / 其余→JPEG），1 = JPEG，2 = PNG8，3 = 无损优化
    target: u8,
    // JPEG 输出质量 1–100
    quality: u8,
) -> Result<JobId, AppError> {
    reject_not_img(&paths)?;
    reject_batch_size(&paths, MAX_FILES, "图片")?;
    let target = match target {
        0 => CompressTarget::Auto,
        1 => CompressTarget::Jpeg,
        2 => CompressTarget::Png8,
        3 => CompressTarget::PngLossless,
        _ => return Err(AppError::new("E_INVALID_NAME", "压缩目标无效")),
    };
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ImgCompress {
                opts: CompressOpts {
                    target,
                    quality: parse_quality(quality)?,
                },
            },
            paths,
            None,
            crate::jobs::Policy::Skip,
            false,
            app,
        ),
    })
}

// 参数面 = IPC 契约（扁平命名参数），Tauri 命令不宜为此强并结构体
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn img_watermark(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    // 贴图水印的图片路径；空串 = 文字水印
    image_path: String,
    // 文字水印内容（image_path 为空时必填）
    text: String,
    // true = 平铺，false = 右下角标
    tile: bool,
    // 不透明度百分比 10–100
    opacity: u8,
    // 水印尺寸 = 短边 / scale_div（4–64）
    scale_div: u32,
) -> Result<JobId, AppError> {
    reject_not_img(&paths)?;
    reject_batch_size(&paths, MAX_FILES, "图片")?;
    let text = text.trim().to_string();
    let image_path = image_path.trim().to_string();
    let opts = if image_path.is_empty() {
        if text.is_empty() || text.chars().count() > 40 {
            return Err(AppError::new("E_INVALID_NAME", "水印文字需为 1–40 个字符"));
        }
        WatermarkOpts {
            image_path: None,
            text,
            tile,
            opacity: opacity.clamp(10, 100),
            scale_div: scale_div.clamp(4, 64),
        }
    } else {
        if !path_exists(&image_path) || !is_img(&image_path) {
            return Err(AppError::new(
                "E_NOT_FOUND",
                "水印贴图不存在或不是可解码的图片",
            ));
        }
        WatermarkOpts {
            image_path: Some(image_path),
            text: String::new(),
            tile,
            opacity: opacity.clamp(10, 100),
            scale_div: scale_div.clamp(4, 64),
        }
    };
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ImgWatermark { opts },
            paths,
            None,
            crate::jobs::Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn img_convert(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    // 0 png / 1 jpg / 2 bmp / 3 tiff / 4 ico / 5 webp(无损)
    target: u8,
    // JPEG 目标质量 1–100（其余忽略）
    quality: u8,
    // 处理前烘焙 EXIF 方向
    bake_exif: bool,
) -> Result<JobId, AppError> {
    reject_not_img(&paths)?;
    reject_batch_size(&paths, MAX_FILES, "图片")?;
    let target = match target {
        0 => ImgFormat::Png,
        1 => ImgFormat::Jpeg,
        2 => ImgFormat::Bmp,
        3 => ImgFormat::Tiff,
        4 => ImgFormat::Ico,
        5 => ImgFormat::Webp,
        _ => return Err(AppError::new("E_INVALID_NAME", "目标格式无效")),
    };
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ImgConvert {
                opts: ConvertOpts {
                    target,
                    quality: parse_quality(quality)?,
                    bake_exif,
                },
            },
            paths,
            None,
            crate::jobs::Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn img_resize(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    // 0 = 百分比（1–800），1 = 指定宽，2 = 指定高（1–20000）
    mode: u8,
    value: u32,
    // true = Lanczos3 高质量，false = Triangle 快速
    lanczos: bool,
    // 目标大于原图时保持原尺寸
    only_down: bool,
) -> Result<JobId, AppError> {
    reject_not_img(&paths)?;
    reject_batch_size(&paths, MAX_FILES, "图片")?;
    let mode = match mode {
        0 => {
            if !(1..=800).contains(&value) {
                return Err(AppError::new("E_INVALID_NAME", "百分比需在 1–800 之间"));
            }
            ImgResizeMode::Percent
        }
        1 | 2 => {
            if value == 0 || value > 20000 {
                return Err(AppError::new(
                    "E_INVALID_NAME",
                    "目标尺寸需在 1–20000px 之间",
                ));
            }
            if mode == 1 {
                ImgResizeMode::Width
            } else {
                ImgResizeMode::Height
            }
        }
        _ => return Err(AppError::new("E_INVALID_NAME", "缩放模式无效")),
    };
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ImgResize {
                opts: ResizeOpts {
                    mode,
                    value,
                    lanczos,
                    only_down,
                },
            },
            paths,
            None,
            crate::jobs::Policy::Skip,
            false,
            app,
        ),
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn img_montage(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    // 列数 2–6
    cols: u32,
    // 单元格边长 px 128–2048
    cell: u32,
    // 间距 px 0–64
    gap: u32,
    // true = 裁切填满，false = 完整留白
    cover: bool,
    // 0 白 / 1 黑 / 2 透明
    bg: u8,
    // 输出文件（首图目录 + 时间戳名，前端生成；重名自动 (2)）
    output: String,
    // true = PNG（透明底必须），false = JPEG 质量 90
    png: bool,
) -> Result<JobId, AppError> {
    reject_not_img(&paths)?;
    reject_batch_size(&paths, MAX_MONTAGE, "拼图输入")?;
    if paths.len() < 4 {
        return Err(AppError::new("E_INVALID_NAME", "宫格拼图至少需要 4 张图片"));
    }
    if !(2..=6).contains(&cols) {
        return Err(AppError::new("E_INVALID_NAME", "列数需在 2–6 之间"));
    }
    if !(128..=2048).contains(&cell) {
        return Err(AppError::new(
            "E_INVALID_NAME",
            "单元格边长需在 128–2048px 之间",
        ));
    }
    if gap > 64 {
        return Err(AppError::new("E_INVALID_NAME", "间距不能超过 64px"));
    }
    if output.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名无效"));
    }
    let bg = match bg {
        0 => MontageBg::White,
        1 => MontageBg::Black,
        2 => MontageBg::Transparent,
        _ => return Err(AppError::new("E_INVALID_NAME", "底色无效")),
    };
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ImgMontage {
                opts: MontageOpts {
                    cols,
                    cell,
                    gap,
                    fill: if cover {
                        MontageFill::Cover
                    } else {
                        MontageFill::Contain
                    },
                    bg,
                    output,
                    png,
                },
            },
            paths,
            None,
            crate::jobs::Policy::Skip,
            false,
            app,
        ),
    })
}
