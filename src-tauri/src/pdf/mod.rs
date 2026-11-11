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
use crate::jobs::pick::available_name;
use crate::jobs::{EmitterState, FailItem, JobProgress, is_cancelled};

fn zlib(data: &[u8]) -> Vec<u8> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    let _ = enc.write_all(data);
    enc.finish().unwrap_or_default()
}

/// 文件名去扩展名（"a.b.pdf" → "a.b"）
pub(crate) fn stem_of(path: &str) -> String {
    let name = crate::fs::path::file_name_of(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name,
    }
}

// ── PDF 拆分参数化（2026-11-10：按页数 N / 按书签层级 + 命名规则 + 子文件夹）──

/// 拆分参数（JobKind::PdfSplit 携带）
#[derive(Clone, Debug, PartialEq)]
pub struct SplitOpts {
    /// true = 按页数拆分（每 n_pages 页一份）；false = 按书签层级拆分
    pub by_pages: bool,
    /// 每 N 页一份（仅按页数；≥1，命令层校验）
    pub n_pages: u32,
    /// 书签层级（仅按书签；0 = 顶级书签，层级为空自动取最深层）
    pub bookmark_level: u32,
    /// 命名规则：占位符 [原文件名] [序号] [页码]，自动补 .pdf
    pub naming_rule: String,
    /// true = 结果存进以源文件名命名的子文件夹
    pub save_to_folder: bool,
}

/// 按页数切区间：(start, end) 1-based 闭区间，末份不足 N 页取余
pub fn split_ranges(total: u32, n_pages: u32) -> Vec<(u32, u32)> {
    let n = n_pages.max(1);
    let mut ranges = Vec::new();
    let mut start = 1;
    while start <= total {
        let end = (start + n - 1).min(total);
        ranges.push((start, end));
        start = end + 1;
    }
    ranges
}

/// 命名规则渲染：[原文件名]/[序号]（第几份）/[页码]（起始页-结束页，单页只写
/// 一数字）；自动补 .pdf。未知占位符原样保留（用户自定义文字的一部分）
pub fn render_split_name(rule: &str, stem: &str, seq: usize, start: u32, end: u32) -> String {
    let page = if start == end {
        start.to_string()
    } else {
        format!("{start}-{end}")
    };
    let name = rule
        .replace("[原文件名]", stem)
        .replace("[序号]", &seq.to_string())
        .replace("[页码]", &page);
    if name.to_ascii_lowercase().ends_with(".pdf") {
        name
    } else {
        format!("{name}.pdf")
    }
}

/// 大纲项 → 1-based 目标页号（直引页面 Reference；命名目标等无法解析的跳过）
fn outline_page(dict: &lopdf::Dictionary, page_num: &HashMap<ObjectId, u32>) -> Option<u32> {
    let dest = match dict.get(b"Dest") {
        Ok(o) => o.clone(),
        Err(_) => {
            let action = dict.get(b"A").ok()?.clone();
            match action {
                Object::Dictionary(a) => a.get(b"D").ok()?.clone(),
                _ => return None,
            }
        }
    };
    match dest {
        Object::Array(items) => items
            .first()
            .and_then(|o| o.as_reference().ok())
            .and_then(|pid| page_num.get(&pid).copied()),
        Object::Reference(pid) => page_num.get(&pid).copied(),
        _ => None,
    }
}

/// 递归遍历大纲链：node = 当前项（或 Outlines 根，depth 0），记录 (深度, 目标页)。
/// 走 First（下一层）与 Next（同层兄弟）；visited 防病态环；深度/条数双上限
fn walk_outline(
    doc: &Document,
    node: ObjectId,
    depth: u32,
    page_num: &HashMap<ObjectId, u32>,
    items: &mut Vec<(u32, u32)>,
    seen: &mut HashSet<ObjectId>,
) {
    if depth > 64 || items.len() > 10_000 || !seen.insert(node) {
        return;
    }
    let dict = match doc.get_dictionary(node) {
        Ok(d) => d,
        Err(_) => return,
    };
    if let Some(p) = outline_page(dict, page_num) {
        items.push((depth, p));
    }
    if let Ok(Object::Reference(first)) = dict.get(b"First") {
        walk_outline(doc, *first, depth + 1, page_num, items, seen);
    }
    if let Ok(Object::Reference(next)) = dict.get(b"Next") {
        walk_outline(doc, *next, depth, page_num, items, seen);
    }
}

