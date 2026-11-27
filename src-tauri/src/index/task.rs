//! 索引守护登录自启任务（2026-11-24 优化批；2026-11-27 改 /XML 注册）：schtasks 计划任务承载。
//!
//! 动机：提权守护是普通进程，重启后消失 → 用户每个开机周期都要重拨开关再过一次
//! UAC。本模块把「登录自启 + 最高权限」登记为计划任务（`XDIR_INDEX_DAEMON`），
//! 指向守护副本绝对路径——由**提权中的守护进程自行注册**（主程序普通权限注册
//! 不动最高权限任务），此后每次登录任务计划程序静默拉起守护，全程零 UAC。
//!
//! 2026-11-27 注册从命令行参数（/TR /SC /RL /RU）改为 /XML 导入：schtasks 命令行
//! **没有电池参数**（缺省「电池下不启动、切入电池即杀」，笔记本上常驻守护被静默
//! 终止，与常驻语义冲突）也**没有执行时限参数**（缺省 72h 到点强杀常驻进程）；
//! XML 一次到位：电池双开、`ExecutionTimeLimit = PT0S`（不限时）。
//!
//! 生命周期：守护启动/配置变更时幂等覆盖注册（`/F`）；收到停止文件（开关关闭）
//! 先删任务再退出——开关语义与自启严格一致：开 = 常驻 + 自启，关 = 全撤。
//! 目录移动/任务丢失由守护下次启动自愈；删除 config 目录即整体卸载（残留任务
//! 指向不存在路径时登录触发静默失败，无副作用）。

use std::path::Path;

/// 任务名（固定 ASCII，避免 schtasks 命令行编码歧义）
pub const TASK_NAME: &str = "XDIR_INDEX_DAEMON";

/// 注册用 XML 暂存文件名（cfg/index 下，注册后即删）
const TASK_XML_FILE: &str = "daemon-task.xml";

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// XML 文本转义（路径含 `&`/引号等不破档）
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 当前用户（DOMAIN\user；XML 的 Principal/LogonTrigger UserId 用）
fn current_user() -> String {
    match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
        (Ok(d), Ok(u)) if !d.is_empty() && !u.is_empty() => format!("{d}\\{u}"),
        (_, Ok(u)) if !u.is_empty() => u,
        _ => String::new(),
    }
}

/// 组装计划任务 XML（纯函数配 cargo test）：登录触发 + InteractiveToken 最高
/// 权限 + 电池双开 + 不限时（PT0S，缺省 72h 会强杀常驻守护）+ IgnoreNew。
/// user 为空（极端环境）时省略 UserId 两处，按注册者身份运行
fn task_xml(daemon_exe: &Path, cfg_root: &Path, user: &str) -> String {
    let cmd = xml_escape(&daemon_exe.to_string_lossy());
    let args = format!(
        "--index-daemon \"{}\"",
        xml_escape(&cfg_root.to_string_lossy())
    );
    let user_line = if user.is_empty() {
        String::new()
    } else {
        let u = xml_escape(user);
        format!("      <UserId>{u}</UserId>\n")
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals>
    <Principal id="Author">
{user_line}      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <Duration>PT10M</Duration>
      <WaitTimeout>PT1H</WaitTimeout>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
{user_line}    </LogonTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>{cmd}</Command>
      <Arguments>{args}</Arguments>
    </Exec>
  </Actions>
</Task>"#
    )
}

/// XML 落盘为 UTF-16 LE + BOM（schtasks 导入的通行编码，声明与实际一致）
fn write_utf16_xml(p: &Path, xml: &str) -> std::io::Result<()> {
    let mut u16s = vec![0xFEFF];
    u16s.extend(xml.encode_utf16());
    let mut bytes = Vec::with_capacity(u16s.len() * 2);
    for w in u16s {
        bytes.extend_from_slice(&w.to_le_bytes());
    }
    std::fs::write(p, bytes)
}

