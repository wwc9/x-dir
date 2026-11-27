//! V3 双轨右键菜单（§3.3）：默认仍是自绘菜单（视觉一致），Shift+右键 /
//! “显示更多选项”弹出系统原生 IContextMenu——包含“打开方式”、第三方扩展
//! （7-Zip / Git / 杀毒等）全部动词。多选要求同目录（Shell 数组绑定的惯例限制）。
//!
//! 呼出提速（2026-11-25 用户需求「优化打开更多系统选项的速度」）：绑定与查询
//! 走**常驻 STA 工作线程**——① 线程一次性 CoInitializeEx 且永不反初始化，
//! 第三方 shell 扩展进程内服务器（DLL）随首次调用常驻，免去每次 CoInit/CoUninit
//! 的卸载重载抖动；② QueryContextMenu（全量枚举扩展动词，重型扩展可达秒级）
//! 离开主线程，枚举期间 UI 不再冻结；③ 启动空闲预热（`warm`）把 DLL 首载成本
//! 移出用户第一次右键的关键路径。
//!
//! ⚠ 显示必须在 owner 窗口线程（2026-11-26 修复「更多系统选项没有反应」）：
//! TrackPopupMenu 的菜单模态循环绑死调用线程与 owner 窗口的输入队列——
//! 在工作线程上跨线程跟踪 owner=主窗时**立即返回 cmd=0 且静默成功**（实测
//! 复现：SetForegroundWindow 成功、QueryContextMenu 正常，TrackPopupMenu
//! 秒回，无菜单无报错，前端 await 收到 Ok）。故流程 = 工作线程枚举 →
//! `run_on_main_thread` 主线程 SetForeground + TrackPopupMenu → 回传命令号 →
//! 工作线程 InvokeCommand（IContextMenu 所在 STA，跨套间直调有死锁风险）。
//! 菜单弹出的模态时长内主线程停驻在 TrackPopupMenu，与历史同步命令版行为一致。

use std::sync::OnceLock;
use std::sync::mpsc::{Receiver, Sender, channel};

use tauri::AppHandle;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    BHID_SFUIObject, CMF_NORMAL, CMIC_MASK_PTINVOKE, CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX,
    IContextMenu, SHCreateShellItemArrayFromIDLists, SHParseDisplayName,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetCursorPos, HMENU, SetForegroundWindow, TPM_LEFTALIGN,
    TPM_RETURNCMD, TPM_RIGHTBUTTON, TPM_TOPALIGN, TrackPopupMenuEx,
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
        app: AppHandle,
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
                app,
                reply,
            } => {
                let r = show(&paths, HWND(owner as *mut _), &app);
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
pub async fn show_async(paths: Vec<String>, owner: isize, app: AppHandle) -> Result<(), String> {
    let (reply_tx, reply_rx) = channel();
    menu_sender()
        .send(Job::Show {
            paths,
            owner,
            app,
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

/// 在 STA 工作线程上完成枚举，把显示挪到主线程（owner 窗口线程）模态跟踪，
/// 用户收场后回工作线程执行动词。工作线程阻塞至菜单关闭是预期行为，枚举期
/// 间主线程全程空闲。坐标取 IPC 到达瞬间的光标位置（与「更多系统选项」点击
/// 点天然同点，误差仅毫秒级，免去 DPI 换算）。
fn show(paths: &[String], owner: HWND, app: &AppHandle) -> Result<(), String> {
    unsafe {
        let _co = crate::native_ops::CoGuard::new().ok_or("COM 初始化失败")?;
        // 光标先行捕获（必须在 bind/QueryContextMenu 之前）：重型扩展枚举可长
        // 达数秒，期间用户多半已移开鼠标，枚举后再取会钉在无关位置（2026-11-27
        // 用户报告「菜单左上角出现在右键文件的位置」病灶）。菜单落点与
        // InvokeCommand 的 ptInvoke 同点共用
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return Err("GetCursorPos".into());
        }
        let cm = bind_context_menu(paths)?;
        let menu = match CreatePopupMenu() {
            Ok(m) => m,
            Err(e) => return Err(format!("CreatePopupMenu：{e}")),
        };
        // 重活在常驻线程：枚举期间主线程事件循环不受影响（2026-11-25 提速的
        // 核心目标；此前同步命令跑主线程，重型扩展秒级枚举会整体冻结 UI）
        if let Err(e) = cm.QueryContextMenu(menu, 0, 1, 0x7FFF, CMF_NORMAL).ok() {
            let _ = DestroyMenu(menu);
            return Err(format!("QueryContextMenu：{e}"));
        }

        // 显示挪回 owner 窗口线程：跨线程 TrackPopupMenu 立即返回 cmd=0 且
        // 静默成功（模块头注释——2026-11-26「更多系统选项没有反应」病灶）
        // 句柄以 isize 交接（HWND/HMENU 含裸指针不可 Send；句柄值全局有效，
        // 独占所有权随闭包移动，主线程收场即销毁菜单）
        let (track_tx, track_rx) = channel();
        let menu_h = menu.0 as isize;
        let owner_h = owner.0 as isize;
        let dispatched = app.run_on_main_thread(move || {
            let cmd = track_menu(menu_h, owner_h, pt);
            let _ = track_tx.send(cmd);
        });
        if dispatched.is_err() {
            let _ = DestroyMenu(menu);
            return Err("主线程不可调度（应用正在退出）".into());
        }
        let cmd = track_rx
            .recv()
            .map_err(|_| "菜单回执通道已断".to_string())?;
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

/// 主线程执行：前台化 owner + 模态跟踪（直至用户收场）+ 销毁菜单。菜单落在
/// 呼出点 pt（右键时光标位置）。返回所选命令号（0 = 取消或失败）。模态期间
/// 主线程停驻，与历史同步命令版一致；枚举已提前在常驻线程完成，菜单即时弹出。
/// menu/owner 以 isize 交接（句柄含裸指针不可 Send；值本身全局有效）
fn track_menu(menu: isize, owner: isize, pt: POINT) -> u32 {
    let menu = HMENU(menu as *mut _);
    let owner = HWND(owner as *mut _);
    unsafe {
        // 原生菜单要求前台窗口，否则可能立即自动关闭（TrackPopupMenu 老坑）
        let _ = SetForegroundWindow(owner);
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
        cmd
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
