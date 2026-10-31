//! 剪贴板历史（§3.7，2026-10-30 定案，Ditto 式）：clipboard-rs watcher 只作
//! 变化信号源（Windows 内部走 AddClipboardFormatListener 真事件，macOS 轮询
//! changeCount），内容读写走自有 clip.rs（CF_HDROP DropEffect / CF_DIB 性能
//! 先例）；rusqlite（bundled SQLite）持久化到 config/clipboard.db（WAL）。
//! watcher 专用线程写库，命令端经 Mutex<Connection> 共享；写回剪贴板时以
//! 「内容 hash + 3 秒时间窗」guard 防自吞回环（写回 → 事件 → 再入库）。
//!
//! 选型调研（GPL 硬红线）：Ditto/CopyQ = GPL-3.0、PasteBar = CC BY-NC，均不可
//! 融入；EcoPaste（Apache-2.0，Tauri 同栈）仅作 watcher→guard→ingest→持久化
//! 的分层架构参考。直接粘贴（回写后恢复目标窗口焦点 + SendInput Ctrl+V）
//! 失败时静默降级为仅回写（管理员权限窗口/UAC 等场景）。

use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicIsize, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
// add_handler/start_watch 是 ClipboardWatcher trait 方法，需显式入域
#[cfg(windows)]
use clipboard_rs::ClipboardWatcher;
#[cfg(windows)]
use tauri::Emitter;
use tauri::{AppHandle, Manager, PhysicalPosition};

use crate::AppState;

/// watcher 轮询间隔（仅 macOS 轮询后端生效；Windows 为真事件驱动）
const WATCH_INTERVAL: Duration = Duration::from_millis(200);
/// 单条护栏：文本 1MiB / 位图 20MB / 文件 500 条，超出不入库（防库膨胀）
const TEXT_MAX_BYTES: usize = 1 << 20;
const IMAGE_MAX_BYTES: usize = 20 << 20;
const FILES_MAX_COUNT: usize = 500;
/// 图片条目缩略图长边上限（列表直接随页下发 dataURL）
const THUMB_EDGE: u32 = 96;
/// 自写回环 guard 时间窗
const SELF_WRITE_WINDOW: Duration = Duration::from_secs(3);
/// 浮窗逻辑尺寸（inner_size 逻辑像素；定位换算物理像素）
const WIN_W: i32 = 460;
const WIN_H: i32 = 540;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── 状态 ────────────────────────────────────────────────────────────────────

/// 监视线程的停止通道登记（代际号防旧线程收尾时误清新线程的登记）
struct WatchHandle {
    watch_gen: u64,
    shutdown: clipboard_rs::WatcherShutdown,
}

/// 剪贴板历史全局状态（挂 AppState）。容量/天数护栏由前端 configure 推送
pub struct ClipHistState {
    /// SQLite 连接（WAL；复制是低频事件，Mutex 竞争可忽略）
    pub conn: Mutex<Connection>,
    /// watcher 停止通道（None = 未在监听）
    shutdown: Mutex<Option<WatchHandle>>,
    /// 监视线程代际号
    watch_gen: AtomicU64,
    /// 历史容量上限（条）
    pub capacity: AtomicUsize,
    /// 保留天数（0 = 永不按时清理）
    pub keep_days: AtomicI64,
    /// 自写回环 guard：最近一次写回的 (hash, 时刻)
    self_write: Mutex<Option<(String, Instant)>>,
    /// 直接粘贴目标窗口（HWND 原始值，0 = 无；浮窗 show 前抓取的前台窗口）
    paste_target: AtomicIsize,
}

impl ClipHistState {
    pub fn new() -> Result<Self, String> {
        let path = crate::config::config_root().join("clipboard.db");
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(&path).map_err(|e| format!("打开 clipboard.db 失败：{e}"))?;
        init_schema(&conn)?;
        Ok(Self::with_conn(conn))
    }

