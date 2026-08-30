import React, { useState, useEffect } from 'react';
import { load } from "@tauri-apps/plugin-store";
import { appDataDir } from "@tauri-apps/api/path";
import { writeText, clear } from "@tauri-apps/plugin-clipboard-manager";
import './PassVault.css';

// --- Web Crypto Helpers ---
async function getDeviceKey(storeInstance) {
    let keyStr = await storeInstance.get("deviceKey");
    if (!keyStr) {
        // Generate a completely random 256-bit key on first launch
        const randomBytes = window.crypto.getRandomValues(new Uint8Array(32));
        keyStr = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        await storeInstance.set("deviceKey", keyStr);
        await storeInstance.save();
    }
    return keyStr;
}

async function getEncryptionKey(storeInstance) {
    const deviceKey = await getDeviceKey(storeInstance);
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(deviceKey),
        { name: "PBKDF2" },
        false,
        ["deriveBits", "deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: enc.encode("fixed-salt-for-local-app"),
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

async function encryptData(data, storeInstance) {
    const key = await getEncryptionKey(storeInstance);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const encryptedContent = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        enc.encode(JSON.stringify(data))
    );

    // Combine IV and Ciphertext
    const encryptedBytes = new Uint8Array(encryptedContent);
    const result = new Uint8Array(iv.length + encryptedBytes.length);
    result.set(iv, 0);
    result.set(encryptedBytes, iv.length);
    return Array.from(result);
}

async function decryptData(dataArray, storeInstance) {
    const key = await getEncryptionKey(storeInstance);
    const data = new Uint8Array(dataArray);
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);

    const decryptedContent = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        key,
        ciphertext
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decryptedContent));
}
// --------------------------

