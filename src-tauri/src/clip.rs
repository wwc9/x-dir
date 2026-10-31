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
/// 标准剪贴板格式号：CF_DIB = 8（BITMAPINFOHEADER + 像素）
#[cfg(windows)]
const CF_DIB: u32 = 8;
/// 标准剪贴板格式号：CF_UNICODETEXT = 13（NUL 结尾的 UTF-16）
#[cfg(windows)]
const CF_UNICODETEXT: u32 = 13;
#[cfg(windows)]
const DROPEFFECT_COPY: u32 = 1;
#[cfg(windows)]
const DROPEFFECT_MOVE: u32 = 2;

/// 构建 CF_DIB 负载（40 字节 BITMAPINFOHEADER + 32bpp BGRA，正 biHeight =
/// 经典 bottom-up 行序——OLE 从 top-down（负高度）DIB 合成 CF_BITMAP 有
/// 已知的取空毛病，bottom-up 是全兼容写法）：逐像素交换 R/B（位运算单趟，
/// 4K 全屏 ~百 ms 级；剪贴板插件的逐像素路径 debug 下 4K 要 2.3s）。独立
/// 纯函数供 test。
#[cfg(windows)]
pub fn build_dib(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let stride = w as usize * 4; // 32bpp 天然 4 字节对齐
    let mut out = vec![0u8; 40 + stride * h as usize];
    out[0..4].copy_from_slice(&40u32.to_le_bytes()); // biSize
    out[4..8].copy_from_slice(&(w as i32).to_le_bytes()); // biWidth
    out[8..12].copy_from_slice(&(h as i32).to_le_bytes()); // biHeight > 0 = bottom-up
    out[12..14].copy_from_slice(&1u16.to_le_bytes()); // biPlanes
    out[14..16].copy_from_slice(&32u16.to_le_bytes()); // biBitCount
    // biCompression = BI_RGB(0)，biSizeImage 等其余字段对 BI_RGB 可为 0
    for (dst_row, src_row) in out[40..]
        .chunks_exact_mut(stride)
        .zip(rgba.chunks_exact(stride).rev())
    {
        for (s, d) in src_row
            .as_chunks::<4>()
            .0
            .iter()
            .zip(dst_row.as_chunks_mut::<4>().0)
        {
            let v = u32::from_le_bytes(*s);
            // RGBA 字节序 LE = A<<24|B<<16|G<<8|R → BGRA = A、G 原位，R/B 互换
            let bgra = (v & 0xFF00_FF00) | ((v & 0x00FF_0000) >> 16) | ((v & 0x0000_00FF) << 16);
            *d = bgra.to_le_bytes();
        }
    }
    out
}

/// 写入位图（CF_DIB）。内存构建全部前置到打开剪贴板之前：EmptyClipboard
/// 一旦成功而后续失败，用户原有剪贴板内容就丢了——失败窗口压缩到
/// SetClipboardData 一瞬（同 set_files 纪律）。
#[cfg(windows)]
pub fn set_image(w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    if w == 0 || h == 0 || rgba.len() != w as usize * h as usize * 4 {
        return Err("位图尺寸与数据不符".into());
    }
    let dib = build_dib(w, h, rgba);
    if !open_clipboard() {
        return Err("无法打开系统剪贴板".into());
    }
    unsafe {
        if EmptyClipboard().is_err() {
            let _ = CloseClipboard();
            return Err("无法清空系统剪贴板".into());
        }
        if !set_block(CF_DIB, &dib) {
            let _ = CloseClipboard();
            return Err("写入 CF_DIB 失败".into());
        }
        let _ = CloseClipboard();
    }
    Ok(())
}

