import React, { useState, useEffect, useRef } from 'react';
import { load } from "@tauri-apps/plugin-store";
import { appDataDir } from "@tauri-apps/api/path";
import { writeText, clear } from "@tauri-apps/plugin-clipboard-manager";
import { Command } from "@tauri-apps/plugin-shell";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import About from "./About";
import './PassVault.css';

// --- Web Crypto Helpers ---
async function getEncryptionKey(deviceKey) {
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

async function encryptData(data, deviceKey) {
    const key = await getEncryptionKey(deviceKey);
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

async function decryptData(dataArray, deviceKey) {
    const key = await getEncryptionKey(deviceKey);
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
        const [isCompact, setIsCompact] = useState(typeof window !== 'undefined' ? window.innerWidth <= 1050 : false);

    useEffect(() => {
        const handleResize = () => {
            setIsCompact(window.innerWidth <= 1050);
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const [search, setSearch] = useState("");
    const [toast, setToast] = useState(null);
    const [copiedId, setCopiedId] = useState(null);
    const [isAdding, setIsAdding] = useState(false);
    const [isAboutOpen, setIsAboutOpen] = useState(false);
    const [isRecoveryOpen, setIsRecoveryOpen] = useState(false);
    const [formattedRecoveryKey, setFormattedRecoveryKey] = useState("");
    const [vaultKey, setVaultKey] = useState(null);
    const [decryptRecoveryKey, setDecryptRecoveryKey] = useState("");
    const [isDecryptModalOpen, setIsDecryptModalOpen] = useState(false);
    const [decryptModalError, setDecryptModalError] = useState("");
    const [restoreData, setRestoreData] = useState(null);
    const [inputRecoveryKey, setInputRecoveryKey] = useState("");
    const [restoreError, setRestoreError] = useState("");
    const [newCred, setNewCred] = useState({ id: null, name: "", url: "", username: "", password: "", connectionType: "web", remarks: "", installPath: "" });
    const [store, setStore] = useState(null);

    const [peers, setPeers] = useState([]);
    const [credToShare, setCredToShare] = useState(null);

    useEffect(() => {
        initVault();
    }, []);

    useEffect(() => {
        // Listen for incoming shares
        const unlisten = listen('incoming-share', async (event) => {
            const { sender, credential } = event.payload;
            if (window.confirm(`User "${sender}" wants to share a credential "${credential.name}" with you. Add to vault?`)) {
                setCredentials(prev => {
                    const newId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).substring(2);
                    const newCreds = [...prev, { ...credential, id: newId }];
                    // Encrypt and save using OS-protected vaultKey
                    if (store && vaultKey) {
                        encryptData(newCreds, vaultKey).then(encrypted => {
                            store.set("credentials", encrypted);
                            store.save();
                        }).catch(err => {
                            console.error("Failed to encrypt shared credential", err);
                        });
                    }
                    return newCreds;
                });
                setToast({ message: `Credential from ${sender} saved!`, duration: 3000 });
                setTimeout(() => setToast(null), 3000);
            }
        });

        // Poll peers
        const interval = setInterval(async () => {
            try {
                const foundPeers = await invoke("get_peers");
                setPeers(foundPeers);
            } catch (e) {}
        }, 3000);

        return () => {
            unlisten.then(f => f());
            clearInterval(interval);
        };
    }, [store, vaultKey]);

    const initVault = async (forcedKey = null) => {
        try {
            const dir = await appDataDir();
            const storeInstance = await load(`${dir}\\vault.json`, { autoSave: false });
            setStore(storeInstance);

            // 1. Retrieve the vault key from OS Keyring (Windows Credential Manager / Apple Keychain / Linux Secret Service)
            let keyStr = forcedKey;
            if (!keyStr) {
                keyStr = await invoke("get_vault_key");
            }

            let isFirstLaunch = false;
            // 2. Migration: Check if legacy vault.json contains deviceKey
            if (!keyStr) {
                const legacyKey = await storeInstance.get("deviceKey");
                if (legacyKey) {
                    // Migrate legacy key into OS Keyring!
                    await invoke("set_vault_key", { key: legacyKey });
                    // Wipe deviceKey from vault.json so it is no longer stored in plaintext!
                    await storeInstance.delete("deviceKey");
                    await storeInstance.save();
                    keyStr = legacyKey;
                } else {
                    const existingEncrypted = await storeInstance.get("credentials");
                    if (existingEncrypted && Array.isArray(existingEncrypted) && existingEncrypted.length > 0) {
                        // Existing vault on disk without key in OS keyring! Do NOT overwrite with a random key!
                        setIsDecryptModalOpen(true);
                        setToast({ message: "Existing vault detected! Enter your Recovery Key to restore OS access.", duration: 6000 });
                        return;
                    } else {
                        // Fresh install: Generate a 256-bit secure key and store in OS Keyring
                        keyStr = await invoke("generate_vault_key");
                        await invoke("set_vault_key", { key: keyStr });
                        isFirstLaunch = true;
                    }
                }
            } else {
                // Ensure legacy deviceKey is not lingering in vault.json
                if (await storeInstance.has("deviceKey")) {
                    await storeInstance.delete("deviceKey");
                    await storeInstance.save();
                }
            }

            setVaultKey(keyStr);

            // Format recovery key for disaster recovery
            try {
                const formatted = await invoke("format_recovery_key", { key: keyStr });
                setFormattedRecoveryKey(formatted);
                if (isFirstLaunch) {
                    setIsRecoveryOpen(true);
                }
            } catch (e) {
                console.error("Failed to format recovery key", e);
            }

            // 3. Decrypt credentials with the OS-protected key
            const encryptedCreds = await storeInstance.get("credentials");
            if (encryptedCreds) {
                try {
                    const decrypted = await decryptData(encryptedCreds, keyStr);
                    setCredentials(decrypted);
                } catch (err) {
                    console.error("Failed to decrypt credentials with key", err);
                    setToast({
                        message: "Unable to decrypt vault with stored OS key. Enter your Recovery Key to unlock it.",
                        duration: 6000
                    });
                    setIsDecryptModalOpen(true);
                }
            } else {
                setCredentials([]);
            }
        } catch (err) {
            console.error("Failed to init vault", err);
        }
    };

    const handleCopy = async (cred, type) => {
        try {
            const textToCopy = type === 'username' ? cred.username : type === 'password' ? cred.password : cred.url;
            if (!textToCopy) return;

            await writeText(textToCopy);

            setCopiedId(`${cred.id}-${type}`);
            setToast({ message: `${type === 'username' ? 'Username' : type === 'password' ? 'Password' : 'URL'} copied to clipboard`, duration: type === 'password' ? 15000 : 3000 });

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


    const copyBothTimerRef = useRef(null);
    const clearClipboardTimerRef = useRef(null);

    const handleAutoType = async (cred) => {
        try {
            const isTerminal = cred.connectionType === 'putty' || cred.connectionType === 'powershell' || cred.connectionType === 'terminal' || cred.connectionType === 'ssh';
            const isPam = cred.connectionType === 'pam';
            setToast({ 
                message: `⚡ Minimizing to auto-type ${isTerminal ? 'into terminal (Enter + 800ms delay)...' : isPam ? 'with PAM keystroke pacing...' : 'into active window...'}`, 
                duration: 4000 
            });
            await invoke("auto_type", {
                username: cred.username || null,
                password: cred.password || null,
                connectionType: cred.connectionType || "web",
                interKeyDelayMs: isPam ? 30 : null
            });
        } catch (err) {
            console.error("Auto-type failed", err);
            setToast({ message: `Auto-type error: ${err}`, duration: 5000 });
            setTimeout(() => setToast(null), 5000);
        }
    };

    const handleCopyBoth = async (cred) => {
        if (!cred.username && !cred.password) return;
        if (!cred.username) return handleCopy(cred, 'password');
        if (!cred.password) return handleCopy(cred, 'username');

        try {
            if (copyBothTimerRef.current) clearTimeout(copyBothTimerRef.current);
            if (clearClipboardTimerRef.current) clearTimeout(clearClipboardTimerRef.current);

            // Step 1: Copy Username
            await writeText(cred.username);
            setCopiedId(`${cred.id}-both-user`);
            setToast({ 
                message: "📋 [1/2] Username copied! Paste it now ➔ Password in 5s...", 
                duration: 5000 
            });

            // Step 2: Switch to Password after 5s
            copyBothTimerRef.current = setTimeout(async () => {
                try {
                    await writeText(cred.password);
                    setCopiedId(`${cred.id}-both-pass`);
                    setToast({ 
                        message: "📋 [2/2] Password now in clipboard! Paste it (clears in 15s).", 
                        duration: 15000 
                    });

                    // Step 3: Clear clipboard after 15s
                    clearClipboardTimerRef.current = setTimeout(async () => {
                        setCopiedId(null);
                        setToast(null);
                        try {
                            await clear();
                        } catch (e) {
                            console.error("Failed to clear clipboard", e);
                        }
                    }, 15000);
                } catch (e) {
                    console.error("Failed to copy password in queue", e);
                }
            }, 5000);

        } catch (err) {
            console.error("Failed in sequential copy", err);
            setToast({ message: "Failed to copy", duration: 3000 });
            setTimeout(() => setToast(null), 3000);
        }
    };

    
    const handleRecoverVault = async (e) => {
        e.preventDefault();
        if (!decryptRecoveryKey.trim()) return;
        setDecryptModalError("");
        try {
            const cleanKey = await invoke("normalize_recovery_key", { input: decryptRecoveryKey.trim() });
            const encryptedCreds = await store.get("credentials");
            if (!encryptedCreds) {
                throw new Error("No encrypted credentials found in vault store.");
            }
            const decrypted = await decryptData(encryptedCreds, cleanKey);
            if (!Array.isArray(decrypted)) {
                throw new Error("Invalid decrypted vault structure.");
            }

            // Key verified! Save key to OS Credential Manager
            await invoke("set_vault_key", { key: cleanKey });
            setVaultKey(cleanKey);
            setCredentials(decrypted);
            
            try {
                const formatted = await invoke("format_recovery_key", { key: cleanKey });
                setFormattedRecoveryKey(formatted);
            } catch (err) {}

            setIsDecryptModalOpen(false);
            setDecryptRecoveryKey("");
            setToast({ message: "✓ Vault successfully unlocked and key saved to OS Credential Manager!", duration: 5000 });
            setTimeout(() => setToast(null), 5000);
        } catch (err) {
            console.error("Vault recovery failed:", err);
            setDecryptModalError(typeof err === 'string' ? err : (err.message || "Failed to decrypt vault with this key. Please check your recovery code."));
        }
    };

    const handleMove = async (id, direction) => {
        if (!store || !vaultKey || search) return;
        const index = credentials.findIndex(c => c.id === id);
        if (index === -1) return;
        
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= credentials.length) return;

        const updatedCreds = [...credentials];
        const temp = updatedCreds[index];
        updatedCreds[index] = updatedCreds[newIndex];
        updatedCreds[newIndex] = temp;

        try {
            const encrypted = await encryptData(updatedCreds, vaultKey);
            await store.set("credentials", encrypted);
            await store.save();
            setCredentials(updatedCreds);
        } catch (err) {
            console.error("Failed to move credential", err);
            alert("Error moving credential");
        }
    };

    const handleBackup = async () => {
        try {
            if (!store || !vaultKey) return;
            const encryptedCreds = await store.get("credentials");
            
            // DO NOT export deviceKey in plaintext!
            const backupData = {
                version: 2,
                app: "PassVault",
                type: "encrypted-vault-backup",
                createdAt: new Date().toISOString(),
                credentials: encryptedCreds || []
            };
            
            const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `passvault_backup_${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            setToast({
                message: "Encrypted backup downloaded. Keep your Emergency Recovery Key to restore it on any device.",
                duration: 5000
            });
            setTimeout(() => setToast(null), 5000);
        } catch (err) {
            console.error("Backup failed", err);
            setToast({ message: "Backup failed", duration: 3000 });
            setTimeout(() => setToast(null), 3000);
        }
    };

    const handleRestore = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    if (!data.credentials) {
                        throw new Error("Invalid backup file format: missing credentials payload");
                    }

                    // Case 1: Legacy v1 backup containing data.deviceKey
                    if (data.deviceKey) {
                        if (!window.confirm("Restore this legacy backup? It will update your vault and import its key into your OS Keyring.")) return;
                        await invoke("set_vault_key", { key: data.deviceKey });
                        if (store) {
                            await store.set("credentials", data.credentials);
                            if (await store.has("deviceKey")) {
                                await store.delete("deviceKey");
                            }
                            await store.save();
                        }
                        await initVault(data.deviceKey);
                        setToast({ message: "Legacy vault restored and migrated to OS Keyring successfully!", duration: 4000 });
                        setTimeout(() => setToast(null), 4000);
                        return;
                    }

                    // Case 2: Standard v2 encrypted backup
                    // Try to decrypt with current vaultKey first
                    let canDecryptWithCurrentKey = false;
                    if (vaultKey) {
                        try {
                            const testDecrypted = await decryptData(data.credentials, vaultKey);
                            if (Array.isArray(testDecrypted)) {
                                canDecryptWithCurrentKey = true;
                                if (!window.confirm("Restore this backup? It will replace your current vault on this device.")) return;
                                if (store) {
                                    await store.set("credentials", data.credentials);
                                    await store.save();
                                }
                                setCredentials(testDecrypted);
                                setToast({ message: "Vault restored successfully!", duration: 3000 });
                                setTimeout(() => setToast(null), 3000);
                                return;
                            }
                        } catch (e) {
                            canDecryptWithCurrentKey = false;
                        }
                    }

                    // If current key cannot decrypt it, prompt for the Emergency Recovery Key!
                    setRestoreData(data);
                    setInputRecoveryKey("");
                    setRestoreError("");
                } catch (err) {
                    console.error("Restore failed", err);
                    setToast({ message: "Restore failed: " + err.message, duration: 4000 });
                    setTimeout(() => setToast(null), 4000);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    };

    const handleConfirmRestoreWithKey = async (e) => {
        e.preventDefault();
        if (!restoreData || !inputRecoveryKey) return;
        setRestoreError("");
        try {
            const normalizedKey = await invoke("normalize_recovery_key", { input: inputRecoveryKey });
            const decrypted = await decryptData(restoreData.credentials, normalizedKey);
            if (!Array.isArray(decrypted)) {
                throw new Error("Invalid decrypted structure");
            }

            // Key is valid! Save key into OS Keyring
            await invoke("set_vault_key", { key: normalizedKey });
            if (store) {
                await store.set("credentials", restoreData.credentials);
                if (await store.has("deviceKey")) {
                    await store.delete("deviceKey");
                }
                await store.save();
            }
            setVaultKey(normalizedKey);
            setCredentials(decrypted);

            const formatted = await invoke("format_recovery_key", { key: normalizedKey });
            setFormattedRecoveryKey(formatted);
            setRestoreData(null);

            setToast({ message: "Vault and key restored successfully into OS Keyring!", duration: 4000 });
            setTimeout(() => setToast(null), 4000);
        } catch (err) {
            console.error("Invalid recovery key for restore", err);
            setRestoreError("The recovery key could not decrypt this backup. Please verify your key and try again.");
        }
    };

    const handleOpenEdit = (cred) => {
        setNewCred({ ...cred });
        setIsAdding(true);
    };

    const handleSaveCredential = async (e) => {
        e.preventDefault();
        if (!store || !vaultKey) return;

        try {
            let updatedCreds;
            if (newCred.id) {
                updatedCreds = credentials.map(c => c.id === newCred.id ? { ...newCred } : c);
                setToast({ message: "Credential updated", duration: 3000 });
            } else {
                const newId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).substring(2);
                updatedCreds = [...credentials, { ...newCred, id: newId }];
                setToast({ message: "Credential added", duration: 3000 });
            }

            const encrypted = await encryptData(updatedCreds, vaultKey);
            await store.set("credentials", encrypted);
            await store.save();

            setCredentials(updatedCreds);
            setIsAdding(false);
            setNewCred({ id: null, name: "", url: "", username: "", password: "", connectionType: "web", remarks: "", installPath: "" });

            setTimeout(() => setToast(null), 3000);
        } catch (err) {
            console.error("Failed to save credential", err);
            alert("Error saving credential: " + err.message);
        }
    };

    const handleDelete = async (id) => {
        if (!store || !vaultKey) return;
        if (!window.confirm("Are you sure you want to delete this credential?")) return;

        try {
            const updatedCreds = credentials.filter(c => c.id !== id);

            const encrypted = await encryptData(updatedCreds, vaultKey);
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
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button className="add-button" style={{ background: '#107c41', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={() => setIsRecoveryOpen(true)} title="View Emergency Recovery Key">
                        🔑 Recovery Key
                    </button>
                    <button className="add-button" style={{ background: '#555' }} onClick={handleBackup} title="Export Encrypted Vault Backup">
                        Backup
                    </button>
                    <button className="add-button" style={{ background: '#555' }} onClick={handleRestore} title="Import / Restore Vault Backup">
                        Restore
                    </button>
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

            <div className="search-container" style={{ position: 'relative' }}>
                <input
                    type="text"
                    className="search-input"
                    placeholder="Search by name or URL/IP..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                    style={{ paddingRight: '3px' }}
                />
                {search && (
                    <button 
                        onClick={() => setSearch("")}
                        style={{ position: 'absolute', right: '1px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.2em', color: '#888' }}
                        title="Clear search"
                    >
                        &times;
                    </button>
                )}
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
                                {/* Row 1: Name + Protocol Badge + Remarks */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', flexWrap: 'wrap' }}>
                                    <h3 style={{ margin: 0, whiteSpace: 'nowrap', fontSize: '1.05rem', fontWeight: 600 }}>{cred.name}</h3>
                                    <span 
                                        className="badge" 
                                        style={{ textTransform: (cred.connectionType === 'pam' || cred.connectionType === 'vpn') ? 'uppercase' : 'capitalize', fontSize: '0.72rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                                        onClick={() => handleConnect(cred)}
                                        title="Click to Connect / Open"
                                    >
                                        {cred.connectionType === 'pgadmin' ? '🐘 ' : 
                                         cred.connectionType === 'mysqlworkbench' ? '🐬 ' :
                                         cred.connectionType === 'putty' ? '🔌 ' :
                                         cred.connectionType === 'powershell' ? '⚡ ' : 
                                         cred.connectionType === 'pam' ? '🛡️ ' :
                                         cred.connectionType === 'vpn' ? '🔒 ' :
                                         <img src={getFaviconUrl(cred.url)} width="13" height="13" onError={(e) => { e.target.onerror = null; e.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>'; }} alt="🌐"/>}
                                        {cred.connectionType || 'web'}
                                    </span>
                                    {cred.remarks && (
                                        <span style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '200px' }} title={cred.remarks}>
                                            &#128221; {cred.remarks}
                                        </span>
                                    )}
                                </div>

                                {/* Row 2: Website / URL and Username (Always visible so user knows which website and which credentials) */}
                                <div className="credential-meta" style={{ marginTop: '5px', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    {cred.url && (
                                        <span 
                                            style={{ fontSize: '0.82rem', color: '#666', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                                            onClick={() => handleCopy(cred, 'url')}
                                            title="Click to copy Website / URL"
                                        >
                                            🌐 <span style={{ textDecoration: copiedId === `${cred.id}-url` ? 'underline' : 'none', fontWeight: 500 }}>
                                                {copiedId === `${cred.id}-url` ? "Copied!" : cred.url}
                                            </span>
                                        </span>
                                    )}
                                    {cred.username && (
                                        <span 
                                            style={{ fontSize: '0.82rem', color: '#444', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                                            onClick={() => handleCopy(cred, 'username')}
                                            title="Click to copy Username"
                                        >
                                            👤 <span style={{ textDecoration: copiedId === `${cred.id}-username` ? 'underline' : 'none', fontWeight: 500 }}>
                                                {copiedId === `${cred.id}-username` ? "Copied!" : cred.username}
                                            </span>
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className={`credential-actions ${isCompact ? 'compact' : ''}`} style={{ flexShrink: 0, display: 'flex', gap: '4px', alignItems: 'center' }}>
                                {(cred.username || cred.password) && (
                                    <button 
                                        className="autotype-button"
                                        onClick={() => handleAutoType(cred)}
                                        title={`⚡ Auto-Type (${cred.connectionType === 'putty' || cred.connectionType === 'powershell' ? 'Terminal: user ➔ Enter ➔ wait ➔ pass' : cred.connectionType === 'pam' ? 'PAM: paced keystrokes' : 'Web: user ➔ Tab ➔ pass'})`}
                                    >
                                        <span className="btn-icon">⚡</span>
                                        <span className="btn-label">Auto-Type</span>
                                    </button>
                                )}
                                {cred.username && cred.password && (
                                    <button 
                                        className={`copy-both-button ${copiedId && copiedId.startsWith(`${cred.id}-both`) ? 'copied' : ''}`}
                                        onClick={() => handleCopyBoth(cred)}
                                        title="Sequential Copy: Copies Username now, switches to Password in 5s"
                                    >
                                        <span className="btn-icon">📋➔🔑</span>
                                        <span className="btn-label">
                                            {copiedId === `${cred.id}-both-user` ? "User Copied!" : copiedId === `${cred.id}-both-pass` ? "Pass Ready!" : "Copy Both"}
                                        </span>
                                    </button>
                                )}
                               {cred.username && (
                                    <button 
                                        className={`copy-button ${copiedId === `${cred.id}-username` ? 'copied' : ''}`}
                                        onClick={() => handleCopy(cred, 'username')}
                                        title={`Copy Username: ${cred.username}`}
                                    >
                                        <span className="btn-icon">👤</span>
                                        <span className="btn-label">{copiedId === `${cred.id}-username` ? "Copied!" : cred.username}</span>
                                    </button>
                                )}
                                <button 
                                    className={`copy-button ${copiedId === `${cred.id}-password` ? 'copied' : ''}`}
                                    onClick={() => handleCopy(cred, 'password')}
                                    title="Copy Password"
                                >
                                    <span className="btn-icon">🔑</span>
                                    <span className="btn-label">{copiedId === `${cred.id}-password` ? "Copied!" : "Password"}</span>
                                </button>
                                
                                <button
                                    className="copy-button btn-share"
                                    style={{ background: '#2563eb' }}
                                    onClick={() => setCredToShare(cred)}
                                    title="Share Credential over LAN"
                                >
                                    <span className="btn-icon">📡</span>
                                    <span className="btn-label">Share</span>
                                </button>

                                <button 
                                    className="edit-button" 
                                    onClick={() => handleOpenEdit(cred)}
                                    title="Edit"
                                >
                                    ✎
                                </button>
                                <button 
                                    className="delete-button" 
                                    onClick={() => handleDelete(cred.id)}
                                    title="Delete"
                                >
                                    🗑️
                                </button>
                                 <div style={{ flexDirection: 'column', gap: '2px', marginRight: '2px' }}>
                                    <button 
                                        className="btn-move" 
                                        onClick={() => handleMove(cred.id, -1)}
                                        title="Move up"
                                        disabled={!!search}
                                    >
                                        ▲
                                    </button>
                                    <button 
                                        className="btn-move" 
                                        onClick={() => handleMove(cred.id, 1)}
                                        title="Move down"
                                        disabled={!!search}
                                    >
                                        ▼
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Share Modal */}
            {credToShare && (
                <div className="modal-overlay">
                    <div className="modal-content">
                        <h2>Share "{credToShare.name}"</h2>
                        <p style={{ color: '#666', fontSize: '0.9em' }}>Select a nearby peer to share securely over LAN (PQC-Encrypted via Kyber768):</p>
                        
                        <div style={{ maxHeight: '200px', overflowY: 'auto', margin: '15px 0' }}>
                            {peers.length === 0 ? (
                                <p style={{ fontStyle: 'italic', color: '#888' }}>Looking for peers on local network...</p>
                            ) : (
                                peers.map((p, idx) => (
                                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px', borderBottom: '1px solid #eee' }}>
                                        <div>
                                            <strong>{p.name}</strong>
                                            <div style={{ fontSize: '0.8em', color: '#666' }}>{p.ip}:{p.port}</div>
                                        </div>
                                        <button 
                                            className="copy-button"
                                            onClick={async () => {
                                                try {
                                                    await invoke("share_credential", {
                                                        peerIp: p.ip,
                                                        peerPort: p.port,
                                                        peerPk: p.public_key,
                                                        credentialJson: JSON.stringify(credToShare)
                                                    });
                                                    setToast({ message: `Sent to ${p.name}!`, duration: 3000 });
                                                    setTimeout(() => setToast(null), 3000);
                                                    setCredToShare(null);
                                                } catch(err) {
                                                    alert("Share failed: " + err);
                                                }
                                            }}
                                        >
                                            Send
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>
                        <div className="modal-actions" style={{ marginTop: '16px' }}>
                            <button type="button" className="btn-secondary" onClick={() => setCredToShare(null)}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Toast Notifications */}
            {toast && (
                <div className="toast">
                    <div className="toast-message">{toast.message}</div>
                    <div className="toast-progress-bar" style={{ animationDuration: `${toast.duration}ms` }}></div>
                </div>
            )}

            {/* Add / Edit Credential Modal */}
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

            {/* Emergency Recovery Key Modal */}
            {isRecoveryOpen && (
                <div className="modal-overlay" style={{ zIndex: 1100 }}>
                    <div className="modal-content" style={{ maxWidth: '520px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                            <span style={{ fontSize: '1.8rem' }}>🔑</span>
                            <h2 style={{ margin: 0 }}>Emergency Recovery Key</h2>
                        </div>
                        <p style={{ color: '#666', fontSize: '0.92rem', lineHeight: '1.5' }}>
                            Your vault encryption key is stored securely in your <strong>Operating System's Credential Manager</strong>. It is never stored in plaintext on disk.
                        </p>
                        
                        <div style={{
                            margin: '16px 0',
                            padding: '16px',
                            background: '#f8fafc',
                            borderRadius: '8px',
                            border: '1px solid #e2e8f0'
                        }}>
                            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                                Your 256-Bit Emergency Recovery Code
                            </label>
                            <div style={{
                                fontFamily: 'monospace',
                                fontSize: '0.95rem',
                                wordBreak: 'break-all',
                                background: '#ffffff',
                                border: '1px solid #cbd5e1',
                                borderRadius: '6px',
                                padding: '12px',
                                color: '#0f172a',
                                fontWeight: 700,
                                userSelect: 'all',
                                textAlign: 'center',
                                letterSpacing: '0.03em'
                            }}>
                                {formattedRecoveryKey || "Loading..."}
                            </div>
                            <button
                                type="button"
                                className="copy-button"
                                style={{ width: '100%', marginTop: '12px', padding: '10px' }}
                                onClick={async () => {
                                    if (formattedRecoveryKey) {
                                        await writeText(formattedRecoveryKey);
                                        setToast({ message: "Emergency Recovery Key copied to clipboard! Save it securely.", duration: 5000 });
                                        setTimeout(() => setToast(null), 5000);
                                    }
                                }}
                            >
                                📋 Copy Emergency Recovery Key
                            </button>
                        </div>

                        <div style={{ background: '#fffbeb', border: '1px solid #fef08a', borderRadius: '6px', padding: '12px', fontSize: '0.85rem', color: '#854d0e', lineHeight: '1.4' }}>
                            ⚠️ <strong>Disaster Recovery Note:</strong> If your computer's motherboard dies, hardware is replaced, or your OS is reinstalled, this Recovery Key is the <strong>ONLY</strong> way to restore your passwords. Save it to a safe place or print it.
                        </div>

                        <div className="modal-actions" style={{ marginTop: '20px' }}>
                            <button type="button" className="copy-button" onClick={() => setIsRecoveryOpen(false)}>
                                I Have Saved My Key
                            </button>
                        </div>
                    </div>
                </div>
            )}

            
            {/* Decrypt Failed / Emergency Recovery Modal */}
            {isDecryptModalOpen && (
                <div className="modal-overlay" style={{ zIndex: 1200 }}>
                    <div className="modal-content" style={{ maxWidth: '480px' }}>
                        <h2>🔑 Unlock Vault with Recovery Key</h2>
                        <p style={{ color: '#666', fontSize: '0.9rem', lineHeight: '1.4' }}>
                            The stored OS key could not decrypt your vault. Enter your <strong>Emergency Recovery Key</strong> to unlock your vault and save it to your local OS Credential Manager:
                        </p>
                        <form onSubmit={handleRecoverVault}>
                            <div className="form-group" style={{ marginTop: '14px' }}>
                                <label>Emergency Recovery Key</label>
                                <textarea
                                    required
                                    rows="3"
                                    className="form-textarea"
                                    style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}
                                    placeholder="Paste PV-XXXXXXXX-... or 64-character hex key"
                                    value={decryptRecoveryKey}
                                    onChange={e => setDecryptRecoveryKey(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            {decryptModalError && (
                                <div style={{ color: '#dc2626', background: '#fef2f2', padding: '8px 12px', borderRadius: '6px', fontSize: '0.85rem', marginBottom: '12px' }}>
                                    {decryptModalError}
                                </div>
                            )}
                            <div className="modal-actions">
                                <button type="button" className="btn-secondary" onClick={() => setIsDecryptModalOpen(false)}>Cancel</button>
                                <button type="submit" className="copy-button">Unlock &amp; Save Key to OS</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Restore with Foreign Recovery Key Modal */}
            {restoreData && (
                <div className="modal-overlay" style={{ zIndex: 1200 }}>
                    <div className="modal-content" style={{ maxWidth: '480px' }}>
                        <h2>🔑 Enter Recovery Key</h2>
                        <p style={{ color: '#666', fontSize: '0.9rem' }}>
                            This backup was encrypted with a different key than your local OS Keyring. Enter the Emergency Recovery Key for this backup to restore it:
                        </p>
                        <form onSubmit={handleConfirmRestoreWithKey}>
                            <div className="form-group" style={{ marginTop: '14px' }}>
                                <label>Emergency Recovery Key</label>
                                <textarea
                                    required
                                    rows="3"
                                    className="form-textarea"
                                    style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}
                                    placeholder="Paste PV-XXXX-... or 64-character hex key"
                                    value={inputRecoveryKey}
                                    onChange={e => setInputRecoveryKey(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            {restoreError && (
                                <div style={{ color: '#dc2626', background: '#fef2f2', padding: '8px 12px', borderRadius: '6px', fontSize: '0.85rem', marginBottom: '12px' }}>
                                    {restoreError}
                                </div>
                            )}
                            <div className="modal-actions">
                                <button type="button" className="btn-secondary" onClick={() => setRestoreData(null)}>Cancel</button>
                                <button type="submit" className="copy-button">Restore &amp; Save Key to OS</button>
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
