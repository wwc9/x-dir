//! 决定性诊断：三种终端启动变体在同一进程内实测 3 秒存活。
//! 跑法：cargo test --test-threads=1 spawn_variants -- --ignored --nocapture
//! 会真实弹出 2~3 个终端窗口，测完自动清理。

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::Duration;

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::CREATE_NEW_CONSOLE;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::PCWSTR;

fn pw16(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn shell_execute_open(dir: &str) {
    let verb = pw16("open");
    let exe = pw16("powershell.exe");
    let args = pw16("-NoExit");
    let d = pw16(dir);
    unsafe {
        ShellExecuteW(
            Some(HWND::default()),
            PCWSTR::from_raw(verb.as_ptr()),
            PCWSTR::from_raw(exe.as_ptr()),
            PCWSTR::from_raw(args.as_ptr()),
            PCWSTR::from_raw(d.as_ptr()),
            SW_SHOWNORMAL,
        );
    }
}

fn spawn_new_console(dir: &str) -> std::process::Child {
    Command::new("powershell")
        .args(["-NoExit"])
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE.0)
        .spawn()
        .expect("spawn B")
}

fn powershell_pids() -> Vec<u32> {
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-Process powershell -ErrorAction SilentlyContinue).Id -join ','",
        ])
        .output()
        .expect("list pids");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .split(',')
        .filter_map(|s| s.parse::<u32>().ok())
        .collect()
}

fn wait_and_report(tag: &str, before: &[u32], known_alive: &mut Vec<u32>) {
    std::thread::sleep(Duration::from_secs(3));
    let after = powershell_pids();
    // 新出现的 PID 且 3 秒后仍在 = 驻留；出现过又消失 = 闪退
    let fresh: Vec<u32> = after
        .iter()
        .filter(|p| !before.contains(p) && !known_alive.contains(p))
        .copied()
        .collect();
    // 再等 3 秒二次确认存活
    std::thread::sleep(Duration::from_secs(3));
    let final_ = powershell_pids();
    let survived: Vec<u32> = fresh
        .iter()
        .filter(|p| final_.contains(p))
        .copied()
        .collect();
    let flashed: Vec<u32> = fresh
        .iter()
        .filter(|p| !final_.contains(p))
        .copied()
        .collect();
    println!(
        "[{tag}] 新进程: {:?} | 3s 后存活: {:?} | 闪退: {:?}",
        fresh, survived, flashed
    );
    known_alive.extend(survived);
}

#[test]
#[ignore]
fn spawn_variants_survive() {
    let dir = "E:\\BaiduNetdiskDownload";
    let mut known_alive: Vec<u32> = powershell_pids();

    let before = powershell_pids();
    shell_execute_open(dir);
    wait_and_report("A ShellExecuteW", &before, &mut known_alive);

    let mut child = spawn_new_console(dir);
    std::thread::sleep(Duration::from_secs(3));
    let alive = child.try_wait().map(|s| s.is_none()).unwrap_or(false);
    println!("[B CREATE_NEW_CONSOLE+current_dir] 子进程 3s 存活: {alive}");
    let _ = child.kill();
    let _ = child.wait();

    let mut child = Command::new("powershell")
        .args(["-NoExit"])
        .current_dir(dir)
        .spawn()
        .expect("spawn C");
    std::thread::sleep(Duration::from_secs(3));
    let alive = child.try_wait().map(|s| s.is_none()).unwrap_or(false);
    println!("[C 无标志+current_dir] 子进程 3s 存活: {alive}");
    let _ = child.kill();
    let _ = child.wait();

    // D. conhost 强制经典宿主（绕过 WT 接管）
    let mut child = Command::new("conhost.exe")
        .arg("--")
        .arg("powershell")
        .args(["-NoExit"])
        .current_dir(dir)
        .spawn()
        .expect("spawn D");
    std::thread::sleep(Duration::from_secs(3));
    let alive = child.try_wait().map(|s| s.is_none()).unwrap_or(false);
    println!("[D conhost 强制] 子进程 3s 存活: {alive}");
    // 不 kill——留作人工确认；后续由清理段收尾

    // 可见性终检：所有 powershell 的 MainWindowHandle
    std::thread::sleep(Duration::from_secs(1));
    let vis = Command::new("powershell")
        .args(["-NoProfile", "-Command",
            "Get-Process powershell -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id):$($_.MainWindowHandle)\" }"])
        .output()
        .expect("vis");
    println!("[可见性] {}", String::from_utf8_lossy(&vis.stdout).trim());

    // 清理 A 驻留的窗口
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command",
            "Get-Process powershell | Where-Object { $_.MainWindowTitle -like '*PowerShell*' -and $_.Id -ne $PID } | Stop-Process -Force"])
        .output();
}