/// 解析 CF_DIB 负载 → (宽, 高, RGBA top-down)。支持 32bpp BGRA 与 24bpp BGR
/// （行 4 字节对齐）、正/负 biHeight（bottom-up / top-down）；BITMAPINFOHEADER
/// 之外的变长头（V4/V5）按 biSize 跳过。压缩格式：BI_RGB(0) 直接收；32bpp
/// 的 BI_BITFIELDS(3) 在掩码为标准布局（R=00FF0000/G=0000FF00/B=000000FF，
/// GDI/OLE 合成 DIB 的常态，2026-10-31 E2E 实测：WinForms SetImage 的合成
/// DIB 即此格式——40 头 + 12 字节掩码 + 像素）时按 BI_RGB 同语义跳过掩码；
/// 其余压缩（BI_RLE/BI_JPEG 等）与非标准掩码返回 None。
/// 独立纯函数供 test（与 build_dib 往返互逆）。
pub fn parse_dib(data: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    if data.len() < 40 {
        return None;
    }
    let bi_size = u32::from_le_bytes(data[0..4].try_into().ok()?) as usize;
    if bi_size < 40 || bi_size > data.len() {
        return None;
    }
    let w = i32::from_le_bytes(data[4..8].try_into().ok()?);
    let h_raw = i32::from_le_bytes(data[8..12].try_into().ok()?);
    let planes = u16::from_le_bytes(data[12..14].try_into().ok()?);
    let bpp = u16::from_le_bytes(data[14..16].try_into().ok()?);
    let compression = u32::from_le_bytes(data[16..20].try_into().ok()?);
    if w <= 0 || h_raw == 0 || planes != 1 {
        return None;
    }
    // BI_BITFIELDS：BITMAPINFOHEADER(40) 后跟 3 个 DWORD 掩码（V4/V5 头掩码
    // 在头内，无需另跳）；仅 32bpp + 标准掩码视为与 BI_RGB 同布局
    let mut pixel_start = bi_size;
    if compression == 3 {
        if bpp != 32 {
            return None;
        }
        if bi_size == 40 {
            if data.len() < bi_size + 12 {
                return None;
            }
            let rd = |i: usize| {
                u32::from_le_bytes(
                    data[bi_size + i..bi_size + i + 4]
                        .try_into()
                        .expect("长度已前置校验"),
                )
            };
            if (rd(0), rd(4), rd(8)) != (0x00FF_0000, 0x0000_FF00, 0x0000_00FF) {
                return None;
            }
            pixel_start = bi_size + 12;
        }
    } else if compression != 0 {
        return None;
    }
    let (w, h) = (w as usize, h_raw.unsigned_abs() as usize);
    let bottom_up = h_raw > 0;
    let bytes_pp = match bpp {
        32 => 4usize,
        24 => 3,
        _ => return None,
    };
    // DIB 行按 4 字节对齐（32bpp 天然满足，24bpp 行尾可能有 1-3 字节填充）
    let src_stride = (w * bytes_pp).div_ceil(4) * 4;
    let pixels = &data[pixel_start..];
    if pixels.len() < src_stride * h {
        return None;
    }
    let mut out = Vec::with_capacity(w * h * 4);
    for row in 0..h {
        let src_row = if bottom_up { h - 1 - row } else { row };
        let line = &pixels[src_row * src_stride..src_row * src_stride + w * bytes_pp];
        match bytes_pp {
            4 => {
                for px in line.as_chunks::<4>().0 {
                    // BGRA → RGBA
                    out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
                }
            }
            _ => {
                for px in line.as_chunks::<3>().0 {
                    out.extend_from_slice(&[px[2], px[1], px[0], 255]);
                }
            }
        }
    }
    Some((w as u32, h as u32, out))
}

/// 写入文本（CF_UNICODETEXT：UTF-16 + NUL 结尾）。内存构建前置到打开剪贴板
/// 之前（同 set_files 纪律）
#[cfg(windows)]
pub fn set_text(text: &str) -> Result<(), String> {
    if text.contains('\0') {
        return Err("文本包含非法 NUL 字符".into());
    }
    let bytes: Vec<u8> = text
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(|u| u.to_le_bytes())
        .collect();
    if !open_clipboard() {
        return Err("无法打开系统剪贴板".into());
    }
    unsafe {
        if EmptyClipboard().is_err() {
            let _ = CloseClipboard();
            return Err("无法清空系统剪贴板".into());
        }
        if !set_block(CF_UNICODETEXT, &bytes) {
            let _ = CloseClipboard();
            return Err("写入 CF_UNICODETEXT 失败".into());
        }
        let _ = CloseClipboard();
    }
    Ok(())
}

/// 读取指定格式的完整字节块（GlobalLock + GlobalSize 拷出）；无该格式或读取
/// 失败返回 None。get_text / get_dib 共用
#[cfg(windows)]
fn read_block(format: u32) -> Option<Vec<u8>> {
    if !open_clipboard() {
        return None;
    }
    unsafe {
        let mut out: Option<Vec<u8>> = None;
        if IsClipboardFormatAvailable(format).is_ok()
            && let Ok(h) = GetClipboardData(format)
        {
            let gh = HGLOBAL(h.0);
            let ptr = GlobalLock(gh);
            if !ptr.is_null() {
                let size = GlobalSize(gh);
                out = Some(std::slice::from_raw_parts(ptr.cast(), size).to_vec());
                let _ = GlobalUnlock(gh);
            }
        }
        let _ = CloseClipboard();
        out
    }
}

/// 读取文本；剪贴板无 CF_UNICODETEXT 或为空串时返回 None
#[cfg(windows)]
pub fn get_text() -> Option<String> {
    let bytes = read_block(CF_UNICODETEXT)?;
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .take_while(|&u| u != 0)
        .collect();
    if units.is_empty() {
        return None;
    }
    Some(String::from_utf16_lossy(&units))
}

