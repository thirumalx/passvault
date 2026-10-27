import React, { useState, useEffect, useRef } from 'react';
import { load } from "@tauri-apps/plugin-store";
import { appDataDir } from "@tauri-apps/api/path";
import { writeText, clear } from "@tauri-apps/plugin-clipboard-manager";
import { Command } from "@tauri-apps/plugin-shell";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import About from "./About";
import { useI18n } from "../i18n";
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
    const { t, lang, setLanguage, languages } = useI18n();
    const [credentials, setCredentials] = useState([]);
    const [isCompact, setIsCompact] = useState(typeof window !== 'undefined' ? window.innerWidth <= 1300 : true);

    useEffect(() => {
        const handleResize = () => {
            setIsCompact(window.innerWidth <= 1300);
        };
        window.addEventListener('resize', handleResize);
        handleResize();
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
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [bluetoothStatus, setBluetoothStatus] = useState({
        connected: false,
        deviceName: "",
        deviceAddress: "",
        registered: false,
        isAvailable: false
    });

    useEffect(() => {
        initVault();

        // Check if running on Android with Bluetooth HID support
        let unlistenBt = null;
        let btInterval = null;

        const updateBtStatus = async () => {
            try {
                const status = await invoke("bluetooth_get_status");
                if (status) {
                    setBluetoothStatus(prev => ({
                        ...prev,
                        ...status,
                        isAvailable: status.isAvailable ?? true
                    }));
                }
            } catch (e) {
                console.warn("Failed to get Bluetooth status:", e);
            }
        };

        const setupBt = async () => {
            await updateBtStatus();
            try {
                unlistenBt = await listen("bluetoothStatusChange", (event) => {
                    if (event.payload) {
                        setBluetoothStatus(prev => ({
                            ...prev,
                            ...event.payload,
                            isAvailable: true
                        }));
                    }
                });
            } catch (_) {}
        };
        setupBt();

        // Poll Bluetooth status every 3s so the UI reflects pairing immediately
        btInterval = setInterval(updateBtStatus, 3000);

        return () => {
            if (unlistenBt) unlistenBt();
            if (btInterval) clearInterval(btInterval);
        };
    }, []);

    useEffect(() => {
        // Listen for incoming shares
        const unlisten = listen('incoming-share', async (event) => {
            const { sender, credential } = event.payload;
            if (window.confirm(`${t('shareModal.incomingTitle')}: "${sender}" ${t('shareModal.incomingPrompt')} "${credential.name}". ${t('shareModal.accept')}?`)) {
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
                setToast({ message: `${t('status.credentialSaved')}: ${sender}`, duration: 3000 });
                setTimeout(() => setToast(null), 3000);
            }
        });

        // Periodic peer discovery poll
        const interval = setInterval(async () => {
            try {
                const foundPeers = await invoke('get_peers');
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
            let storeInstance = null;
            try {
                // Platform-agnostic relative filename - handled natively by Tauri plugin-store
                storeInstance = await load("vault.json", { autoSave: false });
            } catch (errRel) {
                console.warn("Relative load('vault.json') failed, trying appDataDir path:", errRel);
                try {
                    const dir = await appDataDir();
                    const sep = dir.includes('/') ? '/' : '\\';
                    storeInstance = await load(`${dir}${sep}vault.json`, { autoSave: false });
                } catch (errAbs) {
                    console.error("Absolute path load failed:", errAbs);
                }
            }
            if (storeInstance) {
                setStore(storeInstance);
            }

            // 1. Retrieve the vault key from OS Keyring (Windows Credential Manager / Apple Keychain / Linux / Android UID Sandbox)
            let keyStr = forcedKey;
            if (!keyStr) {
                try {
                    keyStr = await invoke("get_vault_key");
                } catch (e) {
                    console.error("Failed to read OS keyring:", e);
                }
            }

            let isFirstLaunch = false;
            // 2. Migration: Check if legacy vault.json contains deviceKey
            if (!keyStr && storeInstance) {
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
                        setToast({ message: t('status.decryptionError'), duration: 6000 });
                        return;
                    } else {
                        // Fresh install: Generate a 256-bit secure key and store in OS Keyring
                        keyStr = await invoke("generate_vault_key");
                        await invoke("set_vault_key", { key: keyStr });
                        isFirstLaunch = true;
                    }
                }
            } else if (storeInstance) {
                // Ensure legacy deviceKey is not lingering in vault.json
                if (await storeInstance.has("deviceKey")) {
                    await storeInstance.delete("deviceKey");
                    await storeInstance.save();
                }
            }

            if (!keyStr) {
                keyStr = await invoke("generate_vault_key");
                await invoke("set_vault_key", { key: keyStr });
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
            if (storeInstance) {
                const encryptedCreds = await storeInstance.get("credentials");
                if (encryptedCreds) {
                    try {
                        const decrypted = await decryptData(encryptedCreds, keyStr);
                        setCredentials(decrypted);
                    } catch (err) {
                        console.error("Failed to decrypt credentials with key", err);
                        setToast({
                            message: t('status.decryptionError'),
                            duration: 6000
                        });
                        setIsDecryptModalOpen(true);
                    }
                } else {
                    setCredentials([]);
                }
            }
        } catch (err) {
            console.error("Failed to init vault", err);
            setToast({ message: "Init Vault Error: " + (err.message || err), duration: 4000 });
        }
    };

    const handleCopy = async (cred, type) => {
        try {
            const textToCopy = type === 'username' ? cred.username : type === 'password' ? cred.password : cred.url;
            if (!textToCopy) return;

            await writeText(textToCopy);

            setCopiedId(`${cred.id}-${type}`);
            setToast({
                message: type === 'username' ? t('status.usernameCopied') : type === 'password' ? t('status.passwordCopied') : t('status.urlCopied'),
                duration: type === 'password' ? 15000 : 3000
            });

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
            setToast({ message: `${t('status.failedCopy')}: ${type}`, duration: 3000 });
        }
    };

    // Sequential Copy: Copies username, waits 5s, then automatically copies password
    const handleCopyBoth = async (cred) => {
        try {
            if (!cred.username && !cred.password) return;

            if (cred.username) {
                await writeText(cred.username);
                setCopiedId(`${cred.id}-both-user`);
                setToast({
                    message: `1/2: ${t('status.usernameCopied')}! ${t('status.passReady')} in 5s...`,
                    duration: 5000
                });
            }

            if (cred.password) {
                setTimeout(async () => {
                    try {
                        await writeText(cred.password);
                        setCopiedId(`${cred.id}-both-pass`);
                        setToast({
                            message: `2/2: ${t('status.passwordCopied')}`,
                            duration: 15000
                        });

                        setTimeout(async () => {
                            setCopiedId(null);
                            setToast(null);
                            try {
                                await clear();
                            } catch (e) {}
                        }, 15000);
                    } catch (e) {
                        console.error("Failed in sequential copy step 2", e);
                    }
                }, 5000);
            }
        } catch (err) {
            console.error("Failed in handleCopyBoth", err);
            setToast({ message: t('status.failedCopy'), duration: 3000 });
        }
    };

    // Auto-Type: Sends credentials via Bluetooth HID Keyboard (phone to PC) or OS simulator (desktop)
    const handleAutoType = async (cred) => {
        try {
            const isBt = bluetoothStatus.isAvailable;
            setToast({
                message: isBt && bluetoothStatus.connected
                    ? `⚡ Typing to "${bluetoothStatus.deviceName || 'PC'}" via Bluetooth...`
                    : t('status.autoTyping'),
                duration: 4000
            });

            if (isBt) {
                // Wirelessly type to paired PC via Bluetooth HID Keyboard
                await invoke("bluetooth_type_credentials", {
                    payload: {
                        username: cred.username || "",
                        password: cred.password || "",
                        connectionType: cred.connectionType || "web",
                        interKeyDelayMs: cred.connectionType === "pam" ? 35 : 20
                    }
                });
            } else {
                // Desktop OS simulation
                await invoke("auto_type", {
                    username: cred.username || "",
                    password: cred.password || "",
                    connectionType: cred.connectionType || "web",
                    delayMs: 1500
                });
            }

            setTimeout(() => {
                setToast({ message: t('status.copied'), duration: 2500 });
                setTimeout(() => setToast(null), 2500);
            }, 2000);
        } catch (err) {
            console.error("Auto-Type failed:", err);
            setToast({
                message: `Auto-Type failed: ${typeof err === 'string' ? err : (err.message || 'Error')}`,
                duration: 5000
            });
            setTimeout(() => setToast(null), 5000);
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
            setToast({ message: t('status.restoreSuccess'), duration: 5000 });
            setTimeout(() => setToast(null), 5000);
        } catch (err) {
            console.error("Vault recovery failed:", err);
            setDecryptModalError(typeof err === 'string' ? err : (err.message || t('login.invalidKey')));
        }
    };

    const handleMove = async (id, direction) => {
        if (!store || !vaultKey || search) return;
        const index = credentials.findIndex(c => c.id === id);
        if (index === -1) return;
        
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= credentials.length) return;

        const updatedCreds = [...credentials];
        const [movedItem] = updatedCreds.splice(index, 1);
        updatedCreds.splice(newIndex, 0, movedItem);

        try {
            const encrypted = await encryptData(updatedCreds, vaultKey);
            await store.set("credentials", encrypted);
            await store.save();
            setCredentials(updatedCreds);
        } catch (err) {
            console.error("Failed to move credential", err);
        }
    };

    const handleConnect = async (cred) => {
        try {
            const type = cred.connectionType || 'web';
            if (type === 'web') {
                if (!cred.url) return;
                let target = cred.url;
                if (!target.startsWith('http://') && !target.startsWith('https://')) {
                    target = 'https://' + target;
                }
                await openUrl(target);
                return;
            }

            const path = cred.installPath ? cred.installPath.trim() : "";
            let commandName = "";
            let args = [];

            if (type === 'putty') {
                commandName = path || "putty";
                if (cred.url) {
                    if (cred.username) {
                        args.push(`${cred.username}@${cred.url}`);
                    } else {
                        args.push(cred.url);
                    }
                }
            } else if (type === 'powershell') {
                commandName = path || "powershell";
                if (cred.url) {
                    args = ["-NoExit", "-Command"];
                    if (cred.username) {
                        args.push(`ssh ${cred.username}@${cred.url}`);
                    } else {
                        args.push(`ssh ${cred.url}`);
                    }
                }
            } else if (type === 'pgadmin') {
                commandName = path || "pgadmin4";
            } else if (type === 'mysqlworkbench') {
                commandName = path || "mysql-workbench";
            } else if (type === 'pam' || type === 'vpn') {
                if (path) {
                    commandName = path;
                } else if (cred.url) {
                    let target = cred.url;
                    if (!target.startsWith('http://') && !target.startsWith('https://')) {
                        target = 'https://' + target;
                    }
                    await openUrl(target);
                    return;
                } else {
                    setToast({ message: "No URL or executable path specified.", duration: 3000 });
                    setTimeout(() => setToast(null), 3000);
                    return;
                }
            }

            if (commandName) {
                const cmd = Command.create(commandName, args);
                await cmd.spawn();
            }
        } catch (err) {
            console.error(`Failed to launch ${cred.connectionType}`, err);
            setToast({ message: `Failed to launch ${cred.connectionType}. Check PATH or installation path.`, duration: 5000 });
            setTimeout(() => setToast(null), 5000);
        }
    };

    const handleBackup = async () => {
        if (!store) return;
        try {
            const data = await store.entries();
            const exportData = {};
            for (const [key, value] of data) {
                exportData[key] = value;
            }
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `passvault_backup_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            setToast({ message: t('status.backupDownloaded'), duration: 3000 });
            setTimeout(() => setToast(null), 3000);
        } catch (err) {
            console.error("Backup failed", err);
        }
    };

    const handleRestore = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    if (!data.credentials) {
                        alert("Invalid backup file: missing credentials payload");
                        return;
                    }

                    // Try decrypting with local OS-stored key first
                    if (vaultKey) {
                        try {
                            const decrypted = await decryptData(data.credentials, vaultKey);
                            if (store) {
                                await store.set("credentials", data.credentials);
                                if (await store.has("deviceKey")) {
                                    await store.delete("deviceKey");
                                }
                                await store.save();
                            }
                            setCredentials(decrypted);
                            setToast({ message: t('status.restoreSuccess'), duration: 3000 });
                            setTimeout(() => setToast(null), 3000);
                            return;
                        } catch (decryptErr) {
                            // Key mismatch - prompt user for recovery key / passphrase
                        }
                    }

                    // Need foreign recovery key / passphrase
                    setRestoreData(data);
                    setInputRecoveryKey("");
                    setRestoreError("");
                } catch (err) {
                    console.error("Restore failed", err);
                    alert("Failed to parse backup JSON file");
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
            const normalizedKey = await invoke("normalize_recovery_key", { input: inputRecoveryKey.trim() });
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

            setToast({ message: t('status.restoreSuccess'), duration: 4000 });
            setTimeout(() => setToast(null), 4000);
        } catch (err) {
            console.error("Invalid recovery key for restore", err);
            setRestoreError(t('login.invalidKey'));
        }
    };

    const handleOpenEdit = (cred) => {
        setNewCred({ ...cred });
        setIsAdding(true);
    };

    const handleSaveCredential = async (e) => {
        e.preventDefault();
        try {
            let currentStore = store;
            if (!currentStore) {
                try {
                    currentStore = await load("vault.json", { autoSave: false });
                } catch (_) {
                    try {
                        const dir = await appDataDir();
                        const sep = dir.includes('/') ? '/' : '\\';
                        currentStore = await load(`${dir}${sep}vault.json`, { autoSave: false });
                    } catch (_) {}
                }
                if (currentStore) setStore(currentStore);
            }

            let currentKey = vaultKey;
            if (!currentKey) {
                try {
                    currentKey = await invoke("get_vault_key");
                } catch (_) {}
                if (!currentKey) {
                    try {
                        currentKey = await invoke("generate_vault_key");
                        await invoke("set_vault_key", { key: currentKey });
                    } catch (_) {}
                }
                if (currentKey) setVaultKey(currentKey);
            }

            if (!currentStore || !currentKey) {
                setToast({ message: "Unable to initialize vault storage.", duration: 3000 });
                return;
            }

            let updatedCreds;
            if (newCred.id) {
                updatedCreds = credentials.map(c => c.id === newCred.id ? newCred : c);
            } else {
                const newId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).substring(2);
                updatedCreds = [...credentials, { ...newCred, id: newId }];
            }

            const encrypted = await encryptData(updatedCreds, currentKey);
            await currentStore.set("credentials", encrypted);
            await currentStore.save();

            setCredentials(updatedCreds);
            setIsAdding(false);
            setToast({ message: t('status.credentialSaved'), duration: 3000 });
            setTimeout(() => setToast(null), 3000);
        } catch (err) {
            console.error("Failed to save credential", err);
            setToast({ message: "Save failed: " + (err.message || err), duration: 4000 });
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm("Are you sure you want to delete this credential?")) return;
        try {
            let currentStore = store;
            let currentKey = vaultKey;
            if (!currentStore || !currentKey) {
                try {
                    currentStore = await load("vault.json", { autoSave: false });
                } catch (_) {}
                if (!currentKey) {
                    currentKey = await invoke("get_vault_key");
                }
            }
            if (!currentStore || !currentKey) return;

            const updatedCreds = credentials.filter(c => c.id !== id);
            const encrypted = await encryptData(updatedCreds, currentKey);
            await currentStore.set("credentials", encrypted);
            await currentStore.save();

            setCredentials(updatedCreds);
            setToast({ message: t('status.credentialDeleted'), duration: 3000 });
            setTimeout(() => setToast(null), 3000);
        } catch (err) {
            console.error("Failed to delete credential", err);
            setToast({ message: "Delete failed: " + (err.message || err), duration: 4000 });
        }
    };

    const filteredCreds = credentials.filter(c => {
        const term = search.toLowerCase();
        return (
            c.name.toLowerCase().includes(term) ||
            (c.url && c.url.toLowerCase().includes(term)) ||
            (c.username && c.username.toLowerCase().includes(term))
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

    const handleBtClick = async () => {
        try {
            await invoke("bluetooth_request_permissions");
            const status = await invoke("bluetooth_get_status");
            if (status) {
                setBluetoothStatus(prev => ({ ...prev, ...status, isAvailable: true }));
            }
        } catch (_) {}
        alert(
            "Bluetooth Auto-Type Instructions:\n\n" +
            "1. Open Bluetooth Settings on this phone.\n" +
            "2. Pair with your PC.\n" +
            "3. Your PC will recognize this phone as a Bluetooth Keyboard.\n" +
            "4. Click into any login box on your PC.\n" +
            "5. Tap 'Auto-Type' (⚡) on any credential in PassVault to beam it wirelessly!"
        );
    };

    return (
        <div className="vault-container">
            <header className="vault-header">
                <h4>
                    <span>&#128272;</span> {t('appTitle')}
                </h4>

                {/* Desktop Header Actions */}
                <div className="desktop-header-actions" style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="add-button" style={{ background: '#107c41', display: 'flex', alignItems: 'center', gap: '2px' }} onClick={() => setIsRecoveryOpen(true)} title={t('recoveryModal.title')}>
                        {t('actions.recoveryKey')}
                    </button>
                    <button className="add-button" style={{ background: '#555' }} onClick={handleBackup} title={t('actions.backup')}>
                        {t('actions.backup')}
                    </button>
                    <button className="add-button" style={{ background: '#555' }} onClick={handleRestore} title={t('actions.restore')}>
                        {t('actions.restore')}
                    </button>
                    <button className="add-button" style={{ background: '#555' }} onClick={() => setIsAboutOpen(true)} title={t('actions.about')}>
                        {t('actions.about')}
                    </button>
                    <button className="add-button" onClick={() => {
                        setNewCred({ id: null, name: "", url: "", username: "", password: "", connectionType: "web", remarks: "", installPath: "" });
                        setIsAdding(true);
                    }}>
                        {t('actions.addCredential')}
                    </button>
                    {/* Bluetooth HID Keyboard Status for Mobile / Desktop */}
                    {bluetoothStatus.isAvailable && (
                        <button
                            className="add-button"
                            onClick={handleBtClick}
                            style={{
                                background: bluetoothStatus.connected ? '#107c41' : '#c0392b',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                fontSize: '0.7rem'
                            }}
                            title={bluetoothStatus.connected ? `Bluetooth Keyboard connected to: ${bluetoothStatus.deviceName || 'PC'}` : "Bluetooth Keyboard disconnected. Tap to pair."}
                        >
                            <span>{bluetoothStatus.connected ? '🟢' : '🔴'}</span>
                            <span>{bluetoothStatus.connected ? `BT: ${bluetoothStatus.deviceName || 'PC'}` : 'BT: Offline'}</span>
                        </button>
                    )}
                    {/* Language Selector Dropdown */}
                    <select
                        value={lang}
                        onChange={(e) => setLanguage(e.target.value)}
                        style={{
                            padding: '6px 10px',
                            borderRadius: '6px',
                            border: '1px solid #ccc',
                            background: 'white',
                            color: '#333',
                            fontSize: '0.65rem',
                            cursor: 'pointer',
                            fontWeight: 400
                        }}
                        title={t('language.select')}
                    >
                        {languages.map(l => (
                            <option key={l.code} value={l.code}>
                                🌐 {l.native}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Mobile Header Actions: Streamlined with BT indicator, + Add button, and Three-Bar Hamburger menu */}
                <div className="mobile-header-actions">
                    {bluetoothStatus.isAvailable && (
                        <button
                            className="btn-mobile-bt"
                            onClick={handleBtClick}
                            style={{ background: bluetoothStatus.connected ? '#107c41' : '#c0392b' }}
                            title={bluetoothStatus.connected ? `Bluetooth Keyboard connected to: ${bluetoothStatus.deviceName || 'PC'}` : "Bluetooth Keyboard disconnected. Tap to pair."}
                        >
                            <span>{bluetoothStatus.connected ? '🟢' : '🔴'}</span>
                            <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>{bluetoothStatus.connected ? (bluetoothStatus.deviceName || 'BT') : 'BT'}</span>
                        </button>
                    )}
                    <button
                        className="add-button"
                        style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                        onClick={() => {
                            setNewCred({ id: null, name: "", url: "", username: "", password: "", connectionType: "web", remarks: "", installPath: "" });
                            setIsAdding(true);
                        }}
                        title={t('actions.addCredential')}
                    >
                        + {t('actions.addCredential')}
                    </button>
                    <button
                        className="hamburger-button"
                        onClick={() => setIsMobileMenuOpen(prev => !prev)}
                        aria-label="Menu"
                        title="Menu"
                    >
                        {isMobileMenuOpen ? '✕' : '☰'}
                    </button>
                </div>

                {/* Mobile Dropdown Drawer */}
                {isMobileMenuOpen && (
                    <div className="mobile-menu-drawer">
                        <button className="mobile-menu-item" onClick={() => { setIsRecoveryOpen(true); setIsMobileMenuOpen(false); }}>
                            <span>🔑</span>
                            <span>{t('actions.recoveryKey')}</span>
                        </button>
                        <button className="mobile-menu-item" onClick={() => { handleBackup(); setIsMobileMenuOpen(false); }}>
                            <span>💾</span>
                            <span>{t('actions.backup')}</span>
                        </button>
                        <button className="mobile-menu-item" onClick={() => { handleRestore(); setIsMobileMenuOpen(false); }}>
                            <span>📂</span>
                            <span>{t('actions.restore')}</span>
                        </button>
                        <button className="mobile-menu-item" onClick={() => { setIsAboutOpen(true); setIsMobileMenuOpen(false); }}>
                            <span>ℹ️</span>
                            <span>{t('actions.about')}</span>
                        </button>
                        <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #eee', marginTop: '4px' }}>
                            <span style={{ fontSize: '0.8rem', color: '#666' }}>🌐 Language</span>
                            <select
                                value={lang}
                                onChange={(e) => {
                                    setLanguage(e.target.value);
                                    setIsMobileMenuOpen(false);
                                }}
                                style={{
                                    padding: '4px 8px',
                                    borderRadius: '6px',
                                    border: '1px solid #ccc',
                                    background: 'white',
                                    fontSize: '0.75rem',
                                    cursor: 'pointer'
                                }}
                            >
                                {languages.map(l => (
                                    <option key={l.code} value={l.code}>
                                        {l.native}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}
            </header>

            {/* Mobile Menu Backdrop */}
            {isMobileMenuOpen && (
                <div
                    className="mobile-menu-backdrop"
                    onClick={() => setIsMobileMenuOpen(false)}
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: 999,
                        background: 'rgba(0,0,0,0.1)'
                    }}
                />
            )}

            <div className="search-container" style={{ position: 'relative' }}>
                <input
                    type="text"
                    className="search-input"
                    placeholder={t('searchPlaceholder')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                    style={{ paddingRight: '28px' }}
                />
                {search && (
                    <button 
                        onClick={() => setSearch("")}
                        style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.2em', color: '#888' }}
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
                        <h2>{search ? t('noSearchResults') : t('noCredentials')}</h2>
                        <p>{search ? "" : "Add your first credential to securely store and manage your access details."}</p>
                        {!search && (
                            <button className="copy-button" style={{ marginTop: '16px' }} onClick={() => {
                                setNewCred({ id: null, name: "", url: "", username: "", password: "", connectionType: "web", remarks: "", installPath: "" });
                                setIsAdding(true);
                            }}>
                                {t('actions.addCredential')}
                            </button>
                        )}
                    </div>
                ) : (
                    filteredCreds.map(cred => (
                        <div key={cred.id} className="credential-card">
                            <div className="credential-info" style={{ flex: 1, minWidth: 0, paddingRight: '0px' }}>
                                {/* Row 1: Name + Protocol Badge + Remarks */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', flexWrap: 'wrap' }}>
                                    <h4 style={{ margin: 0, whiteSpace: 'nowrap', fontSize: '0.85rem', fontWeight: 600 }}>{cred.name}</h4>
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
                                <div className="credential-meta" style={{ marginTop: '1px', display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    {cred.url && (
                                        <span 
                                            style={{ fontSize: '0.82rem', color: '#666', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                                            onClick={() => handleCopy(cred, 'url')}
                                            title="Click to copy Website / URL"
                                        >
                                            🌐 <span style={{ textDecoration: copiedId === `${cred.id}-url` ? 'underline' : 'none', fontWeight: 500 }}>
                                                {copiedId === `${cred.id}-url` ? t('status.copied') : cred.url}
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
                                                {copiedId === `${cred.id}-username` ? t('status.copied') : cred.username}
                                            </span>
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className={`credential-actions ${isCompact ? 'compact' : ''}`} style={{ flexShrink: 0, display: 'flex', gap: '6px', alignItems: 'center' }}>
                                {(cred.username || cred.password) && (
                                    <button 
                                        className="autotype-button"
                                        onClick={() => handleAutoType(cred)}
                                        title={`⚡ ${t('actions.autoType')}: ${cred.connectionType === 'putty' || cred.connectionType === 'powershell' ? 'Terminal (Enter)' : cred.connectionType === 'pam' ? 'PAM (Paced)' : 'Web (Tab)'}`}
                                    >
                                        <span className="btn-icon">⚡</span>
                                        <span className="btn-label">{bluetoothStatus.isAvailable && bluetoothStatus.connected ? 'BT Type' : t('actions.autoType')}</span>
                                    </button>
                                )}
                                {cred.username && cred.password && (
                                    <button 
                                        className={`copy-both-button ${copiedId && copiedId.startsWith(`${cred.id}-both`) ? 'copied' : ''}`}
                                        onClick={() => handleCopyBoth(cred)}
                                        title={t('actions.copyBothTooltip')}
                                    >
                                        <span className="btn-icon">📋➔🔑</span>
                                        <span className="btn-label">
                                            {copiedId === `${cred.id}-both-user` ? t('status.userCopied') : copiedId === `${cred.id}-both-pass` ? t('status.passReady') : t('actions.copyBoth')}
                                        </span>
                                    </button>
                                )}
                                {cred.username && (
                                    <button 
                                        className={`copy-button ${copiedId === `${cred.id}-username` ? 'copied' : ''}`}
                                        onClick={() => handleCopy(cred, 'username')}
                                        title={`${t('actions.copyUsername')}: ${cred.username}`}
                                    >
                                        <span className="btn-icon">👤</span>
                                        <span className="btn-label">{copiedId === `${cred.id}-username` ? t('status.copied') : t('actions.copyUsername')}</span>
                                    </button>
                                )}
                                <button 
                                    className={`copy-button ${copiedId === `${cred.id}-password` ? 'copied' : ''}`}
                                    onClick={() => handleCopy(cred, 'password')}
                                    title={t('actions.copyPasswordTooltip')}
                                >
                                    <span className="btn-icon">🔑</span>
                                    <span className="btn-label">{copiedId === `${cred.id}-password` ? t('status.copied') : t('actions.copyPassword')}</span>
                                </button>
                                
                                <button
                                    className="copy-button btn-share"
                                    style={{ background: '#2563eb' }}
                                    onClick={() => setCredToShare(cred)}
                                    title={t('actions.shareTooltip')}
                                >
                                    <span className="btn-icon">📡</span>
                                    <span className="btn-label">{t('actions.share')}</span>
                                </button>

                                <button 
                                    className="edit-button" 
                                    onClick={() => handleOpenEdit(cred)}
                                    title={t('actions.edit')}
                                >
                                    ✎
                                </button>
                                <button 
                                    className="delete-button" 
                                    onClick={() => handleDelete(cred.id)}
                                    title={t('actions.delete')}
                                >
                                    🗑️
                                </button>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginRight: '2px' }}>
                                    <button 
                                        className="edit-button" 
                                        style={{ height: '17px', width: '22px', fontSize: '10px' }} 
                                        onClick={() => handleMove(cred.id, -1)} 
                                        disabled={credentials.indexOf(cred) === 0 || !!search}
                                        title={t('actions.moveUp')}
                                    >
                                        ▲
                                    </button>
                                    <button 
                                        className="edit-button" 
                                        style={{ height: '17px', width: '22px', fontSize: '10px' }} 
                                        onClick={() => handleMove(cred.id, 1)} 
                                        disabled={credentials.indexOf(cred) === credentials.length - 1 || !!search}
                                        title={t('actions.moveDown')}
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
                        <h2>{t('shareModal.title')} ("{credToShare.name}")</h2>
                        <p style={{ color: '#666', fontSize: '0.9em' }}>{t('shareModal.selectDevice')}</p>
                        
                        <div style={{ maxHeight: '200px', overflowY: 'auto', margin: '15px 0' }}>
                            {peers.length === 0 ? (
                                <p style={{ fontStyle: 'italic', color: '#888' }}>{t('shareModal.searching')}</p>
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
                                                    setToast({ message: `${t('status.credentialSaved')}: ${p.name}`, duration: 3000 });
                                                    setTimeout(() => setToast(null), 3000);
                                                    setCredToShare(null);
                                                } catch(err) {
                                                    alert("Share failed: " + err);
                                                }
                                            }}
                                        >
                                            {t('shareModal.send')}
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>
                        <div className="modal-actions" style={{ marginTop: '16px' }}>
                            <button type="button" className="btn-secondary" onClick={() => setCredToShare(null)}>{t('actions.cancel')}</button>
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
                        <h2>{newCred.id ? t('credForm.editTitle') : t('credForm.addTitle')}</h2>
                        <form onSubmit={handleSaveCredential}>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>{t('credForm.titleLabel')}</label>
                                    <input required value={newCred.name} onChange={e => setNewCred({ ...newCred, name: e.target.value })} placeholder={t('credForm.titlePlaceholder')} />
                                </div>
                                <div className="form-group">
                                    <label>{t('credForm.urlLabel')}</label>
                                    <input value={newCred.url} onChange={e => setNewCred({ ...newCred, url: e.target.value })} placeholder={t('credForm.urlPlaceholder')} />
                                </div>
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>{t('credForm.usernameLabel')}</label>
                                    <input value={newCred.username} onChange={e => setNewCred({ ...newCred, username: e.target.value })} placeholder={t('credForm.usernamePlaceholder')} />
                                </div>
                                <div className="form-group">
                                    <label>{t('credForm.passwordLabel')}</label>
                                    <input type="password" required value={newCred.password} onChange={e => setNewCred({ ...newCred, password: e.target.value })} placeholder={t('credForm.passwordPlaceholder')} />
                                </div>
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>{t('credForm.connectionTypeLabel')}</label>
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
                                        <option value="pam">Arcon PAM</option>
                                        <option value="vpn">VPN</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>{t('credForm.installPathLabel')}</label>
                                    <input value={newCred.installPath || ""} onChange={e => setNewCred({ ...newCred, installPath: e.target.value })} placeholder={t('credForm.installPathPlaceholder')} />
                                </div>
                            </div>
                            <div className="form-group">
                                <label>{t('credForm.remarksLabel')}</label>
                                <textarea
                                    value={newCred.remarks}
                                    onChange={e => setNewCred({ ...newCred, remarks: e.target.value })}
                                    placeholder={t('credForm.remarksPlaceholder')}
                                    className="form-textarea"
                                />
                            </div>

                            <div className="modal-actions">
                                <button type="button" className="btn-secondary" onClick={() => setIsAdding(false)}>{t('actions.cancel')}</button>
                                <button type="submit" className="copy-button">{t('actions.save')}</button>
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
                            <h2 style={{ margin: 0 }}>{t('recoveryModal.title')}</h2>
                        </div>
                        <p style={{ color: '#666', fontSize: '0.92rem', lineHeight: '1.5' }}>
                            {t('recoveryModal.description')}
                        </p>
                        
                        <div style={{
                            margin: '16px 0',
                            padding: '16px',
                            background: '#f8fafc',
                            borderRadius: '8px',
                            border: '1px solid #e2e8f0'
                        }}>
                            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                                {t('recoveryModal.keyLabel')}
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
                                        setToast({ message: t('recoveryModal.copied'), duration: 5000 });
                                        setTimeout(() => setToast(null), 5000);
                                    }
                                }}
                            >
                                {t('recoveryModal.copy')}
                            </button>
                        </div>

                        <div className="modal-actions" style={{ marginTop: '20px' }}>
                            <button type="button" className="copy-button" onClick={() => setIsRecoveryOpen(false)}>
                                {t('recoveryModal.close')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Decrypt Failed / Emergency Recovery Modal */}
            {isDecryptModalOpen && (
                <div className="modal-overlay" style={{ zIndex: 1200 }}>
                    <div className="modal-content" style={{ maxWidth: '480px' }}>
                        <h2>{t('unlockModal.title')}</h2>
                        <p style={{ color: '#666', fontSize: '0.9rem', lineHeight: '1.4' }}>
                            {t('unlockModal.description')}
                        </p>
                        <form onSubmit={handleRecoverVault}>
                            <div className="form-group" style={{ marginTop: '14px' }}>
                                <label>{t('unlockModal.inputLabel')}</label>
                                <textarea
                                    required
                                    rows="3"
                                    className="form-textarea"
                                    style={{ fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: '0.9rem' }}
                                    placeholder={t('unlockModal.inputPlaceholder')}
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
                                <button type="button" className="btn-secondary" onClick={() => setIsDecryptModalOpen(false)}>{t('actions.cancel')}</button>
                                <button type="submit" className="copy-button">{t('unlockModal.unlockButton')}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Restore with Foreign Recovery Key Modal */}
            {restoreData && (
                <div className="modal-overlay" style={{ zIndex: 1200 }}>
                    <div className="modal-content" style={{ maxWidth: '480px' }}>
                        <h2>{t('restoreModal.title')}</h2>
                        <p style={{ color: '#666', fontSize: '0.9rem' }}>
                            {t('restoreModal.description')}
                        </p>
                        <form onSubmit={handleConfirmRestoreWithKey}>
                            <div className="form-group" style={{ marginTop: '14px' }}>
                                <label>{t('restoreModal.keyLabel')}</label>
                                <textarea
                                    required
                                    rows="3"
                                    className="form-textarea"
                                    style={{ fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: '0.9rem' }}
                                    placeholder={t('restoreModal.keyPlaceholder')}
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
                                <button type="button" className="btn-secondary" onClick={() => setRestoreData(null)}>{t('actions.cancel')}</button>
                                <button type="submit" className="copy-button">{t('restoreModal.confirmRestore')}</button>
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
