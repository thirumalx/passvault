# Passvault 🔐

**Passvault** is a lightweight, secure desktop application for managing and quickly copying frequently used credentials without exposing passwords on screen.

Built with **Tauri + React**, the application provides a simple interface where users can search for a credential and copy its password to the clipboard with a single click.

## Features

* 🔐 **Hardware & OS-Native Protection**: Sealed inside OS credential managers (Windows Credential Manager, Apple Keychain, Linux Secret Service)
* 🛡️ **Zero Plaintext Keys on Disk**: Encryption keys are never stored in plaintext inside `vault.json` or source files
* 🔑 **Emergency Disaster Recovery Key**: Human-readable recovery code (`TV-XXXX-...`) prevents data loss during OS reinstall or hardware failure
* 💾 **Safe Encrypted Backups**: Backups contain only encrypted ciphertext and never leak the vault key
* 👁️ **Screen Privacy**: Passwords are never displayed in the UI
* 📋 **One-Click Copy**: Instant clipboard copying with automatic timeout clearing (15s)
* ⚡ **Protocol-Aware Auto-Type**: 1-click keystroke simulation directly into browsers, PuTTY, PowerShell, and Arcon PAM (with automatic Enter/Tab separator selection, terminal SSH delay, and remote session pacing)
* 📋 **Sequential Copy ("Copy Both")**: Two-stage clipboard queue that copies Username first, then automatically switches to Password after 5s
* 🔎 **Fast Search**: Instant filtering by name, URL, IP, or environment
* 🖥️ **Multi-Protocol Launcher**: 1-click connect for Web, SSH (PuTTY), PowerShell remoting, pgAdmin, and MySQL Workbench
* 🌐 **100% Local-First**: Operates offline without external cloud dependency
* ⚡ **Ultra-Lightweight**: Built with Tauri for minimal memory footprint and fast startup
* 📡 **Local LAN Peer-to-Peer Sharing**: Zero-configuration discovery via mDNS
* 🛡️ **Post-Quantum Cryptography**: Crystals-Kyber (ML-KEM/Kyber768) + AES-256-GCM for LAN transfers

## Example

```text
┌─────────────────────────────────────────────┐
│ 🔐 Passvault                  [🔑 Recovery] │
├─────────────────────────────────────────────┤
│ Search: [ Production DB____________ ]       │
│                                             │
│ Production DB                    [ COPY ]   │
│ UAT DB                           [ COPY ]   │
│ SFTP                             [ COPY ]   │
│ DEV DB                           [ COPY ]   │
│                                             │
├─────────────────────────────────────────────┤
│ ✓ Password copied                           │
│ Clipboard will clear in 15 seconds         │
└─────────────────────────────────────────────┘
```

The actual password is never shown to the user. Only the credential name and metadata are displayed.

## Architecture

```text
┌──────────────────────────────────────────────┐
│                  React UI                    │
│   Search / Credential Actions / Recovery UI  │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│             Tauri (Rust Backend)             │
├──────────────────────┬───────────────────────┤
│ • Keystore Module    │ • P2P Sharing (Kyber) │
│ • Clipboard Manager  │ • Biometric Auth Gate │
└──────────┬───────────┴───────────┬───────────┘
           │                       │
           ▼                       ▼
┌──────────────────────┐ ┌──────────────────────┐
│  vault.json (Store)  │ │   OS Secure Keyring  │
│ (Only AES Ciphertext)│ │ (WinCred/Keychain/SS)│
└──────────────────────┘ └──────────────────────┘
```

## Security & Credential Protection

Passvault employs a **Two-Tier Cryptographic Architecture** separating day-to-day access from disaster recovery:

### 1. Active Key Protection (OS-Native Keyring)
* The 256-bit AES-GCM Vault Master Key is **never** written in plaintext to disk or inside `vault.json`.
* Instead, it is stored in the host operating system's native hardware/OS-backed credential manager:
  * **Windows**: Windows Credential Manager (`wincred`) backed by Windows DPAPI.
  * **macOS**: Apple Keychain Services backed by the **Secure Enclave** / user login credentials.
  * **Linux**: FreeDesktop Secret Service API (GNOME Keyring / KWallet).
* Even if `vault.json` is exfiltrated or copied, it cannot be decrypted without releasing the key from that machine's OS Keyring.

### 2. Emergency Disaster Recovery Key
* Hardware chips (TPM 2.0 / Apple Secure Enclave) and OS user keyrings are tied to a specific machine. If a computer's motherboard fails, hardware is replaced, or the OS is cleanly reinstalled, hardware-bound keys are permanently lost.
* To prevent catastrophic data loss, Passvault generates a 256-bit **Emergency Recovery Key** formatted as:
  ```text
  PV-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
  ```
