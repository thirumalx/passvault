//! "Paste-once" clipboard for usernames/passwords.
//!
//! On Windows the secret is placed on the clipboard using *delayed rendering*:
//! we only announce that text is available, and Windows asks us for the actual
//! data (WM_RENDERFORMAT) at the moment another application pastes it. That
//! gives us a reliable "it was pasted" signal, after which the clipboard is
//! cleared following a short grace period. If nothing pastes it, the clipboard
//! is cleared when the timeout expires.
//!
//! The content is also flagged so Windows clipboard history / cloud clipboard
//! and well-behaved clipboard managers neither store it nor trigger a render.
//!
//! Events are emitted to the frontend as `secure-clipboard` with
//! `{ token, status }` where status is "pasted", "expired" or "replaced".
//!
//! On other platforms `secure_copy` returns `None` and the frontend falls back
//! to the regular clipboard plugin with a timed clear.

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn secure_copy(_text: String, _timeout_ms: Option<u32>) -> Result<Option<u64>, String> {
    Ok(None)
}

/// Copies `text` so that it is cleared right after it is pasted, or after
/// `timeout_ms` if it is never pasted. Returns a token identifying this copy
/// in subsequent `secure-clipboard` events.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn secure_copy(app: tauri::AppHandle, text: String, timeout_ms: Option<u32>) -> Result<Option<u64>, String> {
    win::copy(app, text, timeout_ms).map(Some)
}

