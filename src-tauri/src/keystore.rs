#[cfg(not(target_os = "android"))]
use keyring::{Entry, Error};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

#[cfg(not(target_os = "android"))]
const SERVICE_NAME: &str = "PassVault";
#[cfg(not(target_os = "android"))]
const KEY_NAME: &str = "vault_master_key";
const PASSPHRASE_SALT: &[u8] = b"PassVault:MultilingualPassphrase:v1";
const PBKDF2_ROUNDS: u32 = 100_000;

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn get_vault_key() -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE_NAME, KEY_NAME).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(secret) => {
            let trimmed = secret.trim().to_string();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed))
            }
        }
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read OS keyring: {}", e)),
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn get_vault_key(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let key_file = data_dir.join(".vault_key");
    if key_file.exists() {
        let content = std::fs::read_to_string(&key_file).map_err(|e| e.to_string())?;
        let trimmed = content.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed));
        }
    }
    Ok(None)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn set_vault_key(key: String) -> Result<(), String> {
    let clean_key = normalize_key(&key)?;
    let entry = Entry::new(SERVICE_NAME, KEY_NAME).map_err(|e| e.to_string())?;
    // Clear any stale credential entry first to ensure clean overwrite in Windows Credential Manager
    let _ = entry.delete_credential();
    entry
        .set_password(&clean_key)
        .map_err(|e| format!("Failed to save key in OS keyring: {}", e))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn set_vault_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
    use tauri::Manager;
    let clean_key = normalize_key(&key)?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let key_file = data_dir.join(".vault_key");
    std::fs::write(&key_file, &clean_key).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn delete_vault_key() -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, KEY_NAME).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete key from OS keyring: {}", e)),
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn delete_vault_key(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Ok(data_dir) = app.path().app_data_dir() {
        let key_file = data_dir.join(".vault_key");
        if key_file.exists() {
            let _ = std::fs::remove_file(key_file);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn generate_vault_key() -> Result<String, String> {
    let mut key_bytes = [0u8; 32];
    rand::fill(&mut key_bytes);
    let hex_str: String = key_bytes.iter().map(|b| format!("{:02x}", b)).collect();
    Ok(hex_str)
}

#[tauri::command]
pub fn format_recovery_key(key: String) -> Result<String, String> {
    let clean = normalize_key(&key)?;
    // Format 64 hex chars as TV-XXXXXXXX-XXXXXXXX-... (8 groups of 8 characters, uppercase)
    let chunks: Vec<String> = clean
        .as_bytes()
        .chunks(8)
        .map(|c| String::from_utf8_lossy(c).to_uppercase())
        .collect();
    Ok(format!("TV-{}", chunks.join("-")))
}

#[tauri::command]
pub fn normalize_recovery_key(input: String) -> Result<String, String> {
    normalize_key(&input)
}

#[tauri::command]
pub fn derive_passphrase_key(passphrase: String) -> Result<String, String> {
    normalize_key(&passphrase)
}

fn normalize_key(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Key or passphrase cannot be empty".to_string());
    }

    // 1. Check if input is a 64-hex recovery key (e.g. "TV-XXXXXXXX-...", "PV-XXXXXXXX-...", or raw 64 hex chars)
    let stripped = if trimmed.starts_with("TV-") || trimmed.starts_with("tv-") {
        &trimmed[3..]
    } else if trimmed.starts_with("PV-") || trimmed.starts_with("pv-") {
        &trimmed[3..]
    } else {
        trimmed
    };

    // Filter out dashes and whitespace
    let hex_candidate: String = stripped
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();

    if hex_candidate.len() == 64 && hex_candidate.chars().all(|c| c.is_ascii_hexdigit()) {
        // Direct raw 256-bit hexadecimal key
        return Ok(hex_candidate.to_lowercase());
    }

    // 2. Otherwise, treat as a human-language passphrase in any script (English, Tamil, Kannada, Malayalam, Hindi, French, Spanish, etc.)
    if trimmed.chars().count() < 4 {
        return Err("Passphrase must be at least 4 characters long".to_string());
    }

    // Canonical Unicode Normalization (NFC) ensures composed vs decomposed characters match
    let nfc_normalized: String = trimmed.nfc().collect();

    // Derive deterministic 256-bit key using PBKDF2-HMAC-SHA256 with 100,000 iterations
    let mut derived_key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(
        nfc_normalized.as_bytes(),
        PASSPHRASE_SALT,
        PBKDF2_ROUNDS,
        &mut derived_key,
    );

    let hex_key: String = derived_key.iter().map(|b| format!("{:02x}", b)).collect();
    Ok(hex_key)
}