    /// 磁盘库打开失败时的兜底：内存库（历史不持久化，功能可用）
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("内存 SQLite 必定可用");
        if let Err(e) = init_schema(&conn) {
            log::error!("剪贴板历史内存库初始化失败：{e}");
        }
        Self::with_conn(conn)
    }

    fn with_conn(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
            shutdown: Mutex::new(None),
            watch_gen: AtomicU64::new(0),
            capacity: AtomicUsize::new(500),
            keep_days: AtomicI64::new(30),
            self_write: Mutex::new(None),
            paste_target: AtomicIsize::new(0),
        }
    }
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS clip_items (
           id           INTEGER PRIMARY KEY AUTOINCREMENT,
           kind         TEXT    NOT NULL,           -- text | image | files
           hash         TEXT    NOT NULL,           -- sha256 内容指纹（去重）
           text         TEXT,                       -- 全文或文件路径拼接（搜索用）
           preview      TEXT    NOT NULL,           -- 列表单行预览
           image        BLOB,                       -- PNG 原图（kind=image）
           thumb        BLOB,                       -- PNG 缩略 ≤96px（kind=image）
           files        TEXT,                       -- 路径 JSON 数组（kind=files）
           file_cut     INTEGER NOT NULL DEFAULT 0, -- Preferred DropEffect = MOVE
           size         INTEGER NOT NULL,
           pinned       INTEGER NOT NULL DEFAULT 0,
           created_at   INTEGER NOT NULL,           -- unix ms（重复使用置顶=更新此值）
           last_used_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_clip_created ON clip_items(created_at);
         CREATE INDEX IF NOT EXISTS idx_clip_hash    ON clip_items(hash);",
    )
    .map_err(|e| format!("初始化 clipboard.db 失败：{e}"))
}

// ── 载荷与纯函数 ─────────────────────────────────────────────────────────────

/// 一次剪贴板变化的载荷（纯数据形态；护栏/预览/指纹全为纯函数供 test）
#[derive(Clone, Debug, PartialEq)]
pub enum ClipContent {
    Text(String),
    Image { w: u32, h: u32, rgba: Vec<u8> },
    Files { paths: Vec<String>, cut: bool },
}

impl ClipContent {
    pub fn kind(&self) -> &'static str {
        match self {
            ClipContent::Text(_) => "text",
            ClipContent::Image { .. } => "image",
            ClipContent::Files { .. } => "files",
        }
    }

    /// sha256 内容指纹（hex）。类型前缀字节区分同字节的异构载荷
    pub fn hash_hex(&self) -> String {
        let mut h = Sha256::new();
        match self {
            ClipContent::Text(t) => {
                h.update(*b"T");
                h.update(t.as_bytes());
            }
            ClipContent::Image { w, h: hh, rgba } => {
                h.update(*b"I");
                h.update(w.to_le_bytes());
                h.update(hh.to_le_bytes());
                h.update(rgba);
            }
            ClipContent::Files { paths, cut } => {
                h.update(*b"F");
                h.update([*cut as u8]);
                for p in paths {
                    h.update(p.as_bytes());
                    h.update([0]);
                }
            }
        }
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn size(&self) -> u64 {
        match self {
            ClipContent::Text(t) => t.len() as u64,
            ClipContent::Image { rgba, .. } => rgba.len() as u64,
            ClipContent::Files { paths, .. } => paths.iter().map(|p| p.len() as u64 + 2).sum(),
        }
    }

    pub fn within_limits(&self) -> bool {
        match self {
            ClipContent::Text(t) => t.len() <= TEXT_MAX_BYTES,
            ClipContent::Image { rgba, .. } => rgba.len() <= IMAGE_MAX_BYTES,
            ClipContent::Files { paths, .. } => !paths.is_empty() && paths.len() <= FILES_MAX_COUNT,
        }
    }

    /// 搜索正文（text 列；图片无正文）
    pub fn search_text(&self) -> Option<String> {
        match self {
            ClipContent::Text(t) => Some(t.clone()),
            ClipContent::Image { .. } => None,
            ClipContent::Files { paths, .. } => Some(paths.join("\n")),
        }
    }

    /// 列表单行预览：文本取首行并折叠空白、截 160 字符；文件取名 + 项数；
    /// 图片给尺寸
    pub fn preview(&self) -> String {
        match self {
            ClipContent::Text(t) => {
                let first_line = t.split(['\r', '\n']).find(|s| !s.trim().is_empty());
                let collapsed = first_line
                    .unwrap_or("")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                collapsed.chars().take(160).collect()
            }
            ClipContent::Image { w, h, .. } => format!("{w}×{h} 位图"),
            ClipContent::Files { paths, .. } => {
                let names: Vec<String> = paths.iter().map(|p| file_name(p)).collect();
                if names.len() == 1 {
                    names[0].chars().take(160).collect()
                } else {
                    format!(
                        "{} 等 {} 项",
                        names.first().map(|s| s.as_str()).unwrap_or(""),
                        names.len()
                    )
                }
            }
        }
    }
}

