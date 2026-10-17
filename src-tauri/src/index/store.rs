//! 索引文件存取：紧凑定长布局（header + frn 升序条目 + 双 arena），tmp+rename 原子写；
//! 主程序经 [`IndexView`] mmap 只读查询——读侧以 FILE_SHARE_DELETE 打开，与守护进程
//! "写临时文件再 rename 覆盖"共存，旧映射在查询窗口内保持有效。

use std::io;
use std::path::{Path, PathBuf};

use super::table::{ENTRY_SIZE, EntryRec, FLAG_DIR};

pub const MAGIC: [u8; 8] = *b"XDIRIDX\x01";
/// v3：EntryRec 增 py_mask（全拼通道预筛）+ init 首字母 arena 段（首字母查询免 DP）。
/// 升版使旧 .idx 判废，守护进程 load_or_build 打开失败即全量重建（一次性）。
pub const FORMAT_VERSION: u32 = 3;

/// 文件头（repr(C) 定长；读侧校验 magic/version/总长后才按切片解读）
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Header {
    pub magic: [u8; 8],
    pub version: u32,
    pub header_len: u32,
    pub entry_count: u32,
    /// 原文 arena 长度（u16 单位）
    pub names_len: u32,
    /// 小写 arena 长度（u16 单位）
    pub lower_len: u32,
    /// 拼音首字母 arena 长度（u8 单位）
    pub initials_len: u32,
    pub volume_serial: u64,
    pub journal_id: u64,
    pub next_usn: u64,
    pub root_frn: u64,
    pub drive_letter: u8,
    pub _pad: [u8; 7],
    pub built_at_ms: u64,
}

/// 守护进程保存时随表写入的卷元数据
#[derive(Clone, Copy, Debug)]
pub struct VolumeMeta {
    pub volume_serial: u64,
    pub journal_id: u64,
    pub next_usn: u64,
}

pub fn index_path(dir: &Path, letter: u8) -> PathBuf {
    dir.join(format!("{}.idx", letter as char))
}

/// 原子写：compacted 四段 + 卷元数据 → `{letter}.idx.tmp` → rename 覆盖
pub fn save(
    dir: &Path,
    letter: u8,
    table: &super::table::NameTable,
    meta: VolumeMeta,
) -> io::Result<()> {
    let (entries, names, lower, initials) = table.compacted();
    let header = Header {
        magic: MAGIC,
        version: FORMAT_VERSION,
        header_len: std::mem::size_of::<Header>() as u32,
        entry_count: entries.len() as u32,
        names_len: names.len() as u32,
        lower_len: lower.len() as u32,
        initials_len: initials.len() as u32,
        volume_serial: meta.volume_serial,
        journal_id: meta.journal_id,
        next_usn: meta.next_usn,
        root_frn: table.root_frn,
        drive_letter: letter,
        _pad: [0; 7],
        built_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    std::fs::create_dir_all(dir)?;
    let path = index_path(dir, letter);
    let tmp = dir.join(format!("{}.idx.tmp", letter as char));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(header_bytes(&header))?;
        // 条目段：repr(C) 定长记录按原始字节落盘（x64 同端序；版本守护）
        let eb = unsafe {
            std::slice::from_raw_parts(entries.as_ptr() as *const u8, entries.len() * ENTRY_SIZE)
        };
        f.write_all(eb)?;
        f.write_all(u16_bytes(&names))?;
        f.write_all(u16_bytes(&lower))?;
        f.write_all(&initials)?;
        f.sync_data().ok();
    }
    // 读侧（主程序 mmap）以 FILE_SHARE_DELETE 打开，rename 覆盖不冲突
    std::fs::rename(&tmp, &path)
}

fn header_bytes(h: &Header) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(
            h as *const Header as *const u8,
            std::mem::size_of::<Header>(),
        )
    }
}

fn u16_bytes(v: &[u16]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 2) }
}

/// mmap 只读视图：open 时完成全部布局校验，此后切片访问零拷贝、零分配
pub struct IndexView {
    mmap: memmap2::Mmap,
    pub header: Header,
}

