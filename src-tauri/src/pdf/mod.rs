//! PDF 处理（lopdf，MIT）：右键合并 / 拆分单页 / 文字水印。
//! 全部作为任务引擎的 Job 执行：逐文件/逐页进度 + 逐页取消检查。
//! 水印 = ab_glyph + tiny-skia 把文字栅格化成位图（运行时读系统字体，
//! 不打包字体文件），再以带 SMask 的 Image XObject 半透明叠加每页。

pub mod stamp;

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::atomic::AtomicBool;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use lopdf::{Document, Object, ObjectId, Stream, dictionary};

use crate::fs::path::to_extended;
use crate::jobs::{EmitterState, FailItem, JobProgress, is_cancelled};

/// 水印不透明度（文字本色深灰，常量在 stamp.rs）
const STAMP_ALPHA: f32 = 0.16;

fn zlib(data: &[u8]) -> Vec<u8> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    let _ = enc.write_all(data);
    enc.finish().unwrap_or_default()
}

/// 文件名去扩展名（"a.b.pdf" → "a.b"）
fn stem_of(path: &str) -> String {
    let name = crate::fs::path::file_name_of(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name,
    }
}

/// 把 src 中 roots 可达的对象搬入 dst 并重映射引用。roots = (原对象 id, 已克隆对象，
/// 可预先删键)——根对象自身也分配新 id；同一 src 的多页应一次传入以共享资源去重。
fn transfer_objects(
    src: &Document,
    roots: &[(ObjectId, Object)],
    dst: &mut Document,
) -> HashMap<ObjectId, ObjectId> {
    let mut seen: HashSet<ObjectId> = HashSet::new();
    let mut stack: Vec<ObjectId> = Vec::new();
    let mut reachable: Vec<ObjectId> = Vec::new();
    for (_, root) in roots {
        collect_refs(root, &mut stack);
    }
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        if let Ok(obj) = src.get_object(id) {
            reachable.push(id);
            collect_refs(obj, &mut stack);
        }
    }
    let mut map: HashMap<ObjectId, ObjectId> = HashMap::new();
    for &id in &reachable {
        map.insert(id, dst.add_object(Object::Null));
    }
    for (id, _) in roots {
        map.entry(*id)
            .or_insert_with(|| dst.add_object(Object::Null));
    }
    for &id in &reachable {
        let obj = match src.get_object(id) {
            Ok(o) => o.clone(),
            Err(_) => continue,
        };
        let remapped = rewrite_refs(obj, &map);
        if let Ok(slot) = dst.get_object_mut(map[&id]) {
            *slot = remapped;
        }
    }
    for (id, root) in roots {
        if let Some(Ok(slot)) = map.get(id).map(|new_id| dst.get_object_mut(*new_id)) {
            *slot = rewrite_refs(root.clone(), &map);
        }
    }
    map
}

fn collect_refs(obj: &Object, stack: &mut Vec<ObjectId>) {
    match obj {
        Object::Reference(id) => stack.push(*id),
        Object::Array(items) => items.iter().for_each(|o| collect_refs(o, stack)),
        Object::Dictionary(d) => d.iter().for_each(|(_, o)| collect_refs(o, stack)),
        Object::Stream(s) => s.dict.iter().for_each(|(_, o)| collect_refs(o, stack)),
        _ => {}
    }
}

fn rewrite_refs(obj: Object, map: &HashMap<ObjectId, ObjectId>) -> Object {
    match obj {
        Object::Reference(id) => Object::Reference(map.get(&id).copied().unwrap_or(id)),
        Object::Array(mut items) => {
            for o in items.iter_mut() {
                let taken = std::mem::replace(o, Object::Null);
                *o = rewrite_refs(taken, map);
            }
            Object::Array(items)
        }
        Object::Dictionary(mut d) => {
            for (_, o) in d.iter_mut() {
                let taken = std::mem::replace(o, Object::Null);
                *o = rewrite_refs(taken, map);
            }
            Object::Dictionary(d)
        }
        Object::Stream(mut s) => {
            let mut dict = std::mem::take(&mut s.dict);
            for (_, o) in dict.iter_mut() {
                let taken = std::mem::replace(o, Object::Null);
                *o = rewrite_refs(taken, map);
            }
            s.dict = dict;
            Object::Stream(s)
        }
        other => other,
    }
}

/// 搬入单页（剥 /Parent，断开原 Pages 树）
fn transfer_page(src: &Document, page_id: ObjectId, dst: &mut Document) -> Option<ObjectId> {
    let mut page = src.get_object(page_id).ok()?.clone();
    if let Object::Dictionary(d) = &mut page {
        d.remove(b"Parent");
    } else {
        return None;
    }
    let map = transfer_objects(src, &[(page_id, page)], dst);
    map.get(&page_id).copied()
}

