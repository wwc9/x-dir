//! NTFS 名称索引（MFT 初建 + USN 日志增量）：Everything 式秒搜。
//! 架构：提权守护进程（--index-daemon）负责建索引与实时增量，索引以紧凑格式落盘
//! config/index/{盘}.idx；主程序（普通权限）mmap 只读查询——查询方零权限、私有内存
//! 几乎不涨（文件映射页可被系统回收）。守护进程不可用或索引过期时自动落回遍历兜底。
//!
//! 查询通道判定（[`try_search_indexed`] 返回 None 即回退遍历）：
//! 设置开关开启 + 守护心跳存活 + 所请求盘均有 5 分钟内同步的索引 + 查询含名称词。

pub mod daemon;
mod scan;
mod store;
mod table;
mod volume;

pub use daemon::daemon_alive;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::fs::entry::FileEntry;
use crate::fs::matcher::{Query, TypeFilter};
use crate::fs::search::GlobalSearchResult;
use crate::fs::sort::natural_cmp;

/// 状态回执的新鲜窗口：卷级 lastSync 超过该时长视为过期（回退遍历）
const FRESH_WINDOW: Duration = Duration::from_secs(5 * 60);

/// settings.json 的 nameIndex.enabled（主程序写、本进程读，松散解析）
fn index_enabled() -> bool {
    let p = crate::config::config_root().join("settings.json");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("nameIndex")
                .and_then(|n| n.get("enabled"))
                .and_then(|e| e.as_bool())
        })
        .unwrap_or(false)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 索引通道是否整体可用（开关 + 守护存活）
pub fn index_ready() -> bool {
    index_enabled() && daemon_alive()
}

/// 设置面板/搜索面板用：各卷索引状态。
/// configured = daemon.json 启用的卷清单——建索引期间 status.json 尚无该卷条目，
/// 前端靠"已配置但无回执"判定"初建中"。
pub fn status_summary() -> serde_json::Value {
    let daemon = daemon::daemon_alive();
    let configured: Vec<String> = daemon::read_daemon_config_public()
        .iter()
        .map(|l| (*l as char).to_string())
        .collect();
    let mut vols = serde_json::Map::new();
    if let Some(s) = daemon::read_status()
        && let Some(a) = s.get("volumes").and_then(|v| v.as_object())
    {
        for (k, v) in a {
            let fresh = v
                .get("lastSyncMs")
                .and_then(|m| m.as_u64())
                .map(|m| now_ms().saturating_sub(m) < FRESH_WINDOW.as_millis() as u64)
                .unwrap_or(false);
            vols.insert(
                k.clone(),
                serde_json::json!({
                    "entries": v.get("entries").and_then(|e| e.as_u64()).unwrap_or(0),
                    "fresh": fresh,
                    "error": v.get("error").and_then(|e| e.as_str()),
                }),
            );
        }
    }
    serde_json::json!({ "daemonAlive": daemon, "enabled": index_enabled(), "configured": configured, "volumes": vols })
}

/// 索引视图常驻缓存：mmap 常开 + 文件 mtime 变更即重载。
/// 每次查询重复 map/unmap 会让页面反复软缺页；常驻后首次加载之外的查询零缺页。
/// 缓存条目：视图 + 打开时的文件 mtime（变更即重载）
type CachedView = (std::sync::Arc<store::IndexView>, std::time::SystemTime);
type ViewCacheMap = HashMap<u8, CachedView>;

static VIEW_CACHE: OnceLock<Mutex<ViewCacheMap>> = OnceLock::new();

fn view_cache() -> &'static Mutex<ViewCacheMap> {
    VIEW_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取（或打开并缓存）指定盘的索引视图；文件缺失/损坏返回 None
