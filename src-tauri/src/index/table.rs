//! 索引名表（守护进程侧的可变表 + 落盘共享的定长记录）。
//!
//! 设计要点：
//! - 条目以 FRN（NTFS FileReferenceNumber）引用父节点而非下标——删除/搬移条目无需
//!   修复子项引用；落盘时按 frn 升序排列，主程序路径重建走二分。
//! - 双 arena 存名称：原文（展示）+ 小写（扫描），独立偏移（`İ` 等一对多折叠长度不同）。
//! - 守护进程内存侧另持 `by_frn` 哈希表支撑 USN 增量的 O(1) 定位；主程序侧不建表。

use std::collections::HashMap;

pub const FLAG_DIR: u8 = 1;
pub const FLAG_HANZI: u8 = 2;

/// 定长条目记录（repr(C) 与落盘布局一致；x64 同端序同宽，格式版本守护演进）。
/// v3 布局：py_mask（全拼通道预筛）+ init 首字母 arena 段——首字母查询免 DP 直接 contains。
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct EntryRec {
    pub frn: u64,
    pub parent_frn: u64,
    /// 原文 arena 偏移（u16 单位）
    pub name_off: u32,
    pub name_len: u32,
    /// 小写 arena 偏移（u16 单位）
    pub lower_off: u32,
    pub lower_len: u32,
    /// 拼音字母集掩码（`fs::search::pinyin_letter_mask`；0 = 无汉字，全拼通道跳过）
    pub py_mask: u32,
    /// 首字母 arena 偏移（u8 单位；`fs::search::pinyin_initials`，含汉字条目才写）
    pub init_off: u32,
    /// 首字母串长度（u8 单位；0 = 无汉字）
    pub init_len: u16,
    pub flags: u8,
    pub _pad: [u8; 1],
}

pub const ENTRY_SIZE: usize = std::mem::size_of::<EntryRec>();

/// 守护进程内存侧名表：可变条目 + 追加式 arena + FRN 索引。
/// 保存时经 [`NameTable::compacted`] 按 frn 排序并重排 arena（消除改名孤儿段）。
pub struct NameTable {
    pub entries: Vec<EntryRec>,
    pub names: Vec<u16>,
    pub names_lower: Vec<u16>,
    /// 拼音首字母 arena（u8；仅含汉字条目写段）
    pub initials: Vec<u8>,
    pub root_frn: u64,
    pub by_frn: HashMap<u64, u32>,
}

fn is_hanzi(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}')
}

impl NameTable {
    pub fn new(root_frn: u64) -> Self {
        Self {
            entries: Vec::new(),
            names: Vec::new(),
            names_lower: Vec::new(),
            initials: Vec::new(),
            root_frn,
            by_frn: HashMap::new(),
        }
    }

