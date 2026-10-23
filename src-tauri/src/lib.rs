mod share;
mod keystore;
mod autotype;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_biometry::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = share::start_services(app.handle());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            share::get_peers,
            share::share_credential,
            keystore::get_vault_key,
            keystore::set_vault_key,
            keystore::delete_vault_key,
            keystore::generate_vault_key,
            keystore::format_recovery_key,
            keystore::normalize_recovery_key,
            autotype::auto_type
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
