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
/// 图片条目缩略图长边上限（列表直接随页下发 dataURL）。320 档：行内以
/// 2.4 行等高（≈67px）展示，150% DPI 下横图显示宽 ≈179 物理像素，128 档
/// 会被放大 1.4× 发糊（用户实测）；320 只缩不放保清晰，体积靠不透明图编
/// JPEG（比 PNG 小一个量级）控制，随页 IPC 不膨胀
const THUMB_EDGE: u32 = 320;
/// 缩略 JPEG 质量档（截图/照片 80 视觉无损）
const THUMB_JPEG_Q: u8 = 80;
/// 自写回环 guard 时间窗
const SELF_WRITE_WINDOW: Duration = Duration::from_secs(3);
/// 浮窗逻辑尺寸（inner_size 逻辑像素；定位换算物理像素）
const WIN_W: i32 = 460;
const WIN_H: i32 = 540;

pub(crate) fn now_ms() -> i64 {
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
    /// 排除应用清单（逗号/分号分隔进程名，T1-1；configure 推送）
    pub exclude_apps: Mutex<String>,
    /// 富文本保真开关（T3-1；开启时文本条目附带存 HTML 片段）
    pub rich_text: std::sync::atomic::AtomicBool,
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
            exclude_apps: Mutex::new(String::new()),
            rich_text: std::sync::atomic::AtomicBool::new(true),
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
           thumb        BLOB,                       -- 缩略 ≤320px（JPEG/PNG，kind=image）
           files        TEXT,                       -- 路径 JSON 数组（kind=files）
           py           TEXT,                       -- 文本拼音首字母（中文搜索，T1-3）
           source       TEXT,                       -- 来源进程名（T2-2，如 excel.exe）
           html         TEXT,                       -- 富文本 HTML 片段（T3-1，富文本开关开启时）
           fav          INTEGER NOT NULL DEFAULT 0, -- 收藏（T3-2，豁免清理、排最前）
           file_cut     INTEGER NOT NULL DEFAULT 0, -- Preferred DropEffect = MOVE
           size         INTEGER NOT NULL,
           pinned       INTEGER NOT NULL DEFAULT 0,
           created_at   INTEGER NOT NULL,           -- unix ms（重复使用置顶=更新此值）
           last_used_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_clip_created ON clip_items(created_at);
         CREATE INDEX IF NOT EXISTS idx_clip_hash    ON clip_items(hash);",
    )
    .map_err(|e| format!("初始化 clipboard.db 失败：{e}"))?;
    // 惰性迁移（T1-3/T2-2/T3-1/T3-2）：一趟表结构查询判 py/source/html/fav
    // 四列，缺哪补哪（建表语句已含，新库零 ALTER；2026-11-01 合并四次
    // pragma 查询为一次）
    let cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('clip_items')")
        .map_err(|e| format!("读取表结构失败：{e}"))?
        .query_map([], |r| r.get(0))
        .map_err(|e| format!("迭代表结构失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取表结构列失败：{e}"))?;
    let has_col = |k: &str| cols.iter().any(|c| c == k);
    if !has_col("py") {
        conn.execute_batch("ALTER TABLE clip_items ADD COLUMN py TEXT;")
            .map_err(|e| format!("补 py 列失败：{e}"))?;
    }
    if !has_col("source") {
        conn.execute_batch("ALTER TABLE clip_items ADD COLUMN source TEXT;")
            .map_err(|e| format!("补 source 列失败：{e}"))?;
    }
    if !has_col("html") {
        conn.execute_batch("ALTER TABLE clip_items ADD COLUMN html TEXT;")
            .map_err(|e| format!("补 html 列失败：{e}"))?;
    }
    if !has_col("fav") {
        conn.execute_batch("ALTER TABLE clip_items ADD COLUMN fav INTEGER NOT NULL DEFAULT 0;")
            .map_err(|e| format!("补 fav 列失败：{e}"))?;
    }
    // FTS5 全文索引（T3-4）：content 表挂 clip_items 行 id，触发器同步增删改；
    // 已存在则重建一次保证结构新鲜（量级小，秒级）
    // trigram 分词器支持任意子串（含中文 ≥3 字符）；老 SQLite 无此分词器
    // 则清掉重建为默认分词（英文词级，短查询本就走 LIKE 不受影响）
    if conn
        .execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS clip_fts USING fts5(text, content='clip_items', content_rowid='id', tokenize='trigram');",
        )
        .is_err()
    {
        let _ = conn.execute_batch("DROP TABLE IF EXISTS clip_fts;");
    }
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS clip_fts USING fts5(text, content='clip_items', content_rowid='id');
         CREATE TRIGGER IF NOT EXISTS clip_fts_ai AFTER INSERT ON clip_items BEGIN
           INSERT INTO clip_fts(rowid, text) VALUES (new.id, new.text);
         END;
         CREATE TRIGGER IF NOT EXISTS clip_fts_ad AFTER DELETE ON clip_items BEGIN
           INSERT INTO clip_fts(clip_fts, rowid, text) VALUES ('delete', old.id, old.text);
         END;
         CREATE TRIGGER IF NOT EXISTS clip_fts_au AFTER UPDATE ON clip_items BEGIN
           INSERT INTO clip_fts(clip_fts, rowid, text) VALUES ('delete', old.id, old.text);
           INSERT INTO clip_fts(rowid, text) VALUES (new.id, new.text);
         END;",
    )
    .map_err(|e| format!("初始化 FTS 失败：{e}"))?;
    // 重建仅在计数漂移时执行（2026-11-01 启动速度优化）：触发器在每次
    // 增删改时保持 FTS 与主表同步，常态启动零重建；旧无条件全量 rebuild
    // 随库增长线性变慢（几千条文本时可达秒级），而它只对「触发器缺位的
    // 历史库 / 中断写入」有意义——计数一致即视为已同步
    let fts_drift: bool = conn
        .query_row(
            "SELECT (SELECT count(*) FROM clip_fts) != (SELECT count(*) FROM clip_items)",
            [],
            |r| r.get(0),
        )
        .unwrap_or(true);
    if fts_drift {
        conn.execute_batch("INSERT INTO clip_fts(clip_fts) VALUES('rebuild');")
            .map_err(|e| format!("FTS 重建失败：{e}"))?;
    }
    // 回填：仅 text 列非空且 py 为空的行（新库为空集，秒过）
    let rows: Vec<(i64, Option<String>)> = conn
        .prepare("SELECT id, text FROM clip_items WHERE text IS NOT NULL AND py IS NULL")
        .map_err(|e| format!("回填 py 查询失败：{e}"))?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| format!("回填 py 迭代失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("回填 py 读取失败：{e}"))?;
    for (id, text) in rows {
        let py = text.as_deref().and_then(crate::fs::search::pinyin_initials);
        if let Some(p) = py {
            let _ = conn.execute(
                "UPDATE clip_items SET py = ?1 WHERE id = ?2",
                rusqlite::params![p, id],
            );
        } else {
            let _ = conn.execute(
                "UPDATE clip_items SET py = '' WHERE id = ?2",
                rusqlite::params![id],
            );
        }
    }
    Ok(())
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

/// 敏感内容跳过（2026-10-31 T1-1）：高置信凭据模式才拦（误拦正常文本比漏拦
/// 更伤日常）——PEM 私钥块 / AWS AccessKey / JWT / GitHub·Slack·Google 令牌。
/// 手写匹配器（regex 不在依赖内，模式皆前缀+字符集计数，成本忽略不计）
pub fn is_sensitive(t: &str) -> bool {
    // PEM 私钥块（BEGIN…PRIVATE KEY----- 两段同时在場即判）
    if t.contains("-----BEGIN") && t.contains("PRIVATE KEY-----") {
        return true;
    }
    /// 前缀后跟 ≥min_tail 个 pred 字符即命中
    fn token(t: &str, prefix: &str, min_tail: usize, pred: fn(char) -> bool) -> bool {
        let mut from = 0;
        while let Some(i) = t[from..].find(prefix) {
            let tail = t[from + i + prefix.len()..]
                .chars()
                .take_while(|&c| pred(c))
                .count();
            if tail >= min_tail {
                return true;
            }
            from += i + prefix.len();
        }
        false
    }
    const ALNUM: fn(char) -> bool = |c| c.is_ascii_alphanumeric();
    const B64URL: fn(char) -> bool = |c| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    // AWS AccessKey：AKIA + 16 位大写字母数字
    if token(t, "AKIA", 16, |c| {
        c.is_ascii_uppercase() || c.is_ascii_digit()
    }) {
        return true;
    }
    // GitHub / Slack / Google 令牌
    for pfx in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if token(t, pfx, 30, ALNUM) {
            return true;
        }
    }
    for pfx in ["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"] {
        if token(t, pfx, 10, |c| ALNUM(c) || c == '-') {
            return true;
        }
    }
    if token(t, "AIza", 31, B64URL) {
        return true;
    }
    // JWT：eyJ 开头三段 base64url 以 . 相连（首段 ≥10，末段 ≥10）
    let bytes = t.as_bytes();
    let mut i = 0;
    while let Some(j) = t[i..].find("eyJ") {
        let start = i + j;
        let mut k = start + 3;
        let mut segs = 0usize;
        let mut ok = true;
        while segs < 3 {
            let len = t[k..].chars().take_while(|&c| B64URL(c)).count();
            if segs < 2 && len < 10 {
                ok = false;
                break;
            }
            if segs == 2 {
                if len < 10 {
                    ok = false;
                }
                break;
            }
            k += len;
            if bytes.get(k) != Some(&b'.') {
                ok = false;
                break;
            }
            k += 1;
            segs += 1;
        }
        if ok {
            return true;
        }
        i = start + 3;
    }
    false
}

