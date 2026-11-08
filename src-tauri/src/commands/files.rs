//! 文件查询与单文件操作命令（§6.5）。

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

use tauri::Manager;

use crate::AppState;
use crate::fs::entry::{FileEntry, name_exists_ci, path_exists};
use crate::fs::path::{
    file_name_of, is_valid_name, join_name, norm_key, parent_of, same_name_ci, to_extended,
};
use crate::fs::sort::{DirPage, SortDir, SortKey, SortSpec, build_page};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<io::Error> for AppError {
    fn from(e: io::Error) -> Self {
        let code = match e.kind() {
            io::ErrorKind::NotFound => "E_NOT_FOUND",
            io::ErrorKind::PermissionDenied => "E_PERM",
            io::ErrorKind::AlreadyExists => "E_EXISTS",
            io::ErrorKind::InvalidInput => "E_INVALID_NAME",
            _ => "E_IO",
        };
        AppError::new(code, e.to_string())
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // 参数表 = §6.5 IPC 契约，双端同步不宜拆
pub async fn list_dir(
    app: tauri::AppHandle,
    path: String,
    sort: Option<SortSpec>,
    ext_filter: Option<Vec<String>>,
    name_filter: Option<String>,
    show_hidden: bool,
    offset: usize,
    limit: usize,
    force: Option<bool>,
) -> Result<DirPage, AppError> {
    let sort = sort.unwrap_or(SortSpec {
        key: SortKey::Name,
        dir: SortDir::Asc,
    });
    let exts = ext_filter.filter(|v| !v.is_empty());
    let query = name_filter.filter(|s| !s.trim().is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // 两阶段（2026-11-01 审查修复）：缺快照时**锁外**扫描——旧实现整目录
        // 扫描在全局缓存锁内进行，冷/网络目录扫数秒期间所有窗格的列目录、
        // watcher 失效、任务收尾失效全部排队等锁；且旧命令虽 async 却直接在
        // runtime worker 上跑阻塞 IO，占死一个 tokio 线程
        let need = {
            let c = state.cache.lock().unwrap_or_else(|p| p.into_inner());
            c.needs_scan(&path, force.unwrap_or(false))
        };
        if need {
            let entries = crate::fs::entry::scan_dir(&path)?;
            state
                .cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(&path, entries);
        }
        let mut cache = state.cache.lock().unwrap_or_else(|p| p.into_inner());
        Ok(cache.with_entries(&path, |entries| {
            build_page(
                entries,
                &sort,
                exts.as_deref(),
                query.as_deref(),
                show_hidden,
                offset,
                limit,
            )
        }))
    })
    .await
    .map_err(|e| AppError::new("E_IO", format!("列目录线程失败：{e}")))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub source_name: String,
    pub existing_is_dir: bool,
    pub existing_size: u64,
}

/// 导航树：列出子目录名（自然排序；复用 list_dir 的目录缓存，无额外 IO）。
/// 与 list_dir 同款两阶段锁外扫描 + spawn_blocking（冷目录首扫不锁全局、
/// 不占主线程也不占 tokio worker）
#[tauri::command]
pub async fn list_dirs(
    app: tauri::AppHandle,
    path: String,
    show_hidden: Option<bool>,
) -> Result<Vec<String>, AppError> {
    let show_hidden = show_hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let need = {
            let c = state.cache.lock().unwrap_or_else(|p| p.into_inner());
            c.needs_scan(&path, false)
        };
        if need {
            let entries = crate::fs::entry::scan_dir(&path)?;
            state
                .cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(&path, entries);
        }
        let mut cache = state.cache.lock().unwrap_or_else(|p| p.into_inner());
        Ok(cache.with_entries(&path, |entries| {
            crate::fs::sort::dir_names(entries, show_hidden)
        }))
    })
    .await
    .map_err(|e| AppError::new("E_IO", format!("列目录线程失败：{e}")))?
}

