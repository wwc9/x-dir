// DXGI Desktop Duplication 捕获（2026-10-27，§3.6 性能）：4K 全屏捕获
// GDI（xcap 内部实现）~300ms → DXGI ~60-100ms，热键感知延迟再砍 ~200ms。
// 只走 B8G8R8A8_UNORM + 无旋转的常规路径，任何不满足（HDR 纹理格式 / 显示器
// 旋转 / 独占全屏 / 安全桌面 / 驱动异常 / 枚举不到输出）一律返回 None，由调用
// 方回落 xcap——诚实降级，不硬撑。行拷贝 + BGRA→RGBA 翻转抽成纯函数供 test。
//
// 光标不入帧：Desktop Duplication 与 GDI BitBlt 行为一致（均不含鼠标指针），
// 与既有截图语义相同。

use image::RgbaImage;

use super::shot::MonRect;

#[cfg(windows)]
pub(crate) fn capture(mon: &MonRect) -> Option<RgbaImage> {
    capture_impl(mon)
}

#[cfg(not(windows))]
pub(crate) fn capture(_mon: &MonRect) -> Option<RgbaImage> {
    None
}

/// 把 Map 出来的带行距 BGRA 缓冲翻成 RGBA 写入 dst（单遍扫描，4K 约 10-15ms）
fn copy_bgra_rows(dst: &mut RgbaImage, src: &[u8], row_pitch: usize) -> bool {
    let (w, h) = dst.dimensions();
    if row_pitch == 0 || src.len() < h as usize * row_pitch {
        return false;
    }
    let wb = w as usize * 4;
    let mut raw = std::mem::replace(dst, RgbaImage::new(1, 1)).into_raw();
    for y in 0..h as usize {
        let src_row = &src[y * row_pitch..y * row_pitch + wb];
        let dst_row = &mut raw[y * wb..(y + 1) * wb];
        for (d, s) in dst_row
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(src_row.as_chunks::<4>().0)
        {
            *d = [s[2], s[1], s[0], s[3]];
        }
    }
    *dst = RgbaImage::from_raw(w, h, raw).expect("尺寸未变，重建必成功");
    true
}

