//! 内嵌 7-Zip 兜底引擎（2026-11-08）：官方未修改的 7z.exe / 7z.dll 随应用
//! resources 分发（tools/get-7zip.ps1 三重哈希锁定下载），以独立进程调用，
//! 覆盖进程内引擎不支持的能力——解压 rar / 分卷 / xz / bz2，压缩 7z / tar.gz
//! 与加密归档。arm's length 进程调用：本项目代码零 LGPL 义务，7-Zip 与
//! unRAR 许可声明随 THIRD-PARTY-NOTICES.txt 分发（§8 备案见 REQUIREMENTS）。

use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// dev 回退路径：源码树 src-tauri/binaries/7z.exe（CARGO_MANIFEST_DIR 编译期
/// 路径；发布物上源码树不存在，自然不命中）
pub(crate) fn sevenzip_exe_dev() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("7z.exe");
    p.exists().then_some(p)
}

/// 定位内嵌 7z.exe：打包环境 = resource_dir()/binaries/；dev 回退源码树。
/// 两处都缺 → Err（提示一次性运行 tools/get-7zip.ps1）
pub(crate) fn sevenzip_exe(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(rd) = app.path().resource_dir() {
        let p = rd.join("binaries").join("7z.exe");
        if p.exists() {
            return Ok(p);
        }
    }
    if let Some(p) = sevenzip_exe_dev() {
        return Ok(p);
    }
    Err("内嵌 7-Zip 未就绪：请在源码树运行 tools/get-7zip.ps1 下载（一次性）".into())
}

/// 密码参数：恒传 `-p{密码}`（密码为空 = 裸 `-p`）——7-Zip 在 stdin 非终端时
/// 遇加密包会尝试读 stdin，恒传可彻底杜绝交互挂起；密码错误走 exit 2 报错
pub(crate) fn password_arg(password: Option<&str>) -> String {
    format!("-p{}", password.unwrap_or(""))
}

/// stdout 进度行解析（纯函数）：`-bso0 -bsp1` 下 7-Zip 周期输出
/// 「 66% 20 + f28.bin」「  0%」样式行，取行首百分比；其余行返回 None
fn parse_progress_percent(line: &str) -> Option<u8> {
    let s = line.trim_start();
    let digits: &str = s.split('%').next()?;
    if digits.is_empty() || digits.len() > 3 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u8>().ok().filter(|v| *v <= 100)
}

/// 退出码分类（纯函数）：0 = 成功；1 = 警告（个别条目问题但整体完成）；
/// 2 = 失败——stderr 含密码/加密关键词 → 需要密码（前端凭 reason 码弹框重试），
/// 其余取 stderr 末非空行为人话
#[derive(Debug, PartialEq)]
pub(crate) enum SevenZipOutcome {
    Ok,
    Warning(String),
    NeedPassword,
    Failed(String),
}

pub(crate) fn classify_exit(code: i32, stderr: &str) -> SevenZipOutcome {
    match code {
        0 => SevenZipOutcome::Ok,
        1 => SevenZipOutcome::Warning(stderr_tail(stderr)),
        _ => {
            let lower = stderr.to_ascii_lowercase();
            if lower.contains("password") || lower.contains("encrypted") {
                SevenZipOutcome::NeedPassword
            } else if stderr.trim().is_empty() {
                SevenZipOutcome::Failed(format!("7z.exe 失败（exit {code}）"))
            } else {
                SevenZipOutcome::Failed(stderr_tail(stderr))
            }
        }
    }
}

/// stderr 末非空行（去 7-Zip 的「ERROR:」前缀装帧），截 200 字符防刷屏
fn stderr_tail(stderr: &str) -> String {
    let line = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let line = line.strip_prefix("ERROR: ").unwrap_or(line);
    let mut s: String = line.chars().take(200).collect();
    if line.chars().count() > 200 {
        s.push('…');
    }
    s
}

#[derive(Debug)]
pub(crate) enum SevenZipError {
    Cancelled,
    Failed(String),
}

/// 运行一次 7z.exe（args 含子命令与全部参数，密码用 password_arg）：
/// stdout 逐行解析进度回调（0-100 百分比），stderr 由独立线程收尾读取
/// （防管道写满死锁）；cancel 置位即杀进程树返回 Cancelled。stdin 恒 null
pub(crate) fn run_7z(
    exe: &Path,
    args: &[String],
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u8),
) -> Result<(SevenZipOutcome, Vec<String>), SevenZipError> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：后台任务不闪控制台窗
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| SevenZipError::Failed(format!("启动 7z.exe 失败：{e}")))?;
    let mut stderr_pipe = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(se) = stderr_pipe.as_mut() {
            let _ = se.read_to_string(&mut s);
        }
        s
    });
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err(SevenZipError::Failed("7z.exe stdout 缺失".into()));
    };
    let mut reader = std::io::BufReader::new(stdout);
    let mut cancelled = false;
    let mut line = String::new();
    let mut stdout_lines: Vec<String> = Vec::new();
    loop {
        if is_cancelled(cancel) {
            cancelled = true;
            break;
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
                if let Some(p) = parse_progress_percent(&trimmed) {
                    on_progress(p);
                }
                // 进度行不入清单（l -slt 的 Path/Size 块才是解析目标）
                if parse_progress_percent(&trimmed).is_none() && !trimmed.is_empty() {
                    stdout_lines.push(trimmed);
                }
            }
            Err(_) => break,
        }
    }
    if cancelled {
        let _ = child.kill();
        let _ = child.wait();
        return Err(SevenZipError::Cancelled);
    }
    let status = child
        .wait()
        .map_err(|e| SevenZipError::Failed(format!("等待 7z.exe 失败：{e}")))?;
    let stderr = stderr_thread.join().unwrap_or_default();
    Ok((
        classify_exit(status.code().unwrap_or(-1), &stderr),
        stdout_lines,
    ))
}