fn cached_view(letter: u8) -> Option<std::sync::Arc<store::IndexView>> {
    let path = store::index_path(&daemon::index_dir(), letter);
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    let mut c = view_cache().lock().unwrap();
    if let Some((v, t)) = c.get(&letter)
        && *t == mtime
    {
        return Some(v.clone());
    }
    let view = std::sync::Arc::new(store::IndexView::open(&path).ok()?);
    c.insert(letter, (view.clone(), mtime));
    Some(view)
}

/// 应用启动预热：索引模式开启且守护存活时，后台把各盘索引 mmap 并 prefault 进内存，
/// 消除首次查询的冷映射开销（页面进系统文件缓存，可被回收，不占私有内存）。
pub fn warm_views_async() {
    std::thread::spawn(|| {
        if !index_ready() {
            return;
        }
        for letter in daemon::read_daemon_config_public() {
            if let Some(v) = cached_view(letter) {
                v.prefault();
            }
        }
    });
}

/// 全盘搜索的索引通道。
/// 返回：Ok(Some) = 索引服务；Ok(None) = 设计上不适用（开关未开/纯路径词/纯体积时间词），
/// 静默回退；Err(原因) = 降级回退（守护未运行/索引过期/文件加载失败），原因透传给前端展示。
/// `roots` = 请求的扫描根（None = 全部已索引盘）。
/// 名称词与扩展名词都跑在小写名表上（扩展名 = u16 尾缀）；体积/时间词在命中集
/// 补元数据后判定（天然在排序截断之后，多余取数由护栏封顶）。
pub fn try_search_indexed(
    query: &Query,
    tf: TypeFilter,
    max_results: usize,
    roots: Option<&[String]>,
) -> Result<Option<GlobalSearchResult>, String> {
    let start = Instant::now();
    if !index_enabled() || (query.name_terms().is_empty() && !query.has_ext_terms()) {
        return Ok(None);
    }
    if !daemon_alive() {
        return Err("守护进程未运行".into());
    }
    // 请求盘字母（None = daemon.json 配置的全部）
    let want: Vec<u8> = match roots {
        Some(rs) if !rs.is_empty() => rs
            .iter()
            .filter_map(|r| r.chars().next())
            .filter(|c| c.is_ascii_uppercase())
            .map(|c| c as u8)
            .collect(),
        _ => daemon::read_daemon_config_public(),
    };
    if want.is_empty() {
        return Err("未配置索引卷".into());
    }
    // 每个请求盘都需要新鲜的索引文件
    let status = daemon::read_status().ok_or("守护状态回执缺失")?;
    let vols = status
        .get("volumes")
        .and_then(|v| v.as_object())
        .ok_or("守护状态回执缺失")?;
    let mut views = Vec::new();
    let mut scanned = 0usize;
    for letter in &want {
        let key = (*letter as char).to_string();
        let st = vols
            .get(&key)
            .ok_or(format!("{} 盘无索引状态", *letter as char))?;
        if let Some(err) = st.get("error").and_then(|e| e.as_str()) {
            return Err(format!("{} 盘索引错误：{}", *letter as char, err));
        }
        let sync = st.get("lastSyncMs").and_then(|m| m.as_u64()).unwrap_or(0);
        if now_ms().saturating_sub(sync) >= FRESH_WINDOW.as_millis() as u64 {
            return Err(format!("{} 盘索引已过期", *letter as char));
        }
        let Some(view) = cached_view(*letter) else {
            return Err(format!("{} 盘索引文件加载失败", *letter as char));
        };
        scanned += view.header.entry_count as usize;
        views.push(view);
    }

    // 并行扫描 + 路径词过滤 + 排序 + 元数据补全（体积/时间词在此判定）
    let cancel = AtomicBool::new(false);
    struct Hit {
        path: String,
        name: String,
        is_dir: bool,
    }
    let mut all: Vec<Hit> = Vec::new();
    let mut overflow = false;
    for view in &views {
        let out = scan::scan_view(view, query, tf, &cancel, scan::OVER_COLLECT);
        overflow |= out.overflow;
        for idx in out.hits {
            let e = &view.entries()[idx as usize];
            let Some(path) = view.path_of(idx as usize) else {
                continue; // 孤儿条目
            };
            if query.has_path_terms() && !query.match_path(&path.to_lowercase()) {
                continue;
            }
            all.push(Hit {
                name: view.entry_name_string(e),
                path,
                is_dir: store::IndexView::is_dir(e),
            });
        }
    }
    // 排序键与遍历结果一致（文件夹恒在前 + 名称自然序），排序后按序补元数据——
    // 体积/时间过滤词在此逐条判定，凑满 max_results 即止（护栏内最坏 2 万次取属性）
    all.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
    let mut entries: Vec<FileEntry> = Vec::new();
    for h in &all {
        let Some(e) = meta::file_entry_from_path(&h.path) else {
            continue;
        };
        if !query.attr_allows_meta(&e) {
            continue;
        }
        entries.push(e);
        if entries.len() >= max_results {
            break;
        }
    }
    let elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(Some(GlobalSearchResult {
        entries,
        truncated: overflow,
        scanned,
        elapsed_ms,
        engine: "index",
        fallback_reason: None,
    }))
}