/// 粘贴/拖放前的冲突预检（§6.7）。大小写折叠判定（§6.11）：
/// 一次读目录建立折叠名索引，同时覆盖 NTFS 与大小写敏感卷（Dev Drive 等）。
/// spawn_blocking：粘贴目标可能是上万条的目录，整目录枚举不能占住
/// tokio worker（2026-11-01：旧注释自称 async 不占主线程，但 async 命令
/// 直接在 runtime worker 上做阻塞 IO 同样拖慢全部并发 IPC）
#[tauri::command]
pub async fn check_conflicts(
    sources: Vec<String>,
    dest_dir: String,
) -> Result<Vec<ConflictInfo>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut existing: HashMap<String, (bool, u64)> = HashMap::new();
        if let Ok(rd) = fs::read_dir(to_extended(&dest_dir)) {
            for entry in rd.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                let name = entry.file_name().to_string_lossy().to_uppercase();
                existing.insert(
                    name,
                    (meta.is_dir(), if meta.is_dir() { 0 } else { meta.len() }),
                );
            }
        }
        Ok(sources
            .iter()
            .filter_map(|s| {
                let name = file_name_of(s);
                existing
                    .get(&name.to_uppercase())
                    .map(|(is_dir, size)| ConflictInfo {
                        source_name: name,
                        existing_is_dir: *is_dir,
                        existing_size: *size,
                    })
            })
            .collect())
    })
    .await
    .map_err(|e| AppError::new("E_IO", format!("冲突预检线程失败：{e}")))?
}

/// 批量重命名「添加文件」（2026-11-08）：原生多选对话框回传的路径批量转
/// FileEntry（可跨目录）。逐路径独立读取、失败路径跳过（可能已被移动/删除）；
/// spawn_blocking：选择集可能上百，阻塞 IO 不占 tokio worker
#[tauri::command]
pub async fn stat_paths(paths: Vec<String>) -> Result<Vec<FileEntry>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths
            .iter()
            .filter_map(|p| crate::fs::entry::path_to_entry(p))
            .collect())
    })
    .await
    .map_err(|e| AppError::new("E_IO", format!("读取文件信息线程失败：{e}")))?
}

#[tauri::command]
pub fn rename_item(path: String, new_name: String) -> Result<(), AppError> {
    if !is_valid_name(&new_name) {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("非法文件名：{new_name}"),
        ));
    }
    let parent = parent_of(&path).ok_or_else(|| AppError::new("E_UNKNOWN", "路径缺少父目录"))?;
    // 仅改大小写的重命名合法；折叠后与"其他"条目同名才冲突（§6.11）
    if !same_name_ci(&new_name, &file_name_of(&path)) && name_exists_ci(&parent, &new_name) {
        return Err(AppError::new(
            "E_EXISTS",
            format!("已存在同名项：{new_name}"),
        ));
    }
    let target = join_name(&parent, &new_name);
    fs::rename(to_extended(&path), to_extended(&target))?;
    Ok(())
}

#[tauri::command]
pub fn create_dir(parent_dir: String, name: String) -> Result<String, AppError> {
    if !is_valid_name(&name) {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("非法文件夹名：{name}"),
        ));
    }
    let p = join_name(&parent_dir, &name);
    fs::create_dir(to_extended(&p))?;
    Ok(p)
}

#[tauri::command]
pub fn create_file(parent_dir: String, name: String) -> Result<String, AppError> {
    if !is_valid_name(&name) {
        return Err(AppError::new(
            "E_INVALID_NAME",
            format!("非法文件名：{name}"),
        ));
    }
    let p = join_name(&parent_dir, &name);
    // 办公格式带最小合法模板落盘（方案 A，2026-11-05 定案）：0 字节的
    // docx/xlsx/pptx 不是合法 OOXML（ZIP 容器缺 [Content_Types].xml 等部件），
    // Office/WPS 打开报损坏；txt/md 空文件本就合法，维持 0 字节
    if let Some(bytes) = office_template(&name) {
        fs::write(to_extended(&p), bytes)?;
    } else {
        fs::File::create(to_extended(&p))?;
    }
    Ok(p)
}

// ── 新建办公文档模板（最小合法 OOXML；与资源管理器 ShellNew 模板产物同级）──