/// 排除应用匹配（2026-10-31 T1-1）：清单逗号/分号分隔，双方去 .exe 后缀与
/// 大小写比对（用户写 "excel" 或 "excel.exe" 都命中 EXCEL.EXE）
pub fn app_excluded(list: &str, proc: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches(".exe").to_ascii_lowercase();
    let target = norm(proc);
    if target.is_empty() {
        return false;
    }
    list.split([',', ';', '，', '；'])
        .map(norm)
        .any(|e| !e.is_empty() && e == target)
}

/// 路径末段（兼容 / 与 \）
pub(crate) fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

/// 单行、无空白、http(s)/ftp/www 开头且长度合理 → 链接
fn is_url(t: &str) -> bool {
    let t = t.trim();
    t.len() <= 2048
        && !t.contains(char::is_whitespace)
        && (t.starts_with("http://")
            || t.starts_with("https://")
            || t.starts_with("ftp://")
            || t.starts_with("www."))
}

/// 盘符（C:\…）或 UNC（\\server\…）样式且磁盘上实际存在 → 路径。
/// 只认存在的路径，纯文本里长得像路径的句子（"D:\分区说明"）不误判
fn is_existing_path(t: &str) -> bool {
    let t = t.trim();
    let b = t.as_bytes();
    let drive = b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/');
    let unc = t.starts_with(r"\\");
    (drive || unc) && std::fs::metadata(t).is_ok()
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

/// 缩略图（thumbnail 快速整数采样，长边 ≤320 只缩不放保纵横比）。
/// 不透明图编 JPEG（q80，截图/照片体积比 PNG 小一个量级，随分页 dataURL
/// 下发不撑 IPC）；带透明像素编 PNG 保 alpha。透明判定按**实际像素**扫描
/// 而非颜色通道——剪贴板位图恒为 RGBA 源，按通道判定会永远走 PNG
fn make_thumb(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())?;
    let has_alpha = rgba.as_chunks::<4>().0.iter().any(|px| px[3] != 255);
    let thumb = image::DynamicImage::ImageRgba8(img).thumbnail(THUMB_EDGE, THUMB_EDGE);
    let mut out = Vec::new();
    if has_alpha {
        thumb
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .ok()?;
    } else {
        let rgb = thumb.to_rgb8();
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, THUMB_JPEG_Q);
        enc.encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    }
    Some(out)
}

// ── 入库 / 清理 / 查询 ──────────────────────────────────────────────────────

/// 图片条目重编码（PNG 原图 + 缩略图）。独立出来供调用方在 **锁外** 执行：
/// 4K 编码数百 ms，持 conn 锁做会让所有 cliphist 命令排队（同步命令在主
/// 线程 = 整个应用卡住，2026-11-01 响应速度优化）
fn encode_image_payload(w: u32, h: u32, rgba: &[u8]) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    let png = encode_png(w, h, rgba)?;
    let thumb = make_thumb(w, h, rgba);
    Ok((png, thumb))
}

/// 去重查询：相同 hash 已存在则置顶（Ditto 行为），返回 Some(id)
fn promote_if_duplicate(conn: &Connection, hash: &str, now: i64) -> rusqlite::Result<Option<i64>> {
    let existing: Option<i64> =
        match conn.query_row("SELECT id FROM clip_items WHERE hash = ?1", [hash], |r| {
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
        return Ok(Some(id));
    }
    Ok(None)
}

/// 新行落库（不做去重查询——两阶段调用方已复核）。image = 预编码的
/// (原图, 缩略图)，仅 kind=image 条目需要
fn insert_item(
    conn: &Connection,
    content: &ClipContent,
    image: Option<(Vec<u8>, Option<Vec<u8>>)>,
    now: i64,
    source: Option<&str>,
    html: Option<&str>,
    hash: &str,
) -> rusqlite::Result<()> {
    let (text, image, thumb, files, file_cut) = match content {
        ClipContent::Text(_) => (content.search_text(), None, None, None, 0i64),
        ClipContent::Image { .. } => {
            let (png, thumb) = image.expect("图片条目必须先经 encode_image_payload");
            (None, Some(png), thumb, None, 0)
        }
        ClipContent::Files { paths, cut } => {
            let json = serde_json::to_string(paths).unwrap_or_else(|_| "[]".into());
            (content.search_text(), None, None, Some(json), *cut as i64)
        }
    };
    // 条目类型细分（2026-10-31 用户需求"丰富类型判断"）：
    // - 文件列表：全部为目录 → 文件夹类（Explorer 复制目录的常态），含任一
    //   文件/判定失败归文件类（判失败不阻塞入库）
    // - 文本：URL（单行无空白、http(s)/ftp/www 开头）→ 链接；盘符/UNC 样式
    //   且实际存在 → 路径（文件管理器语境高频）。回写仍按纯文本处理
    let row_kind = match &content {
        ClipContent::Files { paths, .. } => {
            if paths
                .iter()
                .all(|p| std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false))
            {
                "dirs"
            } else {
                "files"
            }
        }
        ClipContent::Text(t) => {
            if is_url(t) {
                "link"
            } else if is_existing_path(t) {
                "path"
            } else {
                "text"
            }
        }
        _ => content.kind(),
    };
    // 拼音首字母（T1-3）：仅含汉字的文本有值，供首字母搜索
    let py = text.as_deref().and_then(crate::fs::search::pinyin_initials);
    conn.execute(
        "INSERT INTO clip_items
           (kind, hash, text, preview, image, thumb, files, file_cut, py, source, html,
            size, pinned, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?11, ?12, ?13, ?9, 0, ?10, ?10)",
        rusqlite::params![
            row_kind,
            hash,
            text,
            content.preview(),
            image,
            thumb,
            files,
            file_cut,
            content.size() as i64,
            now,
            py,
            source,
            html.filter(|h| h.len() <= 2_000_000)
        ],
    )?;
    Ok(())
}

