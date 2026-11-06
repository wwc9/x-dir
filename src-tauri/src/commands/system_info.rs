//! 设备与运行环境信息（2026-11-06）：「关于」弹窗展示电脑配置——异机排障
//! 时一眼判断配置档次（弱核显/内存紧张/老系统都是各类渲染与性能问题的
//! 第一嫌疑项）。数据静态（装机配置不随会话变化），一次性收集：OS 版本
//! （RtlGetVersion 与注册表产品名）、CPU（注册表 ProcessorNameString 与
//! 逻辑处理器数）、物理内存总量（GlobalMemoryStatusEx）、GPU 型号（DXGI
//! 枚举，过滤软件渲染器）。全部走既有 windows crate feature，零新增依赖。

use serde::Serialize;
use windows::Wdk::System::SystemServices::RtlGetVersion;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1,
};
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ, REG_VALUE_TYPE, RegCloseKey, RegOpenKeyExW,
    RegQueryValueExW,
};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::core::PCWSTR;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// "Windows 11 专业版 (build 22631)"——build ≥22000 记 Win11
    pub os: String,
    /// "12th Gen Intel Core i7-12700 · 20 线程"
    pub cpu: String,
    /// 物理内存总量 GB（1 位小数，向下取——装机容量语义）
    pub memory_gb: f64,
    /// 显卡型号列表（DXGI 硬件适配器，过滤软件渲染器；主卡在前）
    pub gpus: Vec<String>,
}

#[tauri::command]
pub fn system_info() -> Result<SystemInfo, String> {
    Ok(SystemInfo {
        os: os_version(),
        cpu: cpu_info(),
        memory_gb: memory_total_gb(),
        gpus: gpu_names(),
    })
}

/// OS 版本：RtlGetVersion 不受兼容性清单欺骗（应用未声明 Win11 支持时
/// GetVersionEx 会谎报 Win10），build 号是唯一可靠判据
fn os_version() -> String {
    let mut v =
        unsafe { std::mem::zeroed::<windows::Win32::System::SystemInformation::OSVERSIONINFOW>() };
    if !unsafe { RtlGetVersion(&mut v) }.is_ok() {
        return "Windows（版本未知）".into();
    }
    let build = v.dwBuildNumber;
    let major_name = if build >= 22000 {
        "Windows 11"
    } else {
        "Windows 10"
    };
    let edition = reg_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "EditionId")
        .unwrap_or_default();
    let edition_cn = match edition.as_str() {
        "Professional" => "专业版",
        "Home" | "Home Single Language" => "家庭版",
        "Enterprise" | "Enterprise G" => "企业版",
        "Education" => "教育版",
        "Pro for Workstations" => "专业工作站版",
        _ => "",
    };
    let sep = if edition_cn.is_empty() { "" } else { " " };
    format!("{major_name}{sep}{edition_cn} (build {build})")
}

/// CPU：注册表 ProcessorNameString + 逻辑处理器数
fn cpu_info() -> String {
    let name = reg_string(
        r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        "ProcessorNameString",
    )
    .map(|n| n.trim().to_string())
    .unwrap_or_else(|| "未知处理器".into());
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);
    if threads > 0 {
        format!("{name} · {threads} 线程")
    } else {
        name
    }
}

/// 物理内存总量（GB，1 位小数）
fn memory_total_gb() -> f64 {
    let mut m = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    if !unsafe { GlobalMemoryStatusEx(&mut m) }.is_ok() {
        return 0.0;
    }
    (m.ullTotalPhys as f64 / 1024.0 / 1024.0 / 1024.0 * 10.0).floor() / 10.0
}

/// 显卡型号（DXGI 枚举硬件适配器；"Microsoft Basic Render Driver" 等软件
/// 渲染器不列入——它不代表真实配置，只在无驱动时兜底出现）
fn gpu_names() -> Vec<String> {
    let mut out = Vec::new();
    unsafe {
        // COM 初始化（MTA）：tauri 命令线程已有，cargo test / 任意裸线程没有——
        // 无 init 时 CreateDXGIFactory1 直接失败；已按 STA init 的线程会冲突，
        // 返回错误可忽略（此时 COM 本就可用）
        use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
        let co = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            let _ = co;
            return out;
        };
        for i in 0..8u32 {
            let Ok(adapter) = factory.EnumAdapters1(i) else {
                break;
            };
            let Ok(desc) = adapter.GetDesc1() else {
                continue;
            };
            // 软件适配器（Basic Render Driver / WARP）按 DXGI 标志过滤
            if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                continue;
            }
            let name = String::from_utf16_lossy(
                &desc
                    .Description
                    .iter()
                    .take_while(|&&c| c != 0)
                    .copied()
                    .collect::<Vec<_>>(),
            );
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        }
        if co.is_ok() {
            windows::Win32::System::Com::CoUninitialize();
        }
    }
    out
}

/// 注册表字符串值读取（HKLM，REG_SZ）
fn reg_string(subkey: &str, value: &str) -> Option<String> {
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let sub = wide(subkey);
    let val = wide(value);
    let mut hkey = HKEY::default();
    if !unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(sub.as_ptr()),
            None,
            KEY_READ,
            &mut hkey,
        )
    }
    .is_ok()
    {
        return None;
    }
    let mut ty = REG_VALUE_TYPE(0);
    let mut len = 0u32;
    if !unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(val.as_ptr()),
            None,
            Some(&mut ty),
            None,
            Some(&mut len),
        )
    }
    .is_ok()
        || ty != REG_SZ
    {
        let _ = unsafe { RegCloseKey(hkey) };
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    let ok = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(val.as_ptr()),
            None,
            None,
            Some(buf.as_mut_ptr()),
            Some(&mut len),
        )
    }
    .is_ok();
    let _ = unsafe { RegCloseKey(hkey) };
    if !ok {
        return None;
    }
    let units: Vec<u16> = buf[..len as usize]
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&c| c != 0)
        .collect();
    Some(String::from_utf16_lossy(&units))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_version_shape() {
        let s = os_version();
        assert!(s.starts_with("Windows 1"), "actual: {s}");
        assert!(s.contains("build"), "actual: {s}");
    }

    #[test]
    fn cpu_and_memory_present() {
        let c = cpu_info();
        assert!(!c.contains("未知"), "actual: {c}");
        assert!(c.contains("线程"), "actual: {c}");
        assert!(memory_total_gb() > 0.0);
    }

    #[test]
    fn gpus_no_software_adapter() {
        let g = gpu_names();
        assert!(
            !g.iter().any(|n| n.contains("Basic Render")),
            "actual: {g:?}"
        );
        assert!(!g.is_empty(), "真机至少一块硬件显卡");
    }
}