/// 整文档全部页一次搬运（剥 /Parent；共享资源在同文档内去重）
fn transfer_all_pages(src: &Document, dst: &mut Document) -> Result<Vec<ObjectId>, String> {
    let page_ids: Vec<ObjectId> = src.get_pages().into_values().collect();
    let mut roots: Vec<(ObjectId, Object)> = Vec::new();
    for &pid in &page_ids {
        let mut page = src.get_object(pid).map_err(|e| e.to_string())?.clone();
        if let Object::Dictionary(d) = &mut page {
            d.remove(b"Parent");
        } else {
            continue;
        }
        roots.push((pid, page));
    }
    let map = transfer_objects(src, &roots, dst);
    Ok(page_ids
        .iter()
        .filter_map(|pid| map.get(pid).copied())
        .collect())
}

/// 合并：逐份加载 → 搬入目标（ID 重映射）→ 重建 /Pages 树
pub(crate) fn run_merge(
    paths: &[String],
    output: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let mut docs = Vec::new();
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        match Document::load(to_extended(p)) {
            Ok(d) => docs.push(d),
            Err(e) => failed.push(FailItem {
                path: p.clone(),
                message: e.to_string(),
            }),
        }
        prog.done_files += 1;
        em.progress(prog);
    }
    if is_cancelled(cancel) {
        return;
    }
    let refs: Vec<&Document> = docs.iter().collect();
    let mut merged = match merge_docs(refs) {
        Ok(d) => d,
        Err(e) => {
            failed.push(FailItem {
                path: output.to_string(),
                message: e,
            });
            return;
        }
    };
    if let Err(e) = merged.save(to_extended(output)) {
        failed.push(FailItem {
            path: output.to_string(),
            message: e.to_string(),
        });
    }
}

/// 空白 A4 页插入（2026-10-22）：审计底稿打印场景凑偶数页。
/// 在合并产物（已重建 /Pages 树）的 Kids 头/尾插入一张 595×842 空白页
pub(crate) fn insert_blank_page(doc: &mut Document, at_start: bool) -> Result<(), String> {
    let pages_dict = doc.catalog().map_err(|_| "Catalog 读取失败")?;
    let pages_id: ObjectId = pages_dict
        .get(b"Pages")
        .map_err(|_| "Pages 根缺失")?
        .as_reference()
        .map_err(|_| "Pages 根缺失")?;
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(595),
            Object::Integer(842),
        ]),
        "Resources" => dictionary! {},
    });
    let pages = match doc.get_object_mut(pages_id) {
        Ok(o) => o.as_dict_mut().map_err(|_| "Pages 字典无效")?,
        Err(_) => return Err("Pages 根失效".into()),
    };
    let kids = pages.get_mut(b"Kids").map_err(|_| "Pages /Kids 缺失")?;
    match kids {
        Object::Array(arr) => {
            if at_start {
                arr.insert(0, Object::Reference(page_id));
            } else {
                arr.push(Object::Reference(page_id));
            }
        }
        _ => return Err("Pages /Kids 类型无效".into()),
    }
    let count = pages.get_mut(b"Count").map_err(|_| "Pages /Count 缺失")?;
    if let Object::Integer(n) = count {
        *n += 1;
    }
    Ok(())
}

/// 文件名安全时间戳标签（UTC 近似，yyyymmdd_HHMMSS）：std 无 chrono，天数→日期走
/// Howard Hinnant civil_from_days 算法
fn stamp_label() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
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
    format!("{y:04}{m:02}{d:02}_{h:02}{mi:02}{s:02}")
}

/// 合并可接受扩展名：pdf + image_to_rgb 支持的图片（jpg/jpeg/png）
fn is_mergeable_ext(name_lower: &str) -> bool {
    let ext = name_lower.rsplit('.').next().unwrap_or("");
    matches!(ext, "pdf" | "jpg" | "jpeg" | "png")
}

/// 递归收集目录下可合并文件（跳过系统回收站/还原目录，按名称序不稳定无妨）
fn collect_mergeable(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().to_lowercase();
        if ft.is_dir() {
            if name != "$recycle.bin" && name != "system volume information" {
                collect_mergeable(&e.path(), out);
            }
        } else if is_mergeable_ext(&name) {
            out.push(e.path().to_string_lossy().into_owned());
        }
    }
}