    /// 从落盘各段重建（守护进程续跑）：条目顺序保持（落盘已按 frn 有序），重建 FRN 索引
    pub fn from_parts(
        entries: Vec<EntryRec>,
        names: Vec<u16>,
        names_lower: Vec<u16>,
        initials: Vec<u8>,
        root_frn: u64,
    ) -> Self {
        let by_frn = entries
            .iter()
            .enumerate()
            .map(|(i, e)| (e.frn, i as u32))
            .collect();
        Self {
            entries,
            names,
            names_lower,
            initials,
            root_frn,
            by_frn,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 新增或改名（同 FRN = 原位改名：保下标与父引用，arena 追加新段，旧段待压缩回收）
    pub fn upsert(&mut self, frn: u64, parent_frn: u64, name: &str, is_dir: bool) {
        let (name_off, name_len, lower_off, lower_len, extra) = self.append_name(name);
        let flags = extra | if is_dir { FLAG_DIR } else { 0 };
        let has_hanzi = extra & FLAG_HANZI != 0;
        let py_mask = if has_hanzi {
            crate::fs::search::pinyin_letter_mask(name)
        } else {
            0
        };
        let (init_off, init_len) = if has_hanzi {
            let off = self.initials.len() as u32;
            if let Some(ini) = crate::fs::search::pinyin_initials(name) {
                self.initials.extend_from_slice(ini.as_bytes());
            }
            let len = self.initials.len() as u32 - off;
            (off, len as u16)
        } else {
            (0, 0)
        };
        if let Some(&idx) = self.by_frn.get(&frn) {
            let e = &mut self.entries[idx as usize];
            e.name_off = name_off;
            e.name_len = name_len;
            e.lower_off = lower_off;
            e.lower_len = lower_len;
            e.py_mask = py_mask;
            e.init_off = init_off;
            e.init_len = init_len;
            e.flags = flags;
            return;
        }
        let idx = self.entries.len() as u32;
        self.entries.push(EntryRec {
            frn,
            parent_frn,
            name_off,
            name_len,
            lower_off,
            lower_len,
            py_mask,
            init_off,
            init_len,
            flags,
            _pad: [0],
        });
        self.by_frn.insert(frn, idx);
    }

    /// USN 删除：swap_remove（子项以 FRN 引用父节点，无需修复）
    pub fn remove(&mut self, frn: u64) -> bool {
        let Some(&idx) = self.by_frn.get(&frn) else {
            return false;
        };
        let last = self.entries.len() - 1;
        // 末条目将被搬到 idx 处（先取再换，被删条目自身在 idx）
        let moved_frn = self.entries[last].frn;
        self.entries.swap_remove(idx as usize);
        if (idx as usize) < last {
            self.by_frn.insert(moved_frn, idx);
        }
        self.by_frn.remove(&frn);
        true
    }

    /// 保存格式：按 frn 升序 + arena 重排（去孤儿段）。返回落盘四段。
    pub fn compacted(&self) -> (Vec<EntryRec>, Vec<u16>, Vec<u16>, Vec<u8>) {
        let mut order: Vec<u32> = (0..self.entries.len() as u32).collect();
        order.sort_unstable_by_key(|&i| self.entries[i as usize].frn);
        let mut names: Vec<u16> = Vec::with_capacity(self.names.len());
        let mut lower: Vec<u16> = Vec::with_capacity(self.names_lower.len());
        let mut initials: Vec<u8> = Vec::with_capacity(self.initials.len());
        let mut out = Vec::with_capacity(self.entries.len());
        for &i in &order {
            let e = &self.entries[i as usize];
            let name_off = names.len() as u32;
            names.extend_from_slice(
                &self.names[e.name_off as usize..(e.name_off + e.name_len) as usize],
            );
            let lower_off = lower.len() as u32;
            lower.extend_from_slice(
                &self.names_lower[e.lower_off as usize..(e.lower_off + e.lower_len) as usize],
            );
            let init_off = initials.len() as u32;
            initials.extend_from_slice(
                &self.initials[e.init_off as usize..(e.init_off + e.init_len as u32) as usize],
            );
            out.push(EntryRec {
                frn: e.frn,
                parent_frn: e.parent_frn,
                name_off,
                name_len: e.name_len,
                lower_off,
                lower_len: e.lower_len,
                py_mask: e.py_mask,
                init_off,
                init_len: e.init_len,
                flags: e.flags,
                _pad: [0],
            });
        }
        (out, names, lower, initials)
    }

    fn append_name(&mut self, name: &str) -> (u32, u32, u32, u32, u8) {
        let name_off = self.names.len() as u32;
        self.names.extend(name.encode_utf16());
        let name_len = self.names.len() as u32 - name_off;
        let lower_off = self.names_lower.len() as u32;
        let mut has_hanzi = false;
        let mut buf = [0u16; 3];
        for c in name.chars() {
            if is_hanzi(c) {
                has_hanzi = true;
            }
            for lc in c.to_lowercase() {
                // char::encode_utf16 写入栈缓冲并返回已用切片（一对多折叠自动展开）
                self.names_lower
                    .extend_from_slice(lc.encode_utf16(&mut buf));
            }
        }
        let lower_len = self.names_lower.len() as u32 - lower_off;
        (
            name_off,
            name_len,
            lower_off,
            lower_len,
            if has_hanzi { FLAG_HANZI } else { 0 },
        )
    }
}

/// UTF-16 子串包含（索引扫描快路径；调用方保证 needle 非空且已小写）
pub fn contains_u16(hay: &[u16], needle: &[u16]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > hay.len() {
        return false;
    }
    hay.windows(needle.len()).any(|w| w == needle)
}

/// UTF-16 尾缀匹配（ext: 过滤快路径：小写名表上判 `.{ext}` 结尾，免解码）
pub fn ends_with_u16(hay: &[u16], needle: &[u16]) -> bool {
    hay.len() >= needle.len() && hay[hay.len() - needle.len()..] == *needle
}

/// u8 子串包含（首字母 arena 的拼音首字母通道；调用方保证 needle 已小写）
pub fn contains_u8(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > hay.len() {
        return false;
    }
    hay.windows(needle.len()).any(|w| w == needle)
}

/// 通配符模式首个 `*`/`?` 之前的字面头（用于扫描预筛；全通配返回空）
pub fn wildcard_head(pattern: &str) -> String {
    let end = pattern.find(['*', '?']).unwrap_or(pattern.len());
    pattern[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tbl() -> NameTable {
        let mut t = NameTable::new(5); // 根 FRN = 5
        t.upsert(11, 5, "客户资料", true);
        t.upsert(12, 11, "凭证.xlsx", false);
        t.upsert(13, 11, "2025底稿.docx", false);
        t
    }

    #[test]
    fn upsert_add_and_rename_in_place() {
        let mut t = tbl();
        assert_eq!(t.len(), 3);
        let idx = t.by_frn[&12];
        // 同 FRN 改名：保下标（父引用不受影响），arena 追加
        t.upsert(12, 11, "记账凭证.xlsx", false);
        assert_eq!(t.len(), 3);
        assert_eq!(t.by_frn[&12], idx);
        let e = t.entries[idx as usize];
        let name = &t.names[e.name_off as usize..(e.name_off + e.name_len) as usize];
        assert_eq!(String::from_utf16(name).unwrap(), "记账凭证.xlsx");
    }

    #[test]
    fn remove_swaps_and_reindexes() {
        let mut t = tbl();
        assert!(t.remove(11)); // 删首个：末条目前移
        assert!(!t.remove(11));
        assert_eq!(t.len(), 2);
        // 被搬移条目的 FRN 索引已修复
        let moved_idx = t.by_frn[&13];
        assert_eq!(t.entries[moved_idx as usize].frn, 13);
        assert!(!t.by_frn.contains_key(&11));
    }

    #[test]
    fn compacted_sorts_by_frn_and_rebases_offsets() {
        let mut t = NameTable::new(5);
        t.upsert(30, 5, "ccc", false);
        t.upsert(10, 5, "aaa", false);
        t.upsert(20, 5, "bbb", false);
        t.upsert(10, 5, "aaa2", false); // 改名留孤儿段
        let (es, names, lower, initials) = t.compacted();
        assert_eq!(
            es.iter().map(|e| e.frn).collect::<Vec<_>>(),
            vec![10, 20, 30]
        );
        let name_of = |e: &EntryRec| {
            String::from_utf16(&names[e.name_off as usize..(e.name_off + e.name_len) as usize])
                .unwrap()
        };
        assert_eq!(name_of(&es[0]), "aaa2");
        assert_eq!(name_of(&es[2]), "ccc");
        // 小写 arena 与原文等价（纯 ASCII）；纯 ASCII 条目无首字母段
        assert_eq!(lower.len(), names.len());
        assert!(initials.is_empty());
    }

    #[test]
    fn hanzi_flag_and_lowercase_arena() {
        let mut t = NameTable::new(5);
        t.upsert(1, 5, "我的资料.TXT", false);
        t.upsert(2, 5, "photos", false);
        let h1 = t.entries[0].flags & FLAG_HANZI != 0;
        let h2 = t.entries[1].flags & FLAG_HANZI != 0;
        assert!(h1 && !h2);
        let e = t.entries[0];
        let lower = String::from_utf16(
            &t.names_lower[e.lower_off as usize..(e.lower_off + e.lower_len) as usize],
        )
        .unwrap();
        assert_eq!(lower, "我的资料.txt");
    }

    #[test]
    fn utf16_contains_and_wildcard_head() {
        let hay: Vec<u16> = "预算表2026.xlsx".encode_utf16().collect();
        assert!(contains_u16(
            &hay,
            &"2026".encode_utf16().collect::<Vec<_>>()
        ));
        assert!(contains_u16(
            &hay,
            &"预算".encode_utf16().collect::<Vec<_>>()
        ));
        assert!(!contains_u16(
            &hay,
            &"2027".encode_utf16().collect::<Vec<_>>()
        ));
        assert!(contains_u16(&hay, &[]));
        assert!(!contains_u16(
            &hay,
            &"很长的查询词不存在".encode_utf16().collect::<Vec<_>>()
        ));
        // 尾缀：全名 ".xlsx" 结尾命中；".xls" 不是尾缀
        assert!(ends_with_u16(
            &hay,
            &".xlsx".encode_utf16().collect::<Vec<_>>()
        ));
        assert!(!ends_with_u16(
            &hay,
            &".xls".encode_utf16().collect::<Vec<_>>()
        ));
        assert!(ends_with_u16(&hay, &hay));
        assert_eq!(wildcard_head("wd*.xls"), "wd");
        assert_eq!(wildcard_head("*.xlsx"), "");
        assert_eq!(wildcard_head("plain"), "plain");
    }
}