#[cfg(target_os = "windows")]
mod win {
    use serde::Serialize;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardOwner, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, KillTimer, PostMessageW,
        RegisterClassW, SetTimer, TranslateMessage, HWND_MESSAGE, MSG, WM_APP,
        WM_DESTROYCLIPBOARD, WM_RENDERALLFORMATS, WM_RENDERFORMAT, WM_TIMER, WNDCLASSW,
    };

    #[derive(Clone, Serialize)]
    struct ClipboardEvent {
        token: u64,
        status: &'static str,
    }

    const WM_SECURE_COPY: u32 = WM_APP + 1;
    const TIMER_EXPIRE: usize = 1;
    const TIMER_GRACE: usize = 2;
    /// Time the rendered data stays on the clipboard after the first paste request,
    /// so apps that read the clipboard more than once per paste still succeed.
    const GRACE_MS: u32 = 1000;
    const DEFAULT_TIMEOUT_MS: u32 = 15000;

    struct Pending {
        token: u64,
        text: Vec<u16>,
        timeout_ms: u32,
        rendered: bool,
    }

    static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
    static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
    /// Set while we empty the clipboard ourselves, so our own WM_DESTROYCLIPBOARD is ignored.
    static SELF_EMPTYING: AtomicBool = AtomicBool::new(false);
    static WINDOW: OnceLock<Result<usize, String>> = OnceLock::new();
    static APP: OnceLock<AppHandle> = OnceLock::new();

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn emit(token: u64, status: &'static str) {
        if let Some(app) = APP.get() {
            let _ = app.emit("secure-clipboard", ClipboardEvent { token, status });
        }
    }

    fn wipe(p: &mut Pending) {
        p.text.iter_mut().for_each(|c| *c = 0);
        p.text.clear();
    }

    /// Lazily spawns the thread that owns the hidden clipboard window.
    fn window() -> Result<HWND, String> {
        WINDOW
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel();
                std::thread::Builder::new()
                    .name("secure-clipboard".into())
                    .spawn(move || unsafe { run_window(tx) })
                    .map_err(|e| e.to_string())?;
                rx.recv().map_err(|e| e.to_string())?
            })
            .clone()
            .map(|h| h as HWND)
    }

    unsafe fn run_window(ready: mpsc::Sender<Result<usize, String>>) {
        let class_name = wide("PassvaultSecureClipboard");
        let hinstance = GetModuleHandleW(std::ptr::null());
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(wndproc);
        wc.hInstance = hinstance;
        wc.lpszClassName = class_name.as_ptr();
        RegisterClassW(&wc);

        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            let _ = ready.send(Err("Failed to create clipboard window".into()));
            return;
        }
        let _ = ready.send(Ok(hwnd as usize));

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    unsafe fn open_clipboard(hwnd: HWND) -> bool {
        // Another process may briefly hold the clipboard open; retry a few times.
        for _ in 0..10 {
            if OpenClipboard(hwnd) != 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// Adds a small data blob for a registered format (used for the "don't record me" markers).
    unsafe fn set_registered_format(name: &str, data: &[u8]) {
        let format = RegisterClipboardFormatW(wide(name).as_ptr());
        if format == 0 {
            return;
        }
        let hmem = GlobalAlloc(GMEM_MOVEABLE, data.len().max(1));
        if hmem.is_null() {
            return;
        }
        let ptr = GlobalLock(hmem) as *mut u8;
        if !ptr.is_null() {
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
            GlobalUnlock(hmem);
        }
        SetClipboardData(format, hmem);
    }

    /// Empties the clipboard, but only if it still holds our content.
    unsafe fn clear_if_owner(hwnd: HWND) {
        if GetClipboardOwner() == hwnd && open_clipboard(hwnd) {
            SELF_EMPTYING.store(true, Ordering::SeqCst);
            EmptyClipboard();
            SELF_EMPTYING.store(false, Ordering::SeqCst);
            CloseClipboard();
        }
    }

    unsafe fn on_copy(hwnd: HWND) {
        let timeout_ms = match PENDING.lock().unwrap().as_ref() {
            Some(p) => p.timeout_ms,
            None => return,
        };
        KillTimer(hwnd, TIMER_EXPIRE);
        KillTimer(hwnd, TIMER_GRACE);

        if !open_clipboard(hwnd) {
            if let Some(mut p) = PENDING.lock().unwrap().take() {
                wipe(&mut p);
                emit(p.token, "replaced");
            }
            return;
        }
        SELF_EMPTYING.store(true, Ordering::SeqCst);
        EmptyClipboard();
        SELF_EMPTYING.store(false, Ordering::SeqCst);
        // Null handle = delayed rendering: data is supplied on WM_RENDERFORMAT.
        SetClipboardData(CF_UNICODETEXT as u32, std::ptr::null_mut());
        set_registered_format("ExcludeClipboardContentFromMonitorProcessing", &[0]);
        set_registered_format("CanIncludeInClipboardHistory", &0u32.to_le_bytes());
        set_registered_format("CanUploadToCloudClipboard", &0u32.to_le_bytes());
        CloseClipboard();

        SetTimer(hwnd, TIMER_EXPIRE, timeout_ms, None);
    }

    unsafe fn on_render(hwnd: HWND, format: u32) {
        if format != CF_UNICODETEXT as u32 {
            return;
        }
        let mut guard = PENDING.lock().unwrap();
        let Some(p) = guard.as_mut() else { return };
        if p.rendered {
            return;
        }

        let bytes = (p.text.len() + 1) * 2;
        let hmem = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if hmem.is_null() {
            return;
        }
        let ptr = GlobalLock(hmem) as *mut u16;
        if ptr.is_null() {
            return;
        }
        std::ptr::copy_nonoverlapping(p.text.as_ptr(), ptr, p.text.len());
        *ptr.add(p.text.len()) = 0;
        GlobalUnlock(hmem);
        // The requesting application already has the clipboard open.
        SetClipboardData(CF_UNICODETEXT as u32, hmem);

        p.rendered = true;
        wipe(p);
        let token = p.token;
        drop(guard);

        KillTimer(hwnd, TIMER_EXPIRE);
        SetTimer(hwnd, TIMER_GRACE, GRACE_MS, None);
        emit(token, "pasted");
    }

    unsafe fn on_timer(hwnd: HWND, id: usize) {
        KillTimer(hwnd, id);
        clear_if_owner(hwnd);
        if let Some(mut p) = PENDING.lock().unwrap().take() {
            wipe(&mut p);
            if id == TIMER_EXPIRE {
                emit(p.token, "expired");
            }
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_SECURE_COPY => on_copy(hwnd),
            WM_RENDERFORMAT => on_render(hwnd, wparam as u32),
            // Window is going away while owning the clipboard: leave nothing behind.
            WM_RENDERALLFORMATS => {}
            WM_TIMER if wparam == TIMER_EXPIRE || wparam == TIMER_GRACE => on_timer(hwnd, wparam),
            WM_DESTROYCLIPBOARD => {
                // Someone else put new content on the clipboard; our secret is gone.
                if !SELF_EMPTYING.load(Ordering::SeqCst) {
                    KillTimer(hwnd, TIMER_EXPIRE);
                    KillTimer(hwnd, TIMER_GRACE);
                    if let Some(mut p) = PENDING.lock().unwrap().take() {
                        wipe(&mut p);
                        if !p.rendered {
                            emit(p.token, "replaced");
                        }
                    }
                }
            }
            _ => return DefWindowProcW(hwnd, msg, wparam, lparam),
        }
        0
    }

    pub fn copy(app: AppHandle, text: String, timeout_ms: Option<u32>) -> Result<u64, String> {
        let _ = APP.set(app);
        queue(text, timeout_ms)
    }

    fn queue(text: String, timeout_ms: Option<u32>) -> Result<u64, String> {
        let hwnd = window()?;
        let token = NEXT_TOKEN.fetch_add(1, Ordering::SeqCst);

        if let Some(mut old) = PENDING.lock().unwrap().replace(Pending {
            token,
            text: text.encode_utf16().collect(),
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
            rendered: false,
        }) {
            wipe(&mut old);
            if !old.rendered {
                emit(old.token, "replaced");
            }
        }

        if unsafe { PostMessageW(hwnd, WM_SECURE_COPY, 0, 0) } == 0 {
            return Err("Failed to reach clipboard window".into());
        }
        Ok(token)
    }
}