/// zip 容器打包（[Content_Types].xml 等部件按序写入，Deflated 压缩）
fn zip_parts(parts: &[(&str, &str)]) -> Vec<u8> {
    let mut cur = std::io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut cur);
        let opt = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in parts {
            w.start_file(*name, opt).expect("模板部件写入");
            use std::io::Write;
            w.write_all(body.as_bytes()).expect("模板部件内容");
        }
        w.finish().expect("模板 zip 收尾");
    }
    cur.into_inner()
}

/// 扩展名 → 最小合法模板字节（docx/pptx = zip 打包部件；xlsx = rust_xlsxwriter
/// 空工作簿——项目唯一宽松协议 xlsx 写库，天然合法）；其余扩展名 None（0 字节）。
/// OnceLock 惰性构建一次复用
fn office_template(name: &str) -> Option<&'static [u8]> {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("docx") => {
            static T: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
            Some(T.get_or_init(|| {
                zip_parts(&[
                    (
                        "[Content_Types].xml",
                        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
                    ),
                    (
                        "_rels/.rels",
                        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
                    ),
                    (
                        "word/document.xml",
                        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>"#,
                    ),
                ])
            }))
        }
        Some("xlsx") => {
            static T: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
            Some(T.get_or_init(|| {
                let mut wb = rust_xlsxwriter::Workbook::new();
                wb.add_worksheet();
                wb.save_to_buffer().expect("模板 xlsx 序列化")
            }))
        }
        Some("pptx") => {
            static T: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
            Some(T.get_or_init(|| {
                // 最小演示文稿：presentation → slideMaster + theme + slide；
                // master → layout + theme；slide → layout（PowerPoint 严格校验
                // 引用链，缺任一环会弹修复框——部件齐备才干净打开）
                const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
                const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
                const P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
                const SP_TREE: &str = r#"<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>"#;
                let theme = format!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="{A}" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#
                );
                let slide = format!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"><p:cSld><p:spTree>{SP_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#
                );
                let layout = format!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>{SP_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#
                );
                let master = format!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"><p:cSld><p:spTree>{SP_TREE}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>"#
                );
                let presentation = format!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#
                );
                // 关系部件：pairs = (关系类型, 目标)，Id 按序 rId1…rIdN
                let rels = |pairs: &[(&str, String)]| {
                    let built: String = pairs
                        .iter()
                        .enumerate()
                        .map(|(i, (ty, target))| {
                            format!(r#"<Relationship Id="rId{}" Type="{}" Target="{}"/>"#, i + 1, ty, target)
                        })
                        .collect();
                    format!(
                        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{built}</Relationships>"#
                    )
                };
                let rel_ty = |leaf: &str| format!("{R}/{leaf}");
                zip_parts(&[
                    (
                        "[Content_Types].xml",
                        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>"#,
                    ),
                    (
                        "_rels/.rels",
                        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#,
                    ),
                    (
                        "ppt/presentation.xml",
                        &presentation,
                    ),
                    (
                        "ppt/_rels/presentation.xml.rels",
                        &rels(&[
                            (&rel_ty("slideMaster"), "slideMasters/slideMaster1.xml".into()),
                            (&rel_ty("slide"), "slides/slide1.xml".into()),
                            (&rel_ty("theme"), "theme/theme1.xml".into()),
                        ]),
                    ),
                    ("ppt/slideMasters/slideMaster1.xml", &master),
                    (
                        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
                        &rels(&[
                            (&rel_ty("slideLayout"), "../slideLayouts/slideLayout1.xml".into()),
                            (&rel_ty("theme"), "../theme/theme1.xml".into()),
                        ]),
                    ),
                    ("ppt/slideLayouts/slideLayout1.xml", &layout),
                    (
                        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
                        &rels(&[(&rel_ty("slideMaster"), "../slideMasters/slideMaster1.xml".into())]),
                    ),
                    ("ppt/slides/slide1.xml", &slide),
                    (
                        "ppt/slides/_rels/slide1.xml.rels",
                        &rels(&[(&rel_ty("slideLayout"), "../slideLayouts/slideLayout1.xml".into())]),
                    ),
                    ("ppt/theme/theme1.xml", &theme),
                ])
            }))
        }
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDirFail {
    pub name: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDirsResult {
    /// 实际创建路径（与磁盘重名时自动 "(2)" 递增，可能异于请求名）
    pub created: Vec<String>,
    pub failed: Vec<CreateDirFail>,
}

/// 批量新建文件夹：逐个创建。与磁盘已有项重名自动 (2)（与冲突"保留两者"
/// 同一套 available_name）；名单内重名（大小写不敏感）与非法名逐条报错不中断。
/// 轻量命令不入任务引擎；上限 500。spawn_blocking：available_name 逐项
/// 探测磁盘，网络父目录下数百次探测可拖到秒级（2026-11-01 移出主线程）
#[tauri::command]
pub async fn create_dirs(
    parent_dir: String,
    names: Vec<String>,
) -> Result<CreateDirsResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || create_dirs_blocking(parent_dir, names))
        .await
        .map_err(|e| AppError::new("E_IO", format!("批量创建线程失败：{e}")))?
}

