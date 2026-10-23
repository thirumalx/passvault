use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::thread::sleep;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Auto-types credentials into the previously active window.
///
/// Workflow:
/// 1. Minimizes the Passvault window so focus returns to the target app (Browser, PuTTY, PAM, PowerShell).
/// 2. Waits for the OS window manager to switch focus (default 600ms).
/// 3. Types the username (if provided).
/// 4. Sends separator:
///    - For 'putty', 'powershell', 'terminal': sends Enter + waits 800ms (so SSH/prompt can switch to password/noecho).
///    - For other types ('web', 'pam', etc.): sends Tab + waits 150ms.
/// 5. Types the password (if provided) with optional per-keystroke pacing for remote sessions (e.g., Arcon PAM RDP).
/// 6. Optionally sends Enter after password for terminal logins.
#[tauri::command]
pub async fn auto_type(
    app: AppHandle,
    username: Option<String>,
    password: Option<String>,
    connection_type: Option<String>,
    inter_key_delay_ms: Option<u64>,
) -> Result<(), String> {
    // 1. Minimize main window to restore focus to target application
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }

    // Give the OS 600ms to switch focus to previous foreground window
    sleep(Duration::from_millis(600));

    // Initialize Enigo keyboard simulator
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("Failed to initialize keyboard simulator: {:?}", e))?;

    let conn = connection_type.unwrap_or_else(|| "web".to_string()).to_lowercase();
    let is_terminal = conn == "putty" || conn == "powershell" || conn == "terminal" || conn == "ssh";
    let is_pam = conn == "pam";

    // Keystroke pacing: default 0ms for local web, 30ms for PAM/remote desktop, or custom
    let char_delay = inter_key_delay_ms.unwrap_or(if is_pam { 30 } else { 0 });

    // Helper closure to type text (with optional inter-keystroke pacing for remote sessions)
    let type_paced = |enigo: &mut Enigo, text: &str| -> Result<(), String> {
        if char_delay > 0 {
            for ch in text.chars() {
                let mut buf = [0u8; 4];
                let s = ch.encode_utf8(&mut buf);
                enigo.text(s).map_err(|e| format!("Typing error: {:?}", e))?;
                sleep(Duration::from_millis(char_delay));
            }
        } else {
            enigo.text(text).map_err(|e| format!("Typing error: {:?}", e))?;
        }
        Ok(())
    };

    // 2. Type Username if present
    if let Some(user) = username.as_ref() {
        if !user.is_empty() {
            type_paced(&mut enigo, user)?;

            // Separator between Username and Password
            if is_terminal {
                // In PuTTY / PowerShell / SSH: hit Enter and wait for server password prompt
                sleep(Duration::from_millis(100));
                enigo.key(Key::Return, Direction::Click)
                    .map_err(|e| format!("Enter key error: {:?}", e))?;
                // Delay for SSH/PAM terminal to disable echo and show 'Password:'
                sleep(Duration::from_millis(800));
            } else {
                // In Web / PAM portal: hit Tab to jump to password field
                sleep(Duration::from_millis(100));
                enigo.key(Key::Tab, Direction::Click)
                    .map_err(|e| format!("Tab key error: {:?}", e))?;
                sleep(Duration::from_millis(200));
            }
        }
    }

    // 3. Type Password if present
    if let Some(pass) = password.as_ref() {
        if !pass.is_empty() {
            type_paced(&mut enigo, pass)?;

            // In terminal sessions, automatically submit password with Enter
            if is_terminal {
                sleep(Duration::from_millis(150));
                enigo.key(Key::Return, Direction::Click)
                    .map_err(|e| format!("Enter key error: {:?}", e))?;
            }
        }
    }

    Ok(())
}