* Users can view and copy their recovery key at any time by clicking **"🔑 Recovery Key"** in the top navigation bar.

### 3. Disaster Recovery & Moving Devices
* **Login Screen Restore**: On a new computer or after an OS reinstall, click **"🔑 Restore Vault with Recovery Key"** on the login screen.
* Enter your Emergency Recovery Key: Passvault validates it, saves it securely into the new computer's OS Credential Manager, and unlocks the vault.
* **Encrypted Backups**: Backups exported via **Backup** contain only ciphertext (no plaintext keys). When importing a backup on another device, Passvault verifies the key and imports it into the local OS Keyring upon validation.

## P2P Credential Sharing (Post-Quantum)

Passvault includes a decentralized, serverless mechanism to share credentials with other instances of Passvault on the same local network (LAN) using zero-configuration networking and Post-Quantum Cryptography (PQC).

### How it works
1. **Discovery (mDNS):** When the app launches, it generates a fresh **ML-KEM (Kyber768)** keypair. It broadcasts its presence and its Public Key on the local network via mDNS (`_passvault._tcp.local.`).
2. **Encapsulation (ML-KEM):** When Alice wants to send a credential to Bob, Alice's client uses Bob's broadcasted Public Key to perform Key Encapsulation. This produces a **Ciphertext** and a 32-byte **Shared Secret**.
3. **Encryption (AES-256-GCM):** Alice's client uses the generated Shared Secret to locally encrypt the credential JSON payload with **AES-256-GCM**.
4. **Transmission:** Alice sends an HTTP POST request directly to Bob's IP address containing the ML-KEM Ciphertext and the AES-encrypted payload. 
5. **Decapsulation:** Bob receives the payload, uses his Private Key to **Decapsulate** the Ciphertext and retrieve the exact same Shared Secret, and uses it to decrypt the AES payload, safely importing the credential into his local vault.

This hybrid approach ensures that even if local network traffic is intercepted, the credential remains completely secure against both classical network sniffing and future quantum computer attacks (the "Harvest Now, Decrypt Later" threat).

## Credential Information

A credential can contain metadata such as:

```text
Environment     : PROD
System          : MySQL
Connection Type : Database (MySQL Workbench)
Username        : app_user
Password        : ********
URL / Server    : db-server.internal
Remarks         : Production billing database
```

Only non-sensitive information is displayed in the credential list.

## Technology Stack

* **Tauri v2**
* **Rust** (`keyring`, `aes-gcm`, `pqcrypto-kyber`, `rand`, `tiny_http`, `mdns-sd`)
* **React 19**
* **Vite**
* **OS Keyring APIs** (Windows Credential Manager / Apple Keychain / FreeDesktop Secret Service)
* **Web Crypto API** (PBKDF2 SHA-256, AES-GCM 256)

## Project Goals

The primary goal is to provide a **small, fast, local-first credential utility** for situations where users frequently need to copy credentials but do not want passwords exposed on screen or stored in plain-text files.

> **Passvault — Find it. Copy it. Forget it.**

## Run
Make sure you have installed the prerequisites for your OS: https://tauri.app/start/prerequisites/, then run based on the environment:

```sh
cd passvault
npm install
npm run tauri android init
```

```sh
# Run in development mode
npm run dev
```

## Build
```sh
# Build in release mode
npm run build
```

For Desktop development, run:

```bash
npm run tauri dev
```

For Android development, run:

```bash
npm run tauri android dev
```

# Actions CI/CD Pipeline

Workflow file at:
```bash
release.yml
```

## How to trigger it:

Modify/Increment the version in:
```bash
package.json
tauri.conf.json
Cargo.toml
```

Tag your release with a version number (this is what triggers the automated builders!):

```bash
git tag "v1.0.0"
git push origin main
git tag v0.2.1 
git push origin "v1.0.0"

git add . && git commit -m "Bump version to 0.2.4" && git push origin main && git tag v0.2.4 && git push origin v0.2.4
```

Once you run `git push origin "v1.0.0"`, GitHub's automated servers will immediately spin up a Mac, an Ubuntu, and a Windows machine in the cloud. They will build the app and automatically create a Release on your GitHub page containing the `.dmg`, `.deb`, `.AppImage`, and `.msi` installers!

## How to generate the keys for release

```bash
npm run tauri signer generate -w ~/.tauri/passvault.key
```

Environment variables used to sign:
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PATH`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Set `public key` in the `tauri.conf.json` `pubkey` field. And set `private key` and `private key password` in `settings` -> `secrets` -> `actions`.
