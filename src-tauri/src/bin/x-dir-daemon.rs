//! 索引守护进程入口（2026-11-27 从主程序副本拆为独立 bin）：无条件 windows
//! 子系统——计划任务登录拉起与 UAC 拉起都永不弹控制台黑窗（debug 亦然）；
//! 日志落 config/index/daemon.log（index/daemon.rs dlog）。
//! 与主程序同 crate 同版本产出（Cargo.toml [[bin]]）；dev 与未来随包发布时
//! 主程序按同排路径优先取本 bin，便携/安装版未随包时回落复制主程序自身
//! （index/mod.rs 两级查找），以 `--index-daemon <config_root>` 提权拉起。
#![windows_subsystem = "windows"]

fn main() {
    x_dir_lib::daemon_main()
}
