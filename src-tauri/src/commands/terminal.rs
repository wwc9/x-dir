//! 在指定目录打开终端。
//!
//! 策略（均绕开「默认终端接管」层——CREATE_NEW_CONSOLE / ShellExecute 与
//! Win11 默认终端=WT 的接管组合会闪退，实测见 tests/spawn_variants.rs）：
//! 1. `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe -d <dir>`（Windows Terminal；
//!    cmd 档追加 `cmd` 命令行，让 WT 起命令提示符而非默认 profile）
//! 2. 回退 `conhost.exe -- <shell>`（强制经典控制台，工作目录继承；
//!    powershell 档带 -NoExit，cmd 交互态本身驻留无需参数）
//!
//! shell 由设置下发（settings.terminal = powershell | cmd，未知取值按 powershell）。

use std::path::Path;
use std::process::Command;

use super::files::AppError;

fn wt_path() -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let wt = Path::new(&local).join("Microsoft\\WindowsApps\\wt.exe");
    wt.is_file().then(|| wt.to_string_lossy().into_owned())
}

fn spawn_wt(wt: &str, dir: &str, use_cmd: bool) -> std::io::Result<()> {
    let mut c = Command::new(wt);
    c.arg("-d").arg(dir);
    if use_cmd {
        c.arg("cmd");
    }
    c.spawn().map(|_| ())
}

fn spawn_conhost(dir: &str, use_cmd: bool) -> std::io::Result<()> {
    let mut c = Command::new("conhost.exe");
    c.arg("--");
    if use_cmd {
        c.arg("cmd");
    } else {
        c.args(["powershell", "-NoExit"]);
    }
    c.current_dir(dir).spawn().map(|_| ())
}

#[tauri::command]
pub fn open_terminal(path: String, shell: String) -> Result<(), AppError> {
    if !Path::new(&path).is_dir() {
        return Err(AppError::new("E_NOT_FOUND", format!("目录不存在：{path}")));
    }
    let use_cmd = shell.eq_ignore_ascii_case("cmd");
    if let Some(wt) = wt_path()
        && spawn_wt(&wt, &path, use_cmd).is_ok()
    {
        return Ok(());
    }
    spawn_conhost(&path, use_cmd)
        .map_err(|e| AppError::new("E_IO", format!("无法启动终端：{e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_dir_is_rejected() {
        for shell in ["powershell", "cmd"] {
            let r = open_terminal("Z:\\surely-not-exist-x-dir-test".into(), shell.into());
            assert!(r.is_err());
            assert_eq!(r.unwrap_err().code, "E_NOT_FOUND");
        }
    }
}