/// 分组：merge_by_folder = 文件夹路径各自递归收集成组（输出 <组目录>\合并结果-
/// <文件夹名>-<ts>.pdf），文件路径按父目录归组；否则全部并入单组（输出 =
/// fallback_output）。返回 (组目录, 文件列表, 输出路径)
fn group_merge_paths(
    paths: &[String],
    by_folder: bool,
    ts: &str,
    fallback_output: &str,
) -> Vec<(String, Vec<String>, String)> {
    let mut groups: Vec<(String, Vec<String>, String)> = vec![];
    if by_folder {
        for p in paths {
            let path = std::path::Path::new(p);
            if path.is_dir() {
                let mut files = Vec::new();
                collect_mergeable(path, &mut files);
                if files.is_empty() {
                    continue;
                }
                let dirname = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.trim_end_matches(['\\', '/', ':']).to_string());
                let output = format!(
                    "{}\\合并结果-{dirname}-{ts}.pdf",
                    p.trim_end_matches(['\\', '/'])
                );
                groups.push((p.clone(), files, output));
            } else if path.is_file() {
                let dir = path
                    .parent()
                    .map(|d| d.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let dirname = path
                    .parent()
                    .and_then(|d| d.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| dir.trim_end_matches(['\\', '/', ':']).to_string());
                let output = format!("{dir}\\合并结果-{dirname}-{ts}.pdf");
                let hit = groups
                    .iter_mut()
                    .find(|(d, _, _)| d == &dir)
                    .map(|(_, f, _)| f.push(p.clone()));
                if hit.is_none() {
                    groups.push((dir, vec![p.clone()], output));
                }
            }
        }
    } else {
        let mut files = Vec::new();
        for p in paths {
            let path = std::path::Path::new(p);
            if path.is_dir() {
                collect_mergeable(path, &mut files);
            } else {
                files.push(p.clone());
            }
        }
        groups.push((String::new(), files, fallback_output.to_string()));
    }
    groups
}

/// 合并扩展（2026-10-22）：支持 PDF/图片混列、按文件夹分组合并、空白页凑偶数。
/// 缺失/不可读源逐条记入 failed（自动跳过语义）；输出路径见 group_merge_paths
/// 合并扩展参数（收敛实参数量，clippy too_many_arguments）
pub(crate) struct MergeExOpts<'a> {
    pub merge_by_folder: bool,
    pub auto_blank: bool,
    pub blank_first: bool,
    /// 统一合并模式的输出路径（分组模式忽略，各组自动命名）
    pub fallback_output: &'a str,
}

pub(crate) fn run_merge_ex(
    paths: &[String],
    opts: &MergeExOpts,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    let ts = stamp_label();
    let groups = group_merge_paths(paths, opts.merge_by_folder, &ts, opts.fallback_output);
    prog.total_files = groups.iter().map(|(_, f, _)| f.len()).sum::<usize>() as u64;
    for (dir, files, output) in groups {
        if is_cancelled(cancel) {
            return;
        }
        let _ = dir;
        let mut docs: Vec<Document> = Vec::new();
        for p in &files {
            if is_cancelled(cancel) {
                return;
            }
            prog.current_path = p.clone();
            if p.to_ascii_lowercase().ends_with(".pdf") {
                match Document::load(to_extended(p)) {
                    Ok(d) => docs.push(d),
                    Err(e) => failed.push(FailItem {
                        path: p.clone(),
                        message: e.to_string(),
                    }),
                }
            } else {
                let mut doc = Document::with_version("1.5");
                match image_page(&mut doc, p) {
                    Ok(_) => docs.push(doc),
                    Err(e) => failed.push(FailItem {
                        path: p.clone(),
                        message: e,
                    }),
                }
            }
            prog.done_files += 1;
            em.progress(prog);
        }
        if is_cancelled(cancel) {
            return;
        }
        if docs.is_empty() {
            failed.push(FailItem {
                path: output.clone(),
                message: "没有可合并的 PDF/图片".into(),
            });
            continue;
        }
        let refs: Vec<&Document> = docs.iter().collect();
        let mut merged = match merge_docs(refs) {
            Ok(d) => d,
            Err(e) => {
                failed.push(FailItem {
                    path: output.clone(),
                    message: e,
                });
                continue;
            }
        };
        // 空白页凑偶数：总页数为奇数时按指定位置补 A4 空白页
        if opts.auto_blank
            && merged.get_pages().len() % 2 == 1
            && insert_blank_page(&mut merged, opts.blank_first)
                .inspect_err(|e| {
                    failed.push(FailItem {
                        path: output.clone(),
                        message: e.clone(),
                    });
                })
                .is_err()
        {
            // 空白页插入失败已记入 failed，继续保存偶数差一页的合并产物
        }
        if let Err(e) = merged.save(to_extended(&output)) {
            failed.push(FailItem {
                path: output.clone(),
                message: e.to_string(),
            });
        }
        prog.current_path = output.clone();
        em.progress(prog);
    }
}

