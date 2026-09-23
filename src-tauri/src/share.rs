use tauri::{AppHandle, Emitter, Manager};
use std::sync::Mutex;
use pqcrypto_kyber::kyber768::*;
use pqcrypto_traits::kem::{PublicKey, SecretKey, Ciphertext, SharedSecret};
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::net::{TcpListener};
use std::thread;
use tiny_http::{Server, Response};
use reqwest::blocking::Client;

const SERVICE_TYPE: &str = "_passvault._tcp.local.";

#[derive(Clone, Serialize, Deserialize)]
pub struct Peer {
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub public_key: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct SharePayload {
    pub sender_name: String,
    pub encapsulated_key: Vec<u8>,
    pub nonce: Vec<u8>,
    pub encrypted_data: Vec<u8>,
}

pub struct AppState {
    pub decapsulation_key: Mutex<Option<Vec<u8>>>, // bytes of SecretKey
    pub encapsulation_key: Mutex<Option<Vec<u8>>>, // bytes of PublicKey
    pub peers: Mutex<HashMap<String, Peer>>,
    pub my_name: String,
    pub port: u16,
}

#[tauri::command]
pub fn get_peers(state: tauri::State<AppState>) -> Vec<Peer> {
    let peers = state.peers.lock().unwrap();
    peers.values().cloned().collect()
}

#[tauri::command]
pub fn share_credential(
    peer_ip: String,
    peer_port: u16,
    peer_pk: Vec<u8>,
    credential_json: String,
    state: tauri::State<AppState>
) -> Result<(), String> {
    
    // Parse peer PK
    let pk = PublicKey::from_bytes(&peer_pk).map_err(|_| "Invalid PK size")?;
    
    // Encapsulate
    let (ss, ct) = encapsulate(&pk);
    
    // Encrypt with AES-GCM
    let key = aes_gcm::Key::<Aes256Gcm>::from_slice(ss.as_bytes());
    let cipher = Aes256Gcm::new(key);
    
    let mut nonce_bytes = [0u8; 12];
    rand::fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    
    let encrypted = cipher.encrypt(nonce, credential_json.as_bytes())
        .map_err(|_| "Encryption failed")?;
        
    let payload = SharePayload {
        sender_name: state.my_name.clone(),
        encapsulated_key: ct.as_bytes().to_vec(),
        nonce: nonce_bytes.to_vec(),
        encrypted_data: encrypted,
    };
    
    // Send over HTTP
    let client = Client::new();
    let url = format!("http://{}:{}/share", peer_ip, peer_port);
    let res = client.post(&url)
        .json(&payload)
        .send()
        .map_err(|e| e.to_string())?;
        
    if !res.status().is_success() {
        return Err(format!("Peer rejected request: {}", res.status()));
    }
    
    Ok(())
}

pub fn start_services(app_handle: &AppHandle) -> AppState {
    let (pk, sk) = keypair();
    let ek_bytes = pk.as_bytes().to_vec();
    let dk_bytes = sk.as_bytes().to_vec();
    
    // Find free port
    let listener = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    
    let my_name = format!("{}'s Vault", whoami::username().unwrap_or_else(|_| "My".to_string()));
    
    // Setup state
    let state = AppState {
        decapsulation_key: Mutex::new(Some(dk_bytes.clone())),
        encapsulation_key: Mutex::new(Some(ek_bytes.clone())),
        peers: Mutex::new(HashMap::new()),
        my_name: my_name.clone(),
        port,
    };
    
    // Start HTTP Server
    let server_app_handle = app_handle.clone();
    thread::spawn(move || {
        let server = Server::http(format!("0.0.0.0:{}", port)).unwrap();
        for mut request in server.incoming_requests() {
            if request.url() == "/share" && request.method().as_str() == "POST" {
                let mut content = String::new();
                request.as_reader().read_to_string(&mut content).unwrap();
                if let Ok(payload) = serde_json::from_str::<SharePayload>(&content) {
                    
                    let state: tauri::State<AppState> = server_app_handle.state();
                    let guard = state.decapsulation_key.lock().unwrap();
                    if let Some(dk_bytes) = guard.as_ref() {
                        if let Ok(sk) = SecretKey::from_bytes(dk_bytes) {
                            if let Ok(ct) = Ciphertext::from_bytes(&payload.encapsulated_key) {
                                let ss = decapsulate(&ct, &sk);
                                let key = aes_gcm::Key::<Aes256Gcm>::from_slice(ss.as_bytes());
                                let cipher = Aes256Gcm::new(key);
                                let nonce = Nonce::from_slice(&payload.nonce);
                                
                                if let Ok(decrypted) = cipher.decrypt(nonce, payload.encrypted_data.as_ref()) {
                                    if let Ok(json_str) = String::from_utf8(decrypted) {
                                        #[derive(Serialize, Clone)]
                                        struct IncomingShare {
                                            sender: String,
                                            credential: serde_json::Value,
                                        }
                                        if let Ok(cred_val) = serde_json::from_str(&json_str) {
                                            let msg = IncomingShare {
                                                sender: payload.sender_name.clone(),
                                                credential: cred_val,
                                            };
                                            let _ = server_app_handle.emit("incoming-share", msg);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    let _ = request.respond(Response::from_string("OK"));
                } else {
                    let _ = request.respond(Response::from_string("Bad Request").with_status_code(400));
                }
            } else {
                let _ = request.respond(Response::from_string("Not Found").with_status_code(404));
            }
        }
    });
    
    // Start mDNS
    let mdns_app_handle = app_handle.clone();
    let ek_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &ek_bytes);
    thread::spawn(move || {
        let mdns = ServiceDaemon::new().unwrap();
        let my_ip = local_ip_address::local_ip().unwrap().to_string();
        
        let properties = vec![("pk", ek_b64.as_str()), ("name", my_name.as_str())];
        let service_info = ServiceInfo::new(
            SERVICE_TYPE,
            &my_name,
            &format!("{}.local.", my_name.replace(" ", "")),
            my_ip.clone(),
            port,
            &properties[..],
        ).unwrap();
        
        mdns.register(service_info).unwrap();
        
        let receiver = mdns.browse(SERVICE_TYPE).unwrap();
        for event in receiver.iter() {
            if let mdns_sd::ServiceEvent::ServiceResolved(info) = event {
                if info.get_fullname() != format!("{}.{}", my_name, SERVICE_TYPE) {
                    let state: tauri::State<AppState> = mdns_app_handle.state();
                    let mut peers = state.peers.lock().unwrap();
                    let mut pk_bytes = vec![];
                    if let Some(prop) = info.get_property("pk") {
                        if let Ok(b) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, prop.val_str()) {
                            pk_bytes = b;
                        }
                    }
                    let name = info.get_property("name").map(|p| p.val_str().to_string()).unwrap_or_else(|| "Unknown".to_string());
                    
                    if !pk_bytes.is_empty() {
                        let ip = info.get_addresses().iter().next().map(|i| i.to_string()).unwrap_or("".to_string());
                        peers.insert(name.clone(), Peer {
                            name,
                            ip,
                            port: info.get_port(),
                            public_key: pk_bytes,
                        });
                    }
                }
            }
        }
    });

    state
}
