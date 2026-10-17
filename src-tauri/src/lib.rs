mod clip;
mod commands;
mod config;
mod fs;
mod icons;
mod img;
mod index;
mod jobs;
mod native_menu;
mod native_ops;
mod office;
mod ole_dnd;
mod pdf;
mod watch;

use fs::cache::SnapshotCache;
use icons::IconStore;
use jobs::JobManager;
use std::sync::{Mutex, OnceLock};
use watch::WatchManager;

pub struct AppState {
    pub cache: Mutex<SnapshotCache>,
    pub jobs: JobManager,
    pub watches: WatchManager,
    /// V2 真实图标/缩略图 LRU 缓存（铁律 2：缩略图上限 200）
    pub icons: Mutex<IconStore>,
}

/// 启动参数（供 --bench 内存基准模式等使用）
pub static LAUNCH_ARGS: OnceLock<Vec<String>> = OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    let _ = LAUNCH_ARGS.set(std::env::args().skip(1).collect::<Vec<_>>());
    // 索引守护模式：提权子进程，不创建 WebView，永驻至 stop 文件（§全盘索引）
    if LAUNCH_ARGS
        .get()
        .is_some_and(|a| a.iter().any(|x| x == "--index-daemon"))
    {
        index::daemon::run();
    }
    // 便携化：WebView2 用户数据目录指向程序本地（必须先于 WebView2 环境创建，§6.9）
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        let wv = dir.join("WebView2");
        if std::fs::create_dir_all(&wv).is_ok() {
            // edition 2024 中 set_var 为 unsafe；此处仍在单线程启动阶段，无并发读
            unsafe {
                std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &wv);
            }
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 日志：exe 旁 logs/，5MB 滚动（§6.9/§6.10；release=info / dev=debug）
        .plugin(
            tauri_plugin_log::Builder::new()
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .targets(vec![tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Folder {
                        path: config::config_root()
                            .parent()
                            .map(|p| p.join("logs"))
                            .unwrap_or_else(|| std::path::PathBuf::from("logs")),
                        file_name: Some("x-dir".into()),
                    },
                )])
                .build(),
        )
        // panic 落盘（附版本号与 Windows 版本，§6.10）
        .setup(|_app| {
            std::panic::set_hook(Box::new(|info| {
                log::error!("panic: {info}");
            }));
            // 索引模式预热：后台把已建索引 mmap prefault 进文件缓存，消除首次查询冷映射
            crate::index::warm_views_async();
            // 移除 Win11 对聚焦无边框窗口绘制的顶部强调色边（DWMWA_BORDER_COLOR =
            // 固定色值）：应用有自己的卡片视觉，系统蓝线与其冲突
            #[cfg(windows)]
            {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::Graphics::Dwm::{DWMWA_BORDER_COLOR, DwmSetWindowAttribute};
                if let Some(w) = _app.get_webview_window("main")
                    && let Ok(hwnd) = w.hwnd()
                {
                    let none: u32 = 0x00F1_ECE9; // 与 --np-bg 同色，融入画布
                    unsafe {
                        let _ = DwmSetWindowAttribute(
                            HWND(hwnd.0),
                            DWMWA_BORDER_COLOR,
                            &none as *const u32 as *const std::ffi::c_void,
                            std::mem::size_of::<u32>() as u32,
                        );
                    }
                }
            }
            // 关闭 WebView2 浏览器加速键（F5/Ctrl+R 重载、Ctrl+F 查找栏、Ctrl+P
            // 打印、Ctrl+±缩放）：全局快捷键由前端 lib/keyboard.ts 全权路由，否则
            // 输入框聚焦/弹窗打开时这些键漏给 WebView2 造成整页重载（内存态全丢）
            // 或弹系统 UI。仅 release 构建：dev 构建保留 F12 DevTools 原生入口，
            // 危险键泄漏由 keyboard.ts 顶部的拦截网兜住。微软文档口径：编辑/移动
            // 类按键（Ctrl+C/V/X/A/Z、Home/End/PgUp/PgDn）不受此设置影响
            #[cfg(all(windows, not(debug_assertions)))]
            if let Some(w) = _app.get_webview_window("main") {
                let _ = w.with_webview(|webview| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                    use windows_core::Interface;
                    if let Ok(core) = webview.controller().CoreWebView2()
                        && let Ok(settings) = core.Settings()
                        && let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>()
                    {
                        let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
                    }
                });
            }
            Ok(())
        })
        .manage(AppState {
            cache: Mutex::new(SnapshotCache::new(20)),
            jobs: JobManager::new(),
            watches: WatchManager::new(),
            icons: Mutex::new(IconStore::new()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::files::list_dir,
            commands::files::list_dirs,
            commands::files::check_conflicts,
            commands::files::rename_item,
            commands::files::create_dir,
            commands::files::create_file,
            commands::files::open_item,
            commands::jobs_cmds::copy_items,
            commands::jobs_cmds::move_items,
            commands::jobs_cmds::delete_items,
            commands::jobs_cmds::restore_trash,
            commands::jobs_cmds::cancel_job,
            commands::jobs_cmds::pause_job,
            commands::jobs_cmds::resume_job,
            commands::drives::get_drives,
            commands::drives::get_volume,
            commands::drives::get_known_folder,
            commands::img_cmds::img_compress,
            commands::img_cmds::img_watermark,
            commands::img_cmds::img_convert,
            commands::img_cmds::img_resize,
            commands::img_cmds::img_montage,
            commands::pdf_cmds::pdf_page_count,
            commands::pdf_cmds::pdf_merge,
            commands::pdf_cmds::pdf_split,
            commands::pdf_cmds::pdf_watermark,
            commands::pdf_cmds::pdf_extract_pages,
            commands::pdf_cmds::pdf_remove_pages,
            commands::pdf_cmds::pdf_rotate,
            commands::pdf_cmds::pdf_compress,
            commands::pdf_cmds::images_to_pdf,
            commands::office_cmds::office_to_pdf,
            commands::office_cmds::clean_office_meta,
            commands::office_cmds::office_to_text,
            commands::text_cmds::convert_encoding,
            commands::text_cmds::merge_csv,
            commands::text_cmds::merge_texts,
            commands::text_cmds::zip_files,
            commands::text_cmds::save_text_file,
            commands::archive_cmds::extract_archives,
            commands::analyze_cmds::find_duplicates,
            commands::analyze_cmds::dir_sizes,
            commands::analyze_cmds::compare_dirs,
            commands::config_cmds::get_settings,
            commands::config_cmds::save_settings,
            commands::config_cmds::get_launch_args,
            commands::config_cmds::list_workspaces,
            commands::config_cmds::load_workspace,
            commands::config_cmds::save_workspace,
            commands::config_cmds::delete_workspace,
            commands::config_cmds::export_config,
            commands::config_cmds::import_config,
            commands::terminal::open_terminal,
            commands::watch::watch_dir,
            commands::watch::unwatch_dir,
            commands::fake::fake_list_dir,
            commands::search::search_dir,
            commands::search::search_all,
            commands::search::suggest_paths,
            commands::search::cancel_search,
            commands::index::index_status,
            commands::index::enable_index_mode,
            commands::index::disable_index_mode,
            commands::clipboard::set_clipboard_files,
            commands::clipboard::get_clipboard_files,
            commands::clipboard::clear_clipboard,
            commands::icons::get_file_icons,
            commands::preview::preview_read_text,
            commands::preview::preview_extract_office,
            commands::preview::preview_list_archive,
            commands::preview::preview_tiff_data_url,
            commands::native::show_context_menu,
            commands::native::start_drag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
