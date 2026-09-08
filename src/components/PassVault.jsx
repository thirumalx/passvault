import React, { useState, useEffect } from 'react';
import { load } from "@tauri-apps/plugin-store";
import { appDataDir } from "@tauri-apps/api/path";
import { writeText, clear } from "@tauri-apps/plugin-clipboard-manager";
import { Command } from "@tauri-apps/plugin-shell";
import { openUrl } from "@tauri-apps/plugin-opener";
import About from "./About";
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
    const [toast, setToast] = useState(null);
    const [copiedId, setCopiedId] = useState(null);
    const [isAdding, setIsAdding] = useState(false);
    const [isAboutOpen, setIsAboutOpen] = useState(false);
    const [newCred, setNewCred] = useState({ id: null, name: "", url: "", username: "", password: "", connectionType: "web", remarks: "", installPath: "" });
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

    const handleCopy = async (cred, type) => {
        try {
            const textToCopy = type === 'username' ? cred.username : cred.password;
            if (!textToCopy) return;

            await writeText(textToCopy);

            setCopiedId(`${cred.id}-${type}`);
            setToast({ message: `${type === 'username' ? 'Username' : 'Password'} copied to clipboard`, duration: type === 'password' ? 15000 : 3000 });

            // Clear clipboard after 15 seconds if it's a password
            setTimeout(async () => {
                setCopiedId(null);
                setToast(null);
                if (type === 'password') {
                    try {
                        await clear();
                    } catch (e) {
                        console.error("Failed to clear clipboard", e);
                    }
                }
            }, 15000);

        } catch (err) {
            console.error(`Failed to copy ${type}`, err);
            setToast({ message: `Failed to copy ${type}`, duration: 3000 });
            setTimeout(() => setToast(null), 3000);
        }
    };

    const handleOpenEdit = (cred) => {
        setNewCred({ ...cred });
        setIsAdding(true);
    };

    const handleSaveCredential = async (e) => {
        e.preventDefault();
        if (!store) return;

        try {
            let updatedCreds;
            if (newCred.id) {
                updatedCreds = credentials.map(c => c.id === newCred.id ? { ...newCred } : c);
                setToast({ message: "Credential updated", duration: 3000 });
            } else {
                const newId = crypto.randomUUID();
                updatedCreds = [...credentials, { ...newCred, id: newId }];
                setToast({ message: "Credential added", duration: 3000 });
            }

            const encrypted = await encryptData(updatedCreds, store);
            await store.set("credentials", encrypted);
            await store.save();

            setCredentials(updatedCreds);
            setIsAdding(false);
            setNewCred({ id: null, name: "", url: "", username: "", password: "", connectionType: "web", remarks: "", installPath: "" });

            setTimeout(() => setToast(null), 3000);
        } catch (err) {
            console.error("Failed to save credential", err);
            alert("Error saving credential");
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
            setToast({ message: "Credential deleted", duration: 3000 });
            setTimeout(() => setToast(null), 3000);
        } catch (err) {
            console.error("Failed to delete credential", err);
            alert("Error deleting credential");
        }
    };

    const handleConnect = async (cred) => {
        try {
            const isWin = navigator.userAgent.includes('Win');
            const isMac = navigator.userAgent.includes('Mac');

            if (cred.username) {
                await writeText(cred.username);
                setToast({ message: "Username auto-copied to clipboard! Paste it when prompted.", duration: 15000 });
                setCopiedId(`${cred.id}-username`);
                setTimeout(() => { setCopiedId(null); setToast(null); }, 15000);
            }

            if (cred.connectionType === 'web') {
                let targetUrl = cred.url;
                if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
                    targetUrl = 'https://' + targetUrl;
                }
                const command = cred.installPath ? Command.create(cred.installPath, [targetUrl]) : null;
                if (command) {
                    await command.spawn();
                } else {
                    await openUrl(targetUrl);
                }
            } else if (cred.connectionType === 'putty') {
                const exe = cred.installPath || 'putty';
                const command = Command.create(exe, [
                    '-ssh',
                    `${cred.username}@${cred.url}`,
                    '-pw',
                    cred.password
                ]);
                await command.spawn();
            } else if (cred.connectionType === 'powershell') {
                if (isWin) {
                    const exe = cred.installPath || 'powershell';
                    const command = Command.create(exe, [
                        '-NoExit',
                        '-Command',
                        `Enter-PSSession -ComputerName ${cred.url} -Credential (New-Object System.Management.Automation.PSCredential ("${cred.username}", (ConvertTo-SecureString "${cred.password}" -AsPlainText -Force)))`
                    ]);
                    await command.spawn();
                } else {
                    const exe = cred.installPath || 'pwsh';
                    const command = Command.create(exe, [
                        '-NoExit',
                        '-Command',
                        `Enter-PSSession -ComputerName ${cred.url} -Credential (New-Object System.Management.Automation.PSCredential ("${cred.username}", (ConvertTo-SecureString "${cred.password}" -AsPlainText -Force)))`
                    ]);
                    await command.spawn();
                }
            } else if (cred.connectionType === 'pgadmin') {
                if (cred.installPath) {
                    await Command.create(cred.installPath).spawn();
                } else {
                    if (isWin) {
                        const command = Command.create('powershell', [
                            '-WindowStyle', 'Hidden',
                            '-Command',
                            `Start-Process "pgadmin4" -ErrorAction SilentlyContinue`
                        ]);
                        await command.spawn();
                    } else if (isMac) {
                        await Command.create('open', ['-a', 'pgAdmin 4']).spawn();
                    } else {
                        await Command.create('pgadmin4').spawn();
                    }
                }
            } else if (cred.connectionType === 'mysqlworkbench') {
                if (cred.installPath) {
                    await Command.create(cred.installPath).spawn();
                } else {
                    if (isWin) {
                        const command = Command.create('powershell', [
                            '-WindowStyle', 'Hidden',
                            '-Command',
                            `Start-Process "MySQLWorkbench.exe" -ErrorAction SilentlyContinue; if (!$?) { Start-Process "mysqlworkbench" -ErrorAction SilentlyContinue }`
                        ]);
                        await command.spawn();
                    } else if (isMac) {
                        await Command.create('open', ['-a', 'MySQLWorkbench']).spawn();
                    } else {
                        await Command.create('mysql-workbench').spawn();
                    }
                }
            }
        } catch (err) {
            console.error(`Failed to launch ${cred.connectionType}`, err);
            setToast({ message: `Failed to launch ${cred.connectionType}. Ensure the application is installed and in your PATH.`, duration: 5000 });
            setTimeout(() => setToast(null), 5000);
        }
    };

    const filteredCreds = credentials.filter(c => {
        const term = search.toLowerCase();
        return (
            c.name.toLowerCase().includes(term) ||
            (c.url && c.url.toLowerCase().includes(term))
        );
    });

    const getFaviconUrl = (url) => {
        try {
            if (!url) return null;
            let target = url;
            if (!target.startsWith('http')) target = 'https://' + target;
            const urlObj = new URL(target);
            return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
        } catch (e) {
            return null;
        }
    };

    return (
        <div className="vault-container">
            <header className="vault-header">
                <h1>
                    <span>&#128272;</span> Passvault
                </h1>
                <div style={{ display: 'flex', gap: '10px' }}>
                    <button className="add-button" style={{ background: '#555' }} onClick={() => setIsAboutOpen(true)}>
                        ℹ️ About
                    </button>
                    <button className="add-button" onClick={() => {
                        setNewCred({ id: null, name: "", url: "", username: "", password: "", connectionType: "web", remarks: "", installPath: "" });
                        setIsAdding(true);
                    }}>
                        + Add Credential
                    </button>
                </div>
            </header>

            <div className="search-container">
                <input
                    type="text"
                    className="search-input"
                    placeholder="Search by name or URL/IP..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                />
            </div>

            <div className="vault-list">
                {filteredCreds.length === 0 ? (
                    <div className="empty-state">
                        <svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#ccc', marginBottom: '16px' }}>
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                        </svg>
                        <h2>Your vault is empty</h2>
                        <p>Add your first credential to securely store and manage your access details.</p>
                        <button className="copy-button" style={{ marginTop: '16px' }} onClick={() => {
                            setNewCred({ id: null, name: "", url: "", username: "", password: "", connectionType: "web", remarks: "", installPath: "" });
                            setIsAdding(true);
                        }}>
                            + Add Credential
                        </button>
                    </div>
                ) : (
                    filteredCreds.map(cred => (
                        <div key={cred.id} className="credential-card">
                            <div className="credential-info" style={{ flex: 1, minWidth: 0, paddingRight: '12px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                                    <h3 style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>{cred.name}</h3>
                                    {cred.remarks && (
                                        <span style={{ fontSize: '0.85em', color: '#666', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>
                                            &#128221; {cred.remarks}
                                        </span>
                                    )}
                                    <span 
                                        className="badge" 
                                        style={{ textTransform: (cred.connectionType === 'pam' || cred.connectionType === 'vpn') ? 'uppercase' : 'capitalize', fontSize: '0.75rem', flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                                        onClick={() => handleConnect(cred)}
                                        title="Connect / Open"
                                    >
                                        {cred.connectionType === 'pgadmin' ? '🐘 ' : 
                                         cred.connectionType === 'mysqlworkbench' ? '🐬 ' :
                                         cred.connectionType === 'putty' ? '🔌 ' :
                                         cred.connectionType === 'powershell' ? '⚡ ' : 
                                         cred.connectionType === 'pam' ? '🛡️ ' :
                                         cred.connectionType === 'vpn' ? '🔒 ' :
                                         <img src={getFaviconUrl(cred.url)} width="14" height="14" onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>'; }} alt="🌐"/>}
                                        {cred.connectionType || 'web'}
                                    </span>
                                    {cred.url && (
                                        <span style={{ fontSize: '0.85rem', color: '#666', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>
                                            &#127760; {cred.url}
                                        </span>
                                    )}
                                </div>
                                <div className="credential-meta" style={{ marginTop: '4px' }}>
                                    {cred.username && <span>&#128100; {cred.username}</span>}
                                </div>
                            </div>
                            <div style={{ display: "flex", gap: "4px", alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>

                                <button
                                    className={`copy-button ${copiedId === `${cred.id}-username` ? 'copied' : ''}`}
                                    onClick={() => handleCopy(cred, 'username')}
                                    style={{ padding: '6px 10px', fontSize: '0.85em' }}
                                >
                                    {copiedId === `${cred.id}-username` ? "Copied!" : "Copy User"}
                                </button>

                                <button
                                    className={`copy-button ${copiedId === `${cred.id}-password` ? 'copied' : ''}`}
                                    onClick={() => handleCopy(cred, 'password')}
                                    style={{ padding: '6px 10px', fontSize: '0.85em' }}
                                >
                                    {copiedId === `${cred.id}-password` ? "Copied!" : "Copy Pass"}
                                </button>

                                <button
                                    className="add-button"
                                    style={{ padding: '6px 10px', border: '1px solid #aaa', color: 'inherit', background: 'transparent', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85em' }}
                                    onClick={() => handleOpenEdit(cred)}
                                    title="Edit"
                                >
                                    &#9998; Edit
                                </button>

                                <button
                                    className="delete-button"
                                    onClick={() => handleDelete(cred.id)}
                                    title="Delete"
                                    style={{ padding: '6px 10px', fontSize: '0.85em' }}
                                >
                                    &#128465;
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {toast && (
                <div className="toast">
                    <div className="toast-message">{toast.message}</div>
                    <div className="toast-progress-bar" style={{ animationDuration: `${toast.duration}ms` }}></div>
                </div>
            )}

            {isAdding && (
                <div className="modal-overlay">
                    <div className="modal-content">
                        <h2>{newCred.id ? "Edit Credential" : "Add Credential"}</h2>
                        <form onSubmit={handleSaveCredential}>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Name</label>
                                    <input required value={newCred.name} onChange={e => setNewCred({ ...newCred, name: e.target.value })} placeholder="e.g. My Website, WebServer-01" />
                                </div>
                                <div className="form-group">
                                    <label>URL / IP (Optional)</label>
                                    <input value={newCred.url} onChange={e => setNewCred({ ...newCred, url: e.target.value })} placeholder="e.g. 192.168.1.100 or https://example.com" />
                                </div>
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Username</label>
                                    <input value={newCred.username} onChange={e => setNewCred({ ...newCred, username: e.target.value })} placeholder="e.g. root" />
                                </div>
                                <div className="form-group">
                                    <label>Password</label>
                                    <input type="password" required value={newCred.password} onChange={e => setNewCred({ ...newCred, password: e.target.value })} />
                                </div>
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Connection Type</label>
                                    <select
                                        value={newCred.connectionType}
                                        onChange={e => setNewCred({ ...newCred, connectionType: e.target.value })}
                                        className="form-select"
                                    >
                                        <option value="web">Web (Browser)</option>
                                        <option value="putty">Putty (SSH)</option>
                                        <option value="powershell">PowerShell</option>
                                        <option value="pgadmin">Database (pgAdmin)</option>
                                        <option value="mysqlworkbench">Database (MySQL Workbench)</option>
                                        <option value="pam">PAM</option>
                                        <option value="vpn">VPN</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>Installation Path</label>
                                    <input value={newCred.installPath || ""} onChange={e => setNewCred({ ...newCred, installPath: e.target.value })} placeholder="e.g. C:\Program Files\PuTTY\putty.exe (Optional)" />
                                </div>
                            </div>
                            <div className="form-group">
                                <label>Remarks</label>
                                <textarea
                                    value={newCred.remarks}
                                    onChange={e => setNewCred({ ...newCred, remarks: e.target.value })}
                                    placeholder="Optional notes..."
                                    className="form-textarea"
                                />
                            </div>

                            <div className="modal-actions">
                                <button type="button" className="btn-secondary" onClick={() => setIsAdding(false)}>Cancel</button>
                                <button type="submit" className="copy-button">Save</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {isAboutOpen && (
                <About onClose={() => setIsAboutOpen(false)} />
            )}
        </div>
    );
}
