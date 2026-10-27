// DXGI Desktop Duplication 捕获（2026-10-27，§3.6 性能）：4K 全屏捕获
// GDI（xcap 内部实现）~300ms → DXGI ~60-100ms，热键感知延迟再砍 ~200ms。
// 只走 B8G8R8A8_UNORM + 无旋转的常规路径，任何不满足（HDR 纹理格式 / 显示器
// 旋转 / 独占全屏 / 安全桌面 / 驱动异常 / 枚举不到输出）一律返回 None，由调用
// 方回落 xcap——诚实降级，不硬撑。行拷贝 + BGRA→RGBA 翻转抽成纯函数供 test。
//
// 光标不入帧：Desktop Duplication 与 GDI BitBlt 行为一致（均不含鼠标指针），
// 与既有截图语义相同。
//
// 复制会话保活（2026-10-27 感知延迟二期）：D3D11CreateDevice ~20ms +
// DuplicateOutput ~20ms + 首帧合成等待是首按 380ms 罚金的主体。会话结构
// 按显示器缓存常驻（进程内同时只保一个输出复制），热键路径零初始化直接
// AcquireNextFrame；prewarm 在启动预热期做一次哑捕获，把设备/驱动/首帧
// 合成全部热好。ACCESS_LOST（独占全屏/安全桌面/显示模式切换）等失效即弃
// 缓存重建一次，再失败回落 xcap。

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

/// 启动预热：按当前光标所在显示器建保活会话并哑捕获一帧（结果丢弃），
/// 消掉首次热键的设备初始化与首帧合成等待。失败静默（回落路径照常工作）。
#[cfg(windows)]
pub(crate) fn prewarm() {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT::default();
    if unsafe { GetCursorPos(&mut pt) }.is_err() {
        return;
    }
    let Some(mon) = super::shot::monitor_at(pt.x, pt.y) else {
        return;
    };
    let t0 = std::time::Instant::now();
    match capture(&mon) {
        Some(_) => log::info!(
            "DXGI 预热完成（{}ms），首按零初始化",
            t0.elapsed().as_millis()
        ),
        None => log::warn!("DXGI 预热未成功（HDR/旋转/独占全屏等），热键时按需初始化"),
    }
}

#[cfg(not(windows))]
pub(crate) fn prewarm() {}

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
mod imp {
    use super::copy_bgra_rows;
    use image::RgbaImage;
    use std::sync::Mutex;

    use super::super::shot::MonRect;

    /// 保活的复制会话（设备 + 输出复制 + staging 纹理），进程内只保最近
    /// 使用的一个显示器；COM 接口跨线程顺序使用（windows-rs 句柄 Send）
    struct DupSession {
        key: (i32, i32),
        /// 设备句柄必须随会话保活（staging/duplication 依赖它，_drop 即失效）
        #[allow(dead_code)]
        device: windows::Win32::Graphics::Direct3D11::ID3D11Device,
        context: windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
        dup: windows::Win32::Graphics::Dxgi::IDXGIOutputDuplication,
        staging: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
        #[allow(dead_code)]
        width: u32,
        #[allow(dead_code)]
        height: u32,
    }

    static DUP_SESSION: Mutex<Option<DupSession>> = Mutex::new(None);

    pub(super) fn capture_impl(mon: &MonRect) -> Option<RgbaImage> {
        let mut guard = DUP_SESSION.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(img) = guard
            .as_ref()
            .filter(|s| s.key == (mon.x, mon.y))
            .and_then(|s| s.capture_frame())
        {
            return Some(img);
        }
        // 失效（ACCESS_LOST / 模式切换）或换了显示器：弃缓存重建
        *guard = None;
        let s = DupSession::new(mon)?;
        let img = s.capture_frame()?;
        *guard = Some(s);
        Some(img)
    }

    impl DupSession {
        fn new(mon: &MonRect) -> Option<Self> {
            use windows::Win32::Foundation::HMODULE;
            use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
            use windows::Win32::Graphics::Direct3D11::{
                D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_FLAG, D3D11_SDK_VERSION,
                D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
                ID3D11DeviceContext,
            };
            use windows::Win32::Graphics::Dxgi::Common::{
                DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED,
            };
            use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput1};
            use windows::core::Interface;

            // 1. 枚举适配器/输出，按桌面坐标找到目标显示器（虚拟桌面物理坐标一致）
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

            // 2. 该输出所在适配器上建设备 + 复制会话
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

            let mut td = unsafe { dup.GetDesc() }.ModeDesc;
            if td.Width == 0 || td.Height == 0 {
                td.Width = mon.w;
                td.Height = mon.h;
            }

            // staging 纹理随会话缓存（每帧只做 CopyResource + Map）
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Width: td.Width,
                Height: td.Height,
                MipLevels: 1,
                ArraySize: 1,
                Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
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

            Some(Self {
                key: (mon.x, mon.y),
                device,
                context,
                dup,
                staging,
                width: td.Width,
                height: td.Height,
            })
        }

        /// 取一帧：DWM 对静止桌面可能长时间不合成新帧，AcquireNextFrame 常
        /// 返回 LastPresentTime==0 的未合成黑 buffer（实战高频坑）。循环等
        /// 非零 present 时间；仍拿不到就轻微晃动光标 1px 强制触发一次合成
        /// （原位还原，不影响会话光标语义），再失败返回 None 由调用方弃缓存
        fn capture_frame(&self) -> Option<RgbaImage> {
            use windows::Win32::Graphics::Direct3D11::{
                D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC, ID3D11Texture2D,
            };
            use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
            use windows::Win32::Graphics::Dxgi::{
                DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, IDXGIResource,
            };
            use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};
            use windows::core::Interface;

            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            let mut acquired = false;
            for round in 0..4 {
                match unsafe { self.dup.AcquireNextFrame(60, &mut info, &mut resource) } {
                    Ok(()) => {
                        if info.LastPresentTime != 0 {
                            acquired = true;
                            break;
                        }
                        unsafe {
                            let _ = self.dup.ReleaseFrame();
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

            // 拷进会话缓存的 staging 后立刻 ReleaseFrame，再 Map 读行
            unsafe { self.context.CopyResource(&self.staging, &tex) };
            let _ = unsafe { self.dup.ReleaseFrame() };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe {
                self.context
                    .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            }
            .ok()?;
            let mut out = RgbaImage::new(td.Width, td.Height);
            let ok = unsafe {
                let bytes = std::slice::from_raw_parts(
                    mapped.pData.cast::<u8>(),
                    mapped.RowPitch as usize * td.Height as usize,
                );
                copy_bgra_rows(&mut out, bytes, mapped.RowPitch as usize)
            };
            unsafe { self.context.Unmap(&self.staging, 0) };
            ok.then_some(out)
        }
    }
}

#[cfg(windows)]
use imp::capture_impl;

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