/// 路径末段（兼容 / 与 \）
pub(crate) fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

// ── 编解码 ──────────────────────────────────────────────────────────────────

fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec()).ok_or("位图数据与尺寸不符")?;
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    Ok(out)
}

/// 缩略图（thumbnail 为快速整数采样，长边 ≤96 保纵横比）
fn make_thumb(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())?;
    let thumb = image::DynamicImage::ImageRgba8(img).thumbnail(THUMB_EDGE, THUMB_EDGE);
    let mut out = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

// ── 入库 / 清理 / 查询 ──────────────────────────────────────────────────────

/// 入库（去重置顶 = Ditto 行为：相同 hash 已存在则把该条 created_at 提到现在）。
/// 返回 Ok(true) = 有变化（新增或置顶），Ok(false) = 编码失败跳过
fn ingest(conn: &Connection, content: &ClipContent, now: i64) -> rusqlite::Result<bool> {
    let hash = content.hash_hex();
    let existing: Option<i64> =
        match conn.query_row("SELECT id FROM clip_items WHERE hash = ?1", [&hash], |r| {
            r.get(0)
        }) {
            Ok(id) => Some(id),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e),
        };
    if let Some(id) = existing {
        conn.execute(
            "UPDATE clip_items SET created_at = ?1, last_used_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )?;
        return Ok(true);
    }
    let (text, image, thumb, files, file_cut) = match content {
        ClipContent::Text(_) => (content.search_text(), None, None, None, 0i64),
        ClipContent::Image { w, h, rgba } => {
            let png = match encode_png(*w, *h, rgba) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("剪贴板图片入库跳过：{e}");
                    return Ok(false);
                }
            };
            let thumb = make_thumb(*w, *h, rgba);
            (None, Some(png), thumb, None, 0)
        }
        ClipContent::Files { paths, cut } => {
            let json = serde_json::to_string(paths).unwrap_or_else(|_| "[]".into());
            (content.search_text(), None, None, Some(json), *cut as i64)
        }
    };
    conn.execute(
        "INSERT INTO clip_items
           (kind, hash, text, preview, image, thumb, files, file_cut,
            size, pinned, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
        rusqlite::params![
            content.kind(),
            hash,
            text,
            content.preview(),
            image,
            thumb,
            files,
            file_cut,
            content.size() as i64,
            now
        ],
    )?;
    Ok(true)
}

/// 清理（pinned 豁免）：容量超限删最旧；保留天数到期删（keep_days=0 不限）
fn cleanup(conn: &Connection, capacity: usize, keep_days: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM clip_items WHERE pinned = 0 AND id NOT IN (
           SELECT id FROM clip_items ORDER BY created_at DESC, id DESC LIMIT ?1)",
        rusqlite::params![capacity as i64],
    )?;
    if keep_days > 0 {
        let cutoff = now - keep_days * 86_400_000;
        conn.execute(
            "DELETE FROM clip_items WHERE pinned = 0 AND created_at < ?1",
            rusqlite::params![cutoff],
        )?;
    }
    Ok(())
}

/// 列表条目（thumb 直接给 dataURL，前端零转换）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipHistItemMeta {
    pub id: i64,
    pub kind: String,
    pub preview: String,
    pub size: u64,
    pub pinned: bool,
    pub created_at: i64,
    pub last_used_at: i64,
    pub thumb: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipHistPage {
    pub items: Vec<ClipHistItemMeta>,
    pub total: usize,
}

