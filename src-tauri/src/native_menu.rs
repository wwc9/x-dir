//! V3 双轨右键菜单（§3.3）：默认仍是自绘菜单（视觉一致），Shift+右键 /
//! “显示更多选项”弹出系统原生 IContextMenu——包含“打开方式”、第三方扩展
//! （7-Zip / Git / 杀毒等）全部动词。多选要求同目录（Shell 数组绑定的惯例限制）。

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    BHID_SFUIObject, CMF_NORMAL, CMIC_MASK_PTINVOKE, CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX,
    IContextMenu, SHCreateShellItemArrayFromIDLists, SHParseDisplayName,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetCursorPos, SetForegroundWindow, TPM_LEFTALIGN, TPM_RETURNCMD,
    TPM_RIGHTBUTTON, TPM_TOPALIGN, TrackPopupMenuEx,
};
use windows::core::{PCSTR, PCWSTR};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 弹出原生菜单并执行所选动词；模态直至用户关闭（命令线程阻塞是预期行为）。
/// 坐标取实时光标位置（右键动作与光标天然同点，免去 DPI 换算）。
/// 全部错误路径显式释放 PIDL/HMENU：右键是高频操作，泄漏会长期累积。
pub fn show(paths: &[String], owner: HWND) -> Result<(), String> {
    unsafe {
        let _co = crate::native_ops::CoGuard::new().ok_or("COM 初始化失败")?;
        let pidls = parse_pidls(paths)?;
        let const_pidls: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| *p as *const _).collect();
        let array = match SHCreateShellItemArrayFromIDLists(&const_pidls) {
            Ok(a) => a,
            Err(e) => {
                free_pidls(&pidls);
                return Err(format!("创建 Shell 项数组失败：{e}"));
            }
        };
        // 数组持有的是副本，原 PIDL 仍归本函数
        for pidl in &pidls {
            windows::Win32::UI::Shell::ILFree(Some(*pidl));
        }
        let cm: IContextMenu = array
            .BindToHandler(None, &BHID_SFUIObject)
            .map_err(|e| format!("绑定 IContextMenu 失败：{e}"))?;

        let menu = match CreatePopupMenu() {
            Ok(m) => m,
            Err(e) => return Err(format!("CreatePopupMenu：{e}")),
        };
        if let Err(e) = cm.QueryContextMenu(menu, 0, 1, 0x7FFF, CMF_NORMAL).ok() {
            let _ = DestroyMenu(menu);
            return Err(format!("QueryContextMenu：{e}"));
        }

        // 原生菜单要求前台窗口，否则可能立即自动关闭（TrackPopupMenu 老坑）
        let _ = SetForegroundWindow(owner);
        let mut pt = POINT::default();
        if let Err(e) = GetCursorPos(&mut pt) {
            let _ = DestroyMenu(menu);
            return Err(format!("GetCursorPos：{e}"));
        }
        let cmd = TrackPopupMenuEx(
            menu,
            (TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_TOPALIGN).0,
            pt.x,
            pt.y,
            owner,
            None,
        )
        .0 as u32;
        let _ = DestroyMenu(menu);
        if cmd == 0 {
            return Ok(()); // 用户取消
        }

        // MAKEINTRESOURCE：低 16 位为动词序号（指针值 < 0x10000 即按整数解读）
        let verb = PCWSTR(cmd as usize as *const u16);
        // CMIC_MASK_UNICODE = 0x40000；windows-rs 0.62 未导出，按 SDK 值并入 fMask
        let ici = CMINVOKECOMMANDINFOEX {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
            fMask: CMIC_MASK_PTINVOKE | 0x40000,
            lpVerb: PCSTR(cmd as usize as *const u8),
            lpVerbW: verb,
            ptInvoke: pt,
            nShow: 5, // SW_SHOW
            ..Default::default()
        };
        cm.InvokeCommand(&ici as *const CMINVOKECOMMANDINFOEX as *const CMINVOKECOMMANDINFO)
            .map_err(|e| format!("InvokeCommand：{e}"))
    }
}

fn parse_pidls(paths: &[String]) -> Result<Vec<*mut ITEMIDLIST>, String> {
    unsafe {
        let mut pidls: Vec<*mut ITEMIDLIST> = Vec::new();
        for p in paths {
            let w = wide(p);
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            if let Err(e) =
                SHParseDisplayName(PCWSTR::from_raw(w.as_ptr()), None, &mut pidl, 0, None)
            {
                free_pidls(&pidls);
                return Err(format!("路径不可解析 {p}：{e}"));
            }
            pidls.push(pidl);
        }
        Ok(pidls)
    }
}

fn free_pidls(pidls: &[*mut ITEMIDLIST]) {
    unsafe {
        for pidl in pidls {
            windows::Win32::UI::Shell::ILFree(Some(*pidl));
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn verb_intresource_encoding() {
        // 动词序号经 usize→指针编码，值必须保持 < 0x10000（IS_INTRESOURCE 约定）
        for cmd in [1u32, 42, 0x7FFF] {
            let ptr = cmd as usize as *const u16;
            assert!((ptr as usize) < 0x1_0000);
            assert_eq!(ptr as usize, cmd as usize);
        }
    }
}
