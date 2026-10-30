mod share;
mod keystore;
mod autotype;
mod bluetooth;
mod secure_clipboard;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bluetooth_hid_plugin = tauri::plugin::Builder::<tauri::Wry>::new("bluetoothHid")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("io.github.thirumalx", "BluetoothHidPlugin")?;
                _app.manage(bluetooth::BluetoothHidHandle(handle));
            }
            Ok(())
        })
        .build();

    tauri::Builder::default()
        .plugin(bluetooth_hid_plugin)
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
            keystore::derive_passphrase_key,
            autotype::auto_type,
            secure_clipboard::secure_copy,
            bluetooth::bluetooth_get_status,
            bluetooth::bluetooth_request_permissions,
            bluetooth::bluetooth_type_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
