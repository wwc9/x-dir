//! 应用更新检查（关于浮窗 + 启动静默检查）：Rust 侧派发 PowerShell 直取仓库根
//! update.json。不走 WebView fetch——实测 WebView 内拉取不稳：Gitee API 匿名调用
//! 被 WAF 以 "403 rate limit" 拒绝（curl 同地址 200）、GitHub raw 受 WebView2 代理态
//! 影响超时。PowerShell 走系统代理设置：直连的 Gitee 与需代理的 GitHub 皆可工作；
//! 进程模型复用 office.rs 的 COM 派发惯例（CREATE_NO_WINDOW 防闪窗）。

use serde::{Deserialize, Serialize};

/// 双源清单地址（label 用于 UI 逐源失败原因展示）。
/// Gitee 直取 raw.giteeusercontent.com（免 gitee.com 一跳 302；裸地址实测可用、
/// 不需要签名参数）。
const MANIFEST_SOURCES: &[(&str, &str)] = &[
    (
        "Gitee",
        "https://raw.giteeusercontent.com/wwc9/x-dir/raw/main/update.json",
    ),
    (
        "GitHub",
        "https://raw.githubusercontent.com/wwc9/x-dir/main/update.json",
    ),
];

const FETCH_TIMEOUT_SECS: u64 = 8;