/// 分页查询（铁律 3：过滤/排序/分页全在 Rust 端）。query 空串 = 全部，
/// kind 空串 = 全部类型
pub fn list_page(
    conn: &Connection,
    query: &str,
    kind: &str,
    offset: i64,
    limit: i64,
) -> rusqlite::Result<ClipHistPage> {
    use base64::Engine as _;
    let q = query.trim();
    let where_sql = "WHERE (?1 = '' OR preview LIKE '%'||?1||'%'
                       OR (text IS NOT NULL AND text LIKE '%'||?1||'%'))
                     AND (?2 = '' OR kind = ?2)";
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM clip_items {where_sql}"),
        rusqlite::params![q, kind],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT id, kind, preview, size, pinned, created_at, last_used_at, thumb
         FROM clip_items {where_sql}
         ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4"
    ))?;
    let items = stmt
        .query_map(rusqlite::params![q, kind, limit, offset], |r| {
            let thumb: Option<Vec<u8>> = r.get(7)?;
            Ok(ClipHistItemMeta {
                id: r.get(0)?,
                kind: r.get(1)?,
                preview: r.get(2)?,
                size: r.get::<_, i64>(3)? as u64,
                pinned: r.get::<_, i64>(4)? != 0,
                created_at: r.get(5)?,
                last_used_at: r.get(6)?,
                thumb: thumb.map(|b| {
                    format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(b)
                    )
                }),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ClipHistPage {
        items,
        total: total.max(0) as usize,
    })
}

/// 取回条目完整载荷（写回剪贴板用）：(kind, hash, text, image_png, files, cut)
struct StoredItem {
    kind: String,
    hash: String,
    text: Option<String>,
    image: Option<Vec<u8>>,
    files: Option<String>,
    cut: i64,
}

fn load_item(conn: &Connection, id: i64) -> Option<StoredItem> {
    conn.query_row(
        "SELECT kind, hash, text, image, files, file_cut FROM clip_items WHERE id = ?1",
        [id],
        |r| {
            Ok(StoredItem {
                kind: r.get(0)?,
                hash: r.get(1)?,
                text: r.get(2)?,
                image: r.get(3)?,
                files: r.get(4)?,
                cut: r.get(5)?,
            })
        },
    )
    .ok()
}

// ── watcher（Windows） ──────────────────────────────────────────────────────

#[cfg(windows)]
struct ClipChangeHandler {
    app: AppHandle,
}

#[cfg(windows)]
impl clipboard_rs::ClipboardHandler for ClipChangeHandler {
    fn on_clipboard_change(&mut self) {
        handle_clipboard_change(&self.app);
    }
}

#[cfg(windows)]
fn handle_clipboard_change(app: &AppHandle) {
    let Some(content) = read_clipboard() else {
        return;
    };
    let state = app.state::<AppState>();
    let h = &state.cliphist;
    // 自写回环 guard：hash 命中且在时间窗内 → 跳过（一次性消费）
    let hash = content.hash_hex();
    {
        let mut g = h.self_write.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((hw, t)) = g.take()
            && hw == hash
            && t.elapsed() < SELF_WRITE_WINDOW
        {
            return;
        }
    }
    if !content.within_limits() {
        log::debug!(
            "剪贴板条目超护栏，跳过：kind={} size={}",
            content.kind(),
            content.size()
        );
        return;
    }
    let now = now_ms();
    let conn = h.conn.lock().unwrap_or_else(|p| p.into_inner());
    let changed = ingest(&conn, &content, now).unwrap_or_else(|e| {
        log::warn!("剪贴板条目入库失败：{e}");
        false
    });
    let capacity = h.capacity.load(Ordering::SeqCst);
    let keep_days = h.keep_days.load(Ordering::SeqCst);
    let _ = cleanup(&conn, capacity, keep_days, now);
    drop(conn);
    if changed {
        let _ = app.emit("cliphist-updated", ());
    }
}

/// 读取剪贴板内容：文件 > 文本 > 图片（复制文件的应用通常同时挂多种格式，
/// CF_HDROP 最具体故最优先）
#[cfg(windows)]
fn read_clipboard() -> Option<ClipContent> {
    if let Some((paths, cut)) = crate::clip::get_files() {
        return Some(ClipContent::Files { paths, cut });
    }
    if let Some(t) = crate::clip::get_text()
        && !t.trim().is_empty()
    {
        return Some(ClipContent::Text(t));
    }
    if let Some(dib) = crate::clip::get_dib() {
        return match crate::clip::parse_dib(&dib) {
            Some((w, h, rgba)) => Some(ClipContent::Image { w, h, rgba }),
            // 位图在但不认头（非标准 BI_BITFIELDS/RLE 等）：留痕可查，静默
            // 吞掉会像 2026-10-31 首轮 E2E 那样无从事后定位
            None => {
                log::warn!(
                    "剪贴板位图不入库（不支持的 DIB 变体）：len={} compression={}",
                    dib.len(),
                    u32::from_le_bytes(
                        dib.get(16..20)
                            .unwrap_or_default()
                            .try_into()
                            .unwrap_or([0; 4])
                    )
                );
                None
            }
        };
    }
    None
}

/// 启动监听（幂等：已在监听直接返回）
#[cfg(windows)]
pub fn start_watcher(app: &AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        if state
            .cliphist
            .shutdown
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
        {
            return Ok(());
        }
    }
    let watch_gen = app
        .state::<AppState>()
        .cliphist
        .watch_gen
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app2 = app.clone();
    let spawned = std::thread::Builder::new()
        .name("clip-watcher".into())
        .spawn(move || {
            let mut watcher =
                match clipboard_rs::ClipboardWatcherContext::new_with_interval(WATCH_INTERVAL) {
                    Ok(w) => w,
                    Err(e) => {
                        log::error!("剪贴板监听创建失败：{e}");
                        return;
                    }
                };
            let shutdown = watcher
                .add_handler(ClipChangeHandler { app: app2.clone() })
                .get_shutdown_channel();
            {
                let state = app2.state::<AppState>();
                *state
                    .cliphist
                    .shutdown
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(WatchHandle {
                    watch_gen,
                    shutdown,
                });
            }
            log::info!("剪贴板监听已启动");
            watcher.start_watch(); // 阻塞至 shutdown.stop()
            // 线程收尾：清自己的登记（代际号不匹配说明已被新线程取代）
            {
                let state = app2.state::<AppState>();
                let mut g = state
                    .cliphist
                    .shutdown
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if g.as_ref().is_some_and(|h| h.watch_gen == watch_gen) {
                    *g = None;
                }
            }
            log::info!("剪贴板监听已停止");
        });
    spawned
        .map(|_| ())
        .map_err(|e| format!("剪贴板监视线程启动失败：{e}"))
}

