//! V2 真实文件图标（SHGetFileInfo）。输出统一为 PNG data URL；
//! 缓存 LRU——图标 512 条上限（铁律 2）。

use std::collections::{HashMap, VecDeque};

#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits,
    GetObjectW, HBITMAP, HGDIOBJ, ReleaseDC,
};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_FLAGS_AND_ATTRIBUTES};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES, SHGetFileInfoW,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};
#[cfg(windows)]
use windows::core::PCWSTR;

use crate::fs::path::file_name_of;
use crate::fs::sort::ext_of;

const ICON_CACHE_MAX: usize = 512;

// ---------- LRU 缓存 ----------

pub struct ImageCache {
    max: usize,
    map: HashMap<String, String>,
    order: VecDeque<String>,
}

impl ImageCache {
    pub fn new(max: usize) -> Self {
        Self {
            max,
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn get(&mut self, key: &str) -> Option<&String> {
        if self.map.contains_key(key) {
            self.order.retain(|k| k != key);
            self.order.push_back(key.to_string());
        }
        self.map.get(key)
    }

    pub fn put(&mut self, key: String, value: String) {
        if self.map.insert(key.clone(), value).is_none() {
            self.order.push_back(key);
        }
        while self.map.len() > self.max {
            if let Some(evict) = self.order.pop_front() {
                self.map.remove(&evict);
            }
        }
    }
}

pub struct IconStore {
    pub icons: ImageCache,
}

impl IconStore {
    pub fn new() -> Self {
        Self {
            icons: ImageCache::new(ICON_CACHE_MAX),
        }
    }
}

/// 图标缓存键：普通目录共享一份；盘符根与逐文件不同的类型按路径缓存
pub fn icon_key(path: &str, is_dir: bool) -> String {
    if is_dir {
        // 盘符根（恰为 "X:\"，长度 3）有各自的图标，不能与普通目录共用 "dir" 键——
        // 否则首个被提取的盘符图标会污染全部目录（导航树定位功能踩坑）
        if path.len() == 3 && path.as_bytes()[1] == b':' {
            return format!("p:{path}");
        }
        return "dir".to_string();
    }
    let ext = ext_of(&file_name_of(path)).to_lowercase();
    match ext.as_str() {
        "exe" | "msi" | "lnk" | "scr" | "dll" | "ico" | "cur" | "ani" => format!("p:{path}"),
        _ => format!("e:{ext}"),
    }
}

/// PNG data URL（`data:image/png;base64,...`）
pub fn png_data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", b64_encode(png))
}

// ---------- PNG / base64（纯函数，单测覆盖） ----------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// GDI 产出的 32bpp BGRA 是预乘 alpha；PNG 要直通 alpha，逐像素还原
pub fn un_premultiply_bgra(px: &mut [u8]) {
    for c in px.as_chunks_mut::<4>().0 {
        let a = c[3] as u32;
        if a == 0 || a == 255 {
            continue;
        }
        for v in c.iter_mut().take(3) {
            *v = ((*v as u32 * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

/// BGRA（top-down）→ RGBA
pub fn bgra_to_rgba(px: &mut [u8]) {
    for c in px.as_chunks_mut::<4>().0 {
        c.swap(0, 2);
    }
}

fn encode_png(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// HBITMAP（32bpp）→ PNG 字节。缩略图 / 图标位图共用。
#[cfg(windows)]
unsafe fn hbitmap_to_png(hbm: HBITMAP) -> Option<Vec<u8>> {
    unsafe {
        let mut bmp = BITMAP::default();
        let n = GetObjectW(
            HGDIOBJ(hbm.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(std::ptr::from_mut(&mut bmp).cast()),
        );
        if n == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
            return None;
        }
        let (w, h) = (bmp.bmWidth as u32, bmp.bmHeight as u32);
        let mut px = vec![0u8; (w * h * 4) as usize];
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32), // 负高 = top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let hdc = GetDC(None);
        let ok = GetDIBits(
            hdc,
            hbm,
            0,
            h,
            Some(px.as_mut_ptr().cast()),
            &mut bi,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, hdc);
        if ok == 0 {
            return None;
        }
        un_premultiply_bgra(&mut px);
        bgra_to_rgba(&mut px);
        encode_png(&px, w, h)
    }
}

/// 单个路径的 32×32 真实图标 → PNG data URL。
/// 目录：经 SHGFI_USEFILEATTRIBUTES + FILE_ATTRIBUTE_DIRECTORY 取标准文件夹图标——
/// 目录图标的 Shell 提取（IShellFolder）需要 COM 初始化，命令线程未初始化时会失败。
#[cfg(windows)]
pub fn file_icon_png(path: &str, is_dir: bool) -> Option<String> {
    unsafe {
        let w = wide(path);
        let mut info = SHFILEINFOW::default();
        // 盘符根走真实提取（返回该盘的实际图标）；其余目录走属性回退
        let is_drive_root = is_dir && path.len() == 3 && path.as_bytes()[1] == b':';
        let (attrs, flags) = if is_dir && !is_drive_root {
            (
                FILE_FLAGS_AND_ATTRIBUTES(FILE_ATTRIBUTE_DIRECTORY.0),
                SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
            )
        } else {
            (FILE_FLAGS_AND_ATTRIBUTES(0), SHGFI_ICON | SHGFI_LARGEICON)
        };
        let ok = SHGetFileInfoW(
            PCWSTR::from_raw(w.as_ptr()),
            attrs,
            Some(std::ptr::from_mut(&mut info)),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        );
        if ok == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let png = hicon_to_png(info.hIcon);
        let _ = DestroyIcon(info.hIcon);
        png.map(|p| png_data_url(&p))
    }
}

#[cfg(windows)]
unsafe fn hicon_to_png(icon: HICON) -> Option<Vec<u8>> {
    unsafe {
        let mut ii = ICONINFO::default();
        if GetIconInfo(icon, std::ptr::from_mut(&mut ii)).is_err() {
            return None;
        }
        // 彩色位图为 0 的是单色光标类资源，交回内置图标
        let png = if ii.hbmColor.is_invalid() {
            None
        } else {
            hbitmap_to_png(ii.hbmColor)
        };
        let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        png
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_known_vectors() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn lru_evicts_and_promotes() {
        let mut c = ImageCache::new(2);
        c.put("a".into(), "1".into());
        c.put("b".into(), "2".into());
        assert_eq!(c.get("a").cloned(), Some("1".into())); // a 晋升为最新
        c.put("c".into(), "3".into()); // 淘汰 b
        assert!(c.get("b").is_none());
        assert_eq!(c.get("c").cloned(), Some("3".into()));
        assert!(c.get("a").is_some());
    }

    #[test]
    fn premultiply_restores_straight_alpha() {
        // 预乘 (128,0,0,128) → 直通 (255,0,0,128)
        let mut px = vec![128, 0, 0, 128, 10, 20, 30, 0, 1, 2, 3, 255];
        un_premultiply_bgra(&mut px);
        assert_eq!(px[0], 255);
        assert_eq!(&px[4..8], &[10, 20, 30, 0]); // 全透明不动
        assert_eq!(&px[8..12], &[1, 2, 3, 255]); // 不透明不动
        bgra_to_rgba(&mut px);
        assert_eq!(&px[0..4], &[0, 0, 255, 128]); // B/G/R 交换
    }

    #[test]
    fn dir_icon_extracts_on_real_fs() {
        // C:\Windows 在所有 Windows 机器上都存在；提取失败即 SHGetFileInfo 目录链路损坏
        let png = super::file_icon_png(r"C:\Windows", true);
        assert!(
            png.is_some(),
            "SHGetFileInfo directory icon extraction failed"
        );
    }

    #[test]
    fn icon_keys_share_by_ext() {
        assert_eq!(icon_key("C:\\a\\x.txt", false), "e:txt");
        assert_eq!(icon_key("C:\\a\\y.TXT", false), "e:txt");
        assert_eq!(icon_key("C:\\a\\app.exe", false), "p:C:\\a\\app.exe");
        assert_eq!(icon_key("C:\\a", true), "dir");
    }

    #[test]
    fn drive_roots_have_own_keys() {
        // 盘符根各自独立，且不污染普通目录的 "dir" 共享键
        assert_eq!(icon_key("C:\\", true), "p:C:\\");
        assert_eq!(icon_key("D:\\", true), "p:D:\\");
        assert_ne!(icon_key("C:\\", true), icon_key("D:\\", true));
        assert_ne!(icon_key("C:\\", true), icon_key("C:\\a", true));
        // 大小写保持原样（SHGetFileInfo 按原路径取图标）
        assert_eq!(icon_key("e:\\", true), "p:e:\\");
    }

    #[test]
    fn png_encoder_smoke() {
        let px = vec![255u8, 0, 0, 255];
        let out = encode_png(&px, 1, 1).expect("encode");
        assert_eq!(&out[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert!(png_data_url(&out).starts_with("data:image/png;base64,"));
    }
}
