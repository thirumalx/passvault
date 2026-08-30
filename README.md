# Passvault 🔐

**Passvault** is a lightweight, secure desktop application for managing and quickly copying frequently used credentials without exposing passwords on screen.

Built with **Tauri + React**, the application provides a simple interface where users can search for a credential and copy its password to the clipboard with a single click.

## Features

* 🔐 Secure local credential storage
* 👁️ Passwords are never displayed in the UI
* 📋 One-click password copying
* ⏱️ Automatically clears the clipboard after a configurable timeout
* 🔎 Search credentials by name/system/environment
* 🖥️ Lightweight desktop application
* 🚫 No passwords embedded in source code
* 🔒 Encryption/protection with built-in security mechanisms
* 🌐 Works completely locally without requiring a server
* ⚡ Built with Tauri for low resource consumption

## Example

```text
┌─────────────────────────────────────────────┐
│ 🔐 Passvault                                  │
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

The actual password is never shown to the user. Only the credential name is displayed.

## Architecture

```text
┌──────────────────────┐
│      React UI        │
│                      │
│ Search / Credential  │
│       / Copy         │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│       Tauri          │
│    Rust Backend      │
└──────────┬───────────┘
           │
           ├── Credential Storage
           │
           ├── Encryption
           │
           └── Clipboard
           │
           ▼
┌──────────────────────┐
│     Desktop OS       │
└──────────────────────┘
```

## Security Principles

Passvault is designed around the principle of **"never display the secret unless absolutely necessary."**

Passwords should:

* Never be displayed in the UI
* Never be stored as plaintext
* Never be hard-coded in source code
* Never be logged
* Never be written to application logs
* Be copied only when explicitly requested
* Be removed from the clipboard automatically after a short period

The application should use Windows-native encryption/security facilities where possible.

## Credential Information

A credential can contain metadata such as:

```text
Environment : PROD
System      : MySQL
Account     : Application User
Username    : app_user
Password    : ********
Server      : db-server
Notes       : Production database
```

Only non-sensitive information should be displayed in the credential list.

## Technology Stack

* **Tauri**
* **Rust**
* **React**
* **TypeScript**
* **HTML/CSS**
* **Windows APIs**
* **Windows-native encryption**

## Project Goals

The primary goal is to provide a **small, fast, local-first credential utility** for situations where users frequently need to copy credentials but do not want passwords exposed on screen or stored in plain-text files.

> **Passvault — Find it. Copy it. Forget it.**

## Run
Make sure you have installed the prerequisites for your OS: https://tauri.app/start/prerequisites/, then run based on the environment

```sh
cd passvault
npm install
npm run tauri android init

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
  npm run tauri dev

For Android development, run:
  npm run tauri android dev