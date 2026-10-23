use keyring::{Entry, Error};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

const SERVICE_NAME: &str = "PassVault";
const KEY_NAME: &str = "vault_master_key";
const PASSPHRASE_SALT: &[u8] = b"PassVault:MultilingualPassphrase:v1";
const PBKDF2_ROUNDS: u32 = 100_000;

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
    // Clear any stale credential entry first to ensure clean overwrite in Windows Credential Manager
    let _ = entry.delete_credential();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_raw_64_hex_passthrough() {
        let raw = "1849c2cf3b0b838e64f24a77f831c5430420173b6d132552ae17a4b4d5385ea2";
        assert_eq!(normalize_key(raw).unwrap(), raw);

        let formatted_tv = "TV-1849C2CF-3B0B838E-64F24A77-F831C543-0420173B-6D132552-AE17A4B4-D5385EA2";
        assert_eq!(normalize_key(formatted_tv).unwrap(), raw);

        let formatted_pv = "PV-1849c2cf-3b0b838e-64f24a77-f831c543-0420173b-6d132552-ae17a4b4-d5385ea2";
        assert_eq!(normalize_key(formatted_pv).unwrap(), raw);
    }

    #[test]
    fn test_multilingual_passphrases() {
        // English
        let en = normalize_key("MySecureVaultPassphrase2026!").unwrap();
        assert_eq!(en.len(), 64);

        // Tamil
        let ta = normalize_key("என்ரகசியகடவுச்சொல்2026").unwrap();
        assert_eq!(ta.len(), 64);

        // Kannada
        let kn = normalize_key("ನನ್ನರಹಸ್ಯಪಾಸ್‌ವರ್ಡ್2026").unwrap();
        assert_eq!(kn.len(), 64);

        // Malayalam
        let ml = normalize_key("എന്റെരഹസ്യപാസ്‌വേഡ്2026").unwrap();
        assert_eq!(ml.len(), 64);

        // Hindi
        let hi = normalize_key("मेरागुप्तपासवर्ड2026").unwrap();
        assert_eq!(hi.len(), 64);

        // French (with accents)
        let fr = normalize_key("MonMotDePasseTrèsSécurisé!").unwrap();
        assert_eq!(fr.len(), 64);

        // Spanish (with inverted mark and tilde)
        let es = normalize_key("¡MiContraseñaSúperSegura!").unwrap();
        assert_eq!(es.len(), 64);

        // Determinism: calling it again gives the exact same derived 256-bit key
        assert_eq!(normalize_key("என்ரகசியகடவுச்சொல்2026").unwrap(), ta);
        assert_eq!(normalize_key("ನನ್ನರಹಸ್ಯಪಾಸ್‌ವರ್ಡ್2026").unwrap(), kn);
        assert_eq!(normalize_key("¡MiContraseñaSúperSegura!").unwrap(), es);
    }

    #[test]
    fn test_unicode_normalization_equivalence() {
        // 'é' in NFC (U+00E9) vs NFD (U+0065 U+0301)
        let nfc_str = "Caf\u{00E9}Vault2026";
        let nfd_str = "Cafe\u{0301}Vault2026";
        assert_ne!(nfc_str.as_bytes(), nfd_str.as_bytes()); // Raw bytes differ
        assert_eq!(
            normalize_key(nfc_str).unwrap(),
            normalize_key(nfd_str).unwrap() // Derived key is identical!
        );
    }
}
