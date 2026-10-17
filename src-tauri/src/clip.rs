//! 系统剪贴板互通（V2 §3.2）：CF_HDROP 文件列表 + "Preferred DropEffect"（剪切意图）。
//! DROPFILES 负载的构建/解析是纯函数（单测覆盖），Win32 调用集中在 #[cfg(windows)] 段。

#[cfg(windows)]
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
#[cfg(windows)]
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
#[cfg(windows)]
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
#[cfg(windows)]
use windows::Win32::System::Ole::CF_HDROP;
#[cfg(windows)]
use windows::core::PCWSTR;

/// DROPFILES 头长度（pFiles=4 + POINT=8 + fNC=4 + fWide=4）
const DROPFILES_LEN: usize = 20;
#[cfg(windows)]
const DROPEFFECT_COPY: u32 = 1;
#[cfg(windows)]
const DROPEFFECT_MOVE: u32 = 2;

/// 构建 CF_HDROP 全局内存负载（宽字符路径 + 双 NUL 结尾）
pub fn build_hdrop(paths: &[String]) -> Vec<u8> {
    let mut wide: Vec<u16> = Vec::new();
    for p in paths {
        wide.extend(p.encode_utf16());
        wide.push(0);
    }
    wide.push(0);
    let mut out = vec![0u8; DROPFILES_LEN];
    out[0..4].copy_from_slice(&(DROPFILES_LEN as u32).to_le_bytes()); // pFiles 偏移
    out[16..20].copy_from_slice(&1i32.to_le_bytes()); // fWide = TRUE
    for u in wide {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

/// 解析 CF_HDROP 负载（宽/窄字符自适应）；格式非法返回空表
pub fn parse_hdrop(data: &[u8]) -> Vec<String> {
    if data.len() < DROPFILES_LEN {
        return vec![];
    }
    let pfiles = u32::from_le_bytes(data[0..4].try_into().expect("4 bytes")) as usize;
    let wide = i32::from_le_bytes(data[16..20].try_into().expect("4 bytes")) != 0;
    if pfiles < DROPFILES_LEN || pfiles > data.len() {
        return vec![];
    }
    let body = &data[pfiles..];
    if wide {
        let units: Vec<u16> = body
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        units
            .split(|&u| u == 0)
            .filter(|s| !s.is_empty())
            .map(String::from_utf16_lossy)
            .collect()
    } else {
        body.split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect()
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 剪贴板是全局竞争资源：短重试后再放弃
#[cfg(windows)]
fn open_clipboard() -> bool {
    for _ in 0..10 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    false
}

/// 把字节块放进剪贴板指定格式（成功后所有权移交系统）
#[cfg(windows)]
fn set_block(format: u32, bytes: &[u8]) -> bool {
    unsafe {
        let Ok(h) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else {
            return false;
        };
        let ptr = GlobalLock(h);
        if ptr.is_null() {
            let _ = GlobalFree(Some(h));
            return false;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.cast(), bytes.len());
        let _ = GlobalUnlock(h);
        if SetClipboardData(format, Some(HANDLE(h.0))).is_err() {
            let _ = GlobalFree(Some(h));
            return false;
        }
        true
    }
}

/// 写入文件列表（cut=true 时附 Preferred DropEffect = MOVE）。
/// 内存构建全部前置到打开剪贴板之前：EmptyClipboard 一旦成功而后续失败，
/// 用户原有剪贴板内容就丢了——失败窗口必须压缩到 SetClipboardData 一瞬。
#[cfg(windows)]
pub fn set_files(paths: &[String], cut: bool) -> Result<(), String> {
    let hdrop = build_hdrop(paths);
    let mut effect: Option<(u32, [u8; 4])> = None;
    if !paths.is_empty() {
        let name = wide("Preferred DropEffect");
        let fmt = unsafe { RegisterClipboardFormatW(PCWSTR::from_raw(name.as_ptr())) };
        if fmt != 0 {
            let e: u32 = if cut {
                DROPEFFECT_MOVE
            } else {
                DROPEFFECT_COPY
            };
            effect = Some((fmt, e.to_le_bytes()));
        }
    }
    if !open_clipboard() {
        return Err("无法打开系统剪贴板".into());
    }
    unsafe {
        if EmptyClipboard().is_err() {
            let _ = CloseClipboard();
            return Err("无法清空系统剪贴板".into());
        }
        if !paths.is_empty() && !set_block(CF_HDROP.0 as u32, &hdrop) {
            let _ = CloseClipboard();
            return Err("写入 CF_HDROP 失败".into());
        }
        if let Some((fmt, bytes)) = effect {
            let _ = set_block(fmt, &bytes);
        }
        let _ = CloseClipboard();
    }
    Ok(())
}

/// 读取文件列表；剪贴板无 CF_HDROP 或为空列表时返回 None
#[cfg(windows)]
pub fn get_files() -> Option<(Vec<String>, bool)> {
    if !open_clipboard() {
        return None;
    }
    unsafe {
        let mut result: Option<(Vec<String>, bool)> = None;
        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok()
            && let Ok(h) = GetClipboardData(CF_HDROP.0 as u32)
        {
            let gh = HGLOBAL(h.0);
            let ptr = GlobalLock(gh);
            if !ptr.is_null() {
                let size = GlobalSize(gh);
                let bytes = std::slice::from_raw_parts(ptr.cast(), size);
                let paths = parse_hdrop(bytes);
                if !paths.is_empty() {
                    // Preferred DropEffect 存在且为 MOVE → 剪切语义
                    let mut cut = false;
                    let name = wide("Preferred DropEffect");
                    let fmt = RegisterClipboardFormatW(PCWSTR::from_raw(name.as_ptr()));
                    if fmt != 0
                        && IsClipboardFormatAvailable(fmt).is_ok()
                        && let Ok(eh) = GetClipboardData(fmt)
                    {
                        let ge = HGLOBAL(eh.0);
                        let ep = GlobalLock(ge);
                        if !ep.is_null() && GlobalSize(ge) >= 4 {
                            cut = u32::from_le_bytes(
                                std::slice::from_raw_parts(ep.cast(), 4)
                                    .try_into()
                                    .expect("4 bytes"),
                            ) & DROPEFFECT_MOVE
                                != 0;
                        }
                        let _ = GlobalUnlock(ge);
                    }
                    result = Some((paths, cut));
                }
                let _ = GlobalUnlock(gh);
            }
        }
        let _ = CloseClipboard();
        result
    }
}

/// 清空系统剪贴板（剪切粘贴完成后避免残留移动语义）
#[cfg(windows)]
pub fn clear() -> Result<(), String> {
    if !open_clipboard() {
        return Err("无法打开系统剪贴板".into());
    }
    unsafe {
        let r = EmptyClipboard().map_err(|e| e.to_string());
        let _ = CloseClipboard();
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hdrop_roundtrip() {
        let paths = vec!["C:\\a b\\x.txt".to_string(), "D:\\新建 文件夹".to_string()];
        let bytes = build_hdrop(&paths);
        // 头部字段
        assert_eq!(
            u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize,
            DROPFILES_LEN
        );
        assert_eq!(i32::from_le_bytes(bytes[16..20].try_into().unwrap()), 1);
        assert_eq!(parse_hdrop(&bytes), paths);
        assert_eq!(parse_hdrop(&build_hdrop(&[])).len(), 0);
    }

    #[test]
    fn parse_rejects_bad_payloads() {
        assert!(parse_hdrop(&[]).is_empty());
        assert!(parse_hdrop(&[0u8; 10]).is_empty());
        // 声明了超出负载的偏移
        let mut b = build_hdrop(&["C:\\x".to_string()]);
        b[0..4].copy_from_slice(&9999u32.to_le_bytes());
        assert!(parse_hdrop(&b).is_empty());
        // 窄字符负载
        let mut narrow = vec![0u8; DROPFILES_LEN];
        narrow[0..4].copy_from_slice(&(DROPFILES_LEN as u32).to_le_bytes());
        narrow.extend_from_slice(b"C:\\a\0C:\\b\0\0");
        assert_eq!(parse_hdrop(&narrow), vec!["C:\\a", "C:\\b"]);
    }
}
