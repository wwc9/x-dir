//! M0 内存原型：现生成结构化假数据的分页列目录命令。
//! 模拟真实负载：每条含 String 路径字段，走完整 IPC 链路（前端虚拟滚动按页拉取）。

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FakeAttrs {
    hidden: bool,
    system: bool,
    readonly: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    mtime_ms: u64,
    /// 与真实 FileEntry（fs::entry）契约对齐：TS 侧镜像声明该字段必有
    ctime_ms: u64,
    attrs: FakeAttrs,
    /// 与真实 FileEntry 契约对齐（M0 假数据无汉字，恒 None）
    py: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirPage {
    total: usize,
    entries: Vec<FileEntry>,
}

pub const FAKE_TOTAL: usize = 10_000;

fn fnv1a(path: &str) -> u64 {
    path.bytes().fold(0xcbf2_9a48_4222_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3)
    })
}

struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }
}

const EXTS: [&str; 8] = ["dat", "txt", "pdf", "jpg", "mp3", "zip", "rs", "docx"];

fn generate(path: &str) -> Vec<FileEntry> {
    let mut rng = Rng(fnv1a(path));
    let base = path.trim_end_matches('\\');
    (0..FAKE_TOTAL)
        .map(|i| {
            let is_dir = i % 10 == 0;
            let name = if is_dir {
                format!("folder_{:03}", i / 10)
            } else {
                format!(
                    "file_{:05}.{}",
                    i,
                    EXTS[rng.below(EXTS.len() as u64) as usize]
                )
            };
            FileEntry {
                path: format!("{base}\\{name}"),
                name,
                is_dir,
                size: if is_dir { 0 } else { rng.below(64 << 20) },
                mtime_ms: 1_577_836_800_000 + rng.below(220_000_000_000),
                ctime_ms: 1_577_836_800_000,
                attrs: FakeAttrs {
                    hidden: rng.below(97) == 0,
                    system: rng.below(199) == 0,
                    readonly: rng.below(13) == 0,
                },
                py: None,
            }
        })
        .collect()
}

#[tauri::command]
pub fn fake_list_dir(path: String, offset: usize, limit: usize) -> DirPage {
    let entries = generate(&path);
    let start = offset.min(entries.len());
    let end = offset.saturating_add(limit).min(entries.len());
    DirPage {
        total: entries.len(),
        entries: entries[start..end].to_vec(),
    }
}