/// 停止监听（幂等）
#[cfg(windows)]
pub fn stop_watcher(app: &AppHandle) {
    let state = app.state::<AppState>();
    let taken = state
        .cliphist
        .shutdown
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    if let Some(h) = taken {
        h.shutdown.stop();
    }
}

// ── 浮窗（label "cliphist"） ────────────────────────────────────────────────

/// 浮窗是否在屏（true = 已上屏聚焦；停靠位不算）
static CLIPHIST_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 停靠位（同 shot：虚拟桌面外，保持合成器在场防闪白，绝不用 hide()）
fn park_position() -> PhysicalPosition<i32> {
    PhysicalPosition::new(-32700, -32700)
}

/// 确保常驻浮窗存在（启动预热与热键冷路径共用）。建好即停靠屏幕外保持
/// 「可见」，热键呼出只是一次原子移动
pub(crate) fn ensure_clip_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("cliphist").is_some() {
        return Ok(());
    }
    let boot = serde_json::json!({ "window": "cliphist" });
    let win = tauri::WebviewWindowBuilder::new(
        app,
        "cliphist",
        tauri::WebviewUrl::App("clipboard.html".into()),
    )
    .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
    .title("X-Dir 剪贴板")
    .inner_size(WIN_W as f64, WIN_H as f64)
    .decorations(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .shadow(true)
    .focused(false)
    .visible(false)
    .initialization_script(format!("window.__BOOT__ = {boot};"))
    .build()
    .map_err(|e| format!("创建剪贴板浮窗失败：{e}"))?;
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        crate::commands::shot::disable_dwm_transitions(hwnd);
    }
    let _ = win.set_position(park_position());
    let _ = win.show();
    // 失焦自动收（Ditto 惯例）；Destroyed 复位开关
    let app2 = app.clone();
    win.on_window_event(move |e| match e {
        tauri::WindowEvent::Focused(false) => {
            if CLIPHIST_OPEN.load(Ordering::SeqCst) {
                close_clip_window(&app2);
            }
        }
        tauri::WindowEvent::Destroyed => {
            CLIPHIST_OPEN.store(false, Ordering::SeqCst);
        }
        _ => {}
    });
    Ok(())
}

