//! V3 双轨右键菜单（§3.3）：默认仍是自绘菜单（视觉一致），Shift+右键 /
//! “显示更多选项”弹出系统原生 IContextMenu——包含“打开方式”、第三方扩展
//! （7-Zip / Git / 杀毒等）全部动词。多选要求同目录（Shell 数组绑定的惯例限制）。
//!
//! 呼出提速（2026-11-25 用户需求「优化打开更多系统选项的速度」）：查询与弹出
//! 全程走**常驻 STA 工作线程**——① 线程一次性 CoInitializeEx 且永不反初始化，
//! 第三方 shell 扩展进程内服务器（DLL）随首次调用常驻，免去每次 CoInit/CoUninit
//! 的卸载重载抖动；② QueryContextMenu（全量枚举扩展动词，重型扩展可达秒级）
//! 离开主线程，枚举期间 UI 不再冻结；③ 启动空闲预热（`warm`）把 DLL 首载成本
//! 移出用户第一次右键的关键路径。命令侧 async：主线程事件循环全程空闲，跨线程
//! 菜单通知（WM_INITMENUPOPUP 等经 owner HWND 的 SendMessage）可即时送达。

use std::sync::OnceLock;
use std::sync::mpsc::{Receiver, Sender, channel};

use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    BHID_SFUIObject, CMF_NORMAL, CMIC_MASK_PTINVOKE, CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX,
    IContextMenu, SHCreateShellItemArrayFromIDLists, SHParseDisplayName,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetCursorPos, PostMessageW, SetForegroundWindow, TPM_LEFTALIGN,
    TPM_RETURNCMD, TPM_RIGHTBUTTON, TPM_TOPALIGN, TrackPopupMenuEx, WM_NULL,
};
use windows::core::{PCSTR, PCWSTR};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 工作线程任务：弹菜单（模态至用户收场，经 reply 回执）或空闲预热
enum Job {
    Show {
        paths: Vec<String>,
        owner: isize,
        reply: Sender<Result<(), String>>,
    },
    Warm {
        path: String,
    },
}

/// 常驻 STA 工作线程的任务通道（懒创建，进程生命周期存活）
fn menu_sender() -> Sender<Job> {
    static TX: OnceLock<Sender<Job>> = OnceLock::new();
    TX.get_or_init(spawn_worker).clone()
}

fn spawn_worker() -> Sender<Job> {
    let (tx, rx) = channel::<Job>();
    let _ = std::thread::Builder::new()
        .name("shell-menu".into())
        .spawn(move || worker_loop(rx));
    tx
}

fn worker_loop(rx: Receiver<Job>) {
    // STA 一次性初始化、线程退出才反初始化：shell 扩展 DLL 自此常驻进程
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    while let Ok(job) = rx.recv() {
        match job {
            Job::Show {
                paths,
                owner,
                reply,
            } => {
                let r = show(&paths, HWND(owner as *mut _));
                let _ = reply.send(r);
            }
            Job::Warm { path } => {
                let _ = warm_query(&path);
            }
        }
    }
    if hr.is_ok() {
        unsafe { CoUninitialize() };
    }
}

/// 命令入口（async）：任务交给工作线程并等待回执。前端 await 语义不变
/// （菜单关闭后才 resolve；失败文案走既有 catch → 灵动岛回执）
pub async fn show_async(paths: Vec<String>, owner: isize) -> Result<(), String> {
    let (reply_tx, reply_rx) = channel();
    menu_sender()
        .send(Job::Show {
            paths,
            owner,
            reply: reply_tx,
        })
        .map_err(|_| "菜单线程不可用".to_string())?;
    // 菜单可持续任意久，阻塞等待挪到 blocking 池，不占 async worker
    tauri::async_runtime::spawn_blocking(move || {
        reply_rx
            .recv()
            .unwrap_or_else(|_| Err("菜单线程已退出".into()))
    })
    .await
    .map_err(|e| format!("等待菜单回执失败：{e}"))?
}

/// 启动空闲预热：对已知存在的真实文件跑一次 QueryContextMenu 即弃——只为把
/// 第三方 shell 扩展 DLL 装进常驻线程，后续任意路径的首次右键不再承担 DLL
/// 首载。fire-and-forget，一切失败静默（预热不影响正式路径）
pub fn warm(path: &str) {
    let _ = menu_sender().send(Job::Warm {
        path: path.to_string(),
    });
}

/// 解析 PIDL → Shell 项数组 → IContextMenu（show 与预热共用；错误路径
/// 显式释放 PIDL——右键是高频操作，泄漏会长期累积）
fn bind_context_menu(paths: &[String]) -> Result<IContextMenu, String> {
    unsafe {
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
        array
            .BindToHandler(None, &BHID_SFUIObject)
            .map_err(|e| format!("绑定 IContextMenu 失败：{e}"))
    }
}

/// 在 STA 工作线程上弹出原生菜单并执行所选动词；模态直至用户关闭（工作线程
/// 阻塞是预期行为，主线程不受影响）。坐标取实时光标位置（右键动作与光标天然
/// 同点，免去 DPI 换算）。
fn show(paths: &[String], owner: HWND) -> Result<(), String> {
    unsafe {
        let _co = crate::native_ops::CoGuard::new().ok_or("COM 初始化失败")?;
        let cm = bind_context_menu(paths)?;
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
        // 菜单线程 ≠ owner 线程：补一发 WM_NULL 让 owner 走完焦点收尾
        // （TrackPopupMenu 老坑后半段，防收场后前台状态滞留菜单线程）
        let _ = PostMessageW(Some(owner), WM_NULL, WPARAM(0), LPARAM(0));
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

/// 预热查询：与正式路径同代码绑定 + QueryContextMenu，不弹菜单不执行动词
fn warm_query(path: &str) -> Result<(), String> {
    unsafe {
        let _co = crate::native_ops::CoGuard::new().ok_or("COM 初始化失败")?;
        let cm = bind_context_menu(std::slice::from_ref(&path.to_string()))?;
        let menu = CreatePopupMenu().map_err(|e| format!("CreatePopupMenu：{e}"))?;
        let r = cm.QueryContextMenu(menu, 0, 1, 0x7FFF, CMF_NORMAL).ok();
        let _ = DestroyMenu(menu);
        r.map_err(|e| format!("QueryContextMenu：{e}"))
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