/// 入库（单阶段便捷封装，仅供测试）：去重置顶 / 新条目编码落库。
/// 持锁做图片编码——生产 watcher 路径不经过这里（见 handle_clipboard_change
/// 的两阶段入库）
#[cfg(test)]
fn ingest(
    conn: &Connection,
    content: &ClipContent,
    now: i64,
    source: Option<&str>,
    html: Option<&str>,
) -> rusqlite::Result<bool> {
    let hash = content.hash_hex();
    if promote_if_duplicate(conn, &hash, now)?.is_some() {
        return Ok(true);
    }
    let image = if let ClipContent::Image { w, h, rgba } = content {
        match encode_image_payload(*w, *h, rgba) {
            Ok(p) => Some(p),
            Err(e) => {
                log::warn!("剪贴板图片入库跳过：{e}");
                return Ok(false);
            }
        }
    } else {
        None
    };
    insert_item(conn, content, image, now, source, html, &hash)?;
    Ok(true)
}

/// 清理（pinned 豁免）：容量超限删最旧；保留天数到期删（keep_days=0 不限）
fn cleanup(conn: &Connection, capacity: usize, keep_days: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM clip_items WHERE pinned = 0 AND fav = 0 AND id NOT IN (
           SELECT id FROM clip_items ORDER BY created_at DESC, id DESC LIMIT ?1)",
        rusqlite::params![capacity as i64],
    )?;
    if keep_days > 0 {
        let cutoff = now - keep_days * 86_400_000;
        conn.execute(
            "DELETE FROM clip_items WHERE pinned = 0 AND fav = 0 AND created_at < ?1",
            rusqlite::params![cutoff],
        )?;
    }
    Ok(())
}

/// 清空最近 N 天条目（pinned/fav 豁免，与容量/保留天数清理同口径）；days=0
/// 清空全部非置顶/收藏。返回删除条数。入口 = 设置 → 剪贴板「清理历史条目」
/// （浮窗页脚清空钮已退役 2026-11-12）
pub(crate) fn clear_recent(conn: &Connection, days: u32, now: i64) -> rusqlite::Result<usize> {
    if days == 0 {
        conn.execute("DELETE FROM clip_items WHERE pinned = 0 AND fav = 0", [])
    } else {
        let cutoff = now - (days as i64).min(3650) * 86_400_000;
        conn.execute(
            "DELETE FROM clip_items WHERE pinned = 0 AND fav = 0 AND created_at >= ?1",
            rusqlite::params![cutoff],
        )
    }
}

