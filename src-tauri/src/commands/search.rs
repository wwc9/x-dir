//! V2 搜索与地址栏补全命令（§3.2）+ 全盘搜索。遍历走 spawn_blocking，不占 async runtime。
//!
//! reqId = 搜索槽位号：同槽新搜索自动作废旧搜索（连打不残留），`cancel_search` 可显式
//! 取消；遍历命中经 `search-batch` 事件节流回吐（~100ms/批），invoke 终态仍返回全量权威结果。

use serde::Serialize;
use tauri::Emitter;

use super::files::AppError;
use crate::fs::content::ContentSearchResult;
use crate::fs::entry::{FileEntry, path_exists};
use crate::fs::matcher::{Query, TypeFilter};
use crate::fs::search::{
    BatchSink, GlobalSearchResult, MAX_RESULTS, MAX_RESULTS_ALL, SearchResult,
    cancel_search as cancel_slot, register_search, search_all as search_all_impl, search_tree,
    suggest_children, unregister_search,
};

/// 流式批次事件载荷（前端按 reqId 累积渲染）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchBatch {
    pub req_id: u64,
    pub entries: Vec<FileEntry>,
    pub scanned: usize,
}

/// 当前目录递归搜索：多词 AND / 通配符 / 路径词 / 类型过滤 / 拼音（语义见 fs::matcher）
#[tauri::command]
pub async fn search_dir(
    app: tauri::AppHandle,
    path: String,
    query: String,
    max_results: Option<usize>,
    type_filter: Option<String>,
    req_id: Option<u64>,
) -> Result<SearchResult, AppError> {
    if !path_exists(&path) {
        return Err(AppError::new("E_NOT_FOUND", format!("目录不存在：{path}")));
    }
    let parsed = Query::parse(query.trim());
    if parsed.is_empty() {
        return Ok(SearchResult {
            entries: vec![],
            truncated: false,
            scanned: 0,
            elapsed_ms: 0,
            engine: "scan",
        });
    }
    let max = max_results.unwrap_or(MAX_RESULTS).clamp(1, 5000);
    let tf = TypeFilter::parse(type_filter.as_deref());
    let req_id = req_id.unwrap_or(0);
    let cancel = register_search(req_id);

    // 索引通道：root 所在盘有新鲜索引时毫秒级返回；不可用/命中溢出静默回退遍历。
    // 整卷 mmap 扫描可达数百 ms，必须放 spawn_blocking——直接跑会占死一个
    // async worker，连续输入时并发放大拖慢全部 IPC 响应
    let idx_root = path.clone();
    let idx_query = parsed.clone();
    let idx_cancel = cancel.clone();
    let indexed = tauri::async_runtime::spawn_blocking(move || {
        crate::index::try_search_dir_indexed(&idx_root, &idx_query, tf, max, &idx_cancel)
    })
    .await
    .unwrap_or(None);
    if let Some(result) = indexed {
        unregister_search(req_id, &cancel);
        return Ok(result);
    }

    let cancel_in = cancel.clone();
    let emitter = move |entries: &[FileEntry], scanned: usize| {
        let _ = app.emit(
            "search-batch",
            &SearchBatch {
                req_id,
                entries: entries.to_vec(),
                scanned,
            },
        );
    };
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut sink = BatchSink::new(&emitter);
        search_tree(&path, &parsed, tf, max, &cancel_in, Some(&mut sink))
    })
    .await
    .map_err(|e| AppError::new("E_UNKNOWN", e.to_string()));
    unregister_search(req_id, &cancel);
    out
}

