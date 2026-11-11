//! PDF 处理命令（右键菜单）：合并 / 拆分单页 / 文字水印，入任务引擎队列。
//! 校验：路径存在 + .pdf 扩展名；水印文字非空、≤100 字符。

use tauri::{AppHandle, State};

use super::files::AppError;
use super::jobs_cmds::JobId;
use crate::AppState;
use crate::fs::entry::path_exists;
use crate::fs::path::{is_valid_name, to_extended};
use crate::jobs::{JobKind, Policy};

fn is_pdf(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".pdf")
}

fn reject_not_pdf(paths: &[String]) -> Result<(), AppError> {
    let bad = paths.iter().find(|p| !path_exists(p) || !is_pdf(p));
    match bad {
        Some(p) => Err(AppError::new(
            "E_NOT_FOUND",
            format!("文件不存在或不是 PDF：{}", crate::fs::path::file_name_of(p)),
        )),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn pdf_page_count(path: String) -> Result<u32, AppError> {
    reject_not_pdf(std::slice::from_ref(&path))?;
    let doc = lopdf::Document::load(to_extended(&path))
        .map_err(|e| AppError::new("E_PDF", format!("无法读取 PDF：{e}")))?;
    Ok(doc.get_pages().len() as u32)
}

#[tauri::command]
pub fn pdf_merge(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    output: String,
    merge_by_folder: Option<bool>,
    auto_insert_blank_page: Option<bool>,
    blank_page_position: Option<String>,
) -> Result<JobId, AppError> {
    let auto_blank = auto_insert_blank_page.unwrap_or(false);
    let blank_first = matches!(blank_page_position.as_deref(), Some("第1页之前"));
    if merge_by_folder.unwrap_or(false) || auto_blank {
        // 扩展路径：文件夹递归收集 pdf/图片，缺失/不可读源在任务内自动跳过
        if paths.is_empty() {
            return Err(AppError::new("E_INVALID_NAME", "未选择任何文件或文件夹"));
        }
        return Ok(JobId {
            job_id: state.jobs.enqueue(
                JobKind::PdfMergeEx {
                    merge_by_folder: merge_by_folder.unwrap_or(false),
                    auto_blank,
                    blank_first,
                    output,
                },
                paths,
                None,
                Policy::Skip,
                false,
                app,
            ),
        });
    }
    if paths.len() < 2 {
        return Err(AppError::new("E_INVALID_NAME", "合并至少需要 2 个 PDF"));
    }
    reject_not_pdf(&paths)?;
    if !output.to_ascii_lowercase().ends_with(".pdf") || output.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名无效"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfMerge { output },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// PDF 拆分（2026-11-10 参数化）：method ∈ pages|bookmarks；按页数时
/// n_pages ≥1（每 N 页一份）；按书签时 bookmark_level = 0 即顶级书签
/// （层级为空自动取最深层，无书签在任务执行时报错）；naming_rule 占位符
/// [原文件名]/[序号]/[页码]，空 = 默认「[原文件名]-[序号]」，渲染样例
/// 非法名即时报错；save_to_folder = 结果存进源文件名子文件夹（out_dir
/// 由前端按该开关算好：子夹目录或所在目录）
#[tauri::command]
#[allow(clippy::too_many_arguments)] // 拆分参数面板五项 + 路径/目录，同 pdf_watermark 口径
pub fn pdf_split(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    out_dir: String,
    method: String,
    n_pages: u32,
    bookmark_level: u32,
    naming_rule: String,
    save_to_folder: bool,
) -> Result<JobId, AppError> {
    reject_not_pdf(std::slice::from_ref(&path))?;
    let by_pages = match method.as_str() {
        "pages" => true,
        "bookmarks" => false,
        _ => return Err(AppError::new("E_INVALID_NAME", "不支持的拆分方式")),
    };
    if by_pages && n_pages == 0 {
        return Err(AppError::new("E_INVALID_NAME", "每 N 页必须 ≥ 1"));
    }
    if out_dir.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出目录无效"));
    }
    let rule = naming_rule.trim().to_string();
    let rule = if rule.is_empty() {
        "[原文件名]-[序号]".to_string()
    } else {
        rule
    };
    // 命名规则即时校验：按首份样例渲染（页码 1-1）检查文件名合法性
    let stem = crate::pdf::stem_of(&path);
    let sample = crate::pdf::render_split_name(&rule, &stem, 1, 1, 1);
    let sample_base = sample.strip_suffix(".pdf").unwrap_or(&sample);
    if !is_valid_name(sample_base) {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("命名规则渲染出的文件名无效：{sample}"),
        ));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfSplit {
                out_dir,
                opts: crate::pdf::SplitOpts {
                    by_pages,
                    n_pages,
                    bookmark_level,
                    naming_rule: rule,
                    save_to_folder,
                },
            },
            vec![path],
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pdf_watermark(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    text: String,
    out_name: Option<String>,
    font_name: Option<String>,
    font_size: Option<u32>,
    font_color: Option<String>,
    position: Option<String>,
    transparency: Option<u8>,
    margin: Option<u32>,
    page_range: Option<String>,
    page_number_format: Option<String>,
    datetime_format: Option<String>,
) -> Result<JobId, AppError> {
    reject_not_pdf(&paths)?;
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 100 {
        return Err(AppError::new("E_INVALID_NAME", "水印文字需为 1–100 个字符"));
    }
    let opts = crate::pdf::stamp::WatermarkOpts {
        text,
        out_name: {
            let v = out_name.unwrap_or_default();
            let v = v.trim();
            if v.is_empty() {
                "[原文件名]-水印".to_string()
            } else {
                v.to_string()
            }
        },
        font_name: font_name.unwrap_or_else(|| "heiti".into()),
        font_size: font_size.unwrap_or(14).clamp(5, 99),
        rgb: crate::pdf::stamp::parse_color(&font_color.unwrap_or_else(|| "black".into())),
        pos: crate::pdf::stamp::WmPos::parse(&position.unwrap_or_else(|| "right-top".into()))
            .unwrap_or(crate::pdf::stamp::WmPos::RightTop),
        transparency: transparency.unwrap_or(9).min(10),
        margin: margin.unwrap_or(20),
        range: crate::pdf::stamp::WmRange::parse(&page_range.unwrap_or_else(|| "all".into())),
        num_fmt: crate::pdf::stamp::WmNumFmt::parse(
            &page_number_format.unwrap_or_else(|| "cn".into()),
        )
        .unwrap_or(crate::pdf::stamp::WmNumFmt::Cn),
        dt_fmt: crate::pdf::stamp::WmDtFmt::parse(&datetime_format.unwrap_or_else(|| "cn".into()))
            .unwrap_or(crate::pdf::stamp::WmDtFmt::Cn),
    };
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfWatermark { opts },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

// ── 页级编辑与图片合并（2026-10-14）──

/// 提取/删除页共用校验：文档可读 + 页码范围对真实页数合法 + 输出名有效
fn validate_page_spec(path: &str, spec: &str, output: &str) -> Result<(), AppError> {
    reject_not_pdf(&[path.to_string()])?;
    let doc = lopdf::Document::load(to_extended(path))
        .map_err(|e| AppError::new("E_PDF", format!("无法读取 PDF：{e}")))?;
    let total = doc.get_pages().len() as u32;
    crate::pdf::parse_page_ranges(spec, total).map_err(|e| AppError::new("E_INVALID_NAME", e))?;
    if !output.to_ascii_lowercase().ends_with(".pdf") || output.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名无效"));
    }
    Ok(())
}

#[tauri::command]
pub fn pdf_extract_pages(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    spec: String,
    output: String,
) -> Result<JobId, AppError> {
    validate_page_spec(&path, &spec, &output)?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfExtractPages { spec, output },
            vec![path],
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn pdf_remove_pages(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    spec: String,
    output: String,
) -> Result<JobId, AppError> {
    validate_page_spec(&path, &spec, &output)?;
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfRemovePages { spec, output },
            vec![path],
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn pdf_rotate(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    degrees: i64,
) -> Result<JobId, AppError> {
    reject_not_pdf(std::slice::from_ref(&path))?;
    if degrees == 0 || degrees % 90 != 0 || degrees.abs() > 270 {
        return Err(AppError::new(
            "E_INVALID_NAME",
            "旋转角度须为 ±90/±180/±270",
        ));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfRotate { degrees },
            vec![path],
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

#[tauri::command]
pub fn pdf_compress(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<JobId, AppError> {
    reject_not_pdf(&paths)?;
    Ok(JobId {
        job_id: state
            .jobs
            .enqueue(JobKind::PdfCompress, paths, None, Policy::Skip, false, app),
    })
}

// ── 插入空白页 / 加密 / 解密（2026-11-11 功能库 PDF 组扩充）──

/// PDF 插入空白页：mode ∈ 1–12（语义见 pdf::blank_positions）；模式 8/9 需
/// 指定页码表达式（如 1-3,5,8，对真实页数的合法性在任务内逐份校验）；
/// 模式 10/11/12 的 N 限 2–20（默认 2）
#[tauri::command]
pub fn pdf_insert_blank(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    mode: u8,
    spec: String,
    n: u32,
) -> Result<JobId, AppError> {
    reject_not_pdf(&paths)?;
    if !(1..=12).contains(&mode) {
        return Err(AppError::new("E_INVALID_NAME", "不支持的插入模式"));
    }
    if matches!(mode, 8 | 9) && spec.trim().is_empty() {
        return Err(AppError::new(
            "E_INVALID_NAME",
            "该模式需指定页码（如 1-3,5,8）",
        ));
    }
    if matches!(mode, 10..=12) && !(2..=20).contains(&n) {
        return Err(AppError::new("E_INVALID_NAME", "N 须在 2–20"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfInsertBlank {
                opts: crate::pdf::BlankOpts { mode, spec, n },
            },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// PDF AES-128 加密：open_password（开箱）与 edit_password（权限口令）
/// 至少一个非空（只填开箱 = 权限口令沿用之）；三个 perm_* 开关 true = 禁止
/// 打印/复制/编辑（false/缺省 = 允许）
#[tauri::command]
#[allow(clippy::too_many_arguments)] // 两口令 + 三权限开关 + 路径/上下文，同 pdf_watermark 口径
pub fn pdf_encrypt(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    open_password: String,
    edit_password: String,
    perm_print: bool,
    perm_copy: bool,
    perm_edit: bool,
) -> Result<JobId, AppError> {
    reject_not_pdf(&paths)?;
    if open_password.trim().is_empty() && edit_password.trim().is_empty() {
        return Err(AppError::new(
            "E_INVALID_NAME",
            "开箱密码与权限密码至少填写一个",
        ));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfEncrypt {
                opts: crate::pdf::EncryptOpts {
                    open_password,
                    edit_password,
                    deny_print: perm_print,
                    deny_copy: perm_copy,
                    deny_edit: perm_edit,
                },
            },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

/// PDF 解密：owner_password = 所有者（权限）密码——开箱密码同样可解（PDF
/// 认证两把钥匙等效），任务内逐份校验并旁写 <stem>_解密.pdf
#[tauri::command]
pub fn pdf_decrypt(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    owner_password: String,
) -> Result<JobId, AppError> {
    reject_not_pdf(&paths)?;
    if owner_password.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "请输入密码"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::PdfDecrypt {
                password: owner_password,
            },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}

// ── PDF 转图片（PNG）落盘管线（2026-11-11）：渲染在前端 pdf.js（宽松协议
// 唯一可行解——pdfium/mupdf/poppler 全是 AGPL/GPL 红线），Rust 只做安全落盘 ──

/// 目录若已存在自动 "(2)" 递增并创建，返回最终目录（转图片每源 PDF 独立
/// 子文件夹入口；直存模式前端传现有目录，原样返回）
#[tauri::command]
pub fn ensure_available_dir(path: String) -> Result<String, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "目录路径无效"));
    }
    use crate::jobs::pick::available_name;
    let dir = available_name(&path);
    std::fs::create_dir_all(to_extended(&dir))
        .map_err(|e| AppError::new("E_IO", format!("无法创建目录：{e}")))?;
    Ok(dir)
}

/// 单张 PNG（前端 canvas 渲染产物，base64 不带 dataURL 前缀）写入磁盘。
/// 仅收 .png 后缀路径（防误写任意文件）；父目录须已存在（ensure_available_dir 负责）
#[tauri::command]
pub fn write_png_b64(path: String, b64: String) -> Result<(), AppError> {
    if !path.to_ascii_lowercase().ends_with(".png") {
        return Err(AppError::new("E_INVALID_NAME", "仅允许写入 .png 文件"));
    }
    if path.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "文件路径无效"));
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| AppError::new("E_INVALID_NAME", format!("PNG 数据解码失败：{e}")))?;
    std::fs::write(to_extended(&path), bytes)
        .map_err(|e| AppError::new("E_IO", format!("写入失败：{e}")))
}

fn is_image(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg")
    )
}

#[tauri::command]
pub fn images_to_pdf(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    output: String,
) -> Result<JobId, AppError> {
    if paths.is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "至少需要 1 张图片"));
    }
    let bad = paths.iter().find(|p| !path_exists(p) || !is_image(p));
    if let Some(p) = bad {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!(
                "文件不存在或不是 PNG/JPG：{}",
                crate::fs::path::file_name_of(p)
            ),
        ));
    }
    if !output.to_ascii_lowercase().ends_with(".pdf") || output.trim().is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "输出文件名无效"));
    }
    Ok(JobId {
        job_id: state.jobs.enqueue(
            JobKind::ImagesToPdf { output },
            paths,
            None,
            Policy::Skip,
            false,
            app,
        ),
    })
}