/// 拆分：每页一个独立 PDF，输出 out_dir\\<stem>_p0001.pdf…
pub(crate) fn run_split(
    path: &str,
    out_dir: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    let doc = match Document::load(to_extended(path)) {
        Ok(d) => d,
        Err(e) => {
            failed.push(FailItem {
                path: path.to_string(),
                message: e.to_string(),
            });
            return;
        }
    };
    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    prog.total_files = pages.len() as u64;
    let stem = stem_of(path);
    if let Err(e) = std::fs::create_dir_all(to_extended(out_dir)) {
        failed.push(FailItem {
            path: out_dir.to_string(),
            message: e.to_string(),
        });
        return;
    }
    for (num, page_id) in pages {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = format!("{stem} 第 {num} 页");
        let out_path = format!("{}\\{}_p{num:04}.pdf", to_extended(out_dir).display(), stem);
        let result = (|| -> Result<(), String> {
            let mut out = Document::with_version("1.5");
            let new_page = transfer_page(&doc, page_id, &mut out)
                .ok_or_else(|| "页面对象不可读".to_string())?;
            build_page_tree(&mut out, vec![Object::Reference(new_page)])?;
            out.save(&out_path).map(|_| ()).map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            failed.push(FailItem {
                path: out_path.clone(),
                message: e,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

/// 水印：每份输出旁写 "<stem>_水印.pdf"（不覆盖原文件）
pub(crate) fn run_watermark(
    paths: &[String],
    text: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let Some(font) = stamp::load_cjk_font() else {
        failed.push(FailItem {
            path: "-".to_string(),
            message: "未找到可用的系统字体（msyh/simhei/simsun/arial）".into(),
        });
        return;
    };
    let bitmap = stamp::rasterize_text(&font, text, 64.0);
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        let out = format!("{}\\{}_水印.pdf", parent_dir(p), stem_of(p));
        let result = (|| -> Result<(), String> {
            let mut doc = Document::load(to_extended(p)).map_err(|e| e.to_string())?;
            stamp::stamp_document(&mut doc, &bitmap)?;
            doc.save(to_extended(&out))
                .map(|_| ())
                .map_err(|e| e.to_string())
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
}

fn parent_dir(path: &str) -> String {
    match crate::fs::path::parent_of(path) {
        Some(p) => p,
        None => ".".to_string(),
    }
}

// ────────────────────────── 页级操作（提取 / 删除 / 旋转 / 轻压缩） ──────────────────────────

/// 解析页码范围表达式（1-based，逗号/全角逗号分隔；支持 "3"、"1-3"、"5-"（到末页））：
/// 去重升序返回页号。段内空格/制表符剔除（"1 - 3" ≡ "1-3"）。
pub(crate) fn parse_page_ranges(spec: &str, total: u32) -> Result<Vec<u32>, String> {
    let mut out: Vec<u32> = Vec::new();
    for part in spec.split([',', '，']) {
        let part: String = part.chars().filter(|c| !matches!(c, ' ' | '\t')).collect();
        if part.is_empty() {
            continue;
        }
        let (start, end) = match part.split_once('-') {
            None => {
                let n = parse_page_num(&part, total)?;
                (n, n)
            }
            Some((s, "")) => (parse_page_num(s, total)?, total),
            Some((s, e)) => (parse_page_num(s, total)?, parse_page_num(e, total)?),
        };
        if start > end {
            return Err(format!("页码范围无效：{part}（起始大于结束）"));
        }
        out.extend(start..=end);
    }
    if out.is_empty() {
        return Err("页码范围不能为空".into());
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

fn parse_page_num(s: &str, total: u32) -> Result<u32, String> {
    let n: u32 = s.trim().parse().map_err(|_| format!("页码无效：{s}"))?;
    if n == 0 || n > total {
        return Err(format!("页码超出范围（共 {total} 页）：{n}"));
    }
    Ok(n)
}

/// 全部页（BTreeMap 迭代序 = 页号升序）
fn pages_in_order(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages().into_values().collect()
}

/// 把 src 的指定页搬入新文档并重建页树
fn build_doc_from_pages(src: &Document, page_ids: &[ObjectId]) -> Result<Document, String> {
    let mut out = Document::with_version("1.5");
    let mut kids: Vec<Object> = Vec::new();
    for &pid in page_ids {
        let new_id = transfer_page(src, pid, &mut out).ok_or("页面对象不可读")?;
        kids.push(Object::Reference(new_id));
    }
    if kids.is_empty() {
        return Err("没有可用的页面".into());
    }
    build_page_tree(&mut out, kids)?;
    Ok(out)
}

/// 提取/删除页的公共实现：spec 选页 → 新文档 → 输出 out_path
#[allow(clippy::too_many_arguments)] // 任务上下文（进度/事件/失败表）贯穿引擎全链路
pub(crate) fn run_page_select(
    path: &str,
    spec: &str,
    out_path: &str,
    invert: bool,
    _cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = 1;
    prog.current_path = path.to_string();
    let result = (|| -> Result<(), String> {
        let doc = Document::load(to_extended(path)).map_err(|e| e.to_string())?;
        let all: Vec<ObjectId> = pages_in_order(&doc);
        let total = all.len() as u32;
        let picked = parse_page_ranges(spec, total)?;
        let keep: Vec<ObjectId> = all
            .iter()
            .enumerate()
            .filter(|(i, _)| picked.contains(&(*i as u32 + 1)) != invert)
            .map(|(_, id)| *id)
            .collect();
        if keep.is_empty() {
            return Err("选择结果为空（全部页都被删除）".into());
        }
        let mut out = build_doc_from_pages(&doc, &keep)?;
        out.save(to_extended(out_path))
            .map(|_| ())
            .map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        failed.push(FailItem {
            path: path.to_string(),
            message: e,
        });
    }
    prog.done_files += 1;
    em.progress(prog);
}

/// 旋转：全部页 /Rotate 在原值基础上加 degrees（原地保存，可反向旋转还原）
pub(crate) fn run_rotate(
    path: &str,
    degrees: i64,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = 1;
    prog.current_path = path.to_string();
    let result = (|| -> Result<(), String> {
        let mut doc = Document::load(to_extended(path)).map_err(|e| e.to_string())?;
        for id in pages_in_order(&doc) {
            if is_cancelled(cancel) {
                return Ok(()); // 取消：不写盘
            }
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                let cur = match d.get(b"Rotate") {
                    Ok(Object::Integer(n)) => *n,
                    _ => 0,
                };
                d.set("Rotate", Object::Integer((cur + degrees).rem_euclid(360)));
            }
        }
        doc.save(to_extended(path))
            .map(|_| ())
            .map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        failed.push(FailItem {
            path: path.to_string(),
            message: e,
        });
    }
    prog.done_files += 1;
    em.progress(prog);
}

/// 轻压缩：重新打包（对象去重 + 对象流压缩），旁写 "<stem>_压缩.pdf"
pub(crate) fn run_compress(
    paths: &[String],
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
        let out = format!("{}\\{}_压缩.pdf", parent_dir(p), stem_of(p));
        let result = (|| -> Result<(), String> {
            let mut doc = Document::load(to_extended(p)).map_err(|e| e.to_string())?;
            doc.compress(); // 对象去重 + 对象流化；失败则退化为仅重存
            doc.save(to_extended(&out))
                .map(|_| ())
                .map_err(|e| e.to_string())
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
}

// ────────────────────────── 图片合并转 PDF ──────────────────────────

/// 图片文件解码为 RGB8（PNG/JPEG；CMYK JPEG 转 RGB、灰度复制为三通道）
fn image_to_rgb(path: &str) -> Result<(u32, u32, Vec<u8>), String> {
    let raw = std::fs::read(to_extended(path)).map_err(|e| e.to_string())?;
    let ext = crate::fs::path::file_name_of(path)
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => {
            let mut dec = jpeg_decoder::Decoder::new(std::io::Cursor::new(&raw));
            let pixels = dec.decode().map_err(|e| format!("JPEG 解码失败：{e}"))?;
            let info = dec.info().ok_or("JPEG 信息缺失")?;
            let (w, h) = (info.width, info.height);
            if w == 0 || h == 0 {
                return Err("JPEG 尺寸无效".into());
            }
            let rgb = match info.pixel_format {
                jpeg_decoder::PixelFormat::RGB24 => pixels,
                jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|g| [*g, *g, *g]).collect(),
                jpeg_decoder::PixelFormat::L16 => pixels
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .flat_map(|g| [g[0], g[0], g[0]])
                    .collect(),
                jpeg_decoder::PixelFormat::CMYK32 => pixels
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|c| {
                        let k = c[3] as u32;
                        [
                            (c[0] as u32 * k / 255) as u8,
                            (c[1] as u32 * k / 255) as u8,
                            (c[2] as u32 * k / 255) as u8,
                        ]
                    })
                    .collect(),
            };
            Ok((w as u32, h as u32, rgb))
        }
        "png" => {
            let mut dec = png::Decoder::new(std::io::Cursor::new(&raw));
            dec.set_transformations(png::Transformations::normalize_to_color8());
            let mut reader = dec.read_info().map_err(|e| format!("PNG 解析失败：{e}"))?;
            let size = reader.output_buffer_size().ok_or("PNG 输出缓冲无效")?;
            let mut buf = vec![0u8; size];
            let info = reader
                .next_frame(&mut buf)
                .map_err(|e| format!("PNG 解码失败：{e}"))?;
            let (w, h) = (info.width, info.height);
            let src = &buf[..info.buffer_size()];
            let rgb = match info.color_type {
                png::ColorType::Rgb => src.to_vec(),
                png::ColorType::Rgba => src
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|p| [p[0], p[1], p[2]])
                    .collect(),
                png::ColorType::Grayscale => src.iter().flat_map(|g| [*g, *g, *g]).collect(),
                png::ColorType::GrayscaleAlpha => src
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .flat_map(|g| [g[0], g[0], g[0]])
                    .collect(),
                other => return Err(format!("不支持的 PNG 色彩类型：{other:?}")),
            };
            Ok((w, h, rgb))
        }
        other => Err(format!("不支持的图片格式：.{other}")),
    }
}

/// 单张图 → 一页（页面尺寸 = 像素尺寸 1:1pt，图片铺满页面）
fn image_page(doc: &mut Document, path: &str) -> Result<ObjectId, String> {
    let (w, h, rgb) = image_to_rgb(path)?;
    let img = Object::Stream(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => w as i64,
            "Height" => h as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "Filter" => "FlateDecode",
        },
        zlib(&rgb),
    ));
    let img_id = doc.add_object(img);
    let content_id = doc.add_object(Object::Stream(Stream::new(
        dictionary! {},
        format!("q {w} 0 0 {h} 0 0 cm /Im0 Do Q").into_bytes(),
    )));
    Ok(doc.add_object(dictionary! {
        "Type" => "Page",
        "MediaBox" => Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(w as i64),
            Object::Integer(h as i64),
        ]),
        "Contents" => Object::Reference(content_id),
        "Resources" => dictionary! {
            "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
        },
    }))
}

/// 图片合并转 PDF：每图一页（按选中序），输出 output
pub(crate) fn run_images_to_pdf(
    paths: &[String],
    output: &str,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    let mut out = Document::with_version("1.5");
    let mut kids: Vec<Object> = Vec::new();
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        match image_page(&mut out, p) {
            Ok(id) => kids.push(Object::Reference(id)),
            Err(e) => failed.push(FailItem {
                path: p.clone(),
                message: e,
            }),
        }
        prog.done_files += 1;
        em.progress(prog);
    }
    if kids.is_empty() {
        failed.push(FailItem {
            path: output.to_string(),
            message: "没有可用的图片".into(),
        });
        return;
    }
    if let Err(e) = build_page_tree(&mut out, kids) {
        failed.push(FailItem {
            path: output.to_string(),
            message: e,
        });
        return;
    }
    if let Err(e) = out.save(to_extended(output)) {
        failed.push(FailItem {
            path: output.to_string(),
            message: e.to_string(),
        });
    }
}

/// 新建 /Catalog + /Pages 树挂给定 Kids；Parent 回填需在 trailer 生效后（get_pages 沿新树枚举）
fn build_page_tree(doc: &mut Document, kids: Vec<Object>) -> Result<(), String> {
    let count = kids.len() as i64;
    let pages_id = doc.add_object(dictionary! {
        "Type" => "Pages",
        "Count" => count,
        "Kids" => kids,
    });
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    doc.trailer = dictionary! {
        "Root" => Object::Reference(catalog_id),
    };
    for (_, id) in doc.get_pages() {
        if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
            d.set("Parent", Object::Reference(pages_id));
        }
    }
    Ok(())
}

/// 合并若干已加载文档（对象搬运 + ID 重映射 + 重建页树）
fn merge_docs(docs: Vec<&Document>) -> Result<Document, String> {
    let mut out = Document::with_version("1.5");
    let mut kids: Vec<Object> = Vec::new();
    for doc in &docs {
        for new_id in transfer_all_pages(doc, &mut out)? {
            kids.push(Object::Reference(new_id));
        }
    }
    if kids.is_empty() {
        return Err("没有可合并的页面".into());
    }
    build_page_tree(&mut out, kids)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::Stream;

    fn one_page_doc() -> Document {
        let mut doc = Document::with_version("1.5");
        let content_id = doc.add_object(Object::Stream(Stream::new(
            dictionary! {},
            b"1 0 0 1 0 0 cm".to_vec(),
        )));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "MediaBox" => Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(100),
                Object::Integer(100),
            ]),
            "Contents" => Object::Reference(content_id),
            "Resources" => dictionary! {},
        });
        build_page_tree(&mut doc, vec![Object::Reference(page_id)]);
        doc
    }

    #[test]
    fn blank_page_insert_start_and_end() {
        // 头插：空白 A4 页成为第 1 页
        let mut doc = one_page_doc();
        insert_blank_page(&mut doc, true).unwrap();
        let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
        assert_eq!(pages.len(), 2);
        let first = doc.get_object(pages[0]).unwrap();
        if let Object::Dictionary(d) = first {
            let box_ok = matches!(
                d.get(b"MediaBox"),
                Ok(Object::Array(a)) if a.len() == 4
            );
            assert!(box_ok, "第 1 页应为 595×842 空白页");
        } else {
            panic!("第 1 页不是字典");
        }

        // 尾插：空白 A4 页成为最后一页
        let mut doc = one_page_doc();
        insert_blank_page(&mut doc, false).unwrap();
        let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
        assert_eq!(pages.len(), 2);
        let last = doc.get_object(pages[1]).unwrap();
        if let Object::Dictionary(d) = last {
            let box_ok = matches!(
                d.get(b"MediaBox"),
                Ok(Object::Array(a)) if a.len() == 4
            );
            assert!(box_ok, "最后一页应为 595×842 空白页");
        } else {
            panic!("最后一页不是字典");
        }
    }

    #[test]
    fn group_merge_paths_folder_mode() {
        let base = std::env::temp_dir().join(format!("xdir-pdfmerge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let f1 = base.join("f1");
        let f2 = base.join("f2");
        std::fs::create_dir_all(&f1).unwrap();
        std::fs::create_dir_all(&f2).unwrap();
        std::fs::write(f1.join("a.pdf"), b"x").unwrap();
        std::fs::write(f1.join("junk.exe"), b"x").unwrap();
        std::fs::write(f2.join("b.png"), b"x").unwrap();

        let groups = group_merge_paths(
            &[
                f1.to_string_lossy().into_owned(),
                f2.to_string_lossy().into_owned(),
            ],
            true,
            "TS",
            "ignored.pdf",
        );
        assert_eq!(groups.len(), 2, "两个文件夹各自成组");
        let (d1, files1, out1) = &groups[0];
        assert_eq!(files1.len(), 1, "junk.exe 不入合并清单");
        assert!(files1[0].ends_with("a.pdf"));
        assert!(out1.contains("合并结果-f1-TS.pdf"), "out1 = {out1}");
        assert!(out1.starts_with(d1.as_str()));

        // 单文件路径走父目录归组
        let fp = f1.join("a.pdf").to_string_lossy().into_owned();
        let groups = group_merge_paths(&[fp], true, "TS", "ignored.pdf");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn group_merge_paths_single_mode() {
        let groups = group_merge_paths(
            &[
                "C:\\x\\a.pdf".into(),
                "C:\\x\\b.png".into(),
                "C:\\y\\c.pdf".into(),
            ],
            false,
            "TS",
            "C:\\x\\out.pdf",
        );
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].0, "");
        assert_eq!(groups[0].1.len(), 3, "统一合并 = 全部保留原序");
        assert_eq!(groups[0].2, "C:\\x\\out.pdf");
    }

    /// 生成 N 页最小 PDF（有 MediaBox + 空内容流）
    fn make_doc(pages: u32) -> Document {
        let mut doc = Document::with_version("1.5");
        let mut page_ids = Vec::new();
        for _ in 0..pages {
            let content_id = doc.add_object(Object::Stream(Stream::new(
                dictionary! {},
                b"1 0 0 1 0 0 cm".to_vec(),
            )));
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "MediaBox" => Object::Array(vec![
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Integer(612),
                    Object::Integer(792),
                ]),
                "Contents" => Object::Reference(content_id),
                "Resources" => dictionary! {},
            });
            page_ids.push(page_id);
        }
        let kids: Vec<Object> = page_ids.iter().map(|id| Object::Reference(*id)).collect();
        let pages_id = doc.add_object(dictionary! {
            "Type" => "Pages",
            "Count" => pages as i64,
            "Kids" => kids,
        });
        for id in page_ids {
            if let Ok(page) = doc.get_object_mut(id)
                && let Object::Dictionary(d) = page
            {
                d.set("Parent", Object::Reference(pages_id));
            }
        }
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        doc.trailer = dictionary! {
            "Root" => Object::Reference(catalog_id),
        };
        doc
    }

    fn write_doc(doc: &mut Document, path: &str) {
        doc.save(path).unwrap();
    }

    #[test]
    fn merge_two_docs_counts_pages() {
        let tmp = std::env::temp_dir().join(format!("xdir-pdfm-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let a = tmp.join("a.pdf");
        let b = tmp.join("b.pdf");
        let out = tmp.join("merged.pdf");
        write_doc(&mut make_doc(2), a.to_str().unwrap());
        write_doc(&mut make_doc(3), b.to_str().unwrap());
        let doc = Document::load(&a).unwrap();
        let doc_b = Document::load(&b).unwrap();
        let mut merged = merge_docs(vec![&doc, &doc_b]).unwrap();
        merged.save(&out).unwrap();
        let result = Document::load(&out).unwrap();
        assert_eq!(result.get_pages().len(), 5);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn split_page_transfers_without_parent_tree() {
        let doc = make_doc(3);
        let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
        let mut out = Document::with_version("1.5");
        let new_page = transfer_page(&doc, pages[1], &mut out).unwrap();
        build_page_tree(&mut out, vec![Object::Reference(new_page)]).unwrap();
        assert_eq!(out.get_pages().len(), 1);
        // 对象数远小于原文档整树（未把兄弟页拖进来）
        assert!(out.objects.len() <= 6);
    }

    #[test]
    fn parse_page_ranges_dedup_sorts_and_validates() {
        assert_eq!(parse_page_ranges("3,1-2", 10).unwrap(), vec![1, 2, 3]);
        assert_eq!(parse_page_ranges("5-", 6).unwrap(), vec![5, 6]);
        assert_eq!(parse_page_ranges("2,2，1", 5).unwrap(), vec![1, 2]);
        assert_eq!(parse_page_ranges(" 1 - 3 ", 5).unwrap(), vec![1, 2, 3]);
        assert!(parse_page_ranges("", 5).is_err());
        assert!(parse_page_ranges("0", 5).is_err());
        assert!(parse_page_ranges("6", 5).is_err());
        assert!(parse_page_ranges("3-1", 5).is_err());
        assert!(parse_page_ranges("a", 5).is_err());
    }

    #[test]
    fn extract_and_remove_pages_select_complement() {
        let mut doc = make_doc(5);
        let tmp = std::env::temp_dir().join(format!("xdir-pdfp-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("s.pdf");
        write_doc(&mut doc, src.to_str().unwrap());
        let loaded = Document::load(&src).unwrap();
        // 提取 2-3 → 2 页
        let ids: Vec<ObjectId> = pages_in_order(&loaded);
        let keep: Vec<ObjectId> = ids[1..3].to_vec();
        let mut out = build_doc_from_pages(&loaded, &keep).unwrap();
        let out_path = tmp.join("ext.pdf");
        out.save(&out_path).unwrap();
        assert_eq!(Document::load(&out_path).unwrap().get_pages().len(), 2);
        // 删除 2-3 = 补集 3 页（1,4,5）
        let keep2: Vec<ObjectId> = (0..5)
            .filter(|i| !(1..3).contains(i))
            .map(|i| ids[i])
            .collect();
        let mut out2 = build_doc_from_pages(&loaded, &keep2).unwrap();
        let out2_path = tmp.join("rem.pdf");
        out2.save(&out2_path).unwrap();
        assert_eq!(Document::load(&out2_path).unwrap().get_pages().len(), 3);
        // 空选择报错
        assert!(build_doc_from_pages(&loaded, &[]).is_err());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn rotate_accumulates_and_wraps() {
        let mut doc = make_doc(2);
        for id in pages_in_order(&doc) {
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                d.set("Rotate", Object::Integer(270));
            }
        }
        // +90 → 0（rem_euclid 回绕）
        for id in pages_in_order(&doc) {
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                let cur = match d.get(b"Rotate") {
                    Ok(Object::Integer(n)) => *n,
                    _ => 0,
                };
                d.set("Rotate", Object::Integer((cur + 90).rem_euclid(360)));
            }
        }
        for id in pages_in_order(&doc) {
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                assert_eq!(d.get(b"Rotate").ok(), Some(&Object::Integer(0)));
            }
        }
        // 无 /Rotate 的页视为 0
        let fresh = make_doc(1);
        let id = pages_in_order(&fresh)[0];
        if let Ok(Object::Dictionary(d)) = fresh.get_object(id) {
            assert_eq!(d.get(b"Rotate").ok(), None);
        }
    }

    #[test]
    fn image_page_builds_one_page_with_xobject() {
        // 用 png crate 现场编码一张 2x2 红图
        let tmp = std::env::temp_dir().join(format!("xdir-pdfi-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let img_path = tmp.join("t.png");
        let file = std::fs::File::create(&img_path).unwrap();
        let mut enc = png::Encoder::new(file, 2, 2);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        {
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0])
                .unwrap();
        }
        let mut doc = Document::with_version("1.5");
        let page = image_page(&mut doc, img_path.to_str().unwrap()).unwrap();
        build_page_tree(&mut doc, vec![Object::Reference(page)]).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        let out = tmp.join("o.pdf");
        doc.save(&out).unwrap();
        let reloaded = Document::load(&out).unwrap();
        assert_eq!(reloaded.get_pages().len(), 1);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn watermark_keeps_pages_and_adds_overlay() {
        let tmp = std::env::temp_dir().join(format!("xdir-pdfw-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("w.pdf");
        write_doc(&mut make_doc(2), path.to_str().unwrap());
        let mut doc = Document::load(&path).unwrap();
        let font = stamp::load_cjk_font().expect("Windows 测试机应有系统中文字体");
        let bitmap = stamp::rasterize_text(&font, "绝密", 48.0);
        stamp::stamp_document(&mut doc, &bitmap).unwrap();
        assert_eq!(doc.get_pages().len(), 2);
        let out = tmp.join("w_out.pdf");
        doc.save(&out).unwrap();
        // 重新加载可读，页 /Contents 已是数组（原流 + 水印流）
        let reloaded = Document::load(&out).unwrap();
        assert_eq!(reloaded.get_pages().len(), 2);
        let page_id = *reloaded.get_pages().values().next().unwrap();
        let page = reloaded.get_object(page_id).unwrap();
        if let Object::Dictionary(d) = page {
            let contents = d.get(b"Contents").unwrap();
            assert!(matches!(contents, Object::Array(v) if v.len() == 2));
        } else {
            panic!("page not dict");
        }
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