/// 收浮窗：停靠屏幕外（不销毁、不 SW_HIDE），复位开关。停靠的窗口仍持有
/// 系统焦点——必须把焦点还给呼出前的窗口（paste_target），否则 Esc 关闭后
/// 键盘输入会落进看不见的窗口里（2026-10-31 E2E 实测）；用户主动点了别的
/// 窗口时焦点已不在本进程，SetForegroundWindow 会被系统拒绝，无副作用
pub(crate) fn close_clip_window(app: &AppHandle) {
    CLIPHIST_OPEN.store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("cliphist") {
        let _ = w.set_position(park_position());
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
        let state = app.state::<AppState>();
        let raw = state.cliphist.paste_target.load(Ordering::SeqCst);
        if raw != 0 {
            let hwnd = HWND(raw as *mut std::ffi::c_void);
            if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                let _ = unsafe { SetForegroundWindow(hwnd) };
            }
        }
    }
}

/// 热键入口：开 = 抓前台窗口为粘贴目标、光标显示器居中上屏聚焦；关 = 停靠。
/// 必须在主线程调用（热键回调 / 命令均满足）
pub fn toggle_clip_window(app: &AppHandle) {
    if CLIPHIST_OPEN.load(Ordering::SeqCst) {
        close_clip_window(app);
        return;
    }
    if let Err(e) = ensure_clip_window(app) {
        log::error!("剪贴板浮窗创建失败：{e}");
        return;
    }
    // 上屏抢焦点前抓真实前台窗口作粘贴目标
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let fg = unsafe { GetForegroundWindow() };
        let self_fg = app
            .get_webview_window("cliphist")
            .and_then(|w| w.hwnd().ok())
            .is_some_and(|h| h == fg);
        let state = app.state::<AppState>();
        state
            .cliphist
            .paste_target
            .store(if self_fg { 0 } else { fg.0 as isize }, Ordering::SeqCst);
    }
    if let Some(w) = app.get_webview_window("cliphist") {
        // 光标所在显示器居中（水平居中、垂直 40% 线，物理像素）
        if let Ok(cur) = app.cursor_position()
            && let Some(mon) =
                crate::commands::shot::monitor_at(cur.x.round() as i32, cur.y.round() as i32)
        {
            let (pw, ph) = (
                (WIN_W as f32 * mon.scale) as i32,
                (WIN_H as f32 * mon.scale) as i32,
            );
            let x = mon.x + (mon.w as i32 - pw).max(0) / 2;
            let y = mon.y + (mon.h as i32 - ph).max(0) * 2 / 5;
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
        let _ = w.show();
        let _ = w.set_focus();
        CLIPHIST_OPEN.store(true, Ordering::SeqCst);
    }
}

/// 直接粘贴：恢复目标窗口焦点 → 收浮窗 → 垂直序列 Ctrl+V。返回是否粘贴
/// 成功（目标失效/焦点恢复失败 = false，调用方降级为「已复制」提示）
#[cfg(windows)]
pub fn paste_and_close(app: &AppHandle, h: &ClipHistState) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
    let raw = h.paste_target.load(Ordering::SeqCst);
    let mut focused = false;
    if raw != 0 {
        let hwnd = HWND(raw as *mut std::ffi::c_void);
        if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            // 浮窗此刻仍持有前台权限，先转让给目标再收浮窗，转让合法
            focused = unsafe { SetForegroundWindow(hwnd) }.as_bool();
        }
    }
    if !focused {
        // 焦点恢复失败（管理员权限窗口/UAC/目标已关闭）：浮窗保持打开，
        // 前端提示降级为「已复制」——直接关闭会让降级提示无处可看
        return false;
    }
    close_clip_window(app);
    std::thread::sleep(Duration::from_millis(60));
    send_ctrl_v()
}

/// SendInput 模拟 Ctrl+V（VK_V = 0x56）
#[cfg(windows)]
fn send_ctrl_v() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
        VIRTUAL_KEY, VK_CONTROL,
    };
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let v = VIRTUAL_KEY(0x56);
    let seq = [
        key(VK_CONTROL, false),
        key(v, false),
        key(v, true),
        key(VK_CONTROL, true),
    ];
    let sent = unsafe { SendInput(&seq, std::mem::size_of::<INPUT>() as i32) };
    sent == seq.len() as u32
}