fn create_dirs_blocking(
    parent_dir: String,
    names: Vec<String>,
) -> Result<CreateDirsResult, AppError> {
    if names.is_empty() {
        return Err(AppError::new("E_INVALID_NAME", "名单为空"));
    }
    if names.len() > 500 {
        return Err(AppError::new("E_INVALID_NAME", "一次最多创建 500 个文件夹"));
    }
    if !path_exists(&parent_dir) {
        return Err(AppError::new(
            "E_NOT_FOUND",
            format!("目录不存在：{parent_dir}"),
        ));
    }
    let mut res = CreateDirsResult {
        created: vec![],
        failed: vec![],
    };
    let mut seen = std::collections::HashSet::new();
    for req in &names {
        let name = req.trim();
        if !is_valid_name(name) {
            res.failed.push(CreateDirFail {
                name: req.clone(),
                message: "名称含非法字符或为 Windows 保留名".into(),
            });
            continue;
        }
        if !seen.insert(norm_key(name)) {
            res.failed.push(CreateDirFail {
                name: name.to_string(),
                message: "名单内重名".into(),
            });
            continue;
        }
        let target = crate::jobs::pick::available_name(&join_name(&parent_dir, name));
        match fs::create_dir(to_extended(&target)) {
            Ok(()) => res.created.push(target),
            Err(e) => res.failed.push(CreateDirFail {
                name: name.to_string(),
                message: e.to_string(),
            }),
        }
    }
    Ok(res)
}

