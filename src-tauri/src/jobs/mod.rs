//! 长任务协议（§6.7）：全局串行队列 + 逐文件取消 + 100ms 进度节流 + 终态事件。

pub mod pick;

use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::fs::entry::path_exists;
use crate::fs::path::{
    file_name_of, is_reparse_dir, is_same_volume, join_name, parent_of, to_extended,
};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FailItem {
    pub path: String,
    pub message: String,
    /// 结构化失败原因（目前仅删除链路归因）：前端据 inUse 弹「解除占用」
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<FailReason>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: u32,
    pub phase: &'static str,
    pub total_files: u64,
    pub done_files: u64,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub current_path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JobDone {
    pub job_id: u32,
    pub ok: bool,
    pub cancelled: bool,
    pub failed: Vec<FailItem>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum JobKind {
    Copy,
    Move,
    /// permanent = false 移入回收站（trash crate）；true 直接永久删除（Shift+Del）
    Delete {
        permanent: bool,
    },
    /// PDF 合并 → output 输出文件
    PdfMerge {
        output: String,
    },
    /// PDF 合并扩展（2026-10-22）：按文件夹分组合并 + 空白页凑偶数；
    /// output 仅在 merge_by_folder=false 时作为统一输出
    PdfMergeEx {
        merge_by_folder: bool,
        auto_blank: bool,
        blank_first: bool,
        output: String,
    },
    /// PDF 拆分单页 → out_dir 输出目录
    PdfSplit {
        out_dir: String,
    },
    /// PDF 文字水印（2026-10-22 参数化：占位符/字体/颜色/位置/透明度/页范围）
    PdfWatermark {
        opts: crate::pdf::stamp::WatermarkOpts,
    },
    /// PDF 提取页（spec 选中的页）→ output 新文件
    PdfExtractPages {
        spec: String,
        output: String,
    },
    /// PDF 删除页（spec 指定的页被移除，保留其余）→ output 新文件
    PdfRemovePages {
        spec: String,
        output: String,
    },
    /// PDF 全部页相对旋转（原地保存，degrees 为 90 的倍数）
    PdfRotate {
        degrees: i64,
    },
    /// PDF 轻压缩（对象去重 + 重压缩），旁写 <stem>_压缩.pdf
    PdfCompress,
    /// 图片（PNG/JPEG）合并转 PDF，每图一页 → output
    ImagesToPdf {
        output: String,
    },
    /// Office 文档经 COM 转 PDF（PowerShell 派发，旁写 <stem>.pdf）
    OfficeToPdf,
    /// OOXML 隐私属性清理（docProps 重写），旁写 <stem>_清洁.<ext>
    CleanOfficeMeta,
    /// Office 文档导出文本 TXT（复用预览抽取管线，旁写 <stem>.txt）
    OfficeToText,
    /// 文本/表格编码转换（旁写 <stem><后缀>.<ext>）
    ConvertEncoding {
        target: crate::fs::textops::EncTarget,
    },
    /// CSV/TSV 合并（去重复表头）→ output（UTF-8 BOM）
    MergeCsv {
        output: String,
    },
    /// 文本合并（空行分隔）→ output（UTF-8 BOM）
    MergeTexts {
        output: String,
    },
    /// 压缩为 zip（文件平铺、文件夹递归含顶层目录）→ output
    ZipFiles {
        output: String,
    },
    /// Excel 工作簿合并（calamine 读 → rust_xlsxwriter 写 .xlsx）→ output
    MergeXlsx {
        mode: crate::fs::xlsx::XlsxMergeMode,
        output: String,
    },
    /// 解压 zip/7z：每包解到 <dest>/<包名>/ 子目录（dest 走 enqueue 的 dest 参数）
    Extract,
    /// 图片压缩（Auto/JPEG/PNG8/无损优化），旁写 <stem>_压缩.<ext>
    ImgCompress {
        opts: crate::img::CompressOpts,
    },
    /// 图片水印（文字/贴图，平铺或角标），旁写 <stem>_水印.<ext>
    ImgWatermark {
        opts: crate::img::WatermarkOpts,
    },
    /// 图片格式转换，旁写 <stem>_转换.<ext>
    ImgConvert {
        opts: crate::img::ConvertOpts,
    },
    /// 图片尺寸调整，旁写 <stem>_缩放.<ext>
    ImgResize {
        opts: crate::img::ResizeOpts,
    },
    /// 宫格拼图：多图 → 单张网格画布 → output
    ImgMontage {
        opts: crate::img::MontageOpts,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Policy {
    Overwrite,
    Skip,
    Rename,
}

impl Policy {
    pub fn parse(s: &str) -> Self {
        match s {
            "overwrite" => Policy::Overwrite,
            "rename" => Policy::Rename,
            _ => Policy::Skip,
        }
    }
}

pub(crate) struct EmitterState {
    pub(crate) app: AppHandle,
    last: Instant,
}

impl EmitterState {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            last: Instant::now() - Duration::from_millis(100),
        }
    }
    pub(crate) fn progress(&mut self, p: &JobProgress) {
        if self.last.elapsed() >= Duration::from_millis(100) {
            self.last = Instant::now();
            let _ = self.app.emit("job-progress", p);
        }
    }
}

thread_local! {
    /// 本任务线程的暂停旗标（enqueue 时装配，仅 Copy/Move 响应暂停——
    /// 借线程本地免掉把参数穿透 run_transfer → copy_or_move_path → copy_dir 三层）
    static JOB_PAUSED: std::cell::RefCell<Option<Arc<AtomicBool>>> =
        const { std::cell::RefCell::new(None) };
}

/// 暂停则阻塞等待至恢复/取消；进暂停发一次 paused 进度，恢复切回 running
fn maybe_wait_paused(prog: &mut JobProgress, em: &mut EmitterState) {
    let paused = JOB_PAUSED.with(|p| p.borrow().is_some());
    if !paused {
        return;
    }
    let is_paused = || {
        JOB_PAUSED.with(|p| {
            p.borrow()
                .as_ref()
                .is_some_and(|f| f.load(Ordering::SeqCst))
        })
    };
    if !is_paused() {
        return;
    }
    prog.phase = "paused";
    em.progress(prog);
    while is_paused() {
        if is_cancelled_static() {
            break;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    prog.phase = "running";
    em.progress(prog);
}

// 线程级取消旗标镜像：等待暂停期间检查取消（与 JOB_PAUSED 同批装配）
thread_local! {
    static JOB_CANCEL: std::cell::RefCell<Option<Arc<AtomicBool>>> =
        const { std::cell::RefCell::new(None) };
}
fn is_cancelled_static() -> bool {
    JOB_CANCEL.with(|c| {
        c.borrow()
            .as_ref()
            .is_some_and(|f| f.load(Ordering::SeqCst))
    })
}

pub struct JobManager {
    next_id: AtomicU32,
    cancels: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
    pauses: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
    /// 全局串行：持有该锁的任务才执行，其余排队（§6.7）
    slot: Arc<Mutex<()>>,
}

impl JobManager {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            pauses: Arc::new(Mutex::new(HashMap::new())),
            slot: Arc::new(Mutex::new(())),
        }
    }

    /// 暂停任务（仅 Copy/Move 生效：传输可中途停，批处理类瞬态任务不支持）
    pub fn pause(&self, job_id: u32) {
        if let Some(f) = self.pauses.lock().unwrap().get(&job_id) {
            f.store(true, Ordering::SeqCst);
        }
    }

    /// 恢复已暂停的任务
    pub fn resume(&self, job_id: u32) {
        if let Some(f) = self.pauses.lock().unwrap().get(&job_id) {
            f.store(false, Ordering::SeqCst);
        }
    }

    pub fn enqueue(
        &self,
        kind: JobKind,
        sources: Vec<String>,
        dest: Option<String>,
        policy: Policy,
        native: bool,
        app: AppHandle,
    ) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(id, cancel.clone());
        let paused = Arc::new(AtomicBool::new(false));
        self.pauses.lock().unwrap().insert(id, paused.clone());
        let slot = self.slot.clone();
        let cancels = Arc::clone(&self.cancels);
        let pauses = Arc::clone(&self.pauses);
        let app_h = app.clone();
        let cancels_h = Arc::clone(&cancels);
        let pauses_h = Arc::clone(&pauses);
        std::thread::spawn(move || {
            // panic 兜底（2026-11-01）：任务体任何 panic（含 dest.expect）原会让
            // job-done 永不发出——任务卡永久滞留、cancels/pauses 表项泄漏；
            // catch_unwind 后补发失败回执收场（panic 详情已由全局 hook 落日志）
            let body = std::panic::AssertUnwindSafe(move || {
                // 排队态先行上报：等全局串行槽期间，前端任务卡显示「排队中」
                let _ = app.emit(
                    "job-progress",
                    &JobProgress {
                        job_id: id,
                        phase: "queued",
                        total_files: 0,
                        done_files: 0,
                        total_bytes: 0,
                        done_bytes: 0,
                        current_path: String::new(),
                    },
                );
                // 排队等待可取消（2026-10-22 修复）：此前直接 slot.lock() 阻塞——
                // 全局槽被长任务/暂停任务占用时，排队中的任务连取消旗标都读不到
                //（要等拿到槽才开始读），任务卡永远停在「排队中」且取消无效。
                // 改为 80ms 轮询：排队期间取消 = 直接以 job-done(cancelled) 收尾
                //（无 dirty_dirs，缓存无需失效），前端移除任务卡
                let _guard = loop {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = app.emit(
                            "job-done",
                            &JobDone {
                                job_id: id,
                                ok: true,
                                cancelled: true,
                                failed: vec![],
                            },
                        );
                        cancels.lock().unwrap().remove(&id);
                        pauses.lock().unwrap().remove(&id);
                        return;
                    }
                    match slot.try_lock() {
                        Ok(g) => break g,
                        Err(_) => std::thread::sleep(std::time::Duration::from_millis(80)),
                    }
                };
                // 暂停旗标装配进线程本地（仅 Copy/Move；批处理类瞬态任务不响应暂停）
                if matches!(kind, JobKind::Copy | JobKind::Move) {
                    JOB_PAUSED.with(|p| *p.borrow_mut() = Some(Arc::clone(&paused)));
                    JOB_CANCEL.with(|c| *c.borrow_mut() = Some(Arc::clone(&cancel)));
                }
                let mut em = EmitterState::new(app.clone());
                let mut prog = JobProgress {
                    job_id: id,
                    phase: "running",
                    total_files: 0,
                    done_files: 0,
                    total_bytes: 0,
                    done_bytes: 0,
                    current_path: String::new(),
                };
                let mut failed: Vec<FailItem> = Vec::new();
                let mut dirty_dirs: Vec<String> = Vec::new();
                match &kind {
                    JobKind::Delete { permanent } => {
                        for p in &sources {
                            if let Some(par) = parent_of(p) {
                                dirty_dirs.push(par);
                            }
                        }
                        run_delete(
                            &sources,
                            *permanent,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::Copy | JobKind::Move => {
                        let dest = dest.expect("copy/move require dest");
                        dirty_dirs.push(dest.clone());
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        // V2 原生引擎：进度/冲突由系统 UI 承担；失败回退内置引擎（§3.2/§9）。
                        // Perform 有"部分完成"语义：报错但源已全部消失 = 实际已完成，
                        // 只把仍存在的源交给回退，避免对已移走的源二次搬移报假失败。
                        let mut todo: Vec<String> = sources.to_vec();
                        let mut native_done = false;
                        if native {
                            if crate::native_ops::transfer(
                                matches!(kind, JobKind::Move),
                                &sources,
                                &dest,
                            )
                            .is_ok()
                            {
                                native_done = true;
                            } else {
                                todo.retain(|s| path_exists(s));
                                native_done = todo.is_empty();
                            }
                        }
                        if native_done {
                            prog.total_files = sources.len() as u64;
                            prog.done_files = prog.total_files;
                            em.progress(&prog);
                        } else {
                            run_transfer(
                                matches!(kind, JobKind::Move),
                                &todo,
                                &dest,
                                policy,
                                &cancel,
                                &mut prog,
                                &mut em,
                                &mut failed,
                            );
                        }
                    }
                    JobKind::PdfMerge { output } => {
                        if let Some(par) = parent_of(output) {
                            dirty_dirs.push(par);
                        }
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::pdf::run_merge(
                            &sources,
                            output,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::PdfMergeEx {
                        merge_by_folder,
                        auto_blank,
                        blank_first,
                        output,
                    } => {
                        // 分组模式的输出写在各组目录（= 选中文件夹自身）内
                        if let Some(par) = parent_of(output) {
                            dirty_dirs.push(par);
                        }
                        for s in &sources {
                            if std::path::Path::new(s).is_dir() {
                                dirty_dirs.push(s.clone());
                            }
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        let opts = crate::pdf::MergeExOpts {
                            merge_by_folder: *merge_by_folder,
                            auto_blank: *auto_blank,
                            blank_first: *blank_first,
                            fallback_output: output.as_str(),
                        };
                        crate::pdf::run_merge_ex(
                            &sources,
                            &opts,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::PdfSplit { out_dir } => {
                        if let Some(par) = parent_of(out_dir) {
                            dirty_dirs.push(par);
                        }
                        if let Some(first) = sources.first() {
                            crate::pdf::run_split(
                                first,
                                out_dir,
                                &cancel,
                                &mut prog,
                                &mut em,
                                &mut failed,
                            );
                        }
                    }
                    JobKind::PdfWatermark { opts } => {
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::pdf::run_watermark(
                            &sources,
                            opts,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::PdfExtractPages { spec, output }
                    | JobKind::PdfRemovePages { spec, output } => {
                        if let Some(par) = parent_of(output) {
                            dirty_dirs.push(par);
                        }
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        let invert = matches!(kind, JobKind::PdfRemovePages { .. });
                        if let Some(first) = sources.first() {
                            crate::pdf::run_page_select(
                                first,
                                spec,
                                output,
                                invert,
                                &cancel,
                                &mut prog,
                                &mut em,
                                &mut failed,
                            );
                        }
                    }
                    JobKind::PdfRotate { degrees } => {
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        if let Some(first) = sources.first() {
                            crate::pdf::run_rotate(
                                first,
                                *degrees,
                                &cancel,
                                &mut prog,
                                &mut em,
                                &mut failed,
                            );
                        }
                    }
                    JobKind::PdfCompress => {
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::pdf::run_compress(
                            &sources,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::ImagesToPdf { output } => {
                        if let Some(par) = parent_of(output) {
                            dirty_dirs.push(par);
                        }
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::pdf::run_images_to_pdf(
                            &sources,
                            output,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::OfficeToPdf | JobKind::CleanOfficeMeta | JobKind::OfficeToText => {
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        match &kind {
                            JobKind::OfficeToPdf => crate::office::run_office_to_pdf(
                                &sources,
                                &cancel,
                                &mut prog,
                                &mut em,
                                &mut failed,
                            ),
                            JobKind::CleanOfficeMeta => crate::office::run_clean_meta(
                                &sources,
                                &cancel,
                                &mut prog,
                                &mut em,
                                &mut failed,
                            ),
                            _ => crate::office::run_extract_text(
                                &sources,
                                &cancel,
                                &mut prog,
                                &mut em,
                                &mut failed,
                            ),
                        }
                    }
                    JobKind::ConvertEncoding { target } => {
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::fs::textops::run_convert_encoding(
                            &sources,
                            *target,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::MergeCsv { output } | JobKind::MergeTexts { output } => {
                        if let Some(par) = parent_of(output) {
                            dirty_dirs.push(par);
                        }
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        let plain = matches!(kind, JobKind::MergeTexts { .. });
                        crate::fs::textops::merge_documents(
                            &sources,
                            output,
                            plain,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::ZipFiles { output } => {
                        if let Some(par) = parent_of(output) {
                            dirty_dirs.push(par);
                        }
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::fs::textops::run_zip(
                            &sources,
                            output,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::MergeXlsx { mode, output } => {
                        if let Some(par) = parent_of(output) {
                            dirty_dirs.push(par);
                        }
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::fs::xlsx::merge_xlsx(
                            &sources,
                            output,
                            *mode,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::Extract => {
                        if let Some(dest) = &dest {
                            dirty_dirs.push(dest.clone());
                            for s in &sources {
                                if let Some(par) = parent_of(s) {
                                    dirty_dirs.push(par);
                                }
                            }
                            crate::fs::archive::run_extract(
                                &sources,
                                dest,
                                &cancel,
                                &mut prog,
                                &mut failed,
                            );
                        }
                    }
                    JobKind::ImgCompress { opts } => {
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::img::run_compress(
                            &sources,
                            opts,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::ImgWatermark { opts } => {
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::img::run_watermark(
                            &sources,
                            opts,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::ImgConvert { opts } => {
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::img::run_convert(
                            &sources,
                            opts,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::ImgResize { opts } => {
                        for s in &sources {
                            if let Some(par) = parent_of(s) {
                                dirty_dirs.push(par);
                            }
                        }
                        crate::img::run_resize(
                            &sources,
                            opts,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                    JobKind::ImgMontage { opts } => {
                        if let Some(first) = sources.first()
                            && let Some(par) = parent_of(first)
                        {
                            dirty_dirs.push(par);
                        }
                        if let Some(par) = parent_of(&opts.output) {
                            dirty_dirs.push(par);
                        }
                        crate::img::run_montage(
                            &sources,
                            opts,
                            &cancel,
                            &mut prog,
                            &mut em,
                            &mut failed,
                        );
                    }
                }
                let cancelled = cancel.load(Ordering::SeqCst);
                let _ = app.emit(
                    "job-done",
                    &JobDone {
                        job_id: id,
                        ok: failed.is_empty(),
                        cancelled,
                        failed,
                    },
                );
                // 后端快照同步失效，前端收到 job-done 后重拉当前页（§6.7）
                let state = app.state::<crate::AppState>();
                let mut cache = state.cache.lock().unwrap_or_else(|p| p.into_inner());
                for d in dirty_dirs {
                    cache.invalidate(d.trim_end_matches('\\'));
                }
                drop(cache);
                cancels.lock().unwrap().remove(&id);
                pauses.lock().unwrap().remove(&id);
            });
            if std::panic::catch_unwind(body).is_err() {
                let _ = app_h.emit(
                    "job-done",
                    &JobDone {
                        job_id: id,
                        ok: false,
                        cancelled: false,
                        failed: vec![FailItem {
                            path: String::new(),
                            message: "任务内部错误（panic，详见日志）".into(),
                            reason: None,
                        }],
                    },
                );
                cancels_h.lock().unwrap().remove(&id);
                pauses_h.lock().unwrap().remove(&id);
            }
        });
        id
    }

    pub fn cancel(&self, job_id: u32) {
        if let Some(flag) = self.cancels.lock().unwrap().get(&job_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

pub(crate) fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::SeqCst)
}

/// 共享冲突（拖放事务/缩略图缓存等短暂占用源句柄）：可用短重试消解
fn is_sharing_violation(e: &io::Error) -> bool {
    // 32 = ERROR_SHARING_VIOLATION, 33 = ERROR_LOCK_VIOLATION
    matches!(e.raw_os_error(), Some(32) | Some(33))
}

/// 对可能撞上共享冲突的删除/改名做短重试（累计 <1.1s）；
/// 权限不足等永久错误立即返回，不拖慢真实失败的上报
fn with_sharing_retry<T>(mut f: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    const DELAYS_MS: [u64; 4] = [40, 120, 300, 600];
    let mut attempt = 0;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if attempt < DELAYS_MS.len() && is_sharing_violation(&e) => {
                std::thread::sleep(Duration::from_millis(DELAYS_MS[attempt]));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

fn push_fail(failed: &mut Vec<FailItem>, path: &str, e: &io::Error) {
    failed.push(FailItem {
        path: path.to_string(),
        message: e.to_string(),
        reason: None,
    });
}

// reparse 判定本体在 fs::path::is_reparse_dir（共享工具）：复制引擎不深入——
// 联接可指回祖先目录形成环，递归复制/统计会组合爆炸；处置 = 记为跳过
// 失败项，move 因此不会删源，用户能感知有内容未搬。

/// 目标带只读属性时清除（rename 覆盖前的重试；Explorer 同款行为）。
/// 返回 true = 已清除（值得重试），false = 原本无只读位或清除失败。
/// Windows 专属语义（readonly 位）；Unix 无对应概念，恒 false
#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)] // Windows readonly 位语义，非 Unix 权限位
fn clear_readonly_if_set(path: &str) -> bool {
    let p = to_extended(path);
    let Ok(md) = std::fs::metadata(&p) else {
        return false;
    };
    let mut perm = md.permissions();
    if !perm.readonly() {
        return false;
    }
    perm.set_readonly(false);
    std::fs::set_permissions(&p, perm).is_ok()
}

#[cfg(not(windows))]
fn clear_readonly_if_set(_path: &str) -> bool {
    false
}

/// 预统计文件数与字节（复制进度需要总量；目录算 0 字节）；联接目录不深入
fn walk_stats(path: &str, files: &mut u64, bytes: &mut u64) {
    let md = match std::fs::symlink_metadata(to_extended(path)) {
        Ok(m) => m,
        Err(_) => return,
    };
    if md.is_dir() && !is_reparse_dir(path) {
        if let Ok(rd) = std::fs::read_dir(to_extended(path)) {
            for entry in rd.flatten() {
                let p = entry.path();
                let s = p.to_string_lossy().into_owned();
                walk_stats(&s, files, bytes);
            }
        }
        return;
    }
    if !md.is_dir() {
        *files += 1;
        *bytes += md.len();
    }
}

/// 单项删除：permanent = false 移入回收站（trash），true 直接移除（文件/目录）。
/// Err 携带结构化原因（FailReason）：前端据 InUse 弹「解除占用」跟进
fn delete_one(p: &str, permanent: bool) -> Result<(), DeleteFailure> {
    let extended = to_extended(p);
    let ext = Path::new(&extended);
    if permanent {
        // Windows 删除只读项必须先清 FILE_ATTRIBUTE_READONLY（Explorer 同款）：
        // remove_file 对只读文件必报 ACCESS_DENIED；remove_dir_all 遇只读子项
        // 会先删掉其余内容再报错（部分删除 + 失败，2026-11-01 审查修复）
        clear_readonly_tree(ext);
        let r = if ext.is_dir() {
            std::fs::remove_dir_all(ext)
        } else {
            std::fs::remove_file(ext)
        };
        r.map_err(explain_permanent_failure)
    } else {
        trash::delete(ext).map_err(|e| explain_trash_failure(p, &e))
    }
}

// ---- 删除失败的友好归因 -------------------------------------------------
// trash 的 Windows 实现（IFileOperation）对占用/权限类失败只回
// Unknown { "Some operations were aborted" }，Display 即英文调试串，
// 用户无从下手（2026-11-01 复现锁定）。归因两步走：先看 trash 变体的
// 确定性错误；再用 DELETE 权限探测还原真实原因——探测 = 以删除权限
// 开句柄，系统拒绝时 Win32 码即真实堵点（32/33 占用、5 拒绝访问、2/3 已消失）。

/// 删除失败：用户可读消息 + 结构化原因（None = 未归因出）
#[derive(Clone, Debug)]
pub struct DeleteFailure {
    pub message: String,
    pub reason: Option<FailReason>,
}

impl DeleteFailure {
    fn new(message: impl Into<String>, reason: Option<FailReason>) -> Self {
        Self {
            message: message.into(),
            reason,
        }
    }
}

/// 删除失败的结构化原因（serde camelCase：inUse/accessDenied/missing）
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FailReason {
    /// 正被其他进程占用（前端弹「解除占用」）
    InUse,
    /// 无权限
    AccessDenied,
    /// 已被移动/删除
    Missing,
}

/// trash 变体自带明确语义的错误（跨平台）
fn explain_trash_variant(e: &trash::Error) -> Option<DeleteFailure> {
    match e {
        trash::Error::TargetedRoot => Some(DeleteFailure::new("不能删除驱动器根目录", None)),
        trash::Error::CouldNotAccess { .. } => Some(DeleteFailure::new(
            "无法访问该项（可能已被移动或删除，或无权限）",
            None,
        )),
        trash::Error::CanonicalizePath { .. } => Some(DeleteFailure::new(
            "路径无法解析（可能包含非法字符或已不存在）",
            None,
        )),
        _ => None,
    }
}

/// Win32 码 → 删除失败原因（DELETE 探测与永久删除的 io 错误共用）
#[cfg(windows)]
fn explain_win32_code(code: u32) -> Option<(&'static str, FailReason)> {
    match code {
        32 | 33 => Some((
            "正被其他程序占用（例如已在 Word/WPS 中打开），请关闭后重试",
            FailReason::InUse,
        )),
        5 => Some((
            "没有删除权限（拒绝访问），请检查权限或以管理员身份重试",
            FailReason::AccessDenied,
        )),
        2 | 3 => Some(("该项已被移动或删除，请刷新列表", FailReason::Missing)),
        _ => None,
    }
}

/// 以 DELETE 权限开句柄探测删除失败的真实原因（只读探测，不改文件）。
/// 文件/目录通用（目录需 FILE_FLAG_BACKUP_SEMANTICS）；返回 None = 探测不出，
/// 交由调用方回退原始错误
#[cfg(windows)]
fn probe_delete_reason(raw_path: &str) -> Option<(&'static str, FailReason)> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::core::PCWSTR;
    let extended = to_extended(raw_path);
    let wide: Vec<u16> = extended.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            DELETE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    };
    match handle {
        Ok(h) => {
            unsafe {
                let _ = CloseHandle(h);
            }
            None // 句柄能开 = 系统允许删，失败另有原因
        }
        Err(e) => {
            // CreateFileW 的错误 HRESULT 形如 0x8007XXXX（FACILITY_WIN32），
            // 低 16 位即真实 Win32 错误码
            let code = (e.code().0 as u32) & 0xFFFF;
            explain_win32_code(code)
        }
    }
}

/// 移入回收站失败 → 用户可读原因：变体语义 → DELETE 探测 → 原始错误兜底
fn explain_trash_failure(raw_path: &str, e: &trash::Error) -> DeleteFailure {
    if let Some(d) = explain_trash_variant(e) {
        return d;
    }
    #[cfg(windows)]
    if let Some((msg, reason)) = probe_delete_reason(raw_path) {
        return DeleteFailure::new(msg, Some(reason));
    }
    DeleteFailure::new(format!("无法移入回收站：{e}"), None)
}

/// 永久删除失败 → 同源归因（io 错误自带 Win32 码，无需再探测）
fn explain_permanent_failure(e: io::Error) -> DeleteFailure {
    #[cfg(windows)]
    if let Some((msg, reason)) = e.raw_os_error().and_then(|c| explain_win32_code(c as u32)) {
        return DeleteFailure::new(msg, Some(reason));
    }
    DeleteFailure::new(format!("无法删除：{e}"), None)
}

/// best-effort 清除树内全部只读属性（删除/覆盖前）。跳过 reparse 目录——
/// 联接不属本树内容且会引出环。失败静默：后续删除自会报出真实原因
#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)] // Windows readonly 位语义，非 Unix 权限位
fn clear_readonly_tree(root: &Path) {
    let Ok(md) = std::fs::symlink_metadata(root) else {
        return;
    };
    let mut perm = md.permissions();
    if perm.readonly() {
        perm.set_readonly(false);
        let _ = std::fs::set_permissions(root, perm);
    }
    if !md.is_dir() || md.file_type().is_symlink() {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            clear_readonly_tree(&e.path());
        }
    }
}

#[cfg(not(windows))]
fn clear_readonly_tree(_root: &Path) {}

fn run_delete(
    paths: &[String],
    permanent: bool,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    prog.total_files = paths.len() as u64;
    // 总量就绪即上报：前端立刻切到按项数的实时百分比条
    em.progress(prog);
    for p in paths {
        if is_cancelled(cancel) {
            return;
        }
        prog.current_path = p.clone();
        if let Err(e) = delete_one(p, permanent) {
            failed.push(FailItem {
                path: p.clone(),
                message: e.message,
                reason: e.reason,
            });
        }
        prog.done_files += 1;
        em.progress(prog);
    }
}

#[allow(clippy::too_many_arguments)] // 任务上下文（进度/事件/失败表）贯穿引擎全链路
fn run_transfer(
    is_move: bool,
    sources: &[String],
    dest: &str,
    policy: Policy,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    let mut total_files = 0u64;
    let mut total_bytes = 0u64;
    for s in sources {
        walk_stats(s, &mut total_files, &mut total_bytes);
    }
    prog.total_files = total_files;
    prog.total_bytes = if is_move && sources.iter().all(|s| dest_ok_same_volume(s, dest)) {
        0 // 同卷移动瞬时完成，进度直接 100%（§6.7）
    } else {
        total_bytes
    };
    // 总量就绪即上报：前端立刻从「…」不确定态切到实时百分比条，不等首项完成
    em.progress(prog);

    for src in sources {
        if is_cancelled(cancel) {
            return;
        }
        maybe_wait_paused(prog, em);
        let name = file_name_of(src);
        let target = join_name(dest, &name);
        let Some(target) = resolve_conflict(&target, policy) else {
            continue; // Skip：跳过该冲突项
        };
        copy_or_move_path(is_move, src, &target, policy, cancel, prog, em, failed);
    }
}

fn dest_ok_same_volume(src: &str, dest: &str) -> bool {
    is_same_volume(src, dest)
}

/// 冲突判定：返回实际应使用的目标路径；None = 跳过（§6.7 冲突流程）
fn resolve_conflict(target: &str, policy: Policy) -> Option<String> {
    if !path_exists(target) {
        return Some(target.to_string());
    }
    match policy {
        Policy::Skip => None,
        Policy::Rename => Some(pick::available_name(target)),
        Policy::Overwrite => Some(target.to_string()),
    }
}

#[allow(clippy::too_many_arguments)] // 同上：任务上下文贯穿
fn copy_or_move_path(
    is_move: bool,
    src: &str,
    target: &str,
    policy: Policy,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    // 源即目标（粘贴/拖放到原处 + Overwrite）：必须 no-op——
    // 继续执行会先 remove 目标（= 源本身）再改名失败，文件被永久删除
    if src.eq_ignore_ascii_case(target) {
        prog.done_files += 1;
        em.progress(prog);
        return;
    }
    // 目录联接不搬内容：记为跳过失败项（move 据此不删源，用户可感知）
    if is_reparse_dir(src) {
        failed.push(FailItem {
            path: src.to_string(),
            message: "已跳过目录联接（防止联接环导致无限复制）".to_string(),
            reason: None,
        });
        return;
    }
    let is_dir = std::fs::metadata(to_extended(src))
        .map(|m| m.is_dir())
        .unwrap_or(false);
    prog.current_path = src.to_string();
    let fail_before = failed.len();

    if is_dir {
        if is_move && is_same_volume(src, target) && !path_exists(target) {
            // 同卷目录移动：原子 rename
            if let Err(e) = std::fs::rename(to_extended(src), to_extended(target)) {
                push_fail(failed, src, &e);
            }
            prog.done_files += 1;
            em.progress(prog);
            return;
        }
        // 目录复制 / 跨卷移动 / 同卷覆盖合并：递归复制
        copy_dir(src, target, policy, cancel, prog, em, failed);
        if is_move && failed.len() == fail_before && !is_cancelled(cancel) {
            // 删源失败必须报出（2026-11-01：曾被 let _ = 吞掉——用户以为移动
            // 完成，实际源残留，无从感知）
            if let Err(e) = std::fs::remove_dir_all(to_extended(src)) {
                push_fail(failed, src, &e);
            }
        }
        return;
    }

    // 文件
    if is_move && is_same_volume(src, target) {
        // Overwrite = rename 原子替换（std::fs::rename 在 Windows 带
        // MOVEFILE_REPLACE_EXISTING）。绝不「先删目标再改名」——删除成功而
        // rename 失败（源被杀软/拖放事务占用超出重试窗）时目标已丢、源未动
        // = 用户原有文件凭空消失（2026-11-01 审查修复）。目标带只读属性时
        // rename 会被拒，清属性后重试一次（Explorer 同款行为）
        let renamed = with_sharing_retry(|| std::fs::rename(to_extended(src), to_extended(target)))
            .or_else(|first| {
                if clear_readonly_if_set(target) {
                    with_sharing_retry(|| std::fs::rename(to_extended(src), to_extended(target)))
                } else {
                    Err(first)
                }
            });
        match renamed {
            Ok(()) => prog.done_files += 1,
            Err(e) => push_fail(failed, src, &e),
        }
        em.progress(prog);
        return;
    }
    // 大文件分块复制：字节级进度（限频上报），块间可响应取消/暂停——
    // 单个大文件（如数 GB 的 zip）否则全程 0% 直到 100% 跳变
    let size = std::fs::metadata(to_extended(src))
        .map(|m| m.len())
        .unwrap_or(0);
    let copy_result = if size >= CHUNK_COPY_MIN {
        copy_file_chunked(src, target, prog, em, cancel)
    } else {
        match std::fs::copy(to_extended(src), to_extended(target)) {
            Ok(bytes) => {
                prog.done_bytes += bytes;
                Ok(())
            }
            Err(e) => Err(e),
        }
    };
    match copy_result {
        Ok(()) => {
            prog.done_files += 1;
            // 复制已成功、删源失败 ≠ 操作失败（文件已到位）：共享冲突短重试
            if is_move && let Err(e) = with_sharing_retry(|| std::fs::remove_file(to_extended(src)))
            {
                push_fail(failed, src, &e);
            }
        }
        // 用户取消：半成品已清理，不计失败（取消也是终态，§6.7）
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
        Err(e) => push_fail(failed, src, &e),
    }
    em.progress(prog);
}

/// 分块复制的尺寸阈值：低于此值 std::fs::copy 一步到位（调用次数更少）
const CHUNK_COPY_MIN: u64 = 8 * 1024 * 1024;

/// 大文件分块复制：1 MiB 块读写，done_bytes 逐块累计、≥100ms 限频上报；
/// 块间响应取消（清理半成品并返回 Interrupted）与暂停。完成后对齐
/// std::fs::copy 语义：保留权限与修改时间。
fn copy_file_chunked(
    src: &str,
    target: &str,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    cancel: &AtomicBool,
) -> io::Result<()> {
    use std::io::{Read, Write};
    let meta = std::fs::metadata(to_extended(src))?;
    let mut src_f = std::fs::File::open(to_extended(src))?;
    let mut dst_f = std::fs::File::create(to_extended(target))?;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut last_emit = std::time::Instant::now();
    loop {
        if is_cancelled(cancel) {
            drop(dst_f);
            let _ = std::fs::remove_file(to_extended(target));
            return Err(io::Error::new(io::ErrorKind::Interrupted, "已取消"));
        }
        maybe_wait_paused(prog, em);
        let n = src_f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        dst_f.write_all(&buf[..n])?;
        prog.done_bytes += n as u64;
        if last_emit.elapsed().as_millis() >= 100 {
            last_emit = std::time::Instant::now();
            em.progress(prog);
        }
    }
    dst_f.flush()?;
    drop(dst_f);
    std::fs::set_permissions(to_extended(target), meta.permissions())?;
    if let Ok(m) = meta.modified()
        && let Ok(f) = std::fs::OpenOptions::new()
            .write(true)
            .open(to_extended(target))
    {
        let _ = f.set_modified(m);
    }
    em.progress(prog);
    Ok(())
}

/// 递归复制目录（覆盖 = 合并，逐项应用 policy）。
/// 枚举失败必须计入 failed：move 流程据此判定"未完整复制"，绝不删除源目录。
fn copy_dir(
    src: &str,
    dst: &str,
    policy: Policy,
    cancel: &AtomicBool,
    prog: &mut JobProgress,
    em: &mut EmitterState,
    failed: &mut Vec<FailItem>,
) {
    if let Err(e) = std::fs::create_dir_all(to_extended(dst)) {
        push_fail(failed, dst, &e);
        return;
    }
    let rd = match std::fs::read_dir(to_extended(src)) {
        Ok(rd) => rd,
        Err(e) => {
            push_fail(failed, src, &e);
            return;
        }
    };
    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                // 枚举中途出错：后续内容未知，标记失败并停止（move 不删源）
                push_fail(failed, src, &e);
                return;
            }
        };
        if is_cancelled(cancel) {
            return;
        }
        maybe_wait_paused(prog, em);
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_src = join_name(src, &name);
        let child_dst = resolve_conflict(&join_name(dst, &name), policy);
        let Some(child_dst) = child_dst else { continue };
        copy_or_move_path(
            false, &child_src, &child_dst, policy, cancel, prog, em, failed,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_parse() {
        assert_eq!(Policy::parse("overwrite"), Policy::Overwrite);
        assert_eq!(Policy::parse("rename"), Policy::Rename);
        assert_eq!(Policy::parse("skip"), Policy::Skip);
        assert_eq!(Policy::parse("nonsense"), Policy::Skip);
    }

    #[test]
    fn delete_one_permanent_removes_file_and_dir() {
        let tmp = std::env::temp_dir().join(format!("xdir-delp-{}", std::process::id()));
        let dir = tmp.join("d");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        let file = tmp.join("f.txt");
        std::fs::write(&file, "y").unwrap();
        // 永久删除：目录整棵移除、文件直接移除
        assert!(delete_one(dir.to_str().unwrap(), true).is_ok());
        assert!(!dir.exists());
        assert!(delete_one(file.to_str().unwrap(), true).is_ok());
        assert!(!file.exists());
        // 回收站分支：源位置不再保留（是否进回收站由系统保证）
        let f2 = tmp.join("g.txt");
        std::fs::write(&f2, "z").unwrap();
        assert!(delete_one(f2.to_str().unwrap(), false).is_ok());
        assert!(!f2.exists());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn walk_stats_counts_files_and_bytes() {
        let tmp = std::env::temp_dir().join(format!("xdir-test-{}", std::process::id()));
        let dir = tmp.join("walk");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap(); // 5
        std::fs::write(sub.join("b.txt"), "xy").unwrap(); // 2
        let mut f = 0;
        let mut b = 0;
        walk_stats(dir.to_str().unwrap(), &mut f, &mut b);
        assert_eq!((f, b), (2, 7));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_conflict_overwrite_and_skip() {
        let tmp = std::env::temp_dir().join(format!("xdir-cfl-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let existing = tmp.join("x.txt");
        std::fs::write(&existing, "old").unwrap();
        let target = existing.to_str().unwrap();
        assert_eq!(
            resolve_conflict(target, Policy::Overwrite),
            Some(target.to_string())
        );
        assert_eq!(resolve_conflict(target, Policy::Skip), None);
        let renamed = resolve_conflict(target, Policy::Rename).unwrap();
        assert!(renamed.ends_with("x (2).txt"));
        assert_eq!(
            resolve_conflict(&tmp.join("absent.txt").to_string_lossy(), Policy::Skip).unwrap(),
            tmp.join("absent.txt").to_string_lossy()
        );
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn sharing_violation_classified() {
        assert!(is_sharing_violation(&io::Error::from_raw_os_error(32)));
        assert!(is_sharing_violation(&io::Error::from_raw_os_error(33)));
        // 权限不足等永久错误不重试
        assert!(!is_sharing_violation(&io::Error::from_raw_os_error(5)));
        assert!(!is_sharing_violation(&io::Error::other("无系统错误码")));
    }

    #[test]
    fn retry_resolves_transient_sharing_conflicts() {
        let calls = AtomicU32::new(0);
        let r = with_sharing_retry(|| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                Err(io::Error::from_raw_os_error(32))
            } else {
                Ok(n)
            }
        });
        assert_eq!(r.unwrap(), 2);
    }

    #[test]
    fn retry_fails_fast_on_permanent_error() {
        let r = with_sharing_retry(|| Err::<(), _>(io::Error::from_raw_os_error(5)));
        assert_eq!(r.unwrap_err().raw_os_error(), Some(5));
    }

    #[test]
    fn retry_removes_locked_then_released_source() {
        let tmp = std::env::temp_dir().join(format!("xdir-srcrm-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("a.txt");
        std::fs::write(&f, "data").unwrap();
        let path = f.to_str().unwrap().to_string();
        let r = with_sharing_retry(|| std::fs::remove_file(to_extended(&path)));
        assert!(r.is_ok());
        assert!(!path_exists(&path));
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn trash_variant_errors_explained_in_plain_words() {
        let root = explain_trash_variant(&trash::Error::TargetedRoot).unwrap();
        assert!(root.message.contains("根目录"), "actual: {}", root.message);
        let access =
            explain_trash_variant(&trash::Error::CouldNotAccess { target: "x".into() }).unwrap();
        assert!(
            access.message.contains("无法访问"),
            "actual: {}",
            access.message
        );
    }

    #[test]
    fn permanent_failure_maps_access_denied_and_keeps_raw_fallback() {
        let denied = explain_permanent_failure(io::Error::from_raw_os_error(5));
        assert_eq!(denied.reason, Some(FailReason::AccessDenied));
        assert!(
            denied.message.contains("权限"),
            "actual: {}",
            denied.message
        );
        let fallback = explain_permanent_failure(io::Error::other("boom"));
        assert_eq!(fallback.reason, None);
        assert!(
            fallback.message.contains("boom"),
            "actual: {}",
            fallback.message
        );
    }

    /// IFileOperation 对占用只回无信息的 aborted（2026-11-01 复现），
    /// 锁定场景必须靠 DELETE 探测归因为「正被其他程序占用」
    #[cfg(windows)]
    #[test]
    fn trash_failure_on_locked_file_blames_occupation() {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::{CloseHandle, GENERIC_READ};
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, OPEN_EXISTING,
        };
        use windows::core::PCWSTR;
        let tmp = std::env::temp_dir().join(format!("xdir-lockprobe-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("locked.doc");
        std::fs::write(&f, "x").unwrap();
        let path = f.to_str().unwrap().to_string();
        let wide: Vec<u16> = f.as_os_str().encode_wide().chain(Some(0)).collect();
        // Word 同款锁法：只允许他人读（拒绝对它写/删）
        let h = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                GENERIC_READ.0,
                FILE_SHARE_READ,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .unwrap();
        let aborted = || trash::Error::Unknown {
            description: "Some operations were aborted".into(),
        };
        let msg = explain_trash_failure(&path, &aborted());
        assert_eq!(msg.reason, Some(FailReason::InUse));
        assert!(msg.message.contains("占用"), "actual: {}", msg.message);
        unsafe {
            let _ = CloseHandle(h);
        }
        // 解锁后探测不再命中，回退含原始错误的兜底文案（reason 归因不出）
        assert!(probe_delete_reason(&path).is_none());
        let fallback = explain_trash_failure(&path, &aborted());
        assert_eq!(fallback.reason, None);
        assert!(
            fallback.message.contains("无法移入回收站"),
            "actual: {}",
            fallback.message
        );
        std::fs::remove_file(&f).unwrap();
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