/// 写回执行体（命令层调用）：guard 登记 → 按 kind 写系统剪贴板 → 使用置顶。
/// 返回 Err = 写入失败（前端 toast）；Ok(pasted) = 直接粘贴是否成功
#[cfg(windows)]
pub fn write_back(
    app: &AppHandle,
    h: &ClipHistState,
    id: i64,
    paste: bool,
) -> Result<bool, String> {
    let item = {
        let conn = h.conn.lock().unwrap_or_else(|p| p.into_inner());
        load_item(&conn, id)
    };
    let Some(item) = item else {
        return Err("条目不存在".into());
    };
    // guard 先于写入登记（watcher 事件可能立即到达）
    *h.self_write.lock().unwrap_or_else(|p| p.into_inner()) =
        Some((item.hash.clone(), Instant::now()));
    match item.kind.as_str() {
        "text" => crate::clip::set_text(&item.text.unwrap_or_default())?,
        "files" => {
            let paths: Vec<String> =
                serde_json::from_str(&item.files.unwrap_or_default()).unwrap_or_default();
            crate::clip::set_files(&paths, item.cut != 0)?;
        }
        "image" => {
            let bytes = item.image.unwrap_or_default();
            let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                .map_err(|e| format!("图片条目解码失败：{e}"))?;
            let rgba = img.into_rgba8();
            let (w, hh) = rgba.dimensions();
            crate::clip::set_image(w, hh, rgba.as_raw())?;
        }
        other => return Err(format!("未知条目类型：{other}")),
    }
    // 使用置顶（Ditto 行为）+ 记录使用时间
    {
        let conn = h.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute(
            "UPDATE clip_items SET created_at = ?1, last_used_at = ?1 WHERE id = ?2",
            rusqlite::params![now_ms(), id],
        );
    }
    if !paste {
        close_clip_window(app);
        return Ok(true);
    }
    Ok(paste_and_close(app, h))
}

