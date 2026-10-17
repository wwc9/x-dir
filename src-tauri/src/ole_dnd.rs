//! V3 OLE 拖拽源（§3.3 拖出窗口）：自实现 IDataObject（CF_HDROP + Preferred
//! DropEffect）+ IDropSource，在主线程（源窗口 STA）DoDragDrop——可拖到资源
//! 管理器/桌面/任何外部程序，也可拖回本窗口（落点由 WebView2/Tauri 的拖放
//! 目标接管，前端经 onDragDropEvent 接收完整路径并分发）。

use std::cell::Cell;

use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{
    DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, E_NOTIMPL,
    OLE_E_ADVISENOTSUPPORTED, S_FALSE,
};
use windows::Win32::System::Com::{
    DVASPECT_CONTENT, FORMATETC, IDataObject, IDataObject_Impl, IEnumFORMATETC,
    IEnumFORMATETC_Impl, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::{
    CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE, DROPEFFECT_NONE, DoDragDrop,
    IDropSource, IDropSource_Impl,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::core::PCWSTR;
use windows::core::{BOOL, HRESULT, Ref, implement};

// ─────────────────────── 拖拽源 ───────────────────────

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// "Preferred DropEffect" 注册格式（剪切/复制意图，与系统剪贴板互通同一格式）
fn preferred_format() -> u16 {
    unsafe {
        let w = wide("Preferred DropEffect");
        RegisterClipboardFormatW(PCWSTR::from_raw(w.as_ptr())) as u16
    }
}

fn fmtetc(cf: u16) -> FORMATETC {
    FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

/// 字节 → 新 HGLOBAL（所有权移交请求方，由其 ReleaseStgMedium 释放）
unsafe fn hglobal_from(bytes: &[u8]) -> windows::core::Result<windows::Win32::Foundation::HGLOBAL> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
        let p = GlobalLock(h);
        if p.is_null() {
            return Err(windows::core::Error::from_hresult(E_NOTIMPL));
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p.cast(), bytes.len());
        let _ = GlobalUnlock(h);
        Ok(h)
    }
}

#[implement(IDataObject)]
struct FileDataObject {
    bytes: Vec<u8>,
    preferred: u32,
}

impl IDataObject_Impl for FileDataObject_Impl {
    fn GetData(&self, fmt: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        unsafe {
            let f = &*fmt;
            log::info!(
                "IDataObject::GetData cf={:#06x} tymed={:#x}",
                f.cfFormat,
                f.tymed
            );
            let is_hglobal = (f.tymed as i32 & TYMED_HGLOBAL.0) != 0;
            let payload = if f.cfFormat == CF_HDROP.0 && is_hglobal {
                Some(self.bytes.clone())
            } else if f.cfFormat == preferred_format() && is_hglobal {
                Some(self.preferred.to_le_bytes().to_vec())
            } else {
                None
            };
            match payload {
                Some(bytes) => {
                    let h = hglobal_from(&bytes)?;
                    Ok(STGMEDIUM {
                        tymed: TYMED_HGLOBAL.0 as u32,
                        u: STGMEDIUM_0 { hGlobal: h },
                        pUnkForRelease: std::mem::ManuallyDrop::new(None),
                    })
                }
                None => Err(windows::core::Error::from_hresult(DV_E_FORMATETC)),
            }
        }
    }

    fn GetDataHere(
        &self,
        _fmt: *const FORMATETC,
        _med: *mut STGMEDIUM,
    ) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(E_NOTIMPL))
    }

    fn QueryGetData(&self, fmt: *const FORMATETC) -> HRESULT {
        unsafe {
            let f = &*fmt;
            log::info!(
                "IDataObject::QueryGetData cf={:#06x} tymed={:#x}",
                f.cfFormat,
                f.tymed
            );
            let cf_ok = f.cfFormat == CF_HDROP.0 || f.cfFormat == preferred_format();
            if cf_ok && (f.tymed as i32 & TYMED_HGLOBAL.0) != 0 {
                HRESULT(0)
            } else {
                DV_E_FORMATETC
            }
        }
    }

    fn GetCanonicalFormatEtc(&self, _in_: *const FORMATETC, out: *mut FORMATETC) -> HRESULT {
        unsafe {
            *out = fmtetc(0);
        }
        E_NOTIMPL
    }

    fn SetData(
        &self,
        _fmt: *const FORMATETC,
        _med: *const STGMEDIUM,
        _release: BOOL,
    ) -> windows::core::Result<()> {
        // 目标（如 Explorer）可能写入 DragContext 等；接受但不保存
        Ok(())
    }

    fn EnumFormatEtc(&self, _dir: u32) -> windows::core::Result<IEnumFORMATETC> {
        Ok(EnumFmt {
            formats: vec![fmtetc(CF_HDROP.0), fmtetc(preferred_format())],
            pos: Cell::new(0),
        }
        .into())
    }

    fn DAdvise(
        &self,
        _fmt: *const FORMATETC,
        _advf: u32,
        _sink: Ref<windows::Win32::System::Com::IAdviseSink>,
    ) -> windows::core::Result<u32> {
        Err(windows::core::Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }

    fn DUnadvise(&self, _connection: u32) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }

    fn EnumDAdvise(&self) -> windows::core::Result<windows::Win32::System::Com::IEnumSTATDATA> {
        Err(windows::core::Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }
}

