//! V2 IFileOperation 原生复制/移动（§3.2）：进度与冲突对话框交给系统 UI，
//! 替换 V1 自实现引擎；Perform 失败时由调用方回退内置引擎（§9 风险预案）。

#[cfg(windows)]
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    FOF_ALLOWUNDO, FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
};
#[cfg(windows)]
use windows::core::PCWSTR;

/// 原生操作终态。用户在系统进度/冲突对话框点「取消」时 PerformOperations
/// 仍返回 S_OK，取消信息只在 GetAnyOperationsAborted 出参——不查会把
/// 取消当成功回执（任务卡显示完成而什么都没复制）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeOutcome {
    Done,
    Aborted,
}

/// STA COM 初始化守卫：构造成功必须配对 CoUninitialize（S_FALSE 同样要配对）
#[cfg(windows)]
pub struct CoGuard {
    uninit: bool,
}

#[cfg(windows)]
impl CoGuard {
    /// 线程已是其他套间（如 MTA）时返回 None —— 调用方走回退路径
    pub fn new() -> Option<Self> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr.is_ok() {
            Some(Self { uninit: true })
        } else {
            // RPC_E_CHANGED_THREADMODE 等：本线程已按其他模式初始化，交回退
            None
        }
    }
}

#[cfg(windows)]
impl Drop for CoGuard {
    fn drop(&mut self) {
        if self.uninit {
            unsafe { CoUninitialize() };
        }
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 原生复制/移动。冲突处理与进度由系统对话框承担（不预设 FOF_NOCONFIRMATION）；
/// 允许撤销（FOF_ALLOWUNDO → 删除/移动进回收站语义）。
#[cfg(windows)]
pub fn transfer(
    is_move: bool,
    sources: &[String],
    dest_dir: &str,
) -> Result<NativeOutcome, String> {
    unsafe {
        let _co = CoGuard::new().ok_or("COM 初始化失败")?;
        let op: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        op.SetOperationFlags(FOF_ALLOWUNDO)
            .map_err(|e| e.to_string())?;
        let wdest = wide(dest_dir);
        let dest: IShellItem = SHCreateItemFromParsingName(PCWSTR::from_raw(wdest.as_ptr()), None)
            .map_err(|e| format!("目标不可解析：{e}"))?;
        for s in sources {
            let w = wide(s);
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR::from_raw(w.as_ptr()), None)
                .map_err(|e| format!("源不可解析 {s}：{e}"))?;
            if is_move {
                op.MoveItem(&item, &dest, None, None)
                    .map_err(|e| format!("MoveItem 失败 {s}：{e}"))?;
            } else {
                op.CopyItem(&item, &dest, None, None)
                    .map_err(|e| format!("CopyItem 失败 {s}：{e}"))?;
            }
        }
        op.PerformOperations()
            .map_err(|e| format!("IFileOperation::PerformOperations 失败：{e}"))?;
        // 用户取消：S_OK 但出参为真（部分搬移后取消同样置位）——按取消收尾，
        // 不回退内置引擎（那会把用户刚拒绝的传输原样做完）
        let aborted = op
            .GetAnyOperationsAborted()
            .map_err(|e| format!("GetAnyOperationsAborted 失败：{e}"))?
            .as_bool();
        if aborted {
            return Ok(NativeOutcome::Aborted);
        }
        Ok(NativeOutcome::Done)
    }
}

#[cfg(not(windows))]
pub fn transfer(
    _is_move: bool,
    _sources: &[String],
    _dest_dir: &str,
) -> Result<NativeOutcome, String> {
    Err("非 Windows 平台无原生操作".into())
}