/// 按书签层级切页区间：level = 0 → 顶级书签；该层级无可解析书签自动取最深
/// 层；首个书签前的页并入第一份；PDF 无书签 → Err("PDF 没有书签…")
pub fn bookmark_page_ranges(
    doc: &Document,
    level: u32,
    total: u32,
) -> Result<Vec<(u32, u32)>, String> {
    let page_num: HashMap<ObjectId, u32> =
        doc.get_pages().into_iter().map(|(n, id)| (id, n)).collect();
    let outlines = doc
        .catalog()
        .map_err(|_| "PDF 结构不可读".to_string())?
        .get(b"Outlines")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .ok_or_else(|| "PDF 没有书签，无法按书签拆分".to_string())?;
    let mut items: Vec<(u32, u32)> = Vec::new();
    let mut seen = HashSet::new();
    walk_outline(doc, outlines, 0, &page_num, &mut items, &mut seen);
    // 用户层级 L → 树深度 L+1（Outlines 根 = 0）；层级为空自动取最深有书签层
    let want = level + 1;
    let mut bounds: Vec<u32> = items
        .iter()
        .filter_map(|(d, p)| (*d == want).then_some(*p))
        .collect();
    if bounds.is_empty() {
        let deep = items.iter().map(|(d, _)| *d).max().unwrap_or(0);
        bounds = items
            .iter()
            .filter_map(|(d, p)| (*d == deep).then_some(*p))
            .collect();
    }
    bounds.sort_unstable();
    bounds.dedup();
    bounds.retain(|p| (1..=total).contains(p));
    if bounds.is_empty() {
        return Err("书签存在但目标页无法解析".to_string());
    }
    if bounds[0] > 1 {
        bounds.insert(0, 1);
    }
    let mut ranges = Vec::new();
    for (i, &s) in bounds.iter().enumerate() {
        let e = bounds.get(i + 1).map(|b| b - 1).unwrap_or(total);
        if s <= e {
            ranges.push((s, e));
        }
    }
    Ok(ranges)
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
                reason: None,
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
                reason: None,
            });
            return;
        }
    };
    // 旁写绝不静默覆盖：输出名撞现有文件时自动 (2) 递增（UI 已预校验，此处兜底）
    let out_path = available_name(output);
    if let Err(e) = merged.save(to_extended(&out_path)) {
        failed.push(FailItem {
            path: out_path,
            message: e.to_string(),
            reason: None,
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
/// 递归收集目录数上限：超大目录树限时让位（取消旗标即时生效）
const COLLECT_BUDGET: usize = 100_000;

fn is_mergeable_ext(name_lower: &str) -> bool {
    let ext = name_lower.rsplit('.').next().unwrap_or("");
    matches!(ext, "pdf" | "jpg" | "jpeg" | "png")
}

/// 递归收集目录下可合并文件（跳过系统回收站/还原目录，按名称序不稳定无妨）
fn collect_mergeable(
    dir: &std::path::Path,
    out: &mut Vec<String>,
    visited: &mut std::collections::HashSet<std::path::PathBuf>,
    cancel: &AtomicBool,
    budget: &mut usize,
) {
    if *budget == 0 || is_cancelled(cancel) {
        return;
    }
    let Ok(canonical) = dir.canonicalize() else {
        return;
    };
    if !visited.insert(canonical) {
        return; // junction/符号链接环路：已访问过即剪枝
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        if *budget == 0 || is_cancelled(cancel) {
            return;
        }
        *budget -= 1;
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().to_lowercase();
        if ft.is_dir() {
            if name != "$recycle.bin" && name != "system volume information" {
                collect_mergeable(&e.path(), out, visited, cancel, budget);
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
    cancel: &AtomicBool,
) -> Vec<(String, Vec<String>, String)> {
    let mut groups: Vec<(String, Vec<String>, String)> = vec![];
    if by_folder {
        for p in paths {
            let path = std::path::Path::new(p);
            if path.is_dir() {
                let mut files = Vec::new();
                let mut visited = std::collections::HashSet::new();
                let mut budget = COLLECT_BUDGET;
                collect_mergeable(path, &mut files, &mut visited, cancel, &mut budget);
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
        let mut visited = std::collections::HashSet::new();
        let mut budget = COLLECT_BUDGET;
        for p in paths {
            let path = std::path::Path::new(p);
            if path.is_dir() {
                collect_mergeable(path, &mut files, &mut visited, cancel, &mut budget);
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
    let groups = group_merge_paths(
        paths,
        opts.merge_by_folder,
        &ts,
        opts.fallback_output,
        cancel,
    );
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
                        reason: None,
                    }),
                }
            } else {
                let mut doc = Document::with_version("1.5");
                match image_page(&mut doc, p) {
                    Ok(_) => docs.push(doc),
                    Err(e) => failed.push(FailItem {
                        path: p.clone(),
                        message: e,
                        reason: None,
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
                reason: None,
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
                    reason: None,
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
                        reason: None,
                    });
                })
                .is_err()
        {
            // 空白页插入失败已记入 failed，继续保存偶数差一页的合并产物
        }
        // 旁写绝不静默覆盖：输出名撞现有文件时自动 (2) 递增
        let out_path = available_name(&output);
        if let Err(e) = merged.save(to_extended(&out_path)) {
            failed.push(FailItem {
                path: out_path,
                message: e.to_string(),
                reason: None,
            });
        }
        prog.current_path = output.clone();
        em.progress(prog);
    }
}

/// 拆分（2026-11-10 参数化）：按页数 N 或书签层级切区间，逐区间导出独立
/// PDF；命名规则渲染 + available_name (2) 递增；save_to_folder = 存进以源
/// 文件名命名的子文件夹（撞名 (2) 递增），否则直接输出到 out_dir
pub(crate) fn run_split(
    path: &str,
    out_dir: &str,
    opts: &SplitOpts,
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
                reason: None,
            });
            return;
        }
    };
    let total = doc.get_pages().len() as u32;
    let ranges = if opts.by_pages {
        split_ranges(total, opts.n_pages.max(1))
    } else {
        match bookmark_page_ranges(&doc, opts.bookmark_level, total) {
            Ok(r) => r,
            Err(e) => {
                failed.push(FailItem {
                    path: path.to_string(),
                    message: e,
                    reason: None,
                });
                return;
            }
        }
    };
    prog.total_files = ranges.len() as u64;
    let stem = stem_of(path);
    let page_ids_all = doc.get_pages();
    // 子文件夹模式：目录可能不存在 → available_name (2) 递增；直存模式目录
    // 必已存在，不能再递增（否则输出进 " (2)" 副本目录）
    let out_dir = if opts.save_to_folder {
        available_name(out_dir)
    } else {
        out_dir.to_string()
    };
    if opts.save_to_folder
        && let Err(e) = std::fs::create_dir_all(to_extended(&out_dir))
    {
        failed.push(FailItem {
            path: out_dir.clone(),
            message: e.to_string(),
            reason: None,
        });
        return;
    }
    for (i, &(start, end)) in ranges.iter().enumerate() {
        if is_cancelled(cancel) {
            return;
        }
        let seq = i + 1;
        let name = render_split_name(&opts.naming_rule, &stem, seq, start, end);
        prog.current_path = name.clone();
        let out_path = available_name(&format!("{}\\{}", to_extended(&out_dir).display(), name));
        let result = (|| -> Result<(), String> {
            let page_ids: Vec<ObjectId> = (start..=end)
                .filter_map(|n| page_ids_all.get(&n).copied())
                .collect();
            let mut out = build_doc_from_pages(&doc, &page_ids)?;
            out.save(to_extended(&out_path))
                .map(|_| ())
                .map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            failed.push(FailItem {
                path: out_path.clone(),
                message: e,
                reason: None,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

/// 水印：每份输出旁写 "<stem>_水印.pdf"（不覆盖原文件）
pub(crate) fn run_watermark(
    paths: &[String],
    opts: &stamp::WatermarkOpts,
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
        let dir = parent_dir(p);
        let file_stem = stem_of(p);
        let folder = parent_dir(p);
        // 输出名模板（2026-10-22）：[原文件名]/[原文件夹名]/[日期时间] 可组合，
        // 默认 "[原文件名]-水印"；无扩展名时补 .pdf
        let name = stamp::render_text(
            &opts.out_name,
            &file_stem,
            &folder,
            "",
            "",
            &stamp::today_formatted(opts.dt_fmt),
        );
        let name = if name.to_ascii_lowercase().ends_with(".pdf") {
            name
        } else {
            format!("{name}.pdf")
        };
        let out = available_name(&format!("{dir}\\{name}"));
        let file_stem = stem_of(p);
        let folder = parent_dir(p);
        let result = (|| -> Result<(), String> {
            let mut doc = Document::load(to_extended(p)).map_err(|e| e.to_string())?;
            stamp::stamp_document_ex(&mut doc, opts, &file_stem, &folder)?;
            doc.save(to_extended(&out))
                .map(|_| ())
                .map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
                reason: None,
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
        // 旁写绝不静默覆盖：固定名（_提取/_删页）重复执行自动 (2) 递增
        let out_path = available_name(out_path);
        out.save(to_extended(&out_path))
            .map(|_| ())
            .map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        failed.push(FailItem {
            path: path.to_string(),
            message: e,
            reason: None,
        });
    }
    prog.done_files += 1;
    em.progress(prog);
}

/// 旋转：全部页 /Rotate 在原值基础上加 degrees。2026-11-09 起改旁写
/// "<stem>_旋转<度数>.pdf"（度数取顺时针等效值 90/180/270）——模块内其他
/// 操作全部旁写，原地路径误触即改用户原件（2026-11-09 P1 评审定案）；
/// 保存仍走临时文件 + 原子改名（lopdf save 以 truncate+write 打开目标，
/// 中途失败不留半截文件）。输出名撞现有文件自动 (2) 递增。
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
    if let Err(e) = rotate_pdf_file(path, degrees, cancel) {
        failed.push(FailItem {
            path: path.to_string(),
            message: e,
            reason: None,
        });
    }
    prog.done_files += 1;
    em.progress(prog);
}

/// 旋转核心（独立于 EmitterState 便于单测）：旁写 "<stem>_旋转<eff>.pdf"
/// （eff = 顺时针等效度数 90/180/270），原文件字节不动；保存走临时文件 +
/// 原子改名，失败不留半截文件；输出名撞现有文件自动 (2) 递增
fn rotate_pdf_file(path: &str, degrees: i64, cancel: &AtomicBool) -> Result<String, String> {
    let eff = degrees.rem_euclid(360);
    let out = available_name(&format!(
        "{}\\{}_旋转{}.pdf",
        parent_dir(path),
        stem_of(path),
        eff
    ));
    let tmp = format!("{}\\{}.rotating.tmp", parent_dir(path), stem_of(path));
    let result = (|| -> Result<(), String> {
        let mut doc = Document::load(to_extended(path)).map_err(|e| e.to_string())?;
        for id in pages_in_order(&doc) {
            if is_cancelled(cancel) {
                return Ok(()); // 取消：不写盘（tmp 未产生即无清理）
            }
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                let cur = match d.get(b"Rotate") {
                    Ok(Object::Integer(n)) => *n,
                    _ => 0,
                };
                d.set("Rotate", Object::Integer((cur + degrees).rem_euclid(360)));
            }
        }
        doc.save(to_extended(&tmp)).map_err(|e| e.to_string())?;
        std::fs::rename(to_extended(&tmp), to_extended(&out)).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(to_extended(&tmp));
    }
    result.map(|_| out)
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
        let out = available_name(&format!("{}\\{}_压缩.pdf", parent_dir(p), stem_of(p)));
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
                reason: None,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

// ──────────────── 插入空白页 / 加密 / 解密（2026-11-11 功能库 PDF 组扩充） ────────────────

/// 插入空白页参数（JobKind::PdfInsertBlank 携带）：12 种模式 + 模式 8/9 的
/// 指定页码表达式 + 模式 10/11/12 的间隔 N
#[derive(Clone, Debug, PartialEq)]
pub struct BlankOpts {
    /// 1–12（语义见 blank_positions）
    pub mode: u8,
    /// 模式 8/9：指定页码表达式（"1-3,5,8"，复用 parse_page_ranges 同口径）
    pub spec: String,
    /// 模式 10/11/12：凑 N 的倍数 / 每隔 N 页（2–20，命令层校验）
    pub n: u32,
}

/// 模式 → 最终页序列模板（None = 该位置插一张 A4 空白页，Some = 原第 n 页
/// 顺次消费）。页码全部指原文档 1-based 页号。
/// 1 末尾补页凑偶数 / 2 开头补页凑偶数 / 3 第一页前插一页 / 4 第一页后插一页 /
/// 5 最后一页后插一页 / 6 每页前各插一页 / 7 每页后各插一页 / 8 指定页码前各
/// 插一页 / 9 指定页码后各插一页 / 10 开头补页凑 N 倍数 / 11 末尾补页凑 N 倍数 /
/// 12 每隔 N 页插一页（第 N、2N… 页后，含末页恰为倍数时）
pub fn blank_positions(total: u32, opts: &BlankOpts) -> Result<Vec<Option<u32>>, String> {
    let orig = |v: u32| Some(v);
    const BLANK: Option<u32> = None;
    let pad = |count: u32, at_start: bool| -> Vec<Option<u32>> {
        let mut out = vec![BLANK; count as usize];
        if at_start {
            out.extend((1..=total).map(orig));
        } else {
            out.splice(0..0, (1..=total).map(orig).collect::<Vec<_>>());
        }
        out
    };
    let pages: Vec<Option<u32>> = (1..=total).map(orig).collect();
    let one = |before: u32| -> Result<Vec<Option<u32>>, String> {
        let mut out = Vec::with_capacity(total as usize + 1);
        for p in 1..=total {
            if before == p {
                out.push(BLANK);
            }
            out.push(orig(p));
        }
        Ok(out)
    };
    let one_at = |spec: &str, before: bool| -> Result<Vec<Option<u32>>, String> {
        let marks = parse_page_ranges(spec, total)?;
        let mut out = Vec::new();
        for p in 1..=total {
            if marks.binary_search(&p).is_ok() {
                if before {
                    out.push(BLANK);
                }
                out.push(orig(p));
                if !before {
                    out.push(BLANK);
                }
            } else {
                out.push(orig(p));
            }
        }
        Ok(out)
    };
    let around = |after_each: bool| -> Vec<Option<u32>> {
        let mut out = Vec::with_capacity(total as usize * 2);
        for p in 1..=total {
            if !after_each {
                out.push(BLANK);
            }
            out.push(orig(p));
            if after_each {
                out.push(BLANK);
            }
        }
        out
    };
    let need_spec = matches!(opts.mode, 8..=9);
    let need_n = matches!(opts.mode, 10..=12);
    if need_spec && opts.spec.trim().is_empty() {
        return Err("该模式需指定页码（如 1-3,5,8）".into());
    }
    if need_n && !(2..=20).contains(&opts.n) {
        return Err(format!("N 须在 2–20：{}", opts.n));
    }
    match opts.mode {
        1 => Ok(if total % 2 == 1 { pad(1, false) } else { pages }),
        2 => Ok(if total % 2 == 1 { pad(1, true) } else { pages }),
        3 => one(1),
        4 => Ok({
            let mut out = vec![orig(1), BLANK];
            out.extend((2..=total).map(orig));
            out
        }),
        5 => Ok({
            let mut out = pages;
            out.push(BLANK);
            out
        }),
        6 => Ok(around(false)),
        7 => Ok(around(true)),
        8 => one_at(&opts.spec, true),
        9 => one_at(&opts.spec, false),
        10 => Ok({
            let short = (opts.n - total % opts.n) % opts.n;
            if short == 0 { pages } else { pad(short, true) }
        }),
        11 => Ok({
            let short = (opts.n - total % opts.n) % opts.n;
            if short == 0 { pages } else { pad(short, false) }
        }),
        12 => Ok({
            let mut out = Vec::new();
            for p in 1..=total {
                out.push(orig(p));
                if p % opts.n == 0 {
                    out.push(BLANK);
                }
            }
            out
        }),
        other => Err(format!("不支持的插入模式：{other}")),
    }
}

/// A4 空白页（595×842pt，Resources 空）对象——加入 doc 但不挂页树，
/// 由调用方随 Kids 交给 build_page_tree 回填 Parent
fn blank_page_object(doc: &mut Document) -> ObjectId {
    doc.add_object(dictionary! {
        "Type" => "Page",
        "MediaBox" => Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(595),
            Object::Integer(842),
        ]),
        "Resources" => dictionary! {},
    })
}

/// 插入空白页：原页顺序 + 模式决定的位置插 A4 空白页，重建页树后旁写
/// "<stem>_插页.pdf"（原文件不动；书签/表单域等文档级对象不搬——与提取/
/// 删页/拆分同口径，页面内容完整保留）
pub(crate) fn run_insert_blank(
    paths: &[String],
    opts: &BlankOpts,
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
        let out = available_name(&format!("{}\\{}_插页.pdf", parent_dir(p), stem_of(p)));
        let result = (|| -> Result<(), String> {
            let doc = Document::load(to_extended(p)).map_err(|e| e.to_string())?;
            let total = doc.get_pages().len() as u32;
            let positions = blank_positions(total, opts)?;
            let ids = doc.get_pages();
            let mut out_doc = Document::with_version("1.5");
            let mut kids: Vec<Object> = Vec::new();
            for slot in positions {
                match slot {
                    Some(n) => {
                        let pid = ids.get(&n).copied().ok_or("页号越界")?;
                        let new_id =
                            transfer_page(&doc, pid, &mut out_doc).ok_or("页面对象不可读")?;
                        kids.push(Object::Reference(new_id));
                    }
                    None => kids.push(Object::Reference(blank_page_object(&mut out_doc))),
                }
            }
            build_page_tree(&mut out_doc, kids)?;
            out_doc
                .save(to_extended(&out))
                .map(|_| ())
                .map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
                reason: None,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

/// 加密参数（JobKind::PdfEncrypt 携带）：AES-128（V4/R4 StdCF）。
/// open_password = 用户口令（打开查看）；edit_password = 所有者口令（权限
/// 控制），二者不可同时为空，只填其一亦可（edit 空 = 沿用 open，保证权限
/// 位不被空口令一关就破）；三个 deny_* = true 即禁止对应权限
#[derive(Clone, Debug, PartialEq)]
pub struct EncryptOpts {
    pub open_password: String,
    pub edit_password: String,
    pub deny_print: bool,
    pub deny_copy: bool,
    pub deny_edit: bool,
}

/// 权限位映射：禁止打印 = 清 PRINTABLE + 高质量打印位；禁止复制 = 清
/// COPYABLE（无障碍抽取位按 PDF 2.0 建议恒保持）；禁止编辑 = 清 MODIFIABLE
fn permissions_from(opts: &EncryptOpts) -> lopdf::encryption::Permissions {
    let mut perms = lopdf::encryption::Permissions::all();
    if opts.deny_print {
        perms.remove(
            lopdf::encryption::Permissions::PRINTABLE
                | lopdf::encryption::Permissions::PRINTABLE_IN_HIGH_QUALITY,
        );
    }
    if opts.deny_copy {
        perms.remove(lopdf::encryption::Permissions::COPYABLE);
    }
    if opts.deny_edit {
        perms.remove(lopdf::encryption::Permissions::MODIFIABLE);
    }
    perms
}

/// 确保 trailer /ID 存在（R3/R4 密钥派生依赖文件 ID；lopdf 不自动生成）。
/// 缺失时用时间纳秒 + PID + 路径哈希混熵生成 16 字节（std 无 rand 库；
/// ID 不承担安全语义，唯一性够用即可）
fn ensure_document_id(doc: &mut Document, path: &str) {
    if doc.trailer.get(b"ID").is_ok() {
        return;
    }
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut h: u64 = t ^ ((std::process::id() as u64).wrapping_mul(0x9E3779B97F4A7C15));
    for b in path.bytes() {
        h = h.rotate_left(8) ^ (b as u64).wrapping_mul(0xC2B2AE3D27D4EB4F);
    }
    let bytes: Vec<u8> = (0..16)
        .map(|i| {
            h = h.rotate_left(7).wrapping_add(0x2545F4914F6CDD1D ^ i);
            (h >> ((i * 5) % 56)) as u8
        })
        .collect();
    let id = Object::Array(vec![
        Object::String(bytes.clone(), lopdf::StringFormat::Hexadecimal),
        Object::String(bytes, lopdf::StringFormat::Hexadecimal),
    ]);
    doc.trailer.set(b"ID", id);
}

/// AES-128 加密核心（独立于任务上下文便于单测）：旁写 "<stem>_加密.pdf"。
/// 已加密文件拒绝重复加密（密码未知无从叠加）
/// 就地加密（可单测）：构造 AES-128（V4/R4 StdCF）加密态并替换全部
/// 字符串/流，trailer 挂 /Encrypt。已加密文档拒绝重复加密
fn encrypt_doc_inplace(doc: &mut Document, opts: &EncryptOpts) -> Result<(), String> {
    let owner = if opts.edit_password.is_empty() {
        opts.open_password.clone()
    } else {
        opts.edit_password.clone()
    };
    let mut filters = std::collections::BTreeMap::new();
    filters.insert(
        b"StdCF".to_vec(),
        std::sync::Arc::new(lopdf::encryption::crypt_filters::Aes128CryptFilter)
            as std::sync::Arc<dyn lopdf::encryption::crypt_filters::CryptFilter>,
    );
    let state =
        lopdf::encryption::EncryptionState::try_from(lopdf::encryption::EncryptionVersion::V4 {
            document: doc,
            encrypt_metadata: true,
            crypt_filters: filters,
            stream_filter: b"StdCF".to_vec(),
            string_filter: b"StdCF".to_vec(),
            owner_password: &owner,
            user_password: &opts.open_password,
            permissions: permissions_from(opts),
        })
        .map_err(|e| format!("加密参数构造失败：{e}"))?;
    doc.encrypt(&state).map_err(|e| format!("加密失败：{e}"))
}

fn encrypt_pdf_file(path: &str, opts: &EncryptOpts) -> Result<String, String> {
    let mut doc = Document::load(to_extended(path)).map_err(|e| e.to_string())?;
    if doc.is_encrypted() {
        return Err("PDF 已加密，请先解密再重新加密".into());
    }
    ensure_document_id(&mut doc, path);
    encrypt_doc_inplace(&mut doc, opts)?;
    let out = available_name(&format!("{}\\{}_加密.pdf", parent_dir(path), stem_of(path)));
    let tmp = format!("{}\\{}.encrypting.tmp", parent_dir(path), stem_of(path));
    doc.save(to_extended(&tmp)).map_err(|e| e.to_string())?;
    std::fs::rename(to_extended(&tmp), to_extended(&out)).map_err(|e| e.to_string())?;
    Ok(out)
}

/// 批量加密：逐份旁写 "<stem>_加密.pdf"
pub(crate) fn run_encrypt(
    paths: &[String],
    opts: &EncryptOpts,
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
        if let Err(e) = encrypt_pdf_file(p, opts) {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
                reason: None,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

/// 解密核心（独立便于单测）：带密码加载（读取器当场认证 + 解密全部对象；
/// xref 流惰性解析下「先 load 再运行时 decrypt()」只会迭代空对象表，密文
/// 原样通过）→ 旁写 "<stem>_解密.pdf"（原文件不动）；未加密文件拒绝
fn decrypt_pdf_file(path: &str, password: &str) -> Result<String, String> {
    // 预检（无密码试读）：未加密直接拒绝；was_encrypted 覆盖「空用户口令
    // 被读取器静默解密」的形态（此时 is_encrypted 已翻假）
    {
        let probe = Document::load(to_extended(path)).map_err(|e| e.to_string())?;
        if !probe.is_encrypted() && !probe.was_encrypted() {
            return Err("PDF 未加密，无需解密".into());
        }
    }
    let mut doc = Document::load_with_options(
        to_extended(path),
        lopdf::LoadOptions::with_password(password),
    )
    .map_err(|_| "密码错误或无法解密（需所有者/权限密码）".to_string())?;
    // 认证失败的形态 = 返回未解密空壳（不报错）：仍处加密态即密码不对
    if doc.is_encrypted() {
        return Err("密码错误或无法解密（需所有者/权限密码）".into());
    }
    let out = available_name(&format!("{}\\{}_解密.pdf", parent_dir(path), stem_of(path)));
    let tmp = format!("{}\\{}.decrypting.tmp", parent_dir(path), stem_of(path));
    doc.save(to_extended(&tmp)).map_err(|e| e.to_string())?;
    std::fs::rename(to_extended(&tmp), to_extended(&out)).map_err(|e| e.to_string())?;
    Ok(out)
}

/// 批量解密：逐份旁写 "<stem>_解密.pdf"
pub(crate) fn run_decrypt(
    paths: &[String],
    password: &str,
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
        if let Err(e) = decrypt_pdf_file(p, password) {
            failed.push(FailItem {
                path: p.clone(),
                message: e,
                reason: None,
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
                reason: None,
            }),
        }
        prog.done_files += 1;
        em.progress(prog);
    }
    if kids.is_empty() {
        failed.push(FailItem {
            path: output.to_string(),
            message: "没有可用的图片".into(),
            reason: None,
        });
        return;
    }
    if let Err(e) = build_page_tree(&mut out, kids) {
        failed.push(FailItem {
            path: output.to_string(),
            message: e,
            reason: None,
        });
        return;
    }
    if let Err(e) = out.save(to_extended(&available_name(output))) {
        failed.push(FailItem {
            path: output.to_string(),
            message: e.to_string(),
            reason: None,
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
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

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
        build_page_tree(&mut doc, vec![Object::Reference(page_id)]).unwrap();
        doc
    }

    #[test]
    fn rotate_side_writes_original_untouched_and_increments() {
        let cancel = Arc::new(AtomicBool::new(false));
        let base = std::env::temp_dir().join(format!("xdir-pdfrot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let src = base.join("doc.pdf");
        let p = src.to_string_lossy().into_owned();
        one_page_doc().save(to_extended(&p)).unwrap();
        let before = std::fs::read(&src).unwrap();

        // 逆时针 90°（degrees = -90）→ 旁写 _旋转270.pdf（顺时针等效值），原文件不动
        let out = rotate_pdf_file(&p, -90, &cancel).unwrap();
        assert!(out.ends_with("doc_旋转270.pdf"), "out = {out}");
        assert_eq!(
            std::fs::read(&src).unwrap(),
            before,
            "旋转后原文件字节不得改动"
        );
        let mut doc = Document::load(to_extended(&out)).unwrap();
        let id = pages_in_order(&doc)[0];
        if let Object::Dictionary(d) = doc.get_object_mut(id).unwrap() {
            assert_eq!(d.get(b"Rotate").unwrap(), &Object::Integer(270));
        } else {
            panic!("页对象不是字典");
        }

        // 同度数重复执行：输出名 (2) 递增，绝不覆盖上次结果
        let out2 = rotate_pdf_file(&p, -90, &cancel).unwrap();
        assert!(out2.ends_with("doc_旋转270 (2).pdf"), "out2 = {out2}");

        let _ = std::fs::remove_dir_all(&base);
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
        let cancel = Arc::new(AtomicBool::new(false));
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
            &cancel,
        );
        assert_eq!(groups.len(), 2, "两个文件夹各自成组");
        let (d1, files1, out1) = &groups[0];
        assert_eq!(files1.len(), 1, "junk.exe 不入合并清单");
        assert!(files1[0].ends_with("a.pdf"));
        assert!(out1.contains("合并结果-f1-TS.pdf"), "out1 = {out1}");
        assert!(out1.starts_with(d1.as_str()));

        // 单文件路径走父目录归组
        let fp = f1.join("a.pdf").to_string_lossy().into_owned();
        let groups = group_merge_paths(&[fp], true, "TS", "ignored.pdf", &cancel);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn group_merge_paths_single_mode() {
        let cancel = Arc::new(AtomicBool::new(false));
        let groups = group_merge_paths(
            &[
                "C:\\x\\a.pdf".into(),
                "C:\\x\\b.png".into(),
                "C:\\y\\c.pdf".into(),
            ],
            false,
            "TS",
            "C:\\x\\out.pdf",
            &cancel,
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
        let opts = stamp::WatermarkOpts {
            text: "绝密".into(),
            out_name: "[原文件名]-水印".into(),
            font_name: "heiti".into(),
            font_size: 48,
            rgb: [64, 64, 64],
            pos: stamp::WmPos::DiagMain,
            transparency: 9,
            margin: 20,
            range: stamp::WmRange::All,
            num_fmt: stamp::WmNumFmt::Cn,
            dt_fmt: stamp::WmDtFmt::Cn,
        };
        stamp::stamp_document_ex(&mut doc, &opts, "w", "tmp").unwrap();
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

    // ── PDF 拆分参数化（2026-11-10）──
    #[test]
    fn split_ranges_chunks() {
        assert_eq!(split_ranges(7, 3), vec![(1, 3), (4, 6), (7, 7)]);
        assert_eq!(split_ranges(4, 1), vec![(1, 1), (2, 2), (3, 3), (4, 4)]);
        assert_eq!(split_ranges(3, 10), vec![(1, 3)]); // N 超总页数
        assert_eq!(split_ranges(6, 2), vec![(1, 2), (3, 4), (5, 6)]);
    }

    #[test]
    fn render_name_placeholders() {
        assert_eq!(
            render_split_name("[原文件名]-[序号]", "测试", 2, 5, 6),
            "测试-2.pdf"
        );
        assert_eq!(
            render_split_name("[原文件名]-[页码]", "测试", 1, 1, 3),
            "测试-1-3.pdf"
        );
        assert_eq!(
            render_split_name("[原文件名]-[页码]", "测试", 3, 3, 3),
            "测试-3.pdf"
        );
        // 单页只写一数字；已带 .pdf 后缀不双补；未知文字原样保留
        assert_eq!(render_split_name("清单.pdf", "x", 1, 1, 1), "清单.pdf");
        assert_eq!(
            render_split_name("报告 [序号] 号", "x", 2, 1, 1),
            "报告 2 号.pdf"
        );
    }

    /// 4 页文档 + 三级大纲：顶级(深度1) A→p1、B→p3、C→p4；A 子层(深度2) p1、p2
    fn doc_with_outline() -> Document {
        let mut doc = Document::with_version("1.5");
        let mut kids = Vec::new();
        for _ in 0..4 {
            let pid = doc.add_object(dictionary! { "Type" => "Page" });
            kids.push(Object::Reference(pid));
        }
        build_page_tree(&mut doc, kids).unwrap();
        fn page_ref(doc: &Document, n: u32) -> Object {
            for (num, id) in doc.get_pages() {
                if num == n {
                    return Object::Reference(id);
                }
            }
            Object::Null
        }
        let outlines = doc.add_object(dictionary! { "Type" => "Outlines" });
        doc.catalog_mut()
            .unwrap()
            .set(b"Outlines", Object::Reference(outlines));
        let b_a = doc.add_object(dictionary! { "Title" => "A", "Parent" => Object::Reference(outlines), "Dest" => page_ref(&doc, 1) });
        let b_b = doc.add_object(dictionary! { "Title" => "B", "Parent" => Object::Reference(outlines), "Dest" => page_ref(&doc, 3) });
        let b_c = doc.add_object(dictionary! { "Title" => "C", "Parent" => Object::Reference(outlines), "Dest" => page_ref(&doc, 4) });
        let c1 = doc.add_object(dictionary! { "Title" => "A-1", "Parent" => Object::Reference(b_a), "Dest" => page_ref(&doc, 1) });
        let c2 = doc.add_object(dictionary! { "Title" => "A-2", "Parent" => Object::Reference(b_a), "Dest" => page_ref(&doc, 2) });
        doc.get_dictionary_mut(outlines)
            .unwrap()
            .set(b"First", Object::Reference(b_a));
        doc.get_dictionary_mut(outlines)
            .unwrap()
            .set(b"Last", Object::Reference(b_c));
        doc.get_dictionary_mut(outlines)
            .unwrap()
            .set(b"Count", Object::Integer(5));
        doc.get_dictionary_mut(b_a)
            .unwrap()
            .set(b"Next", Object::Reference(b_b));
        doc.get_dictionary_mut(b_a)
            .unwrap()
            .set(b"First", Object::Reference(c1));
        doc.get_dictionary_mut(b_a)
            .unwrap()
            .set(b"Last", Object::Reference(c2));
        doc.get_dictionary_mut(b_b)
            .unwrap()
            .set(b"Prev", Object::Reference(b_a));
        doc.get_dictionary_mut(b_b)
            .unwrap()
            .set(b"Next", Object::Reference(b_c));
        doc.get_dictionary_mut(b_c)
            .unwrap()
            .set(b"Prev", Object::Reference(b_b));
        doc.get_dictionary_mut(c1)
            .unwrap()
            .set(b"Next", Object::Reference(c2));
        doc
    }

    #[test]
    fn bookmark_levels_and_fallback() {
        let doc = doc_with_outline();
        {
            let ba = doc
                .get_dictionary(b_a_marker_of(&doc))
                .cloned()
                .unwrap_or_default();
            eprintln!("[diag] b_a = {:?}", ba);
        }
        fn b_a_marker_of(doc: &Document) -> ObjectId {
            let outlines = doc
                .catalog()
                .unwrap()
                .get(b"Outlines")
                .unwrap()
                .as_reference()
                .unwrap();
            let o = doc.get_dictionary(outlines).unwrap();
            match o.get(b"First").unwrap() {
                Object::Reference(id) => *id,
                _ => panic!("no first"),
            }
        }
        // 顶级（level 0）：p1、p3、p4；p3 前的 p1-2 并入第一份
        assert_eq!(
            bookmark_page_ranges(&doc, 0, 4).unwrap(),
            vec![(1, 2), (3, 3), (4, 4)]
        );
        // 子层（level 1）：A 的子书签 p1、p2 → 两份 = [p1]、[p2..末页]
        assert_eq!(
            bookmark_page_ranges(&doc, 1, 4).unwrap(),
            vec![(1, 1), (2, 4)]
        );
        // level 5 为空 → 自动取最深有书签层（1）
        assert_eq!(
            bookmark_page_ranges(&doc, 5, 4).unwrap(),
            vec![(1, 1), (2, 4)]
        );
    }

    #[test]
    fn bookmark_first_gap_merged() {
        // 唯一书签指向 p3 → bounds = [1,3]，两份 = [p1-2]、[p3-4]
        let mut doc = Document::with_version("1.5");
        let mut kids = Vec::new();
        for _ in 0..4 {
            let pid = doc.add_object(dictionary! { "Type" => "Page" });
            kids.push(Object::Reference(pid));
        }
        build_page_tree(&mut doc, kids).unwrap();
        fn page_ref(doc: &Document, n: u32) -> Object {
            for (num, id) in doc.get_pages() {
                if num == n {
                    return Object::Reference(id);
                }
            }
            Object::Null
        }
        let outlines = doc.add_object(dictionary! { "Type" => "Outlines" });
        doc.catalog_mut()
            .unwrap()
            .set(b"Outlines", Object::Reference(outlines));
        let b = doc.add_object(dictionary! { "Title" => "第三章", "Parent" => Object::Reference(outlines), "Dest" => page_ref(&doc, 3) });
        doc.get_dictionary_mut(outlines)
            .unwrap()
            .set(b"First", Object::Reference(b));
        doc.get_dictionary_mut(outlines)
            .unwrap()
            .set(b"Last", Object::Reference(b));
        assert_eq!(
            bookmark_page_ranges(&doc, 0, 4).unwrap(),
            vec![(1, 2), (3, 4)]
        );
    }

    #[test]
    fn no_outline_errors() {
        let mut doc = Document::with_version("1.5");
        let kids: Vec<Object> = (0..2)
            .map(|_| Object::Reference(doc.add_object(dictionary! { "Type" => "Page" })))
            .collect();
        build_page_tree(&mut doc, kids).unwrap();
        assert_eq!(
            bookmark_page_ranges(&doc, 0, 2).unwrap_err().to_string(),
            "PDF 没有书签，无法按书签拆分"
        );
    }

    // ── 插入空白页（2026-11-11）：12 模式矩阵 + 重建产物可读 ──
    const B: Option<u32> = None;

    fn orig(range: std::ops::RangeInclusive<u32>) -> Vec<Option<u32>> {
        range.map(Some).collect()
    }

    #[test]
    fn blank_positions_mode_matrix() {
        let o = |m, spec: &str, n, total| {
            blank_positions(
                total,
                &BlankOpts {
                    mode: m,
                    spec: spec.into(),
                    n,
                },
            )
            .unwrap()
        };
        // 偶数页不补；奇数页头/尾补一页
        assert_eq!(o(1, "", 2, 4), orig(1..=4));
        assert_eq!(o(1, "", 2, 5), [orig(1..=5), vec![B]].concat());
        assert_eq!(o(2, "", 2, 5), [vec![B], orig(1..=5)].concat());
        assert_eq!(o(2, "", 2, 6), orig(1..=6));
        // 第一页前/后、末页后各一页
        assert_eq!(o(3, "", 2, 2), [vec![B], vec![Some(1), Some(2)]].concat());
        assert_eq!(o(4, "", 2, 2), [Some(1), B, Some(2)]);
        assert_eq!(o(5, "", 2, 2), [Some(1), Some(2), B]);
        // 每页前/后各插一页
        assert_eq!(o(6, "", 2, 2), [B, Some(1), B, Some(2)]);
        assert_eq!(o(7, "", 2, 2), [Some(1), B, Some(2), B]);
        // 指定页码前/后（"1-2,4" 于 5 页）
        assert_eq!(
            o(8, "1-2,4", 2, 5),
            [B, Some(1), B, Some(2), Some(3), B, Some(4), Some(5)]
        );
        assert_eq!(o(9, "2", 2, 4), [Some(1), Some(2), B, Some(3), Some(4)]);
        // 开头/末尾补页凑 N 的倍数：已整除不补；差 short 补 short
        assert_eq!(o(10, "", 3, 6), orig(1..=6));
        assert_eq!(o(10, "", 3, 5), [vec![B], orig(1..=5)].concat());
        assert_eq!(o(10, "", 4, 5), [vec![B, B, B], orig(1..=5)].concat());
        assert_eq!(o(11, "", 4, 5), [orig(1..=5), vec![B, B, B]].concat());
        // 每隔 N 页插一页（含末页恰为倍数）
        assert_eq!(
            o(12, "", 2, 5),
            [Some(1), Some(2), B, Some(3), Some(4), B, Some(5)]
        );
        assert_eq!(o(12, "", 4, 4), [Some(1), Some(2), Some(3), Some(4), B]);
        // 参数校验：未知模式 / 模式 8/9 缺页码 / N 越界
        assert!(
            blank_positions(
                5,
                &BlankOpts {
                    mode: 13,
                    spec: "".into(),
                    n: 2
                }
            )
            .is_err()
        );
        assert!(
            blank_positions(
                5,
                &BlankOpts {
                    mode: 8,
                    spec: "  ".into(),
                    n: 2
                }
            )
            .is_err()
        );
        assert!(
            blank_positions(
                5,
                &BlankOpts {
                    mode: 8,
                    spec: "99".into(),
                    n: 2
                }
            )
            .is_err()
        );
        assert!(
            blank_positions(
                5,
                &BlankOpts {
                    mode: 12,
                    spec: "".into(),
                    n: 1
                }
            )
            .is_err()
        );
        assert!(
            blank_positions(
                5,
                &BlankOpts {
                    mode: 12,
                    spec: "".into(),
                    n: 21
                }
            )
            .is_err()
        );
    }

    #[test]
    fn insert_blank_rebuilds_readable_document() {
        let tmp = std::env::temp_dir().join(format!("xdir-pdfib-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("doc.pdf");
        write_doc(&mut make_doc(3), src.to_str().unwrap());
        // mode 1：奇数页末尾补一页 → 4 页可读
        let doc = Document::load(&src).unwrap();
        let positions = blank_positions(
            3,
            &BlankOpts {
                mode: 1,
                spec: "".into(),
                n: 2,
            },
        )
        .unwrap();
        let ids = doc.get_pages();
        let mut rebuilt = Document::with_version("1.5");
        let mut kids: Vec<Object> = Vec::new();
        for slot in &positions {
            match slot {
                Some(n) => {
                    let pid = ids.get(n).copied().unwrap();
                    let new_id = transfer_page(&doc, pid, &mut rebuilt).unwrap();
                    kids.push(Object::Reference(new_id));
                }
                None => kids.push(Object::Reference(blank_page_object(&mut rebuilt))),
            }
        }
        build_page_tree(&mut rebuilt, kids).unwrap();
        let out_path = tmp.join("ins.pdf");
        rebuilt.save(&out_path).unwrap();
        let loaded = Document::load(&out_path).unwrap();
        assert_eq!(loaded.get_pages().len(), 4);
        // 空白页是 A4 且 Resources 为空
        let last = loaded.get_pages().values().last().copied().unwrap();
        if let Object::Dictionary(d) = loaded.get_object(last).unwrap() {
            assert!(
                matches!(d.get(b"MediaBox"), Ok(Object::Array(a)) if a.len() == 4),
                "末页应为 A4 空白页"
            );
        }
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // ── 加密 / 解密（2026-11-11）：AES-128（V4/R4）往返 + 权限位 ──
    #[test]
    fn encrypt_decrypt_roundtrip_with_permissions() {
        let tmp = std::env::temp_dir().join(format!("xdir-pdfenc-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("doc.pdf");
        write_doc(&mut make_doc(2), src.to_str().unwrap());
        let sp = src.to_string_lossy().into_owned();

        // 加密：禁打印/复制、允许编辑；只给打开密码（owner 沿用）
        let opts = EncryptOpts {
            open_password: "open123".into(),
            edit_password: "".into(),
            deny_print: true,
            deny_copy: true,
            deny_edit: false,
        };
        let enc_out = encrypt_pdf_file(&sp, &opts).unwrap();
        assert!(enc_out.ends_with("doc_加密.pdf"), "out = {enc_out}");
        // 原文件不动
        assert_eq!(Document::load(&src).unwrap().get_pages().len(), 2);

        // 已加密文件拒绝二次加密
        assert!(
            encrypt_pdf_file(&enc_out, &opts)
                .unwrap_err()
                .contains("已加密")
        );

        // 解密 = 带密码加载：错误密码报 InvalidPassword、正确密码得到干净明文档
        assert!(
            Document::load_with_options(
                to_extended(&enc_out),
                lopdf::LoadOptions::with_password("wrong"),
            )
            .is_err(),
            "错误密码不得解密"
        );
        let dec = Document::load_with_options(
            to_extended(&enc_out),
            lopdf::LoadOptions::with_password("open123"),
        )
        .unwrap();
        assert_eq!(dec.get_pages().len(), 2, "解密后页数不变");
        assert!(
            dec.trailer.get(b"Encrypt").is_err(),
            "解密后 trailer 不应再有 /Encrypt"
        );
        assert!(!dec.is_encrypted());

        // 权限位：就地加密后 /Encrypt 字典 P 值清 PRINTABLE|COPYABLE、保持 MODIFIABLE
        let mut doc = Document::load(&src).unwrap();
        ensure_document_id(&mut doc, &sp);
        encrypt_doc_inplace(&mut doc, &opts).unwrap();
        let enc_ref = doc.trailer.get(b"Encrypt").unwrap().as_reference().unwrap();
        let dict = doc.get_dictionary(enc_ref).unwrap();
        let p = match dict.get(b"P").unwrap() {
            Object::Integer(v) => *v as u64,
            other => panic!("P 不是整数：{other:?}"),
        };
        assert_eq!(p & (1 << 2), 0, "PRINTABLE 应被清除");
        assert_eq!(p & (1 << 4), 0, "COPYABLE 应被清除");
        assert_ne!(p & (1 << 3), 0, "MODIFIABLE 应保持");

        // 解密：旁写 <stem>_解密.pdf（解密 doc_加密.pdf 即 doc_加密_解密.pdf），
        // 产物无加密可读
        let dec_out = decrypt_pdf_file(&enc_out, "open123").unwrap();
        assert!(dec_out.ends_with("_解密.pdf"), "out = {dec_out}");
        let dec_doc = Document::load(&dec_out).unwrap();
        assert!(!dec_doc.is_encrypted(), "解密产物不应再加密");
        assert_eq!(dec_doc.get_pages().len(), 2);
        // 错误密码不解密
        assert!(
            decrypt_pdf_file(&enc_out, "bad")
                .unwrap_err()
                .contains("密码错误")
        );
        // 未加密文件拒绝解密
        assert!(decrypt_pdf_file(&sp, "x").unwrap_err().contains("未加密"));

        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn encrypt_owner_password_only_and_dual_password() {
        let tmp = std::env::temp_dir().join(format!("xdir-pdfenc2-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let a = tmp.join("a.pdf");
        let b = tmp.join("b.pdf");
        write_doc(&mut make_doc(1), a.to_str().unwrap());
        write_doc(&mut make_doc(1), b.to_str().unwrap());
        let ap = a.to_string_lossy().into_owned();
        let bp = b.to_string_lossy().into_owned();

        // 只给所有者密码（用户口令留空 = 免开箱、仅权限限制）
        let owner_only = EncryptOpts {
            open_password: "".into(),
            edit_password: "owner".into(),
            deny_print: false,
            deny_copy: false,
            deny_edit: true,
        };
        let out = encrypt_pdf_file(&ap, &owner_only).unwrap();
        // 空用户口令：任意外口令也开得了箱（读取器空口令回退），空口令直接解
        let doc =
            Document::load_with_options(to_extended(&out), lopdf::LoadOptions::with_password(""))
                .unwrap();
        assert_eq!(doc.get_pages().len(), 1);

        // 双密码：open 开箱、owner 解权限——两把钥匙都能完成解密
        let dual = EncryptOpts {
            open_password: "u1".into(),
            edit_password: "o1".into(),
            deny_print: false,
            deny_copy: false,
            deny_edit: false,
        };
        let out2 = encrypt_pdf_file(&bp, &dual).unwrap();
        for pwd in ["u1", "o1"] {
            let d = Document::load_with_options(
                to_extended(&out2),
                lopdf::LoadOptions::with_password(pwd),
            )
            .unwrap();
            assert_eq!(d.get_pages().len(), 1, "口令 {pwd} 应可解密");
        }
        // 错误口令报 InvalidPassword（用户口令非空时读取器不回退空口令）
        assert!(
            Document::load_with_options(
                to_extended(&out2),
                lopdf::LoadOptions::with_password("zzz"),
            )
            .is_err(),
            "错误口令不得解密"
        );

        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
