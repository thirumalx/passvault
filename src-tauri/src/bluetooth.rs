use tauri::Manager;

#[cfg(target_os = "android")]
#[derive(Clone)]
pub struct BluetoothHidHandle(pub tauri::plugin::PluginHandle<tauri::Wry>);

#[tauri::command]
pub async fn bluetooth_get_status(
    _app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        if let Some(bh) = _app.try_state::<BluetoothHidHandle>() {
            return bh.0.run_mobile_plugin::<serde_json::Value>("getStatus", ())
                .map_err(|e| e.to_string());
        }
        Ok(serde_json::json!({
            "isAvailable": true,
            "connected": false,
            "deviceName": "",
            "deviceAddress": "",
            "registered": false,
            "hasPermissions": false
        }))
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(serde_json::json!({
            "isAvailable": false,
            "connected": false
        }))
    }
}

#[tauri::command]
pub async fn bluetooth_request_permissions(
    _app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        if let Some(bh) = _app.try_state::<BluetoothHidHandle>() {
            return bh.0.run_mobile_plugin::<serde_json::Value>("requestPermissions", ())
                .map_err(|e| e.to_string());
        }
        Ok(serde_json::json!({ "requested": false }))
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(serde_json::json!({ "requested": false }))
    }
}

#[tauri::command]
pub async fn bluetooth_type_credentials(
    _app: tauri::AppHandle,
    payload: serde_json::Value,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        if let Some(bh) = _app.try_state::<BluetoothHidHandle>() {
            return bh.0.run_mobile_plugin::<()>("typeCredentials", payload)
                .map_err(|e| e.to_string());
        }
        Err("Bluetooth HID handle not available".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = payload;
        Err("Bluetooth Auto-Type is only supported on mobile devices".to_string())
    }
}

