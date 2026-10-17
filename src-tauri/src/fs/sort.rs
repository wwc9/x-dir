//! 排序 / 过滤 / 分页（§6.4 分页与快照协议、§7.5 视图细节）。

use serde::Deserialize;
use serde::Serialize;
use std::cmp::Ordering;

use super::entry::FileEntry;

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortKey {
    Name,
    Size,
    Mtime,
    Type,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct SortSpec {
    pub key: SortKey,
    pub dir: SortDir,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirPage {
    pub total: usize,
    pub entries: Vec<FileEntry>,
}

pub fn ext_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i + 1 < name.len() => &name[i + 1..],
        _ => "",
    }
}

/// 自然排序：与资源管理器一致（StrCmpLogicalW，按数字值比较、大小写不敏感）
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::StrCmpLogicalW;
        use windows::core::PCWSTR;
        let wa: Vec<u16> = a.encode_utf16().chain(std::iter::once(0)).collect();
        let wb: Vec<u16> = b.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { StrCmpLogicalW(PCWSTR::from_raw(wa.as_ptr()), PCWSTR::from_raw(wb.as_ptr())) }
            .cmp(&0)
    }
    #[cfg(not(windows))]
    {
        a.to_lowercase().cmp(&b.to_lowercase())
    }
}