/// 全盘文件名搜索：NTFS 索引可用时走索引通道（毫秒级），否则固定盘并行遍历兜底。
/// roots 省略 = 全部固定盘；typeFilter = all|files|dirs。
#[tauri::command]
pub async fn search_all(
    app: tauri::AppHandle,
    query: String,
    max_results: Option<usize>,
    roots: Option<Vec<String>>,
    type_filter: Option<String>,
    req_id: Option<u64>,
) -> Result<GlobalSearchResult, AppError> {
    let parsed = Query::parse(query.trim());
    if parsed.is_empty() {
        return Ok(GlobalSearchResult {
            entries: vec![],
            truncated: false,
            scanned: 0,
            elapsed_ms: 0,
            engine: "scan",
            fallback_reason: None,
        });
    }
    let max = max_results.unwrap_or(MAX_RESULTS_ALL).clamp(1, 5000);
    let tf = TypeFilter::parse(type_filter.as_deref());
    let req_id = req_id.unwrap_or(0);

    // 索引通道：Err(原因) = 降级回退，原因随结果透传给前端展示。
    // 同 search_dir：整卷并行扫描放 spawn_blocking，不占 async worker
    let mut fallback_reason: Option<String> = None;
    let idx_query = parsed.clone();
    let idx_roots = roots.clone();
    let indexed = tauri::async_runtime::spawn_blocking(move || {
        crate::index::try_search_indexed(&idx_query, tf, max, idx_roots.as_deref())
    })
    .await
    .unwrap_or_else(|_| Err("索引查询任务失败".into()));
    match indexed {
        Ok(Some(result)) => return Ok(result),
        Err(reason) => fallback_reason = Some(reason),
        Ok(None) => {}
    }

    let cancel = register_search(req_id);
    let cancel_in = cancel.clone();
    let emitter = move |entries: &[FileEntry], scanned: usize| {
        let _ = app.emit(
            "search-batch",
            &SearchBatch {
                req_id,
                entries: entries.to_vec(),
                scanned,
            },
        );
    };
    let mut out = tauri::async_runtime::spawn_blocking(move || {
        let scan_roots = roots.unwrap_or_else(super::drives::fixed_drive_roots);
        let sink = std::sync::Mutex::new(BatchSink::new(&emitter));
        search_all_impl(&scan_roots, &parsed, tf, max, &cancel_in, Some(&sink))
    })
    .await
    .map_err(|e| AppError::new("E_UNKNOWN", e.to_string()));
    unregister_search(req_id, &cancel);
    // 回退原因注入（仅遍历结果携带；索引结果已在上方直接返回）
    if let Ok(ref mut r) = out {
        r.fallback_reason = fallback_reason;
    }
    out
}

/// 内容搜索（2026-10-22）：限定目录范围内做文件内容关键词匹配（无内容索引，
/// 有界范围保证可用性）。多词 AND、大小写不敏感；单文件 2MB 上限 + 二进制
/// 嗅探；命中文件数/扫描数封顶。语义见 fs::content。
#[tauri::command]
pub async fn search_content(
    root: String,
    query: String,
    exts: Option<String>,
    req_id: Option<u64>,
) -> Result<ContentSearchResult, AppError> {
    let terms_lower: Vec<String> = query.split_whitespace().map(|s| s.to_lowercase()).collect();
    if terms_lower.is_empty() {
        return Ok(ContentSearchResult::empty());
    }
    let exts_lower = exts.map(|e| {
        e.split([',', ';', '；'])
            .map(|s| s.trim().trim_start_matches('.').to_lowercase())
            .filter(|s| !s.is_empty())
            .collect()
    });
    let req_id = req_id.unwrap_or(0);
    let cancel = register_search(req_id);
    let cancel_in = cancel.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        crate::fs::content::search_content(&root, &terms_lower, exts_lower, &cancel_in)
    })
    .await
    .unwrap_or_else(|_| ContentSearchResult::empty());
    unregister_search(req_id, &cancel);
    Ok(out)
}

/// 取消指定槽位正在进行的搜索（Esc / 输入变化时由前端调用）
#[tauri::command]
pub fn cancel_search(req_id: u64) {
    cancel_slot(req_id);
}

/// 地址栏自动补全：输入切出"父目录 + 末段前缀"，返回匹配子目录完整路径
#[tauri::command]
pub async fn suggest_paths(input: String, limit: Option<usize>) -> Vec<String> {
    let (parent, prefix) = split_parent_prefix(&input);
    let Some(parent) = parent else {
        return vec![];
    };
    let limit = limit.unwrap_or(8).min(20);
    tauri::async_runtime::spawn_blocking(move || suggest_children(&parent, &prefix, limit))
        .await
        .unwrap_or_default()
}

/// "E:\Cod" → ("E:\", "Cod")；"E:\Code\" → ("E:\Code", "")；无法切分 → None
fn split_parent_prefix(input: &str) -> (Option<String>, String) {
    if input.len() >= 3 && input.ends_with('\\') {
        // 已输完整段：补全其子目录
        return (
            Some(input.trim_end_matches('\\').to_string()),
            String::new(),
        );
    }
    match input.rfind('\\') {
        Some(2) => (Some(format!("{}\\", &input[..2])), input[3..].to_string()),
        Some(i) if i > 2 => (Some(input[..i].to_string()), input[i + 1..].to_string()),
        _ => (None, String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_prefix_split() {
        let (p, s) = split_parent_prefix("E:\\Cod");
        assert_eq!(p.as_deref(), Some("E:\\"));
        assert_eq!(s, "Cod");
        let (p, s) = split_parent_prefix("E:\\Code\\");
        assert_eq!(p.as_deref(), Some("E:\\Code"));
        assert_eq!(s, "");
        let (p, s) = split_parent_prefix("E:\\a\\bc");
        assert_eq!(p.as_deref(), Some("E:\\a"));
        assert_eq!(s, "bc");
        assert!(split_parent_prefix("E:").0.is_none());
        assert!(split_parent_prefix("abc").0.is_none());
    }
}