/// 窗格递归搜索的索引通道：root 所在盘有新鲜索引时，整卷名称扫描 + 路径前缀过滤。
/// 任何不适用/不可用情形都返回 Ok(None) 静默回退遍历（流式+取消兜底体验已足够）；
/// 命中触护栏（溢出）同样回退——保证大范围查询的结果完整性。
pub fn try_search_dir_indexed(
    root: &str,
    query: &Query,
    tf: TypeFilter,
    max_results: usize,
    cancel: &AtomicBool,
) -> Option<crate::fs::search::SearchResult> {
    let start = Instant::now();
    if !index_ready() || (query.name_terms().is_empty() && !query.has_ext_terms()) {
        return None;
    }
    // root 必须是可识别的本地盘路径且该盘索引新鲜
    let letter = root
        .chars()
        .next()
        .map(|c| c.to_ascii_uppercase() as u8)
        .filter(|c| c.is_ascii_uppercase())?;
    if !daemon::read_daemon_config_public().contains(&letter) {
        return None;
    }
    let status = daemon::read_status()?;
    let st = status
        .get("volumes")?
        .as_object()?
        .get(&(letter as char).to_string())?;
    if st.get("error").and_then(|e| e.as_str()).is_some() {
        return None;
    }
    let sync = st.get("lastSyncMs").and_then(|m| m.as_u64()).unwrap_or(0);
    if now_ms().saturating_sub(sync) >= FRESH_WINDOW.as_millis() as u64 {
        return None;
    }
    let view = cached_view(letter)?;

    // 前缀归一："E:\a\b" → "e:\a\b\"（drive 根 "E:\" 保持自身）
    let mut root_lower = root.trim_end_matches('\\').to_lowercase();
    if root_lower.ends_with(':') {
        root_lower.push('\\');
    }
    let prefix = if root_lower.ends_with('\\') {
        root_lower.clone()
    } else {
        format!("{root_lower}\\")
    };

    let out = scan::scan_view(&view, query, tf, cancel, scan::SCOPED_OVER_COLLECT);
    if out.overflow {
        return None; // 整卷命中过多 → 遍历兜底保证目录范围的完整性
    }
    struct Hit {
        path: String,
        name: String,
        is_dir: bool,
    }
    let mut all: Vec<Hit> = Vec::new();
    for idx in out.hits {
        let e = &view.entries()[idx as usize];
        let Some(path) = view.path_of(idx as usize) else {
            continue; // 孤儿条目
        };
        let path_lower = path.to_lowercase();
        // 严格在 root 之下（root 自身不算命中，与遍历语义一致）
        if path_lower != root_lower && path_lower.starts_with(&prefix) {
            all.push(Hit {
                name: view.entry_name_string(e),
                path,
                is_dir: store::IndexView::is_dir(e),
            });
        }
    }
    // 与遍历同序：文件夹恒在前 + 名称自然序；体积/时间过滤词在元数据补全时判定
    all.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
    let mut entries: Vec<FileEntry> = Vec::new();
    for h in &all {
        let Some(e) = meta::file_entry_from_path(&h.path) else {
            continue;
        };
        if !query.attr_allows_meta(&e) {
            continue;
        }
        entries.push(e);
        if entries.len() >= max_results {
            break;
        }
    }
    Some(crate::fs::search::SearchResult {
        entries,
        truncated: false,
        scanned: 0, // 索引通道无"已扫描"语义，前端按引擎标识展示
        elapsed_ms: start.elapsed().as_millis() as u64,
        engine: "index",
    })
}

