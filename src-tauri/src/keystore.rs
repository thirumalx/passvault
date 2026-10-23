use keyring::{Entry, Error};

const SERVICE_NAME: &str = "PassVault";
const KEY_NAME: &str = "vault_master_key";

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

#[tauri::command]
pub fn set_vault_key(key: String) -> Result<(), String> {
    let clean_key = normalize_key(&key)?;
    let entry = Entry::new(SERVICE_NAME, KEY_NAME).map_err(|e| e.to_string())?;
    entry
        .set_password(&clean_key)
        .map_err(|e| format!("Failed to save key in OS keyring: {}", e))
}

#[tauri::command]
pub fn delete_vault_key() -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, KEY_NAME).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete key from OS keyring: {}", e)),
    }
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
    // Format 64 hex chars as PV-XXXXXXXX-XXXXXXXX-... (8 groups of 8 characters, uppercase)
    let chunks: Vec<String> = clean
        .as_bytes()
        .chunks(8)
        .map(|c| String::from_utf8_lossy(c).to_uppercase())
        .collect();
    Ok(format!("PV-{}", chunks.join("-")))
}

#[tauri::command]
pub fn normalize_recovery_key(input: String) -> Result<String, String> {
    normalize_key(&input)
}

fn normalize_key(input: &str) -> Result<String, String> {
    let cleaned: String = input
        .trim()
        .strip_prefix("PV-")
        .unwrap_or(input.trim())
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();

    if cleaned.len() != 64 {
        return Err(format!(
            "Invalid vault key length (expected 64 hex characters / 256 bits, got {})",
            cleaned.len()
        ));
    }

    Ok(cleaned.to_lowercase())
}