/// 列表条目（thumb 直接给 dataURL，前端零转换）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipHistItemMeta {
    pub id: i64,
    pub kind: String,
    pub preview: String,
    pub source: Option<String>,
    pub size: u64,
    pub pinned: bool,
    pub fav: bool,
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
    let q_all = q.is_empty();
    let where_sql = if q_all || q.chars().count() < 3 {
        // 空查询或短查询（trigram 最小 3 字符）：LIKE 通道（保子词语义）
        "WHERE (?1 = '' OR preview LIKE '%'||?1||'%'
                       OR (text IS NOT NULL AND text LIKE '%'||?1||'%')
                       OR (py IS NOT NULL AND py LIKE '%'||?1||'%')
                       OR (source IS NOT NULL AND source LIKE '%'||?1||'%'))
                     AND (?2 = '' OR (?2 = 'fav' AND fav = 1) OR kind = ?2)"
            .to_string()
    } else {
        // 全文（T3-4）：trigram 任意子串（含中文）；双引号双写转义、单引号
        // 双写防注入（char::from 构造免转义符）
        let dq = char::from(34);
        let sq = char::from(39);
        let phrase = q.replace(dq, &format!("{dq}{dq}"));
        let fts_sql = format!("{dq}{phrase}{dq}").replace(sq, "''");
        format!(
            "WHERE (id IN (SELECT rowid FROM clip_fts WHERE text MATCH '{fts_sql}')
                   OR (py IS NOT NULL AND py LIKE '%'||?1||'%')
                   OR (source IS NOT NULL AND source LIKE '%'||?1||'%'))
             AND (?2 = '' OR (?2 = 'fav' AND fav = 1) OR kind = ?2)"
        )
    };
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM clip_items {where_sql}"),
        rusqlite::params![q, kind],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT id, kind, preview, size, pinned, created_at, last_used_at, thumb, source, fav
         FROM clip_items {where_sql}
         ORDER BY fav DESC, pinned DESC, created_at DESC, id DESC LIMIT ?3 OFFSET ?4"
    ))?;
    let items = stmt
        .query_map(rusqlite::params![q, kind, limit, offset], |r| {
            let thumb: Option<Vec<u8>> = r.get(7)?;
            Ok(ClipHistItemMeta {
                id: r.get(0)?,
                kind: r.get(1)?,
                preview: r.get(2)?,
                source: r.get(8)?,
                size: r.get::<_, i64>(3)? as u64,
                pinned: r.get::<_, i64>(4)? != 0,
                fav: r.get::<_, i64>(9)? != 0,
                created_at: r.get(5)?,
                last_used_at: r.get(6)?,
                thumb: thumb.map(|b| {
                    // mime 按实际编码标（make_thumb 不透明 = JPEG / 带透明 = PNG）
                    let mime = if b.starts_with(&[0x89, b'P', b'N', b'G']) {
                        "image/png"
                    } else {
                        "image/jpeg"
                    };
                    format!(
                        "data:{mime};base64,{}",
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
    html: Option<String>,
    image: Option<Vec<u8>>,
    files: Option<String>,
    cut: i64,
}

fn load_item(conn: &Connection, id: i64) -> Option<StoredItem> {
    conn.query_row(
        "SELECT kind, hash, text, html, image, files, file_cut FROM clip_items WHERE id = ?1",
        [id],
        |r| {
            Ok(StoredItem {
                kind: r.get(0)?,
                hash: r.get(1)?,
                text: r.get(2)?,
                html: r.get(3)?,
                image: r.get(4)?,
                files: r.get(5)?,
                cut: r.get(6)?,
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

/// 前台进程名（小写 exe 名，如 "excel.exe"）——剪贴板变化时前台即来源应用
#[cfg(windows)]
fn frontmost_app_name() -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    use windows::core::PWSTR;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return None;
    };
    let mut buf = [0u16; 512];
    let mut len = buf.len() as u32;
    let r = unsafe {
        windows::Win32::System::Threading::QueryFullProcessImageNameW(
            handle,
            windows::Win32::System::Threading::PROCESS_NAME_FORMAT(0),
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    if r.is_err() || len == 0 || len as usize > buf.len() {
        return None;
    }
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    let name = full.rsplit(['\\', '/']).next().unwrap_or(&full);
    if name.is_empty() {
        None
    } else {
        Some(name.to_ascii_lowercase())
    }
}

#[cfg(windows)]
fn handle_clipboard_change(app: &AppHandle) {
    let state = app.state::<AppState>();
    let h = &state.cliphist;
    // 来源应用（变化时前台即来源）：排除清单命中 → 整条不入库（T1-1）
    let source_app = frontmost_app_name();
    if let Some(proc) = &source_app
        && app_excluded(
            h.exclude_apps
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_str(),
            proc,
        )
    {
        log::debug!("剪贴板条目来自排除应用 {proc}，跳过");
        return;
    }
    let Some(content) = read_clipboard() else {
        return;
    };
    // 敏感凭据跳过（高置信模式，T1-1）
    if let ClipContent::Text(t) = &content
        && is_sensitive(t)
    {
        log::info!("剪贴板文本命中敏感凭据模式，跳过入库");
        return;
    }
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
    // 富文本（T3-1）：文本类且开关开启时附带 HTML Format（Word/浏览器源）
    let html_frag = if h.rich_text.load(Ordering::SeqCst) && matches!(content, ClipContent::Text(_))
    {
        crate::clip::get_html()
    } else {
        None
    };
    let now = now_ms();
    // 两阶段入库（2026-11-01 响应速度优化）：先短锁查重（µs 级，命中即置顶
    // 返回）；新条目在 **锁外** 做 PNG 编码（4K 数百 ms——持锁编码期间所有
    // cliphist 命令排队，而它们是主线程同步命令 = 整个应用卡住），编码完再
    // 短锁复核（编码期间同 hash 可能已被并发写入）+ 落库 + 清理
    let promoted = {
        let conn = h.conn.lock().unwrap_or_else(|p| p.into_inner());
        promote_if_duplicate(&conn, &hash, now).unwrap_or_else(|e| {
            log::warn!("剪贴板条目查重失败：{e}");
            None
        })
    };
    if promoted.is_some() {
        let _ = app.emit("cliphist-updated", ());
        return;
    }
    let image = if let ClipContent::Image { w, h: hh, rgba } = &content {
        match encode_image_payload(*w, *hh, rgba) {
            Ok(p) => Some(p),
            Err(e) => {
                log::warn!("剪贴板图片入库跳过：{e}");
                return;
            }
        }
    } else {
        None
    };
    {
        let conn = h.conn.lock().unwrap_or_else(|p| p.into_inner());
        let changed = match promote_if_duplicate(&conn, &hash, now) {
            Ok(None) => insert_item(
                &conn,
                &content,
                image,
                now,
                source_app.as_deref(),
                html_frag.as_deref(),
                &hash,
            )
            .map(|_| true),
            Ok(Some(_)) => Ok(true),
            Err(e) => {
                log::warn!("剪贴板条目入库失败：{e}");
                Ok(false)
            }
        }
        .unwrap_or(false);
        if !changed {
            return;
        }
        let capacity = h.capacity.load(Ordering::SeqCst);
        let keep_days = h.keep_days.load(Ordering::SeqCst);
        let _ = cleanup(&conn, capacity, keep_days, now);
    }
    let _ = app.emit("cliphist-updated", ());
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

/// 浮窗呼出时刻（unix ms，看门狗宽限基准）。看门狗**不依赖 Focused(true)
/// 置位**——实测 set_focus 已使窗口持前台（GetForegroundWindow 命中）时
/// Tauri 的 Focused(true) 事件仍可能不回调（无焦点切换发生 = 无事件），
/// 以事件置位 gating 会永久 disarm；呼出 + 宽限 1.2s 即 armed
static CLIPHIST_SUMMONED_AT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// 浮窗常驻（置顶钮，2026-10-31）：true = 失焦不自动收窗（浮窗本就
/// always_on_top，常驻语义 = 钉在屏幕上连续取用；Esc/热键/显式动作仍收）。
/// 会话级状态，不持久化——与贴图的临时性同口径
static CLIPHIST_PINNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 常驻开关（cliphist_set_pinned 命令入口）
pub fn set_window_pinned(pinned: bool) {
    CLIPHIST_PINNED.store(pinned, Ordering::SeqCst);
}

/// 诊断快照读取（cliphist_debug_state 命令）：状态位直读
pub fn debug_open() -> bool {
    CLIPHIST_OPEN.load(Ordering::SeqCst)
}
pub fn debug_pinned() -> bool {
    CLIPHIST_PINNED.load(Ordering::SeqCst)
}
pub fn debug_summoned_at() -> i64 {
    CLIPHIST_SUMMONED_AT.load(Ordering::SeqCst)
}

/// 浮窗最大化（2026-10-31 顶栏窗口钮）：手动撑满所在显示器工作区方案，
/// 不用 tauri maximize——与停靠位（park）的 set_position 互作不可控
static CLIPHIST_MAXED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 最大化前的窗口矩形（还原用；关窗即清）
static CLIPHIST_RESTORE: Mutex<Option<(PhysicalPosition<i32>, u32, u32)>> = Mutex::new(None);

/// 最大化/还原（cliphist_set_maximized 命令入口，幂等）
pub fn set_window_maximized(app: &AppHandle, maximized: bool) -> Result<(), String> {
    let Some(w) = app.get_webview_window("cliphist") else {
        return Ok(());
    };
    if maximized {
        if CLIPHIST_MAXED.load(Ordering::SeqCst) {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use windows::Win32::Graphics::Gdi::{
                GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
            };
            let Ok(hwnd) = w.hwnd() else { return Ok(()) };
            let hmon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
            let mut mi = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if !unsafe { GetMonitorInfoW(hmon, &mut mi) }.as_bool() {
                return Ok(());
            }
            // 记录放大前矩形 → 撑满工作区（rcWork 不含任务栏）
            let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else {
                return Ok(());
            };
            *CLIPHIST_RESTORE.lock().unwrap_or_else(|p| p.into_inner()) =
                Some((pos, size.width, size.height));
            let r = mi.rcWork;
            let _ = w.set_position(PhysicalPosition::new(r.left, r.top));
            let _ = w.set_size(tauri::PhysicalSize::new(
                (r.right - r.left) as u32,
                (r.bottom - r.top) as u32,
            ));
            // 撑满态锁边缘拖拽（拖边只会得到怪异中间尺寸）
            let _ = w.set_resizable(false);
            CLIPHIST_MAXED.store(true, Ordering::SeqCst);
        }
    } else {
        if !CLIPHIST_MAXED.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        if let Some((pos, ww, hh)) = CLIPHIST_RESTORE
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            let _ = w.set_position(pos);
            let _ = w.set_size(tauri::PhysicalSize::new(ww, hh));
        }
        let _ = w.set_resizable(true);
    }
    Ok(())
}

/// 浮窗尺寸下限（逻辑 px）：类型分段/搜索框最低可用宽度；上限防拖出天际
const WIN_MIN_W: f64 = 360.0;
const WIN_MIN_H: f64 = 300.0;
const WIN_MAX_W: f64 = 1200.0;
const WIN_MAX_H: f64 = 1500.0;

/// 读回持久化的浮窗尺寸（settings.json cliphistWinW/H，逻辑 px；缺省/越界
/// 回默认 460×540）——边缘拖拽调宽高后跨会话保持（2026-10-31）
fn persisted_win_size() -> (f64, f64) {
    let read = |k: &str| -> Option<f64> {
        std::fs::read_to_string(crate::config::config_root().join("settings.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get(k).and_then(|x| x.as_f64()))
    };
    let w = read("cliphistWinW").unwrap_or(WIN_W as f64);
    let h = read("cliphistWinH").unwrap_or(WIN_H as f64);
    (w.clamp(WIN_MIN_W, WIN_MAX_W), h.clamp(WIN_MIN_H, WIN_MAX_H))
}

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
    let (win_w, win_h) = persisted_win_size();
    let win = tauri::WebviewWindowBuilder::new(
        app,
        "cliphist",
        tauri::WebviewUrl::App("clipboard.html".into()),
    )
    .additional_browser_args(crate::commands::shot::WEBVIEW_BROWSER_ARGS)
    .title("X-Dir 剪贴板")
    .inner_size(win_w, win_h)
    .decorations(false)
    // 边缘拖拽调宽高（2026-10-31 用户需求）：页面 resize 防抖持久化到
    // settings.json（cliphistWinW/H），建窗读回；最大化态临时锁
    .resizable(true)
    .min_inner_size(WIN_MIN_W, WIN_MIN_H)
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
    // 失焦自动收（Ditto 惯例；置顶常驻时豁免）；Destroyed 复位开关
    let app2 = app.clone();
    win.on_window_event(move |e| match e {
        tauri::WindowEvent::Focused(false) => {
            // 光标仍在窗内 = 用户正与浮窗交互：拖拽区原生拖拽会让窗口在
            // 拖拽中「伪失焦」（点顶栏移动浮窗即触发）——不收，交给焦点
            // 看门狗在光标真正离开窗后兜底（同口径：前台非本窗 + 光标窗外）
            #[cfg(windows)]
            {
                use windows::Win32::Foundation::POINT;
                use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
                let mut pt = POINT::default();
                if unsafe { GetCursorPos(&mut pt) }.is_ok()
                    && app2.get_webview_window("cliphist").is_some_and(|w| {
                        let (Ok(pos), Ok(sz)) = (w.outer_position(), w.outer_size()) else {
                            return false;
                        };
                        pt.x >= pos.x
                            && pt.y >= pos.y
                            && pt.x < pos.x + sz.width as i32
                            && pt.y < pos.y + sz.height as i32
                    })
                {
                    return;
                }
            }
            if CLIPHIST_OPEN.load(Ordering::SeqCst) && !CLIPHIST_PINNED.load(Ordering::SeqCst) {
                close_clip_window(&app2);
            }
        }
        tauri::WindowEvent::Destroyed => {
            CLIPHIST_OPEN.store(false, Ordering::SeqCst);
        }
        _ => {}
    });
    // 焦点看门狗（2026-11-12 用户反馈「点顶栏空白后点外部不再自动收」）：
    // 顶栏拖拽区的原生拖拽会让 WebView2 焦点状态错乱——浮窗可见但前台已易主，
    // Focused(false) 永不触发 = 永不自动收（既有注释记录过的失败模式）。
    // 每 400ms 比对：呼出超宽限 1.2s → 前台已非本窗 → 光标也不在窗内 →
    // 收窗。**gating = 呼出时刻 + 宽限，不吃 Focused(true) 置位**——实测
    // set_focus 已使窗口持前台时无焦点切换发生、Focused(true) 不回调，
    // 以事件置位 gating 会永久 disarm。光标悬窗内 = 用户交互中不收
    #[cfg(windows)]
    {
        let app_wd = app.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(400));
                if !CLIPHIST_OPEN.load(Ordering::SeqCst) || CLIPHIST_PINNED.load(Ordering::SeqCst) {
                    continue;
                }
                let since = now_ms() - CLIPHIST_SUMMONED_AT.load(Ordering::SeqCst);
                if since < 1200 {
                    continue;
                }
                let Some(w) = app_wd.get_webview_window("cliphist") else {
                    continue;
                };
                use windows::Win32::Foundation::POINT;
                use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow};
                let Ok(h) = w.hwnd() else {
                    continue;
                };
                if unsafe { GetForegroundWindow() } == h {
                    continue;
                }
                let mut pt = POINT::default();
                if unsafe { GetCursorPos(&mut pt) }.is_ok()
                    && let (Ok(pos), Ok(sz)) = (w.outer_position(), w.outer_size())
                {
                    let in_win = pt.x >= pos.x
                        && pt.y >= pos.y
                        && pt.x < pos.x + sz.width as i32
                        && pt.y < pos.y + sz.height as i32;
                    // 光标悬在浮窗内 = 用户仍在交互（点击/拖拽中），等它真正离开
                    if in_win {
                        continue;
                    }
                }
                close_clip_window(&app_wd);
            }
        });
    }
    Ok(())
}

/// 收浮窗：停靠屏幕外（不销毁、不 SW_HIDE），复位开关。停靠的窗口仍持有
/// 系统焦点——必须把焦点还给呼出前的窗口（paste_target），否则 Esc 关闭后
/// 键盘输入会落进看不见的窗口里（2026-10-31 E2E 实测）；用户主动点了别的
/// 窗口时焦点已不在本进程，SetForegroundWindow 会被系统拒绝，无副作用。
/// 焦点归还延迟 200ms（2026-11-06 修复「快关快开浮窗无焦点不自动收」）：
/// 立即归还会把前台权限转让给目标窗口，随后的重开受 Windows 前台锁定
/// 拒绝 set_focus——浮窗显示着却无焦点，点击别处也不发失焦事件 = 永不
/// 自动收；延迟窗内若已重开（CLIPHIST_OPEN 回 true）则跳过归还，前台
/// 链从未断裂，重开聚焦稳定成功
pub(crate) fn close_clip_window(app: &AppHandle) {
    park_clip_window(app);
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
        let state = app.state::<AppState>();
        let raw = state.cliphist.paste_target.load(Ordering::SeqCst);
        if raw != 0 && unsafe { IsWindow(Some(HWND(raw as *mut std::ffi::c_void))) }.as_bool() {
            // HWND 指针值跨线程传递：Send 由裸值承担（Win32 HWND 是纯句柄值）
            struct SendHwnd(pub isize);
            unsafe impl Send for SendHwnd {}
            let target = SendHwnd(raw);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(200));
                // 重开即取消归还（前台权限留给浮窗自己）
                if !CLIPHIST_OPEN.load(Ordering::SeqCst) {
                    let _ = unsafe { SetForegroundWindow(HWND(target.0 as *mut std::ffi::c_void)) };
                }
            });
        }
    }
}

/// 仅收浮窗（停靠 + 状态复位），不做焦点归还——供「跳主窗」类路径使用：
/// 若先归还 paste_target，会抢在主窗聚焦之后把前台夺走，设置面板开了
/// 却压在别的窗口后面（2026-10-31 用户实测「直达失败」根因）
pub(crate) fn park_clip_window(app: &AppHandle) {
    CLIPHIST_OPEN.store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("cliphist") {
        // 最大化态关窗：复位默认尺寸（停靠位只挪位置，不还原尺寸——不复位
        // 的话下次呼出仍是撑满态）
        if CLIPHIST_MAXED.swap(false, Ordering::SeqCst) {
            *CLIPHIST_RESTORE.lock().unwrap_or_else(|p| p.into_inner()) = None;
            let _ = w.set_size(tauri::LogicalSize::new(WIN_W as f64, WIN_H as f64));
            let _ = w.set_resizable(true);
        }
        let _ = w.set_position(park_position());
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
            // 实际窗口尺寸（用户可拖边调整，不再恒为默认值）
            let sz = w.inner_size().unwrap_or_default();
            let (pw, ph) = (sz.width as i32, sz.height as i32);
            let x = mon.x + (mon.w as i32 - pw).max(0) / 2;
            let y = mon.y + (mon.h as i32 - ph).max(0) * 2 / 5;
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
        // 记录呼出时刻（看门狗宽限基准，先于 show/set_focus）
        CLIPHIST_SUMMONED_AT.store(now_ms(), Ordering::SeqCst);
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
        "text" | "link" | "path" => {
            let t = item.text.clone().unwrap_or_default();
            // 富文本保真回写（T3-1）：有 HTML 片段时双格式（CF_UNICODETEXT +
            // HTML Format），富文本目标保留格式、纯文本目标仍读文本
            match item.html.as_deref().filter(|h| !h.is_empty()) {
                Some(h) => crate::clip::set_text_and_html(&t, h)?,
                None => crate::clip::set_text(&t)?,
            }
        }
        "files" | "dirs" => {
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
        // 置顶常驻态不关窗（连续取用多条）；直接粘贴路径仅在非常驻态请求
        if !CLIPHIST_PINNED.load(Ordering::SeqCst) {
            close_clip_window(app);
        }
        return Ok(true);
    }
    Ok(paste_and_close(app, h))
}

/// PNG 字节 → data URL（T2-1 图片放大预览用）。独立纯函数供 test
pub fn png_data_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// 图片 OCR 取字（T2-4）：Windows.Media.Ocr（系统组件零新依赖，中文系统
/// 即中文引擎）→ 识别文本写回剪贴板（不设自写 guard——识别结果作为新文本
/// 条目自然入库，可搜索可再粘贴）。识别文本返回供前端回执。
/// 取字节与识别拆成两段（2026-11-01 响应速度）：OCR 是秒级重活，命令层
/// 把 ocr_png 放 blocking 线程——旧同步命令整段在主线程跑，期间全部窗口
/// 冻住
pub fn image_png_bytes(h: &ClipHistState, id: i64) -> Result<Vec<u8>, String> {
    let conn = h.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.query_row(
        "SELECT image FROM clip_items WHERE id = ?1 AND kind = 'image'",
        [id],
        |r| r.get::<_, Option<Vec<u8>>>(0),
    )
    .map_err(|_| "图片条目不存在".to_string())?
    .ok_or("该条目没有原图数据".to_string())
}

/// PNG 字节 → OCR 识别文本（无状态重活；识别结果写回剪贴板）
pub fn ocr_png(png: &[u8]) -> Result<String, String> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|e| format!("图片解码失败：{e}"))?;
    let rgba = img.into_rgba8();
    let (w, hh) = rgba.dimensions();
    #[cfg(windows)]
    {
        use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
        use windows::Media::Ocr::OcrEngine;
        use windows::Storage::Streams::Buffer;
        let buf = Buffer::Create(rgba.len() as u32).map_err(|e| format!("缓冲创建失败：{e}"))?;
        {
            use windows::Storage::Streams::IDataWriter;
            use windows::core::Interface;
            let writer: IDataWriter = buf
                .cast()
                .map_err(|e| format!("DataWriter 获取失败：{e}"))?;
            let _ = writer.WriteBytes(&rgba);
            let flush = writer
                .FlushAsync()
                .map_err(|e| format!("FlushAsync 失败：{e}"))?;
            let _ = tauri::async_runtime::block_on(std::future::IntoFuture::into_future(flush));
            writer
                .DetachBuffer()
                .map_err(|e| format!("DetachBuffer 失败：{e}"))?;
        }
        let sb = SoftwareBitmap::CreateCopyFromBuffer(
            &buf,
            BitmapPixelFormat::Rgba8,
            w as i32,
            hh as i32,
        )
        .map_err(|e| format!("位图构建失败：{e}"))?;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| "系统无可用的 OCR 引擎（设置 → 语言 添加中文/英文语言包）".to_string())?;
        let recognize = engine
            .RecognizeAsync(&sb)
            .map_err(|e| format!("OCR 启动失败：{e}"))?;
        let result =
            tauri::async_runtime::block_on(std::future::IntoFuture::into_future(recognize))
                .map_err(|e| format!("OCR 识别失败：{e}"))?;
        let text = result
            .Text()
            .map_err(|e| format!("取识别文本失败：{e}"))?
            .to_string();
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("未识别出文字".into());
        }
        crate::clip::set_text(&text)?;
        Ok(text)
    }
    #[cfg(not(windows))]
    {
        let _ = (w, hh);
        Err("OCR 仅 Windows 支持".into())
    }
}