/// 读取 CF_DIB 原始负载（BITMAPINFOHEADER + 像素）；无位图时 None。
/// 解码见 parse_dib
#[cfg(windows)]
pub fn get_dib() -> Option<Vec<u8>> {
    read_block(CF_DIB)
}

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

    #[cfg(windows)]
    #[test]
    fn parse_dib_roundtrip_with_build_dib() {
        // 3×2 已知像素，覆盖 bottom-up 行序翻转与 R/B 互换
        let rgba: Vec<u8> = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, //
            255, 255, 0, 255, 0, 255, 255, 255, 10, 20, 30, 128,
        ];
        let dib = build_dib(3, 2, &rgba);
        assert_eq!(parse_dib(&dib), Some((3, 2, rgba)));
    }

    #[cfg(windows)]
    #[test]
    fn parse_dib_handles_variants_and_rejects_garbage() {
        // top-down（负 biHeight）
        let rgba = vec![1, 2, 3, 255, 4, 5, 6, 255];
        let mut dib = build_dib(2, 1, &rgba);
        dib[8..12].copy_from_slice(&(-1i32).to_le_bytes());
        assert_eq!(parse_dib(&dib), Some((2, 1, rgba.clone())));
        // 24bpp + 行尾填充：2 像素 × 3 字节 = 6，对齐到 8
        let mut b24 = vec![0u8; 40 + 8];
        b24[0..4].copy_from_slice(&40u32.to_le_bytes());
        b24[4..8].copy_from_slice(&2i32.to_le_bytes());
        b24[8..12].copy_from_slice(&1i32.to_le_bytes());
        b24[12..14].copy_from_slice(&1u16.to_le_bytes());
        b24[14..16].copy_from_slice(&24u16.to_le_bytes());
        b24[40..46].copy_from_slice(&[3, 2, 1, 6, 5, 4]); // BGR BGR
        b24[46..48].copy_from_slice(&[0xEE, 0xEE]); // 填充字节应被忽略
        assert_eq!(
            parse_dib(&b24),
            Some((2, 1, vec![1, 2, 3, 255, 4, 5, 6, 255]))
        );
        // BI_BITFIELDS(3) 标准掩码（40 头 + 12 掩码 + 像素）：GDI/OLE 合成
        // DIB 的常态，按 BI_RGB 同语义收（2026-10-31 E2E 实测 WinForms SetImage）
        let src = build_dib(2, 1, &rgba);
        let mut bf: Vec<u8> = src[..40].to_vec();
        bf[16..20].copy_from_slice(&3u32.to_le_bytes());
        bf.extend_from_slice(&0x00FF_0000u32.to_le_bytes());
        bf.extend_from_slice(&0x0000_FF00u32.to_le_bytes());
        bf.extend_from_slice(&0x0000_00FFu32.to_le_bytes());
        bf.extend_from_slice(&src[40..]);
        assert_eq!(parse_dib(&bf), Some((2, 1, rgba.clone())));
        // 非标准掩码（R/B 互换布局）拒绝——不能默默换通道
        let mut bad_masks = bf.clone();
        bad_masks[40..44].copy_from_slice(&0x0000_00FFu32.to_le_bytes());
        bad_masks[44..48].copy_from_slice(&0x00FF_0000u32.to_le_bytes());
        assert_eq!(parse_dib(&bad_masks), None);
        // 掩码数组被截断拒绝（40 + 10 < 40 + 12）
        assert_eq!(parse_dib(&bf[..50]), None);
        // 非法输入全家桶
        assert_eq!(parse_dib(&[]), None);
        assert_eq!(parse_dib(&[0u8; 39]), None);
        let mut bad = build_dib(2, 1, &rgba);
        bad[16..20].copy_from_slice(&5u32.to_le_bytes()); // BI_JPEG 拒绝
        assert_eq!(parse_dib(&bad), None);
        let mut trunc = build_dib(2, 1, &rgba);
        trunc.truncate(45); // 像素不足
        assert_eq!(parse_dib(&trunc), None);
    }

    #[cfg(windows)]
    #[test]
    fn dib_header_and_pixel_swizzle() {
        // 2×2 已知像素：第一行红/绿，第二行蓝/白（RGBA）
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 255, // row 0
            0, 0, 255, 255, 255, 255, 255, 255, // row 1
        ];
        let dib = build_dib(2, 2, &rgba);
        assert_eq!(dib.len(), 40 + 16);
        assert_eq!(u32::from_le_bytes(dib[0..4].try_into().unwrap()), 40);
        assert_eq!(i32::from_le_bytes(dib[4..8].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(dib[12..14].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(dib[14..16].try_into().unwrap()), 32);
        assert_eq!(u32::from_le_bytes(dib[16..20].try_into().unwrap()), 0);
        // 像素 BGRA 且行序 bottom-up：DIB 第一行 = 源图最后一行，R/B 互换
        assert_eq!(&dib[40..48], &[255, 0, 0, 255, 255, 255, 255, 255]);
        assert_eq!(&dib[48..56], &[0, 0, 255, 255, 0, 255, 0, 255]);
    }
}