/// `/Delete` 结果判定（纯函数配 cargo test）：成功即成；任务不存在同样视为
/// 已达成「删完」目标（schtasks 中英文案分别是「does not exist」「找不到指定的任务」
/// ——注意中文案不含「不存在」字样；**GBK 字节经 UTF-8 lossy 解码即乱码，
/// 文案匹配只作快捷旁路**，权威判定走 task_exists 的 exit code）
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

/// 任务存在性探测（exit code 权威判定，规避 stderr 编码差异：中文系统
/// schtasks 输出为 GBK 字节，UTF-8 lossy 解码后文案全乱，匹配不可靠）
fn task_exists() -> bool {
    matches!(schtasks(&["/Query", "/TN", TASK_NAME]), Ok(out) if out.status.success())
}

/// 注册（幂等覆盖）登录自启任务：XML 写暂存文件 → `schtasks /Create /F /XML`。
/// 由提权守护进程调用——主程序普通权限注册不动 /RL HIGHEST 任务
pub fn register_autostart_task(daemon_exe: &Path, cfg_root: &Path) -> Result<(), String> {
    let xml_path = cfg_root.join("index").join(TASK_XML_FILE);
    write_utf16_xml(&xml_path, &task_xml(daemon_exe, cfg_root, &current_user()))
        .map_err(|e| format!("任务 XML 写入失败：{e}"))?;
    let xml_str = xml_path.to_string_lossy().to_string();
    let out = schtasks(&["/Create", "/F", "/TN", TASK_NAME, "/XML", &xml_str]);
    let _ = std::fs::remove_file(&xml_path);
    let out = out?;
    if !out.status.success() {
        return Err(format!(
            "schtasks 注册失败（{}）：{}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// 删除自启任务（不存在时视为成功——关闭语义要求「删完」，缺失即已达成）。
/// 判定链：exit 0 即成；文案旁路命中（GBK 乱码时失灵）即成；仍不明朗则以
/// task_exists 复核——任务已不在 = 目标达成，其余才是真失败
pub fn delete_autostart_task() -> Result<(), String> {
    let out = schtasks(&["/Delete", "/F", "/TN", TASK_NAME])?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() || delete_succeeded(false, &stderr) || !task_exists() {
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
    fn task_xml_shapes_logon_highest_task() {
        let xml = task_xml(
            Path::new("C:\\cfg\\index\\x-dir-daemon.exe"),
            Path::new("C:\\cfg"),
            "DESKTOP-WWC\\PRIME",
        );
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        // 电池双开 + 不限时（schtasks 命令行注册做不到的三件事，改 XML 的全部动机）
        assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(xml.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains("<UserId>DESKTOP-WWC\\PRIME</UserId>"));
        // 动作 = 守护副本绝对路径 + 配置根参数（参数带引号，含空格路径安全）
        assert!(xml.contains("<Command>C:\\cfg\\index\\x-dir-daemon.exe</Command>"));
        assert!(xml.contains(r#"<Arguments>--index-daemon "C:\cfg"</Arguments>"#));
    }

    #[test]
    fn task_xml_escapes_xml_specials_in_paths() {
        let xml = task_xml(
            Path::new("C:\\a&b<c>\\x-dir-daemon.exe"),
            Path::new("C:\\d&e"),
            "u",
        );
        assert!(xml.contains("<Command>C:\\a&amp;b&lt;c&gt;\\x-dir-daemon.exe</Command>"));
        assert!(xml.contains(r#"<Arguments>--index-daemon "C:\d&amp;e"</Arguments>"#));
    }

    #[test]
    fn task_xml_omits_userid_when_user_empty() {
        let xml = task_xml(Path::new("d.exe"), Path::new("c"), "");
        assert!(!xml.contains("<UserId>"));
    }

    #[test]
    fn xml_escape_covers_all_five() {
        assert_eq!(xml_escape(r#"a&<>"'"#), "a&amp;&lt;&gt;&quot;&apos;");
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