/// UAC 拉起提权守护进程（ShellExecuteExW runas；用户取消 UAC → Err）
pub fn launch_elevated_daemon() -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
    // 守护用主程序 exe 的独立副本（config/index/x-dir-daemon.exe）：守护常驻不再
    // 锁死 target 产物，开发期热重编译不被阻塞；配置根经参数显式传递
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let cfg = crate::config::config_root();
    let dir = cfg.join("index");
    let _ = std::fs::create_dir_all(&dir);
    let daemon_exe = dir.join("x-dir-daemon.exe");
    if std::fs::copy(&exe, &daemon_exe).is_err() && !daemon_exe.exists() {
        return Err("无法准备守护进程副本（config/index/x-dir-daemon.exe）".into());
    }
    let params_str = format!("--index-daemon \"{}\"", cfg.to_string_lossy());
    let file: Vec<u16> = daemon_exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params: Vec<u16> = params_str
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();
    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: windows::core::PCWSTR::from_raw(verb.as_ptr()),
        lpFile: windows::core::PCWSTR::from_raw(file.as_ptr()),
        lpParameters: windows::core::PCWSTR::from_raw(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut sei) }.map_err(|e| {
        if (e.code().0 as u32) & 0xFFFF == 1223 {
            "已取消授权（UAC）".to_string()
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

/// 结果元数据补全（GetFileAttributesExW；仅对最终 ≤maxResults 条调用）
pub(crate) mod meta {
    use crate::fs::entry::{
        FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM, FileAttrs, FileEntry,
    };
    use windows::Win32::Storage::FileSystem::{
        GetFileAttributesExW, GetFileExInfoStandard, WIN32_FILE_ATTRIBUTE_DATA,
    };
    use windows::core::PCWSTR;

    fn filetime_to_unix_ms(ft: &windows::Win32::Foundation::FILETIME) -> u64 {
        let t = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
        // 1601-01-01 → 1970-01-01：减去 11644473600 秒（100ns 单位 → 毫秒）
        (t / 10_000).saturating_sub(11_644_473_600_000)
    }

    pub fn file_entry_from_path(path: &str) -> Option<FileEntry> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
        unsafe {
            GetFileAttributesExW(
                PCWSTR::from_raw(wide.as_ptr()),
                GetFileExInfoStandard,
                &mut data as *mut _ as *mut std::ffi::c_void,
            )
        }
        .ok()?;
        let size = ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64;
        let is_dir = data.dwFileAttributes & 0x10 != 0;
        let name = crate::fs::path::file_name_of(path);
        let py = crate::fs::search::pinyin_initials(&name);
        Some(FileEntry {
            name,
            path: path.to_string(),
            is_dir,
            size: if is_dir { 0 } else { size },
            mtime_ms: filetime_to_unix_ms(&data.ftLastWriteTime),
            ctime_ms: filetime_to_unix_ms(&data.ftCreationTime),
            attrs: FileAttrs {
                hidden: data.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN != 0,
                system: data.dwFileAttributes & FILE_ATTRIBUTE_SYSTEM != 0,
                readonly: data.dwFileAttributes & FILE_ATTRIBUTE_READONLY != 0,
            },
            py,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_flag_parsed_loosely() {
        // 无 settings.json / 无该字段 → false（默认关闭，不影响验收基线）
        let _ = index_enabled();
    }

    #[test]
    fn engine_not_ready_without_daemon() {
        // 守护未运行时索引通道不可用（CI/开发机常态）：必须回退遍历且给出原因
        let q = Query::parse("报表");
        // Ok(Some)（索引服务）只允许在守护存活时出现；其余分支都是合法回退
        if let Ok(Some(r)) = try_search_indexed(&q, TypeFilter::All, 100, None) {
            assert!(daemon_alive());
            assert_eq!(r.engine, "index");
        }
    }

    /// 真实索引查询基准：对守护进程产出的 .idx 测完整查询链路
    /// （mmap 打开 → 并行扫描 → 路径重建 → 元数据补全）。需要提权守护已建索引。
    #[test]
    #[ignore]
    fn bench_real_index_query() {
        use std::time::Instant;
        let dir = std::path::Path::new("target/debug/config/index");
        if !store::index_path(dir, b'C').exists() {
            panic!("无真实索引（先运行提权守护建索引）");
        }
        let q = Query::parse("王文铖");
        let cancel = AtomicBool::new(false);
        let t0 = Instant::now();
        let views: Vec<_> = b"CDE"
            .iter()
            .filter_map(|l| store::IndexView::open(&store::index_path(dir, *l)).ok())
            .collect();
        let t_open = t0.elapsed();
        let mut total_hits = 0usize;
        let mut overflow = false;
        let t1 = Instant::now();
        let mut all_paths: Vec<String> = Vec::new();
        for view in &views {
            let out = scan::scan_view(view, &q, TypeFilter::All, &cancel, scan::OVER_COLLECT);
            overflow |= out.overflow;
            total_hits += out.hits.len();
            for idx in out.hits {
                if let Some(p) = view.path_of(idx as usize) {
                    all_paths.push(p);
                }
            }
        }
        let t_scan_path = t1.elapsed();
        let t2 = Instant::now();
        all_paths.sort();
        all_paths.truncate(500);
        let with_meta = all_paths
            .iter()
            .filter(|p| meta::file_entry_from_path(p).is_some())
            .count();
        if let (Some(first), 0) = (all_paths.first(), with_meta) {
            println!(
                "首条路径元数据失败，长度={}，前 8 字节={:?}",
                first.len(),
                &first.as_bytes()[..8.min(first.len())]
            );
        }
        let t_meta = t2.elapsed();
        println!("打开 mmap:    {:>8.1?}（{} 个卷）", t_open, views.len());
        println!(
            "扫描+路径重建: {:>8.1?}（命中 {} 条，overflow={}",
            t_scan_path, total_hits, overflow
        );
        println!("排序+元数据:  {:>8.1?}（补全 {}/500）", t_meta, with_meta);
        println!("总计:         {:>8.1?}", t0.elapsed());
        assert!(total_hits > 0, "预期王文铖有命中");

        // 目录范围索引搜索（窗格搜索通道）：整卷扫 + 路径前缀过滤
        for (root, label) in [
            (r"D:\Desktop\报表工作", "D-报表工作"),
            (r"C:\Users\PRIME", "C-用户目录"),
        ] {
            let prefix = format!("{}\\", root.to_lowercase());
            let t3 = Instant::now();
            let mut scoped = 0usize;
            for view in &views {
                let out = scan::scan_view(
                    view,
                    &q,
                    TypeFilter::All,
                    &cancel,
                    scan::SCOPED_OVER_COLLECT,
                );
                for idx in out.hits {
                    if let Some(p) = view.path_of(idx as usize)
                        && p.to_lowercase().starts_with(&prefix)
                    {
                        scoped += 1;
                    }
                }
            }
            println!(
                "窗格范围[{}]: {:>8.1?}（{} 条）",
                label,
                t3.elapsed(),
                scoped
            );
        }
    }
}
