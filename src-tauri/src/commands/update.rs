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
    ("Gitee", "https://raw.giteeusercontent.com/wwc9/x-dir/raw/main/update.json"),
    ("GitHub", "https://raw.githubusercontent.com/wwc9/x-dir/main/update.json"),
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
                        }
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
