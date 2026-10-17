//! 冲突"保留两者"命名：name.ext → name (2).ext → name (3).ext …

use crate::fs::entry::path_exists;
use crate::fs::path::{file_name_of, join_name, parent_of, split_ext};

/// 给定一个已存在的目标路径，返回不冲突的邻近路径
pub fn available_name(target: &str) -> String {
    if !path_exists(target) {
        return target.to_string();
    }
    let dir = parent_of(target).unwrap_or_default();
    let name = file_name_of(target);
    let (stem, ext) = split_ext(&name);
    for n in 2..10000u32 {
        let cand = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let p = join_name(&dir, &cand);
        if !path_exists(&p) {
            return p;
        }
    }
    join_name(
        &dir,
        &format!(
            "{stem} (副本){}",
            ext.is_empty()
                .then(String::new)
                .unwrap_or_else(|| format!(".{ext}"))
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn tempdir() -> String {
        let d = std::env::temp_dir().join(format!(
            "xdir-pick-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn picks_incrementing_names() {
        let dir = tempdir();
        let a = join_name(&dir, "a.txt");
        std::fs::write(&a, "x").unwrap();
        assert_eq!(available_name(&a), join_name(&dir, "a (2).txt"));
        std::fs::write(join_name(&dir, "a (2).txt"), "x").unwrap();
        assert_eq!(available_name(&a), join_name(&dir, "a (3).txt"));
        assert_eq!(
            available_name(&join_name(&dir, "b.txt")),
            join_name(&dir, "b.txt")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn no_ext_and_hidden_files() {
        let dir = tempdir();
        let a = join_name(&dir, "makefile");
        std::fs::write(&a, "x").unwrap();
        assert_eq!(available_name(&a), join_name(&dir, "makefile (2)"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