#[cfg(windows)]
fn capture_impl(mon: &MonRect) -> Option<RgbaImage> {
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_FLAG, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
        D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11CreateDevice,
        ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED,
        DXGI_SAMPLE_DESC,
    };
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, IDXGIFactory1,
        IDXGIOutput1, IDXGIResource,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};
    use windows::core::Interface;

    // 1. 枚举适配器/输出，按桌面坐标找到光标所在显示器（虚拟桌面物理坐标一致）
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    let mut found: Option<(windows::Win32::Graphics::Dxgi::IDXGIAdapter1, _)> = None;
    for a in 0..8u32 {
        // let-else 的 scrutinee 不能直接是块表达式（unsafe{}），先提出
        let res = unsafe { factory.EnumAdapters1(a) };
        let Ok(adapter) = res else {
            break;
        };
        for o in 0..8u32 {
            let res = unsafe { adapter.EnumOutputs(o) };
            let Ok(output) = res else {
                break;
            };
            let res = unsafe { output.GetDesc() };
            let Ok(desc) = res else {
                continue;
            };
            if !desc.AttachedToDesktop.as_bool() {
                continue;
            }
            let r = desc.DesktopCoordinates;
            if r.left == mon.x && r.top == mon.y {
                // 旋转屏的复制帧是横向原始纹理，需要几何变换，交给 xcap 回落
                if !matches!(
                    desc.Rotation,
                    DXGI_MODE_ROTATION_IDENTITY | DXGI_MODE_ROTATION_UNSPECIFIED
                ) {
                    return None;
                }
                found = Some((adapter, output));
                break;
            }
        }
        if found.is_some() {
            break;
        }
    }
    let (adapter, output) = found?;

    // 2. 该输出所在适配器上建设备 + 复制会话（D3D11CreateDevice ~20ms +
    //    DuplicateOutput ~20ms；首帧 AcquireNextFrame 即返回整幅桌面）
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            &adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .ok()?;
    let device = device?;
    let context = context?;
    let output1: IDXGIOutput1 = output.cast().ok()?;
    let dup = unsafe { output1.DuplicateOutput(&device) }.ok()?;

    // 3. 取帧：DWM 对静止桌面可能长时间不合成新帧，DuplicateOutput 后首个
    //    AcquireNextFrame 常返回 LastPresentTime==0 的未合成黑 buffer（实战
    //    高频坑）。循环等非零 present 时间；仍拿不到就轻微晃动光标 1px 强制
    //    触发一次合成（原位还原，不影响会话光标语义），再失败回落 xcap
    let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
    let mut resource: Option<IDXGIResource> = None;
    let mut acquired = false;
    for round in 0..4 {
        match unsafe { dup.AcquireNextFrame(60, &mut info, &mut resource) } {
            Ok(()) => {
                if info.LastPresentTime != 0 {
                    acquired = true;
                    break;
                }
                unsafe {
                    let _ = dup.ReleaseFrame();
                }
                resource = None;
            }
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {}
            Err(_) => return None,
        }
        if round == 1 {
            // 静止桌面强制合成：光标 1px 出走再回位（DWM 立即重排一帧）
            let mut pt = Default::default();
            unsafe { GetCursorPos(&mut pt) }.ok()?;
            unsafe { SetCursorPos(pt.x + 1, pt.y) }.ok()?;
            unsafe { SetCursorPos(pt.x, pt.y) }.ok()?;
        }
    }
    if !acquired {
        return None;
    }
    let tex: ID3D11Texture2D = resource?.cast().ok()?;
    let mut td = D3D11_TEXTURE2D_DESC::default();
    unsafe { tex.GetDesc(&mut td) };
    // HDR 桌面给的是 R16G16B16A16_FLOAT，翻不过来，回落 xcap
    if td.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
        return None;
    }

    // 4. 拷进 CPU 可读 staging 后立刻 ReleaseFrame，再 Map 读行
    let staging_desc = D3D11_TEXTURE2D_DESC {
        Width: td.Width,
        Height: td.Height,
        MipLevels: 1,
        ArraySize: 1,
        Format: td.Format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut staging = None;
    unsafe { device.CreateTexture2D(&staging_desc, None, Some(&mut staging)) }.ok()?;
    let staging = staging?;
    unsafe { context.CopyResource(&staging, &tex) };
    let _ = unsafe { dup.ReleaseFrame() };
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.ok()?;
    let mut out = RgbaImage::new(td.Width, td.Height);
    let ok = unsafe {
        let bytes = std::slice::from_raw_parts(
            mapped.pData.cast::<u8>(),
            mapped.RowPitch as usize * td.Height as usize,
        );
        copy_bgra_rows(&mut out, bytes, mapped.RowPitch as usize)
    };
    unsafe { context.Unmap(&staging, 0) };
    ok.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::copy_bgra_rows;
    use image::RgbaImage;

    #[test]
    fn bgra_rows_swizzle_and_skip_stride() {
        // 2×2 图，行距 12（每行尾部 4 字节 padding 必须被跳过）
        let mut img = RgbaImage::new(2, 2);
        // 行0: BGRA(1,2,3,4) BGRA(5,6,7,8) pad(9,9,9,9)
        // 行1: BGRA(10,20,30,40) BGRA(50,60,70,80) pad(0,0,0,0)
        let src: Vec<u8> = vec![
            1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9, //
            10, 20, 30, 40, 50, 60, 70, 80, 0, 0, 0, 0,
        ];
        assert!(copy_bgra_rows(&mut img, &src, 12));
        assert_eq!(img.get_pixel(0, 0).0, [3, 2, 1, 4]);
        assert_eq!(img.get_pixel(1, 0).0, [7, 6, 5, 8]);
        assert_eq!(img.get_pixel(0, 1).0, [30, 20, 10, 40]);
        assert_eq!(img.get_pixel(1, 1).0, [70, 60, 50, 80]);
    }

    #[test]
    fn bgra_rows_rejects_short_buffer() {
        let mut img = RgbaImage::new(2, 2);
        assert!(!copy_bgra_rows(&mut img, &[0u8; 8], 12));
        assert!(!copy_bgra_rows(&mut img, &[0u8; 24], 0));
    }
}