/// 取图片条目原图 dataURL（T2-1 预览放大）
pub fn get_image_data_url(h: &ClipHistState, id: i64) -> Result<String, String> {
    let conn = h.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.query_row(
        "SELECT image FROM clip_items WHERE id = ?1 AND kind = 'image'",
        [id],
        |r| r.get::<_, Option<Vec<u8>>>(0),
    )
    .map_err(|_| "图片条目不存在".to_string())?
    .map(|b| png_data_url(&b))
    .ok_or_else(|| "该条目没有原图数据".to_string())
}

/// 备份条目行（T3-3 导出格式，JSON 序列化；image 为 base64）
#[derive(serde::Serialize, serde::Deserialize)]
pub struct BackupItem {
    pub kind: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub preview: Option<String>,
    pub image: Option<String>,
    pub files: Option<String>,
    pub file_cut: i64,
    pub size: i64,
    pub pinned: bool,
    pub fav: bool,
    pub created_at: i64,
    pub source: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Backup {
    pub app: String,
    pub version: u32,
    pub items: Vec<BackupItem>,
}

/// 导出全部条目为 Backup 结构（T3-3；纯函数供 test 往返）
pub fn export_backup(conn: &Connection) -> rusqlite::Result<Backup> {
    use base64::Engine as _;
    let mut stmt = conn.prepare(
        "SELECT kind, text, html, preview, image, files, file_cut, size, pinned, fav,
                created_at, source FROM clip_items ORDER BY id",
    )?;
    let items = stmt
        .query_map([], |r| {
            Ok(BackupItem {
                kind: r.get(0)?,
                text: r.get(1)?,
                html: r.get(2)?,
                preview: r.get(3)?,
                image: r
                    .get::<_, Option<Vec<u8>>>(4)?
                    .map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                files: r.get(5)?,
                file_cut: r.get(6)?,
                size: r.get(7)?,
                pinned: r.get::<_, i64>(8)? != 0,
                fav: r.get::<_, i64>(9)? != 0,
                created_at: r.get(10)?,
                source: r.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Backup {
        app: "x-dir".into(),
        version: 1,
        items,
    })
}

/// 导入备份（T3-3）：逐条 INSERT（hash 重算；image base64 还原；与现存
/// 重复的行由调用方接受的插入语义处理——保留双份，用户自行清理）。
/// 返回导入条数
pub fn import_backup(conn: &Connection, backup: &Backup) -> rusqlite::Result<usize> {
    use base64::Engine as _;
    let mut n = 0usize;
    for it in &backup.items {
        let image = it
            .image
            .as_ref()
            .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
        let hash_src = it.text.clone().unwrap_or_default();
        let hash = sha256_hex(&hash_src);
        conn.execute(
            "INSERT INTO clip_items
               (kind, hash, text, html, preview, image, files, file_cut, py, source, fav,
                size, pinned, created_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, ?12, ?13, ?13)",
            rusqlite::params![
                it.kind,
                hash,
                it.text,
                it.html,
                it.preview,
                image,
                it.files,
                it.file_cut,
                it.source,
                it.fav as i64,
                it.size,
                it.pinned as i64,
                it.created_at
            ],
        )?;
        n += 1;
    }
    Ok(n)
}

/// 多条文本合并（T1-4）：按调用方给定顺序（列表可见序）取 text/link/path
/// 三类条目的全文，换行连接；无可合并条目 = None。独立纯函数供 test。
/// 按 ids 精确取行（2026-11-01 优化：旧实现全表载入三类条目——容量上限
/// 10000 × 单条 1MiB 文本的极端库会把无关节点全部读进内存）
pub fn merge_texts(conn: &Connection, ids: &[i64]) -> Option<String> {
    if ids.is_empty() {
        return None;
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT id, text FROM clip_items
         WHERE kind IN ('text','link','path') AND id IN ({placeholders})"
    );
    let mut by_id = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare(&sql)
        && let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
        })
    {
        for row in rows.flatten() {
            by_id.insert(row.0, row.1);
        }
    }
    let parts: Vec<String> = ids
        .iter()
        .filter_map(|id| by_id.get(id).cloned().flatten())
        .filter(|t| !t.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// 合并粘贴执行体（T1-4）：合并 → 写回剪贴板 →（可选）直接粘贴；选中集合
/// 由前端维护，ids 即列表可见序。返回 pasted（直接粘贴是否成功）
pub fn merge_paste(
    app: &AppHandle,
    h: &ClipHistState,
    ids: &[i64],
    paste: bool,
) -> Result<bool, String> {
    let merged = {
        let conn = h.conn.lock().unwrap_or_else(|p| p.into_inner());
        merge_texts(&conn, ids)
    }
    .ok_or("没有可合并的文本条目（仅文本/链接/路径参与）")?;
    // guard 先于写入登记（合并文本是新内容，正常不会被回环吞掉）
    *h.self_write.lock().unwrap_or_else(|p| p.into_inner()) =
        Some((sha256_hex(&merged), Instant::now()));
    crate::clip::set_text(&merged)?;
    if !paste {
        if !CLIPHIST_PINNED.load(Ordering::SeqCst) {
            close_clip_window(app);
        }
        return Ok(true);
    }
    #[cfg(windows)]
    {
        Ok(paste_and_close(app, h))
    }
    #[cfg(not(windows))]
    {
        close_clip_window(app);
        Ok(false)
    }
}

fn sha256_hex(t: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(*b"T");
    h.update(t.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
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
    fn ingest_marks_link_and_path_kind() {
        let c = mem_db();
        // 链接：http(s)/ftp/www 单行无空白
        ingest(&c, &text("https://gitee.com/wwc9/x-dir"), 1, None, None).unwrap();
        ingest(&c, &text("www.baidu.com"), 2, None, None).unwrap();
        // 带空格的句子长得像 URL 也不判链接
        ingest(
            &c,
            &text("https://example.com 这是一段说明文字"),
            3,
            None,
            None,
        )
        .unwrap();
        // 路径：盘符样式且存在（用临时目录保证存在）
        let base = std::env::temp_dir().join("xdir_cliphist_path");
        let _ = std::fs::create_dir_all(&base);
        ingest(&c, &text(&base.to_string_lossy()), 4, None, None).unwrap();
        // 盘符样式但不存在 → 纯文本
        ingest(&c, &text(r"Q:\肯定不存在的盘\文件.txt"), 5, None, None).unwrap();
        let kinds: Vec<String> = c
            .prepare("SELECT kind FROM clip_items ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(kinds, vec!["link", "link", "text", "path", "text"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ingest_marks_dirs_kind() {
        let c = mem_db();
        let base = std::env::temp_dir().join("xdir_cliphist_dirs");
        let _ = std::fs::create_dir_all(&base);
        // 纯目录列表 → dirs（Explorer 复制文件夹的常态）
        ingest(
            &c,
            &ClipContent::Files {
                paths: vec![base.to_string_lossy().into_owned()],
                cut: false,
            },
            1,
            None,
            None,
        )
        .unwrap();
        // 目录 + 文件混合 → files
        let f = base.join("a.txt");
        std::fs::write(&f, b"x").unwrap();
        ingest(
            &c,
            &ClipContent::Files {
                paths: vec![
                    base.to_string_lossy().into_owned(),
                    f.to_string_lossy().into_owned(),
                ],
                cut: false,
            },
            2,
            None,
            None,
        )
        .unwrap();
        let kinds: Vec<String> = c
            .prepare("SELECT kind FROM clip_items ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(kinds, vec!["dirs", "files"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn sensitive_patterns_hit_and_benign_pass() {
        // 命中：PEM / AWS / JWT / GitHub / Slack / Google
        assert!(is_sensitive(
            "-----BEGIN RSA PRIVATE KEY-----
MIIE...
-----END-----"
        ));
        assert!(is_sensitive("AKIAIOSFODNN7EXAMPLE"));
        assert!(is_sensitive(
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4"
        ));
        assert!(is_sensitive(
            "token ghp_16C7e42F292c6912E7710c838347Ae178B4a"
        ));
        assert!(is_sensitive("xoxb-1234567890abcdefAB"));
        assert!(is_sensitive(
            "key = AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7"
        ));
        // 放行：日常文本（含长得像但长度/结构不符的）
        assert!(!is_sensitive("会议要点：AKIA 是亚马逊的缩写"));
        assert!(!is_sensitive("普通文本，没有任何凭据 eyJ 短段"));
        assert!(!is_sensitive("https://github.com/wwc9/x-dir"));
    }

    #[test]
    fn app_excluded_matches_names() {
        assert!(app_excluded("keepass.exe, 1password.exe", "KeePass.exe"));
        assert!(app_excluded("keepass;EXCEL", "excel.exe"));
        assert!(app_excluded("微信", "微信.exe"));
        assert!(!app_excluded("keepass.exe", "explorer.exe"));
        assert!(!app_excluded("", "anything.exe"));
        assert!(!app_excluded("keepass.exe", ""));
    }

    #[test]
    fn pinyin_initials_search() {
        let c = mem_db();
        ingest(&c, &text("季度审计报告要点"), 1000, None, None).unwrap();
        ingest(&c, &text("hello world"), 2000, None, None).unwrap();
        // 入库即计算首字母（含汉字才有值）
        let py: Option<String> = c
            .query_row(
                "SELECT py FROM clip_items WHERE preview LIKE '%审计%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(py.as_deref().is_some_and(|p| p.contains("sjbg")));
        // 首字母命中："sj" 找到「季度审计…」
        let p = list_page(&c, "sj", "", 0, 50).unwrap();
        assert_eq!(p.items.len(), 1);
        assert!(p.items[0].preview.contains("审计"));
        // 全文与英文查询不受影响
        assert_eq!(list_page(&c, "审计", "", 0, 50).unwrap().items.len(), 1);
        assert_eq!(list_page(&c, "hello", "", 0, 50).unwrap().items.len(), 1);
        assert_eq!(list_page(&c, "zzz", "", 0, 50).unwrap().items.len(), 0);
    }

    #[test]
    fn png_data_url_format() {
        let url = png_data_url(&[1, 2, 3]);
        assert!(url.starts_with("data:image/png;base64,"));
        // base64(1,2,3) = AQID
        assert!(url.ends_with("AQID"));
    }

    #[test]
    fn source_stored_and_searchable() {
        let c = mem_db();
        ingest(&c, &text("报表数据"), 1000, Some("excel.exe"), None).unwrap();
        ingest(&c, &text("plain"), 2000, None, None).unwrap();
        // 存取：返回给前端
        let p = list_page(&c, "", "", 0, 50).unwrap();
        assert_eq!(p.items[1].source.as_deref(), Some("excel.exe"));
        assert_eq!(p.items[0].source, None);
        // 搜索命中 source：敲 excel 找到从 Excel 复制的条目
        assert_eq!(list_page(&c, "excel", "", 0, 50).unwrap().items.len(), 1);
    }

    #[test]
    fn favorite_exempts_cleanup_and_filters() {
        let c = mem_db();
        for i in 0..3 {
            ingest(&c, &text(&format!("f{i}")), 1000 + i, None, None).unwrap();
        }
        // 收藏 f0（最旧）：容量 1 也不删它；f1 被清
        c.execute("UPDATE clip_items SET fav = 1 WHERE preview = 'f0'", [])
            .unwrap();
        cleanup(&c, 1, 0, 5000).unwrap();
        let left: Vec<String> = c
            .prepare("SELECT preview FROM clip_items ORDER BY created_at")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(left, vec!["f0", "f2"]);
        // 过滤档 'fav'：只列收藏
        let p = list_page(&c, "", "fav", 0, 50).unwrap();
        assert_eq!(p.items.len(), 1);
        assert!(p.items[0].fav);
        // 排序：fav 最前
        let all = list_page(&c, "", "", 0, 50).unwrap();
        assert_eq!(all.items[0].preview, "f0");
    }

    #[test]
    fn merge_texts_filters_kinds_and_keeps_order() {
        let c = mem_db();
        ingest(&c, &text("第一条"), 1000, None, None).unwrap();
        ingest(
            &c,
            &ClipContent::Files {
                paths: vec![r"C:\b.png".into()],
                cut: false,
            },
            1100,
            None,
            None,
        )
        .unwrap();
        ingest(
            &c,
            &ClipContent::Image {
                w: 2,
                h: 2,
                rgba: vec![0; 16],
            },
            1200,
            None,
            None,
        )
        .unwrap();
        ingest(&c, &text("第二条"), 1300, None, None).unwrap();
        let ids: Vec<i64> = c
            .prepare("SELECT id FROM clip_items ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        // 指定倒序 [第二条, 图片, 文件, 第一条]：非文本类被滤除、顺序保持
        let mut order = ids.clone();
        order.reverse();
        assert_eq!(
            merge_texts(&c, &order).as_deref(),
            Some(
                "第二条
第一条"
            )
        );
        // 仅非文本 id = None
        assert_eq!(merge_texts(&c, &[ids[1], ids[2]]), None);
    }

    #[test]
    fn ingest_dedup_promotes() {
        let c = mem_db();
        ingest(&c, &text("hello"), 1000, None, None).unwrap();
        ingest(&c, &text("world"), 2000, None, None).unwrap();
        // 同 hash 二次复制 → 不新增，created_at 置顶
        ingest(&c, &text("hello"), 3000, None, None).unwrap();
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
        assert!(ingest(&c, &ClipContent::Image { w, h, rgba }, 1, None, None).unwrap());
        let (img, thumb): (Option<Vec<u8>>, Option<Vec<u8>>) = c
            .query_row("SELECT image, thumb FROM clip_items", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let img = img.expect("原图入库");
        let decoded = image::load_from_memory_with_format(&img, image::ImageFormat::Png).unwrap();
        assert_eq!(decoded.dimensions(), (w, h));
        // 不透明缩略编 JPEG（体积小一个量级），解码按内容嗅探不受格式影响
        let t = thumb.expect("缩略图入库");
        assert_eq!(&t[..2], &[0xFF, 0xD8], "不透明缩略应为 JPEG");
        let dt = image::load_from_memory(&t).unwrap();
        assert!(dt.width() <= THUMB_EDGE && dt.height() <= THUMB_EDGE);
    }

    #[test]
    fn thumb_with_transparent_pixels_stays_png() {
        let c = mem_db();
        let (w, h) = (2u32, 3u32);
        // 任一像素带透明 → 缩略保 PNG（dataURL mime 同步为 image/png）
        let mut rgba = vec![255u8; (w * h * 4) as usize];
        rgba[3] = 0;
        assert!(ingest(&c, &ClipContent::Image { w, h, rgba }, 1, None, None).unwrap());
        let thumb: Vec<u8> = c
            .query_row("SELECT thumb FROM clip_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(&thumb[..4], &[0x89, b'P', b'N', b'G'], "透明缩略应保 PNG");
    }

    #[test]
    fn clear_recent_respects_days_and_exemptions() {
        let c = mem_db();
        let day = 86_400_000i64;
        let now = 30 * day;
        assert!(ingest(&c, &text("old"), now - 4 * day, None, None).unwrap());
        assert!(ingest(&c, &text("mid"), now - 2 * day, None, None).unwrap());
        assert!(ingest(&c, &text("new"), now, None, None).unwrap());
        assert!(ingest(&c, &text("pinned"), now - 2 * day, None, None).unwrap());
        assert!(ingest(&c, &text("fav"), now - 2 * day, None, None).unwrap());
        c.execute(
            "UPDATE clip_items SET pinned = 1 WHERE preview = 'pinned'",
            [],
        )
        .unwrap();
        c.execute("UPDATE clip_items SET fav = 1 WHERE preview = 'fav'", [])
            .unwrap();
        // 清最近 3 天：删 mid/new，old（过期不触及）/pinned/fav（豁免）保留
        assert_eq!(clear_recent(&c, 3, now).unwrap(), 2);
        let left: Vec<String> = c
            .prepare("SELECT preview FROM clip_items ORDER BY preview")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(left, vec!["fav", "old", "pinned"]);
        // days = 0：清空全部非置顶/收藏
        assert_eq!(clear_recent(&c, 0, now).unwrap(), 1);
        let left: Vec<String> = c
            .prepare("SELECT preview FROM clip_items ORDER BY preview")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(left, vec!["fav", "pinned"]);
    }

    #[test]
    fn cleanup_respects_capacity_days_and_pin() {
        let c = mem_db();
        for i in 0..5 {
            ingest(&c, &text(&format!("item{i}")), 1000 + i, None, None).unwrap();
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
            ingest(&c, &text(&format!("alpha {i}")), 1000 + i, None, None).unwrap();
        }
        ingest(
            &c,
            &ClipContent::Files {
                paths: vec!["C:\\b.png".into()],
                cut: false,
            },
            2000,
            None,
            None,
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
        // 置顶排前（2026-10-31）：pin 住最旧的 alpha 3 → 跳到列表首位
        c.execute(
            "UPDATE clip_items SET pinned = 1 WHERE preview = 'alpha 3'",
            [],
        )
        .unwrap();
        let pp = list_page(&c, "", "", 0, 50).unwrap();
        assert_eq!(pp.items[0].preview, "alpha 3");
        assert!(pp.items[0].pinned);
        assert_eq!(pp.items[1].preview, "b.png");
    }
}
