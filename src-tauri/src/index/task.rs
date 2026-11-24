//! 索引守护登录自启任务（2026-11-24 优化批）：schtasks 计划任务承载。
//!
//! 动机：提权守护是普通进程，重启后消失 → 用户每个开机周期都要重拨开关再过一次
//! UAC。本模块把「登录自启 + 最高权限」登记为计划任务（`XDIR_INDEX_DAEMON`），
//! 指向守护副本绝对路径——由**提权中的守护进程自行注册**（主程序普通权限注册
//! 不动最高权限任务），此后每次登录任务计划程序静默拉起守护，全程零 UAC。
//!
//! 生命周期：守护启动/配置变更时幂等覆盖注册（`/F`）；收到停止文件（开关关闭）
//! 先删任务再退出——开关语义与自启严格一致：开 = 常驻 + 自启，关 = 全撤。
//! 目录移动/任务丢失由守护下次启动自愈；删除 config 目录即整体卸载（残留任务
//! 指向不存在路径时登录触发静默失败，无副作用）。

use std::path::Path;

/// 任务名（固定 ASCII，避免 schtasks 命令行编码歧义）
pub const TASK_NAME: &str = "XDIR_INDEX_DAEMON";

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 组装 `schtasks /Create` 参数（纯函数配 cargo test）：/F 幂等覆盖、
/// /SC ONLOGON + /RL HIGHEST = 登录静默提权拉起、/RU 显式当前用户
/// （登录触发无需存凭据，不加 /RP 免密码交互）
fn create_args(daemon_exe: &Path, cfg_root: &Path, user: &str) -> Vec<String> {
    let tr = format!(
        "\"{}\" --index-daemon \"{}\"",
        daemon_exe.display(),
        cfg_root.display()
    );
    let mut args: Vec<String> = vec![
        "/Create".into(),
        "/F".into(),
        "/TN".into(),
        TASK_NAME.into(),
        "/TR".into(),
        tr,
        "/SC".into(),
        "ONLOGON".into(),
        "/RL".into(),
        "HIGHEST".into(),
    ];
    if !user.is_empty() {
        args.push("/RU".into());
        args.push(user.to_string());
    }
    args
}

/// `/Delete` 结果判定（纯函数配 cargo test）：成功即成；任务不存在同样视为
/// 已达成「删完」目标（schtasks 中英文案分别是「does not exist」「找不到指定的任务」
/// ——注意中文案不含「不存在」字样）
fn delete_succeeded(status_success: bool, stderr: &str) -> bool {
    status_success
        || stderr.contains("does not exist")
        || stderr.contains("不存在")
        || stderr.contains("找不到")
}

fn schtasks(args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("schtasks")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("schtasks 启动失败：{e}"))
}

/// 注册（幂等覆盖）登录自启任务。由提权守护进程调用——主程序普通权限
/// 注册不动 /RL HIGHEST 任务
pub fn register_autostart_task(daemon_exe: &Path, cfg_root: &Path) -> Result<(), String> {
    let args = create_args(
        daemon_exe,
        cfg_root,
        &std::env::var("USERNAME").unwrap_or_default(),
    );
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = schtasks(&refs)?;
    if !out.status.success() {
        return Err(format!(
            "schtasks 注册失败（{}）：{}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// 删除自启任务（不存在时视为成功——关闭语义要求「删完」，缺失即已达成）
pub fn delete_autostart_task() -> Result<(), String> {
    let out = schtasks(&["/Delete", "/F", "/TN", TASK_NAME])?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if delete_succeeded(out.status.success(), &stderr) {
        return Ok(());
    }
    Err(format!(
        "schtasks 删除失败（{}）：{}",
        out.status,
        stderr.trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_args_shapes_logon_highest_task() {
        let args = create_args(
            Path::new("C:\\cfg\\index\\x-dir-daemon.exe"),
            Path::new("C:\\cfg"),
            "PRIME",
        );
        let joined = args.join(" ");
        assert!(joined.contains("/Create /F /TN XDIR_INDEX_DAEMON"));
        // 动作 = 守护副本绝对路径 + 配置根参数，均带引号（含空格路径安全）
        assert!(joined.contains("\"C:\\cfg\\index\\x-dir-daemon.exe\" --index-daemon \"C:\\cfg\""));
        assert!(joined.contains("/SC ONLOGON"));
        assert!(joined.contains("/RL HIGHEST"));
        assert!(joined.contains("/RU PRIME"));
    }

    #[test]
    fn create_args_omits_empty_user() {
        let args = create_args(Path::new("d.exe"), Path::new("c"), "");
        assert!(!args.iter().any(|a| a == "/RU"));
    }

    #[test]
    fn tr_quoting_survives_spaces_in_paths() {
        // 带空格目录（演示机常见）必须整段引号包裹，schtasks /TR 才不裂参
        let args = create_args(
            Path::new("C:\\Program Files\\x-dir\\config\\index\\d.exe"),
            Path::new("C:\\Program Files\\x-dir\\config"),
            "u",
        );
        let tr = &args[5];
        assert!(tr.starts_with('"') && tr.contains("--index-daemon"));
        assert!(tr.matches('"').count() >= 4);
    }

    #[test]
    fn delete_treats_missing_task_as_success() {
        assert!(delete_succeeded(true, ""));
        assert!(delete_succeeded(
            false,
            "ERROR: The specified task does not exist"
        ));
        assert!(delete_succeeded(false, "错误: 系统找不到指定的任务。"));
        assert!(!delete_succeeded(false, "ERROR: Access is denied."));
    }
}