export default function PassVault() {
    const [credentials, setCredentials] = useState([]);
    const [search, setSearch] = useState("");
    const [toastMessage, setToastMessage] = useState("");
    const [copiedId, setCopiedId] = useState(null);
    const [isAdding, setIsAdding] = useState(false);
    const [newCred, setNewCred] = useState({ name: "", system: "", environment: "", username: "", password: "" });
    const [store, setStore] = useState(null);

    useEffect(() => {
        initVault();
    }, []);

    const initVault = async () => {
        try {
            const dir = await appDataDir();
            const storeInstance = await load(`${dir}\\vault.json`, { autoSave: false });
            setStore(storeInstance);

            const encryptedCreds = await storeInstance.get("credentials");
            if (encryptedCreds) {
                try {
                    const decrypted = await decryptData(encryptedCreds, storeInstance);
                    setCredentials(decrypted);
                } catch (err) {
                    console.error("Failed to decrypt credentials", err);
                }
            }
        } catch (err) {
            console.error("Failed to init vault", err);
        }
    };

    const handleCopy = async (cred) => {
        try {
            await writeText(cred.password);

            setCopiedId(cred.id);
            setToastMessage("✓ Password copied to clipboard");

            // Clear clipboard after 15 seconds
            setTimeout(async () => {
                setCopiedId(null);
                setToastMessage("");
                try {
                    await clear();
                } catch (e) {
                    console.error("Failed to clear clipboard", e);
                }
            }, 15000);

        } catch (err) {
            console.error("Failed to copy password", err);
            setToastMessage("❌ Failed to copy password");
            setTimeout(() => setToastMessage(""), 3000);
        }
    };

    const handleAddCredential = async (e) => {
        e.preventDefault();
        if (!store) return;

        try {
            const newId = crypto.randomUUID();
            const updatedCreds = [...credentials, { ...newCred, id: newId }];

            const encrypted = await encryptData(updatedCreds, store);
            await store.set("credentials", encrypted);
            await store.save();

            setCredentials(updatedCreds);
            setIsAdding(false);
            setNewCred({ name: "", system: "", environment: "", username: "", password: "" });
        } catch (err) {
            console.error("Failed to add credential", err);
            alert("Error adding credential");
        }
    };

    const handleDelete = async (id) => {
        if (!store) return;
        if (!window.confirm("Are you sure you want to delete this credential?")) return;

        try {
            const updatedCreds = credentials.filter(c => c.id !== id);
            
            const encrypted = await encryptData(updatedCreds, store);
            await store.set("credentials", encrypted);
            await store.save();
            
            setCredentials(updatedCreds);
            setToastMessage("✓ Credential deleted");
            setTimeout(() => setToastMessage(""), 3000);
        } catch (err) {
            console.error("Failed to delete credential", err);
            alert("Error deleting credential");
        }
    };

    const filteredCreds = credentials.filter(c => {
        const term = search.toLowerCase();
        return (
            c.name.toLowerCase().includes(term) ||
            (c.system && c.system.toLowerCase().includes(term)) ||
            (c.environment && c.environment.toLowerCase().includes(term))
        );
    });

    return (
        <div className="vault-container">
            <header className="vault-header">
                <h1>
                    <span>🔐</span> Passvault
                </h1>
                <button className="add-button" onClick={() => setIsAdding(true)}>
                    + Add Credential
                </button>
            </header>

            <div className="search-container">
                <input
                    type="text"
                    className="search-input"
                    placeholder="Search by name, system, or environment..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                />
            </div>

            <div className="vault-list">
                {filteredCreds.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#888', marginTop: '20px' }}>
                        No credentials found. Click '+ Add Credential' to create one.
                    </div>
                ) : (
                    filteredCreds.map(cred => (
                        <div key={cred.id} className="credential-card">
                            <div className="credential-info">
                                <h3>{cred.name}</h3>
                                <div className="credential-meta">
                                    {cred.environment && <span className="badge">{cred.environment}</span>}
                                    {cred.system && <span>{cred.system}</span>}
                                    {cred.username && <span>👤 {cred.username}</span>}
                                </div>
                            </div>
                            <div style={{ display: "flex", gap: "8px" }}>
                                <button
                                    className={`copy-button ${copiedId === cred.id ? 'copied' : ''}`}
                                    onClick={() => handleCopy(cred)}
                                >
                                    {copiedId === cred.id ? "✓ Copied" : "Copy"}
                                </button>
                                <button
                                    className="delete-button"
                                    onClick={() => handleDelete(cred.id)}
                                    title="Delete"
                                >
                                    🗑️
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {toastMessage && (
                <div className="toast">
                    <div className="toast-message">{toastMessage}</div>
                    {copiedId && <div className="toast-hint">Clipboard will clear in 15 seconds</div>}
                </div>
            )}

            {isAdding && (
                <div className="modal-overlay">
                    <div className="modal-content">
                        <h2>Add Credential</h2>
                        <form onSubmit={handleAddCredential}>
                            <div className="form-group">
                                <label>Name</label>
                                <input required value={newCred.name} onChange={e => setNewCred({ ...newCred, name: e.target.value })} placeholder="e.g. Production DB" />
                            </div>
                            <div className="form-group">
                                <label>System</label>
                                <input value={newCred.system} onChange={e => setNewCred({ ...newCred, system: e.target.value })} placeholder="e.g. MySQL" />
                            </div>
                            <div className="form-group">
                                <label>Environment</label>
                                <input value={newCred.environment} onChange={e => setNewCred({ ...newCred, environment: e.target.value })} placeholder="e.g. PROD" />
                            </div>
                            <div className="form-group">
                                <label>Username</label>
                                <input value={newCred.username} onChange={e => setNewCred({ ...newCred, username: e.target.value })} placeholder="e.g. app_user" />
                            </div>
                            <div className="form-group">
                                <label>Password</label>
                                <input type="password" required value={newCred.password} onChange={e => setNewCred({ ...newCred, password: e.target.value })} />
                            </div>

                            <div className="modal-actions">
                                <button type="button" className="btn-secondary" onClick={() => setIsAdding(false)}>Cancel</button>
                                <button type="submit" className="copy-button">Save</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