/// 非 Windows 桩（clip.rs 的系统剪贴板互通仅 Windows 实现）
#[cfg(not(windows))]
pub fn write_back(
    app: &AppHandle,
    _h: &ClipHistState,
    _id: i64,
    _paste: bool,
) -> Result<bool, String> {
    close_clip_window(app);
    Err("剪贴板历史仅 Windows 支持".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    fn mem_db() -> Connection {
        let c = Connection::open_in_memory().expect("内存库");
        init_schema(&c).expect("建表");
        c
    }

    fn text(s: &str) -> ClipContent {
        ClipContent::Text(s.into())
    }

    #[test]
    fn preview_collapses_and_truncates() {
        assert_eq!(text("hello").preview(), "hello");
        // 首个非空行 + 空白折叠
        assert_eq!(text("\r\n  a \t b\nsecond").preview(), "a b");
        // 160 字符截断（按字符不按字节）
        let long = "字".repeat(200);
        assert_eq!(text(&long).preview().chars().count(), 160);
    }

    #[test]
    fn preview_files_and_image() {
        let files = ClipContent::Files {
            paths: vec!["C:\\dir\\a.txt".into(), "C:\\dir\\b.txt".into()],
            cut: false,
        };
        assert_eq!(files.preview(), "a.txt 等 2 项");
        assert_eq!(
            ClipContent::Files {
                paths: vec!["D:\\单独.png".into()],
                cut: true
            }
            .preview(),
            "单独.png"
        );
        assert_eq!(
            ClipContent::Image {
                w: 1920,
                h: 1080,
                rgba: vec![]
            }
            .preview(),
            "1920×1080 位图"
        );
    }

    #[test]
    fn limits_and_hash_distinction() {
        assert!(text(&"x".repeat(TEXT_MAX_BYTES)).within_limits());
        assert!(!text(&"x".repeat(TEXT_MAX_BYTES + 1)).within_limits());
        assert!(
            !ClipContent::Files {
                paths: (0..FILES_MAX_COUNT + 1).map(|i| i.to_string()).collect(),
                cut: false
            }
            .within_limits()
        );
        // 类型前缀区分同字节异构载荷；cut 影响文件指纹
        assert_ne!(
            text("F").hash_hex(),
            ClipContent::Files {
                paths: vec!["F".into()],
                cut: false
            }
            .hash_hex()
        );
        assert_ne!(
            ClipContent::Files {
                paths: vec!["a".into()],
                cut: false
            }
            .hash_hex(),
            ClipContent::Files {
                paths: vec!["a".into()],
                cut: true
            }
            .hash_hex()
        );
    }

    #[test]
    fn ingest_dedup_promotes() {
        let c = mem_db();
        ingest(&c, &text("hello"), 1000).unwrap();
        ingest(&c, &text("world"), 2000).unwrap();
        // 同 hash 二次复制 → 不新增，created_at 置顶
        ingest(&c, &text("hello"), 3000).unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM clip_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
        let (top, ts): (String, i64) = c
            .query_row(
                "SELECT preview, created_at FROM clip_items ORDER BY created_at DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(top, "hello");
        assert_eq!(ts, 3000);
    }

    #[test]
    fn ingest_image_stores_png_and_thumb() {
        let c = mem_db();
        let (w, h) = (2u32, 3u32);
        let rgba = vec![255u8; (w * h * 4) as usize];
        assert!(ingest(&c, &ClipContent::Image { w, h, rgba }, 1).unwrap());
        let (img, thumb): (Option<Vec<u8>>, Option<Vec<u8>>) = c
            .query_row("SELECT image, thumb FROM clip_items", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let img = img.expect("原图入库");
        let decoded = image::load_from_memory_with_format(&img, image::ImageFormat::Png).unwrap();
        assert_eq!(decoded.dimensions(), (w, h));
        // 缩略图 ≤96 且能解码
        let t = thumb.expect("缩略图入库");
        let dt = image::load_from_memory_with_format(&t, image::ImageFormat::Png).unwrap();
        assert!(dt.width() <= THUMB_EDGE && dt.height() <= THUMB_EDGE);
    }

    #[test]
    fn cleanup_respects_capacity_days_and_pin() {
        let c = mem_db();
        for i in 0..5 {
            ingest(&c, &text(&format!("item{i}")), 1000 + i).unwrap();
        }
        // 容量 3：删掉最旧两条（item0/item1）
        cleanup(&c, 3, 0, 5000).unwrap();
        let previews: Vec<String> = c
            .prepare("SELECT preview FROM clip_items ORDER BY created_at")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(previews, vec!["item2", "item3", "item4"]);
        // 置顶豁免：pin item2 后容量 1 也不会删它
        c.execute("UPDATE clip_items SET pinned=1 WHERE preview='item2'", [])
            .unwrap();
        cleanup(&c, 1, 0, 6000).unwrap();
        let previews: Vec<String> = c
            .prepare("SELECT preview FROM clip_items ORDER BY created_at")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(previews, vec!["item2", "item4"]);
        // 保留天数：keep_days=1，now 推到两天后 → item4 到期删除（pin 豁免）
        cleanup(&c, 10, 1, 1004 + 2 * 86_400_000).unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM clip_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1); // 只剩 pinned item2
    }

    #[test]
    fn list_page_filters_and_paginates() {
        let c = mem_db();
        for i in 0..7 {
            ingest(&c, &text(&format!("alpha {i}")), 1000 + i).unwrap();
        }
        ingest(
            &c,
            &ClipContent::Files {
                paths: vec!["C:\\b.png".into()],
                cut: false,
            },
            2000,
        )
        .unwrap();
        // 全量分页
        let p1 = list_page(&c, "", "", 0, 5).unwrap();
        assert_eq!(p1.items.len(), 5);
        assert_eq!(p1.total, 8);
        let p2 = list_page(&c, "", "", 5, 5).unwrap();
        assert_eq!(p2.items.len(), 3);
        // 搜索：只命中文本条目
        let ps = list_page(&c, "alpha 3", "", 0, 50).unwrap();
        assert_eq!(ps.items.len(), 1);
        assert_eq!(ps.items[0].preview, "alpha 3");
        // 搜索命中文件路径
        let pf = list_page(&c, "b.png", "", 0, 50).unwrap();
        assert_eq!(pf.items.len(), 1);
        assert_eq!(pf.items[0].kind, "files");
        // 类型过滤
        let pk = list_page(&c, "", "files", 0, 50).unwrap();
        assert_eq!(pk.items.len(), 1);
        assert!(pk.items[0].thumb.is_none());
    }
}
