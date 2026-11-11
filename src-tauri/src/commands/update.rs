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

/// 一键更新看门狗（2026-11-12 用户反馈「更新完成后没有提示、未自动重开」）：
/// NSIS 模板的 /R 自启实测未生效，改为下载前由前端先拉起本看门狗（分离进程
/// CREATE_NO_WINDOW，随父退出存活）：① 等安装器进程出现（下载需时长，钳 120s）；
/// ② 等安装器退出（钳 180s）；③ 落定后应用未运行则启动新版——插件 /R 自启
/// 成功时此处检测到实例直接静默退出，绝不多开；失败则兜底重启。
/// 安装器文件名口径 = build-release.ps1 产物 `X-Dir_{版本}_x64-setup.exe`
/// （进程名无扩展名）。
#[tauri::command]
pub fn spawn_update_watchdog(version: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = std::env::current_exe()
        .map_err(|e| format!("取应用路径失败：{e}"))?
        .to_string_lossy()
        .replace('\'', "''");
    let setup = format!("X-Dir_{version}_x64-setup");
    let script = format!(
        "$setup = '{setup}'; $exe = '{exe}'; \
         $p = $null; \
         for ($i = 0; $i -lt 120; $i++) {{ $p = Get-Process -Name $setup -ErrorAction SilentlyContinue; if ($p) {{ break }}; Start-Sleep 1 }}; \
         if (-not $p) {{ exit }}; \
         Wait-Process -Id $p.Id -Timeout 180 -ErrorAction SilentlyContinue; \
         Start-Sleep -Seconds 2; \
         for ($i = 0; $i -lt 10; $i++) {{ if (Get-Process -Name 'x-dir' -ErrorAction SilentlyContinue) {{ exit }}; Start-Sleep 1 }}; \
         Start-Process -FilePath $exe",
    );
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