/// 仓库清单（update.json）文件结构：version 必需；其余可选（camelCase）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    version: String,
    pub_date: Option<String>,
    notes: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManifestDto {
    pub version: String,
    pub pub_date: Option<String>,
    pub notes: Vec<String>,
    pub source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFetchResult {
    pub manifest: Option<UpdateManifestDto>,
    pub errors: Vec<String>,
}

/// 解析清单文本：version 必需非空；notes/pubDate 容缺省
fn parse_manifest(text: &str, source: &str) -> Result<UpdateManifestDto, String> {
    let file: ManifestFile =
        serde_json::from_str(text).map_err(|e| format!("响应格式异常（{e}）"))?;
    let version = file.version.trim().to_string();
    if version.is_empty() {
        return Err("version 为空".into());
    }
    Ok(UpdateManifestDto {
        version,
        pub_date: file.pub_date,
        notes: file.notes.unwrap_or_default(),
        source: source.to_string(),
    })
}

/// 单源拉取：成功返回响应文本；失败返回 UI 可读原因。
/// IWR 对非 2xx 抛异常，catch 里输出机器可读标记 __ERR__<statusCode>（0 = 连不上/超时）。
fn ps_fetch(url: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         [Console]::OutputEncoding=[Text.Encoding]::UTF8; \
         [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; \
         try {{ \
         $r = Invoke-WebRequest -Uri '{url}' -UseBasicParsing -TimeoutSec {timeout}; \
         Write-Output $r.Content; \
         }} catch {{ \
         $code = 0; \
         if ($_.Exception.Response) {{ $code = [int]$_.Exception.Response.StatusCode; }} \
         Write-Output ('__ERR__' + $code); \
         }}",
        url = url,
        timeout = FETCH_TIMEOUT_SECS,
    );
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("无法启动 PowerShell：{e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if let Some(code) = text.strip_prefix("__ERR__") {
        return Err(match code {
            "0" => format!("网络不可达或超时（{FETCH_TIMEOUT_SECS}s）"),
            other => format!("HTTP {other}"),
        });
    }
    if text.is_empty() {
        return Err("响应为空".into());
    }
    Ok(text)
}

/// 逐源直取清单：单源失败（非 2xx/连不上/超时/解析失败）记入 errors 后换下一源。
/// 阻塞 IO（进程派发 + 网络）沉到 spawn_blocking，不占 async 运行时线程。
#[tauri::command]
pub async fn fetch_update_manifest() -> UpdateFetchResult {
    tauri::async_runtime::spawn_blocking(|| {
        let mut errors = Vec::new();
        for (label, url) in MANIFEST_SOURCES {
            match ps_fetch(url) {
                Err(msg) => errors.push(format!("{label}：{msg}")),
                Ok(text) => match parse_manifest(&text, label) {
                    Ok(dto) => {
                        return UpdateFetchResult {
                            manifest: Some(dto),
                            errors,
                        };
                    }
                    Err(msg) => errors.push(format!("{label}：{msg}")),
                },
            }
        }
        UpdateFetchResult {
            manifest: None,
            errors,
        }
    })
    .await
    .unwrap_or_else(|_| UpdateFetchResult {
        manifest: None,
        errors: vec!["内部错误：更新检查任务失败".into()],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_manifest_camel_case() {
        let m = parse_manifest(
            r#"{"version":"0.2.0","pubDate":"2026-10-20","notes":["新增 A","修复 B"]}"#,
            "Gitee",
        )
        .unwrap();
        assert_eq!(m.version, "0.2.0");
        assert_eq!(m.pub_date.as_deref(), Some("2026-10-20"));
        assert_eq!(m.notes, vec!["新增 A", "修复 B"]);
        assert_eq!(m.source, "Gitee");
    }

    #[test]
    fn parse_optional_fields_missing() {
        let m = parse_manifest(r#"{"version":"1.0"}"#, "GitHub").unwrap();
        assert_eq!(m.version, "1.0");
        assert_eq!(m.pub_date, None);
        assert!(m.notes.is_empty());
    }

    #[test]
    fn parse_rejects_missing_or_empty_version() {
        assert!(parse_manifest(r#"{"notes":[]}"#, "Gitee").is_err());
        assert!(parse_manifest(r#"{"version":"  ","pubDate":null}"#, "Gitee").is_err());
        assert!(parse_manifest("not json", "Gitee").is_err());
    }
}

/// 看门狗/自测共用日志（config/update-watchdog.log）：每次一键更新与自测全程
/// 落盘各阶段时间戳——远程排障「更新后没重开」直接读此文件即可归因
/// （2026-11-15：上一版看门狗因安装器进程名口径错误从未命中过，无日志是排障
/// 最大盲区）。Rust 侧时间戳 = epoch 秒（time crate 未开 formatting feature，
/// 同 worklog 口径）；PS 侧写人类可读本地时间。
pub fn append_watchdog_log(msg: &str) {
    let p = crate::config::config_root().join("update-watchdog.log");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{ts}] {msg}");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
    {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

/// 版本号白名单（进 PowerShell 单引号串前的唯一防线）：清单来自远端 JSON，
/// version 字段被拼进看门狗脚本，只许 semver 常见字符，杜绝注入
fn valid_watchdog_version(v: &str) -> bool {
    !v.is_empty()
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'))
}

/// 构建看门狗 PS 脚本（独立成纯函数配单测：进程名口径是历史踩坑点——
/// updater 插件把下载的安装器落到 %TEMP%\{产品名}-{版本}-updater-*\，
/// 文件名 = {产品名}-{版本}-installer.exe（产品名 = tauri productName
/// "X-Dir"，带连字符），进程名口径据此三重兜底：精确临时名 / 旧口径
/// x64-setup / 通配任意 X-Dir-*-installer）
fn build_watchdog_script(version: &str, exe: &str, log: &str) -> String {
    format!(
        r#"$log = '{log}'; $exe = '{exe}'
function Log([string]$m) {{ Add-Content -Path $log -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m) }}
Log 'watchdog: start, waiting installer (max 120s)'
$pat = @('X-Dir-{v}-installer*', 'X-Dir_{v}_x64-setup*', 'X-Dir-*-installer*')
$p = $null
for ($i = 0; $i -lt 120; $i++) {{ $p = Get-Process -Name $pat -ErrorAction SilentlyContinue; if ($p) {{ break }}; Start-Sleep 1 }}
if (-not $p) {{ Log 'watchdog: installer never appeared, give up'; exit }}
Log ('watchdog: installer pid=' + (($p | ForEach-Object {{ [string]$_.Id }}) -join ','))
$p | Wait-Process -Timeout 240 -ErrorAction SilentlyContinue
Log 'watchdog: installer exited'
Start-Sleep -Seconds 2
$up = $false
for ($i = 0; $i -lt 30; $i++) {{ if (Get-Process -Name 'x-dir' -ErrorAction SilentlyContinue) {{ $up = $true; break }}; Start-Sleep 1 }}
if ($up) {{ Log 'watchdog: app already running (installer /R worked), exit'; exit }}
Log 'watchdog: app not running 30s after install, relaunching'
Start-Process -FilePath $exe
Log 'watchdog: relaunched'
"#,
        log = log,
        exe = exe,
        v = version,
    )
}

/// 一键更新看门狗（2026-11-12 用户反馈「更新完成后没有提示、未自动重开」；
/// 2026-11-15 二次修正后降级为兜底）：插件 install 完成前应用即 exit(0)，
/// 正常重启链路 = NSIS 模板 .onInstSuccess 的 /R 自启（installer.nsi 修正后
/// 已生效）；看门狗只兜底「/R 也失败」的场景——下载前由前端拉起分离进程
/// （CREATE_NO_WINDOW，随父退出存活）：① 通配等安装器进程出现（钳 120s）；
/// ② 等安装器退出（钳 240s）；③ 落定后应用未运行则启动新版（插件 /R 成功时
/// 检测到实例直接静默退出，绝不多开）。全程写 update-watchdog.log。
#[tauri::command]
pub fn spawn_update_watchdog(version: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if !valid_watchdog_version(&version) {
        return Err(format!("版本号异常：{version}"));
    }
    let exe = std::env::current_exe()
        .map_err(|e| format!("取应用路径失败：{e}"))?
        .to_string_lossy()
        .replace('\'', "''");
    let log = crate::config::config_root()
        .join("update-watchdog.log")
        .to_string_lossy()
        .replace('\'', "''");
    append_watchdog_log(&format!("watchdog: spawned for update to v{version}"));
    let script = build_watchdog_script(&version, &exe, &log);
    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("看门狗启动失败：{e}"))
}

/// 一键更新全链路自测（2026-11-15，`--self-update-test` 启动参数触发）：
/// 与 AboutDialog 一键更新同链路（updater check → 看门狗 → download_and_install，
/// 仅省 UI 进度），供 tools/update-selftest.ps1 在本机回归「更新后自动重开」。
/// 版本持平即空转退出，故安装器 /R /ARGS 透传该参数到新版也不会循环更新。
/// 成功路径插件在拉起安装器后 std::process::exit(0)，重启由安装器 /R 负责。
pub fn maybe_self_update_test(app: &tauri::AppHandle) {
    if !std::env::args().any(|a| a == "--self-update-test") {
        return;
    }
    use tauri_plugin_updater::UpdaterExt;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        append_watchdog_log(&format!(
            "selftest: start, current v{}",
            app.package_info().version
        ));
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                append_watchdog_log(&format!("selftest: updater build failed: {e}"));
                return;
            }
        };
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            Ok(None) => {
                append_watchdog_log("selftest: no update available (versions equal), done");
                return;
            }
            Err(e) => {
                append_watchdog_log(&format!("selftest: check failed: {e}"));
                return;
            }
        };
        append_watchdog_log(&format!(
            "selftest: update found v{}, spawning watchdog",
            update.version
        ));
        if let Err(e) = spawn_update_watchdog(update.version.clone()) {
            append_watchdog_log(&format!("selftest: watchdog spawn failed: {e}"));
        }
        if let Err(e) = update.download_and_install(|_got, _total| {}, || {}).await {
            append_watchdog_log(&format!("selftest: download/install failed: {e}"));
            return;
        }
        append_watchdog_log("selftest: install returned (unexpected on Windows)");
    });
}

/// 更新状态文件结构（config/update-state.json）：仅记录上次运行版本
/// （运行态，非用户配置——不随 export_config 导出，同 clipboard.db 口径）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateState {
    last_version: String,
}

/// 纯判定：旧状态 → 升级回执（from ≠ current 且 old 存在时 Some(from, current)）。
/// 配单测（锁 JSON 解析与版本变化口径）。
fn update_notice(state_text: Option<&str>, current: &str) -> Option<(String, String)> {
    let old = state_text
        .and_then(|t| serde_json::from_str::<UpdateState>(t).ok())
        .map(|s| s.last_version)?;
    if old != current {
        Some((old, current.to_string()))
    } else {
        None
    }
}

/// 启动时记录/对比运行版本（2026-11-12 用户反馈「更新完成后没有提示」）：
/// 与上次运行版本不同 → 发 app-updated 事件，前端灵动岛回执「已更新到 vX」，
/// 让静默更新完成有感知；状态写回 config/update-state.json。
pub fn check_app_updated(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let current = app.package_info().version.to_string();
    let p = crate::config::config_root().join("update-state.json");
    let notice = update_notice(std::fs::read_to_string(&p).ok().as_deref(), &current);
    if let Ok(new_text) = serde_json::to_string(&serde_json::json!({ "lastVersion": current })) {
        let _ = std::fs::write(&p, new_text);
    }
    if let Some((from, to)) = notice {
        let _ = app.emit("app-updated", serde_json::json!({ "from": from, "to": to }));
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;

    #[test]
    fn update_notice_basic() {
        assert_eq!(
            update_notice(Some(r#"{"lastVersion":"0.1.7"}"#), "0.1.8"),
            Some(("0.1.7".into(), "0.1.8".into()))
        );
        assert_eq!(
            update_notice(Some(r#"{"lastVersion":"0.1.8"}"#), "0.1.8"),
            None
        );
    }

    #[test]
    fn update_notice_tolerates_missing_or_broken_state() {
        assert_eq!(update_notice(None, "0.1.8"), None);
        assert_eq!(update_notice(Some("not json"), "0.1.8"), None);
        assert_eq!(update_notice(Some("{}"), "0.1.8"), None);
    }
}

#[cfg(test)]
mod watchdog_tests {
    use super::*;

    #[test]
    fn version_whitelist_blocks_injection_and_semver_passes() {
        assert!(valid_watchdog_version("0.2.2"));
        assert!(valid_watchdog_version("0.10.3-beta.1"));
        assert!(!valid_watchdog_version(""));
        // 远端清单 version 含引号/换行/PS 元字符 → 必须拒绝（脚本注入防线）
        assert!(!valid_watchdog_version("0.2.2'); Start-Process calc; #"));
        assert!(!valid_watchdog_version("0.2.2\n"));
        assert!(!valid_watchdog_version("零.二"));
    }

    #[test]
    fn watchdog_script_uses_installer_temp_name_and_logs() {
        let s = build_watchdog_script("0.2.2", "C:\\App\\x-dir.exe", "C:\\App\\config\\w.log");
        // 插件临时安装器进程名 = {productName}-{version}-installer（2026-11-15 修正）
        assert!(s.contains("'X-Dir-0.2.2-installer*'"));
        // 旧口径（build-release 产物名）与通配兜底仍在
        assert!(s.contains("'X-Dir_0.2.2_x64-setup*'"));
        assert!(s.contains("'X-Dir-*-installer*'"));
        assert!(s.contains("$exe = 'C:\\App\\x-dir.exe'"));
        assert!(s.contains("Start-Process -FilePath $exe"));
        assert!(s.contains("$log = 'C:\\App\\config\\w.log'"));
        // 版本号注入必须进不了脚本（白名单在上游拦截，这里只守口径）
        assert!(!s.contains("'; Start-Process"));
    }
}