impl IndexView {
    pub fn open(path: &Path) -> io::Result<IndexView> {
        use std::os::windows::fs::OpenOptionsExt;
        // 0x7 = READ|WRITE|DELETE 共享：守护进程可 rename 覆盖本文件
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x7)
            .open(path)?;
        let mmap = unsafe { memmap2::Mmap::map(&file)? };
        let hlen = std::mem::size_of::<Header>();
        if mmap.len() < hlen {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "索引文件过短"));
        }
        let header: Header = unsafe { std::ptr::read_unaligned(mmap.as_ptr() as *const Header) };
        let expect = hlen
            + header.entry_count as usize * ENTRY_SIZE
            + (header.names_len as usize + header.lower_len as usize) * 2
            + header.initials_len as usize;
        if header.magic != MAGIC
            || header.version != FORMAT_VERSION
            || header.header_len as usize != hlen
            || mmap.len() != expect
        {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "索引格式不符"));
        }
        Ok(IndexView { mmap, header })
    }

    /// 把映射页同步预取进内存（启动预热用；页面进系统文件缓存，可被回收）。
    /// Windows 无 MAP_POPULATE：按页跨步触碰触发软缺页。
    pub fn prefault(&self) {
        const PAGE: usize = 4096;
        let len = self.mmap.len();
        let mut off = 0;
        while off < len {
            std::hint::black_box(self.mmap[off]);
            off += PAGE;
        }
    }

    fn sections(&self) -> (*const u8, usize) {
        (self.mmap.as_ptr(), self.mmap.len())
    }

    pub fn entries(&self) -> &[EntryRec] {
        let (base, _) = self.sections();
        unsafe {
            std::slice::from_raw_parts(
                base.add(std::mem::size_of::<Header>()) as *const EntryRec,
                self.header.entry_count as usize,
            )
        }
    }

    pub fn names(&self) -> &[u16] {
        let (base, _) = self.sections();
        unsafe {
            std::slice::from_raw_parts(
                base.add(
                    std::mem::size_of::<Header>() + self.header.entry_count as usize * ENTRY_SIZE,
                ) as *const u16,
                self.header.names_len as usize,
            )
        }
    }

    pub fn lower(&self) -> &[u16] {
        let (base, _) = self.sections();
        unsafe {
            std::slice::from_raw_parts(
                base.add(
                    std::mem::size_of::<Header>()
                        + self.header.entry_count as usize * ENTRY_SIZE
                        + self.header.names_len as usize * 2,
                ) as *const u16,
                self.header.lower_len as usize,
            )
        }
    }

    /// 拼音首字母 arena（u8；仅含汉字条目有段）
    pub fn initials(&self) -> &[u8] {
        let (base, _) = self.sections();
        unsafe {
            std::slice::from_raw_parts(
                base.add(
                    std::mem::size_of::<Header>()
                        + self.header.entry_count as usize * ENTRY_SIZE
                        + (self.header.names_len + self.header.lower_len) as usize * 2,
                ),
                self.header.initials_len as usize,
            )
        }
    }

    pub fn entry_name(&self, e: &EntryRec) -> &[u16] {
        &self.names()[e.name_off as usize..(e.name_off + e.name_len) as usize]
    }

    pub fn entry_lower(&self, e: &EntryRec) -> &[u16] {
        &self.lower()[e.lower_off as usize..(e.lower_off + e.lower_len) as usize]
    }

    /// 条目拼音首字母串（u8；无汉字条目为空切片）
    pub fn entry_initials(&self, e: &EntryRec) -> &[u8] {
        &self.initials()[e.init_off as usize..(e.init_off + e.init_len as u32) as usize]
    }

    pub fn entry_name_string(&self, e: &EntryRec) -> String {
        String::from_utf16_lossy(self.entry_name(e))
    }

    pub fn is_dir(e: &EntryRec) -> bool {
        e.flags & FLAG_DIR != 0
    }

    /// frn → 条目下标（落盘按 frn 升序，二分）
    pub fn find_by_frn(&self, frn: u64) -> Option<usize> {
        self.entries().binary_search_by_key(&frn, |e| e.frn).ok()
    }

    /// 条目完整路径（沿父 FRN 链上溯 + 二分定位；孤儿/超深链返回 None）
    pub fn path_of(&self, idx: usize) -> Option<String> {
        // FRN 高 16 位是序列号、低 48 位是 MFT 记录号；根判定必须按记录号——
        // 卷根的完整 FRN 带序列号（如 0x0005_0000_0000_0005），裸值比较永远不等于 5
        const FRN_SEQ_MASK: u64 = 0x0000_FFFF_FFFF_FFFF;
        let root_rec = self.header.root_frn & FRN_SEQ_MASK;
        let entries = self.entries();
        if idx >= entries.len() {
            return None;
        }
        let mut parts: Vec<&[u16]> = Vec::new();
        let mut cur = idx;
        let mut parent = entries[idx].parent_frn;
        loop {
            let e = &entries[cur];
            parts.push(self.entry_name(e));
            if parent & FRN_SEQ_MASK == root_rec {
                break;
            }
            let i = self.find_by_frn(parent)?;
            cur = i;
            parent = entries[i].parent_frn;
            if parts.len() > 512 {
                return None; // 链异常（防环）
            }
        }
        let head = format!("{}:\\", self.header.drive_letter as char);
        let mut out = head;
        for (i, p) in parts.iter().rev().enumerate() {
            if i > 0 {
                out.push('\\');
            }
            out.push_str(&String::from_utf16_lossy(p));
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::super::table::NameTable;
    use super::*;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("xdir-idx-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sample_table() -> NameTable {
        let mut t = NameTable::new(5);
        // frn 乱序插入，验证落盘有序 + 路径重建
        t.upsert(30, 11, "回单.pdf", false);
        t.upsert(11, 5, "客户A", true);
        t.upsert(12, 11, "报表.xlsx", false);
        t.upsert(20, 5, "底稿", true);
        t
    }

    #[test]
    fn save_open_roundtrip_and_paths() {
        let dir = tempdir("roundtrip");
        let tbl = sample_table();
        save(
            &dir,
            b'C',
            &tbl,
            VolumeMeta {
                volume_serial: 0xABCD,
                journal_id: 7,
                next_usn: 100,
            },
        )
        .unwrap();

        let view = IndexView::open(&index_path(&dir, b'C')).unwrap();
        assert_eq!(view.header.entry_count, 4);
        assert_eq!(view.header.volume_serial, 0xABCD);
        assert_eq!(view.header.journal_id, 7);
        // 落盘按 frn 升序
        let frns: Vec<u64> = view.entries().iter().map(|e| e.frn).collect();
        let mut sorted = frns.clone();
        sorted.sort_unstable();
        assert_eq!(frns, sorted);

        // 路径重建（父链上溯）
        let i11 = view.find_by_frn(11).unwrap();
        assert_eq!(view.path_of(i11).unwrap(), "C:\\客户A");
        let i30 = view.find_by_frn(30).unwrap();
        assert_eq!(view.path_of(i30).unwrap(), "C:\\客户A\\回单.pdf");
        let i20 = view.find_by_frn(20).unwrap();
        assert_eq!(view.path_of(i20).unwrap(), "C:\\底稿");
        // 孤儿（父不存在）→ None
        let mut t2 = NameTable::new(5);
        t2.upsert(99, 404, "孤儿.txt", false);
        save(
            &dir,
            b'D',
            &t2,
            VolumeMeta {
                volume_serial: 1,
                journal_id: 1,
                next_usn: 1,
            },
        )
        .unwrap();
        let v2 = IndexView::open(&index_path(&dir, b'D')).unwrap();
        assert_eq!(v2.path_of(v2.find_by_frn(99).unwrap()), None);

        // 名称/小写切片一致性
        let e30 = &view.entries()[i30];
        assert_eq!(view.entry_name_string(e30), "回单.pdf");
        let lower = String::from_utf16_lossy(view.entry_lower(e30));
        assert_eq!(lower, "回单.pdf");

        // 篡改魔数 → 拒载（先释放 mmap，否则写覆盖报 ERROR_USER_MAPPED_FILE）
        drop(view);
        drop(v2);
        let p = index_path(&dir, b'C');
        let mut bytes = std::fs::read(&p).unwrap();
        bytes[1] = b'Y'; // 'D' → 'Y'，破坏魔数
        std::fs::write(&p, &bytes).unwrap();
        assert!(IndexView::open(&p).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_rejects_truncated() {
        let dir = tempdir("trunc");
        let tbl = sample_table();
        save(
            &dir,
            b'E',
            &tbl,
            VolumeMeta {
                volume_serial: 1,
                journal_id: 1,
                next_usn: 1,
            },
        )
        .unwrap();
        let p = index_path(&dir, b'E');
        let bytes = std::fs::read(&p).unwrap();
        std::fs::write(&p, &bytes[..bytes.len() - 4]).unwrap();
        assert!(IndexView::open(&p).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