#[implement(IEnumFORMATETC)]
struct EnumFmt {
    formats: Vec<FORMATETC>,
    pos: Cell<usize>,
}

impl IEnumFORMATETC_Impl for EnumFmt_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, fetched: *mut u32) -> HRESULT {
        let mut n = 0u32;
        while n < celt {
            let i = self.pos.get();
            if i >= self.formats.len() {
                break;
            }
            unsafe {
                *rgelt.add(n as usize) = self.formats[i];
            }
            self.pos.set(i + 1);
            n += 1;
        }
        if !fetched.is_null() {
            unsafe {
                *fetched = n;
            }
        }
        if n == celt { HRESULT(0) } else { S_FALSE }
    }

    fn Skip(&self, celt: u32) -> windows::core::Result<()> {
        self.pos
            .set((self.pos.get() + celt as usize).min(self.formats.len()));
        Ok(())
    }

    fn Reset(&self) -> windows::core::Result<()> {
        self.pos.set(0);
        Ok(())
    }

    fn Clone(&self) -> windows::core::Result<IEnumFORMATETC> {
        Ok(EnumFmt {
            formats: self.formats.clone(),
            pos: Cell::new(self.pos.get()),
        }
        .into())
    }
}

#[implement(IDropSource)]
struct DropSource;

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, escape_pressed: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape_pressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if keys.0 & MK_LBUTTON.0 == 0 {
            DRAGDROP_S_DROP
        } else {
            HRESULT(0)
        }
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// 发起 OLE 拖拽（阻塞直至放下/取消），返回最终效果 "copy" | "move" | "none"。
/// 必须在主线程（源窗口 STA，install() 已 OleInitialize）执行 DoDragDrop——
/// 跨线程发起时拖拽循环取不到本线程键状态，会卡死在无幽灵状态（Win32 语义）。
/// 命令线程经通道等待结果；主线程在模态循环中泵消息，UI 保持响应。
pub fn start(paths: &[String], app: AppHandle) -> Result<String, String> {
    use std::sync::mpsc::channel;
    if paths.is_empty() {
        return Ok("none".into());
    }
    let (tx, rx) = channel::<String>();
    let paths: Vec<String> = paths.to_vec();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        unsafe {
            let data: IDataObject = FileDataObject {
                bytes: crate::clip::build_hdrop(&paths),
                preferred: (DROPEFFECT_COPY | DROPEFFECT_MOVE).0,
            }
            .into();
            let src: IDropSource = DropSource.into();
            let mut effect = DROPEFFECT_NONE;
            log::info!("OLE start_drag: {} 个路径（主线程）", paths.len());
            let hr = DoDragDrop(&data, &src, DROPEFFECT_COPY | DROPEFFECT_MOVE, &mut effect);
            let r = match effect.0 {
                e if e == DROPEFFECT_COPY.0 => "copy",
                e if e == DROPEFFECT_MOVE.0 => "move",
                // WebView2 的 DropTarget 落到网页上时不回写 effect 标志（实测
                // effect=NONE 且 hr=DRAGDROP_S_DROP），但 drop 确实发生——
                // 单独区分"已放置"，供暂存区等调用方判定"已取走"
                _ if hr == DRAGDROP_S_DROP => "drop",
                _ => "none",
            };
            log::info!("OLE start_drag 完成: effect={r} hr=0x{:08X}", hr.0 as u32);
            // 源父目录快照失效（可见窗格由 watcher 兜底刷新）
            let state = app2.state::<crate::AppState>();
            let mut cache = state.cache.lock().unwrap();
            for p in &paths {
                if let Some(par) = crate::fs::path::parent_of(p) {
                    cache.invalidate(par.trim_end_matches('\u{5c}'));
                }
            }
            drop(cache);
            let _ = tx.send(r.to_string());
        }
    })
    .map_err(|e| format!("调度主线程失败：{e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(120))
        .map_err(|_| "拖拽等待超时".to_string())
}

// 落点（拖入/窗内落点）不经此处：WebView2/Tauri 已在 webview HWND 注册拖放目标，
// 前端经 @tauri-apps/api/webview 的 onDragDropEvent 接收（携带完整路径），
// 本模块只负责拖出方向（FileDataObject + DropSource + DoDragDrop）。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmtetc_covers_hglobal_only() {
        let f = fmtetc(15);
        assert_eq!(f.cfFormat, 15);
        assert_eq!(f.tymed as i32, TYMED_HGLOBAL.0);
        assert_eq!(f.lindex, -1);
    }
}