fn is_cancelled(c: &AtomicBool) -> bool {
    c.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_line_parse() {
        assert_eq!(parse_progress_percent("  66% 20 + prog\\f28.bin"), Some(66));
        assert_eq!(parse_progress_percent("0%"), Some(0));
        assert_eq!(parse_progress_percent("100%"), Some(100));
        assert_eq!(parse_progress_percent("  0M Scan"), None);
        assert_eq!(parse_progress_percent(""), None);
        assert_eq!(parse_progress_percent("abc% 5"), None);
        assert_eq!(parse_progress_percent("1234% 1 + x"), None);
        assert_eq!(parse_progress_percent("101%"), None);
    }

    #[test]
    fn exit_classification() {
        assert_eq!(classify_exit(0, ""), SevenZipOutcome::Ok);
        assert!(matches!(
            classify_exit(1, "WARNING: x locked"),
            SevenZipOutcome::Warning(_)
        ));
        assert_eq!(
            classify_exit(2, "ERROR: Wrong password"),
            SevenZipOutcome::NeedPassword
        );
        assert_eq!(
            classify_exit(2, "Cannot open encrypted archive. Wrong password?"),
            SevenZipOutcome::NeedPassword
        );
        assert!(matches!(
            classify_exit(2, "ERROR: some file fail"),
            SevenZipOutcome::Failed(_)
        ));
        assert!(matches!(classify_exit(7, ""), SevenZipOutcome::Failed(_)));
    }

    #[test]
    fn password_arg_always_present() {
        assert_eq!(password_arg(None), "-p");
        assert_eq!(password_arg(Some("")), "-p");
        assert_eq!(password_arg(Some("s3cret")), "-ps3cret");
    }

    /// 引擎 E2E（依赖 src-tauri/binaries/7z.exe，缺失时跳过）：打包 → 列表
    /// → 解包 → 内容一致；错误密码分类 NeedPassword
    #[test]
    fn run_7z_pack_list_extract_roundtrip() {
        let Some(exe) = sevenzip_exe_dev() else {
            eprintln!("skip: 内嵌 7-Zip 未下载（tools/get-7zip.ps1）");
            return;
        };
        let dir = std::env::temp_dir().join(format!("xdir-7z-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("payload")).unwrap();
        std::fs::write(dir.join("payload/a.txt"), "hello").unwrap();
        std::fs::write(dir.join("payload/b.txt"), "world").unwrap();
        let ar = dir.join("t.7z");
        let args = |v: Vec<&str>| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut seen = Vec::new();
        let (out, _) = run_7z(
            &exe,
            &args(vec![
                "a",
                ar.to_str().unwrap(),
                dir.join("payload").to_str().unwrap(),
                "-bso0",
                "-bsp1",
            ]),
            &AtomicBool::new(false),
            |p| seen.push(p),
        )
        .unwrap();
        assert_eq!(out, SevenZipOutcome::Ok);
        // 进度回调值全部合法（小包可能零条进度行，不强求非空）
        assert!(seen.iter().all(|p| *p <= 100));
        let (out, listing) = run_7z(
            &exe,
            &args(vec!["l", "-slt", "-p", ar.to_str().unwrap()]),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(out, SevenZipOutcome::Ok);
        // 清单行可用：-slt 块含 Path 与 Size 键
        assert!(listing.iter().any(|l| l.starts_with("Path = ")));
        assert!(listing.iter().any(|l| l.starts_with("Size = ")));
        let outdir = dir.join("out");
        std::fs::create_dir_all(&outdir).unwrap();
        let (out, _) = run_7z(
            &exe,
            &args(vec![
                "x",
                ar.to_str().unwrap(),
                &format!("-o{}", outdir.display()),
                "-y",
                "-bso0",
                "-bsp1",
                "-p",
            ]),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(out, SevenZipOutcome::Ok);
        assert_eq!(
            std::fs::read_to_string(outdir.join("payload/a.txt")).unwrap(),
            "hello"
        );
        // 错误密码 = NeedPassword（先造一个加密包）
        let enc = dir.join("enc.7z");
        run_7z(
            &exe,
            &args(vec![
                "a",
                enc.to_str().unwrap(),
                dir.join("payload/a.txt").to_str().unwrap(),
                "-psecret",
                "-mhe=on",
                "-bso0",
            ]),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let (out, _) = run_7z(
            &exe,
            &args(vec![
                "x",
                enc.to_str().unwrap(),
                &format!("-o{}", dir.join("out2").display()),
                "-y",
                "-bso0",
                "-pwrong",
            ]),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(out, SevenZipOutcome::NeedPassword);
        std::fs::remove_dir_all(&dir).ok();
    }
}