/// 文件夹恒在前，再按 key 排序（§7.5）
pub fn cmp_entries(a: &FileEntry, b: &FileEntry, sort: &SortSpec) -> Ordering {
    if a.is_dir != b.is_dir {
        return if a.is_dir {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let ord = match sort.key {
        SortKey::Name => natural_cmp(&a.name, &b.name),
        SortKey::Size => a.size.cmp(&b.size),
        SortKey::Mtime => a.mtime_ms.cmp(&b.mtime_ms),
        SortKey::Type => ext_of(&a.name)
            .to_lowercase()
            .cmp(&ext_of(&b.name).to_lowercase())
            .then_with(|| natural_cmp(&a.name, &b.name)),
    };
    match sort.dir {
        SortDir::Asc => ord,
        SortDir::Desc => ord.reverse(),
    }
}

/// 名称过滤词（视图内过滤）：空格分隔多词 = AND，逐词大小写不敏感子串；
/// ASCII 词对含汉字条目追加拼音首字母串匹配（列表随条目下发的 py 字段，
/// 与首字母跳转同源——"凭证汇总" 敲 "pzhz" 或 "hz" 都能留在视图里）
pub fn name_filter_terms(query: &str) -> Vec<String> {
    query.split_whitespace().map(|t| t.to_lowercase()).collect()
}

pub fn entry_matches_terms(e: &FileEntry, terms: &[String]) -> bool {
    terms.iter().all(|t| {
        e.name.to_lowercase().contains(t) || e.py.as_deref().is_some_and(|py| py.contains(t))
    })
}

/// 过滤 + 排序 + 分页切片（铁律：Rust 端完成后分页下发，§4.3）
pub fn build_page(
    entries: &[FileEntry],
    sort: &SortSpec,
    ext_filter: Option<&[String]>,
    name_filter: Option<&str>,
    show_hidden: bool,
    offset: usize,
    limit: usize,
) -> DirPage {
    let mut view: Vec<&FileEntry> = entries
        .iter()
        .filter(|e| show_hidden || !(e.attrs.hidden || e.attrs.system))
        .collect();
    if let Some(q) = name_filter {
        let terms = name_filter_terms(q);
        if !terms.is_empty() {
            view.retain(|e| entry_matches_terms(e, &terms));
        }
    }
    if let Some(exts) = ext_filter
        && !exts.is_empty()
    {
        view.retain(|e| e.is_dir || exts.iter().any(|x| x.eq_ignore_ascii_case(ext_of(&e.name))));
    }
    view.sort_by(|a, b| cmp_entries(a, b, sort));
    let total = view.len();
    let start = offset.min(total);
    let end = offset.saturating_add(limit).min(total);
    DirPage {
        total,
        entries: view[start..end].iter().map(|e| (*e).clone()).collect(),
    }
}

/// 导航树：仅保留目录名（可选含隐藏/系统项），自然排序。
/// 输入 = list_dir 共用的目录缓存条目，不做额外 IO。
pub fn dir_names(entries: &[FileEntry], show_hidden: bool) -> Vec<String> {
    let mut names: Vec<String> = entries
        .iter()
        .filter(|e| e.is_dir && (show_hidden || !(e.attrs.hidden || e.attrs.system)))
        .map(|e| e.name.clone())
        .collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    names
}

#[cfg(test)]
mod tests {
    use super::super::entry::FileAttrs;
    use super::*;

    fn e(name: &str, is_dir: bool, size: u64) -> FileEntry {
        FileEntry {
            path: format!("C:\\t\\{name}"),
            name: name.to_string(),
            is_dir,
            size,
            mtime_ms: 1000,
            ctime_ms: 0,
            attrs: FileAttrs {
                hidden: false,
                system: false,
                readonly: false,
            },
            py: None,
        }
    }

    fn asc(key: SortKey) -> SortSpec {
        SortSpec {
            key,
            dir: SortDir::Asc,
        }
    }

    #[test]
    fn natural_order_matches_explorer() {
        assert_eq!(natural_cmp("a2", "a10"), Ordering::Less);
        assert_eq!(natural_cmp("A", "a"), Ordering::Equal);
        assert_eq!(natural_cmp("b", "a10"), Ordering::Greater);
    }

    #[test]
    fn dirs_first_regardless_of_sort() {
        let dir = e("zzz", true, 0);
        let file = e("aaa.txt", false, 1);
        let desc = SortSpec {
            key: SortKey::Name,
            dir: SortDir::Desc,
        };
        assert_eq!(
            cmp_entries(&dir, &file, &asc(SortKey::Name)),
            Ordering::Less
        );
        assert_eq!(cmp_entries(&dir, &file, &desc), Ordering::Less);
    }

    #[test]
    fn hidden_and_ext_filter() {
        let mut hidden = e("h.txt", false, 1);
        hidden.attrs.hidden = true;
        let entries = [
            hidden,
            e("a.pdf", false, 1),
            e("b.docx", false, 1),
            e("d", true, 0),
        ];
        let page = build_page(&entries, &asc(SortKey::Name), None, None, false, 0, 100);
        assert_eq!(page.total, 3); // 隐藏项被过滤

        let exts = vec!["PDF".to_string()];
        let page = build_page(
            &entries,
            &asc(SortKey::Name),
            Some(&exts),
            None,
            true,
            0,
            100,
        );
        // 文件夹不受扩展名过滤影响
        assert_eq!(page.total, 2);
        assert!(page.entries.iter().any(|e| e.is_dir));
    }

    #[test]
    fn name_filter_substring_and_pinyin() {
        let mut zh = e("凭证汇总.xlsx", false, 1);
        zh.py = Some("pzhz".to_string());
        let entries = [zh, e("report.pdf", false, 1), e("docs", true, 0)];

        // 单词子串：命中名称或拼音首字母串
        let page = build_page(
            &entries,
            &asc(SortKey::Name),
            None,
            Some("pzh"),
            false,
            0,
            100,
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.entries[0].name, "凭证汇总.xlsx");
        let page = build_page(
            &entries,
            &asc(SortKey::Name),
            None,
            Some("Port"),
            false,
            0,
            100,
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.entries[0].name, "report.pdf");
        // 文件夹同名一样被过滤（与 ext_filter 不同：视图过滤按名称一视同仁）
        let page = build_page(
            &entries,
            &asc(SortKey::Name),
            None,
            Some("docs"),
            false,
            0,
            100,
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.entries[0].name, "docs");

        // 多词 = AND
        let page = build_page(
            &entries,
            &asc(SortKey::Name),
            None,
            Some("port pzh"),
            false,
            0,
            100,
        );
        assert_eq!(page.total, 0);
        let page = build_page(
            &entries,
            &asc(SortKey::Name),
            None,
            Some("report pdf"),
            false,
            0,
            100,
        );
        assert_eq!(page.total, 1);

        // 空串 / 纯空白 = 不过滤
        for q in ["", "   "] {
            let page = build_page(&entries, &asc(SortKey::Name), None, Some(q), false, 0, 100);
            assert_eq!(page.total, 3);
        }
        // None = 不过滤
        let page = build_page(&entries, &asc(SortKey::Name), None, None, false, 0, 100);
        assert_eq!(page.total, 3);
    }

    #[test]
    fn dir_names_filters_hidden_and_natural_sorts() {
        let mut hidden_dir = e("zzz", true, 0);
        hidden_dir.attrs.hidden = true;
        let entries = [
            e("b2", true, 0),
            e("a10", true, 0),
            e("a2", true, 0),
            e("f.txt", false, 1),
            hidden_dir,
        ];
        // 只留目录；自然排序（a2 < a10）；隐藏目录默认剔除
        assert_eq!(dir_names(&entries, false), vec!["a2", "a10", "b2"]);
        // show_hidden = true 时隐藏目录回归并参与排序
        assert_eq!(dir_names(&entries, true), vec!["a2", "a10", "b2", "zzz"]);
    }

    #[test]
    fn pagination_slices_sorted_view() {
        let entries: Vec<FileEntry> = (0..100)
            .map(|i| e(&format!("f{:03}", i), false, i))
            .collect();
        let page = build_page(&entries, &asc(SortKey::Name), None, None, true, 10, 5);
        assert_eq!(page.total, 100);
        assert_eq!(page.entries.len(), 5);
        assert_eq!(page.entries[0].name, "f010");
        let tail = build_page(&entries, &asc(SortKey::Size), None, None, true, 98, 5);
        assert_eq!(tail.entries.len(), 2);
    }
}