#[tauri::command]
pub fn open_item(path: String) -> Result<(), AppError> {
    if !path_exists(&path) {
        return Err(AppError::new("E_NOT_FOUND", path));
    }
    tauri_plugin_opener::open_path(Path::new(&path), None::<&str>)
        .map_err(|e| AppError::new("E_UNSUPPORTED", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    fn tempdir() -> String {
        let d = std::env::temp_dir().join(format!(
            "xdir-files-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn create_dirs_dedups_and_sideloads_existing() {
        let dir = tempdir();
        std::fs::create_dir_all(join_name(&dir, "已有")).unwrap();
        let r = create_dirs_blocking(
            dir.clone(),
            vec![
                "甲".into(),
                "乙".into(),
                "已有".into(), // 与磁盘重名 → 已有 (2)
                "甲".into(),   // 名单内重名（大小写不敏感语义）→ 报错不中断
                "ab".into(),
                "AB".into(),  // 名单内大小写冲突
                "con".into(), // Windows 保留名 → 报错不中断
            ],
        )
        .unwrap();
        assert_eq!(
            r.created,
            vec![
                join_name(&dir, "甲"),
                join_name(&dir, "乙"),
                join_name(&dir, "已有 (2)"),
                join_name(&dir, "ab"),
            ]
        );
        assert_eq!(r.failed.len(), 3);
        assert_eq!(r.failed[0].name, "甲");
        assert_eq!(r.failed[0].message, "名单内重名");
        assert_eq!(r.failed[1].name, "AB");
        assert_eq!(r.failed[2].name, "con");
        // 磁盘实况与回执一致
        assert!(path_exists(&join_name(&dir, "已有 (2)")));
        assert!(!path_exists(&join_name(&dir, "con")));
    }

    #[test]
    fn create_dirs_rejects_empty_and_missing_parent() {
        let dir = tempdir();
        assert!(create_dirs_blocking(dir.clone(), vec![]).is_err());
        assert!(create_dirs_blocking(join_name(&dir, "不存在"), vec!["a".into()]).is_err());
    }
}

#[cfg(test)]
mod office_template_tests {
    use super::*;
    use calamine::Reader;

    /// 解 zip 部件名清单（校验容器可读 + 关键部件在列）
    fn zip_names(bytes: &[u8]) -> Vec<String> {
        let cursor = std::io::Cursor::new(bytes.to_vec());
        let mut z = zip::ZipArchive::new(cursor).expect("zip 可读");
        (0..z.len())
            .map(|i| z.by_index(i).unwrap().name().to_string())
            .collect()
    }

    #[test]
    fn docx_template_is_valid_ooxml_zip() {
        let b = office_template("新建 Word 文档.docx").expect("docx 模板");
        assert_eq!(&b[..4], b"PK\x03\x04", "ZIP 魔数");
        let names = zip_names(b);
        for part in ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] {
            assert!(names.iter().any(|n| n == part), "缺部件 {part}: {names:?}");
        }
    }

    #[test]
    fn pptx_template_has_full_reference_chain() {
        let b = office_template("演示文稿.PPTX").expect("pptx 模板（大写扩展名）");
        assert_eq!(&b[..4], b"PK\x03\x04");
        let names = zip_names(b);
        for part in [
            "[Content_Types].xml",
            "_rels/.rels",
            "ppt/presentation.xml",
            "ppt/_rels/presentation.xml.rels",
            "ppt/slideMasters/slideMaster1.xml",
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            "ppt/slideLayouts/slideLayout1.xml",
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            "ppt/slides/slide1.xml",
            "ppt/slides/_rels/slide1.xml.rels",
            "ppt/theme/theme1.xml",
        ] {
            assert!(names.iter().any(|n| n == part), "缺部件 {part}: {names:?}");
        }
    }

    #[test]
    fn xlsx_template_loads_in_calamine() {
        let b = office_template("新建 Excel 工作表.xlsx").expect("xlsx 模板");
        assert_eq!(&b[..4], b"PK\x03\x04");
        // calamine = 项目预览同源读取器：能开即合法（表格/sheet 可枚举）
        let tmp = std::env::temp_dir().join("xdir_tpl_test.xlsx");
        std::fs::write(&tmp, b).unwrap();
        let mut wb: calamine::Xlsx<_> = calamine::open_workbook(&tmp).expect("calamine 可打开");
        let sheets = wb.sheet_names().to_vec();
        assert!(!sheets.is_empty(), "至少一个工作表: {sheets:?}");
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn txt_md_stay_zero_bytes() {
        assert!(office_template("新建文本文档.txt").is_none());
        assert!(office_template("笔记.md").is_none());
        assert!(office_template("无扩展名").is_none());
    }

    #[test]
    fn create_file_seeds_templates_on_disk() {
        let d = std::env::temp_dir().join("xdir_tpl_create_test");
        std::fs::create_dir_all(&d).unwrap();
        for (name, expect_pk) in [
            ("a.txt", false),
            ("b.md", false),
            ("c.docx", true),
            ("d.xlsx", true),
            ("e.pptx", true),
        ] {
            let p = create_file(d.to_string_lossy().into(), name.into()).unwrap();
            let bytes = std::fs::read(&p).unwrap();
            if expect_pk {
                assert_eq!(&bytes[..4], b"PK\x03\x04", "{name} 应为 zip 容器");
            } else {
                assert!(bytes.is_empty(), "{name} 应为 0 字节");
            }
        }
        std::fs::remove_dir_all(&d).unwrap();
    }
}
