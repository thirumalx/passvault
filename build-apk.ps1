# PassVault Android ARM64 APK Build Script
$ErrorActionPreference = "Stop"

$PROJECT_ROOT = "C:\Users\ThirumalM\git\passvault"
$NODE_PATH    = "D:\eclipse\.node\node-v22.21.1-win-x64"
$JAVA_HOME    = "C:\Program Files\Java\jdk-21.0.12"
$ANDROID_HOME = "D:\Android\sdk"
$NDK_HOME     = "D:\Android\sdk\ndk\26.1.10909125"
$GRADLE_HOME  = "D:\.gradle"
$RUSTUP_BIN   = "C:\Users\ThirumalM\scoop\persist\rustup\.cargo\bin"
$LLVM_BIN     = "$NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin"

Write-Host "=== Step 1: Building Frontend (Vite) ===" -ForegroundColor Cyan
Set-Location $PROJECT_ROOT
$env:PATH = "$NODE_PATH;$env:PATH"
npm run build

Write-Host "`n=== Step 2: Compiling Rust Library for Android ARM64 (Release Mode - Embedded Assets) ===" -ForegroundColor Cyan
Set-Location "$PROJECT_ROOT\src-tauri"
$env:PATH = "$RUSTUP_BIN;$LLVM_BIN;$env:PATH"
$env:CARGO_HOME = "C:\Users\ThirumalM\scoop\persist\rustup\.cargo"
$env:RUSTUP_HOME = "C:\Users\ThirumalM\scoop\persist\rustup\.rustup"
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$LLVM_BIN\aarch64-linux-android24-clang.cmd"
$env:CC_aarch64_linux_android = "$LLVM_BIN\aarch64-linux-android24-clang.cmd"
cargo build --target aarch64-linux-android --release

Write-Host "`n=== Step 3: Copying Shared Library to jniLibs ===" -ForegroundColor Cyan
$jniDir = "$PROJECT_ROOT\src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a"
New-Item -ItemType Directory -Force -Path $jniDir | Out-Null
Copy-Item "$PROJECT_ROOT\src-tauri\target\aarch64-linux-android\release\libpassvault_lib.so" "$jniDir\libpassvault_lib.so" -Force

Write-Host "`n=== Step 4: Assembling APK with Gradle ===" -ForegroundColor Cyan
Set-Location "$PROJECT_ROOT\src-tauri\gen\android"
$env:JAVA_HOME = $JAVA_HOME
$env:ANDROID_HOME = $ANDROID_HOME
$env:ANDROID_SDK_ROOT = $ANDROID_HOME
$env:GRADLE_USER_HOME = $GRADLE_HOME
$env:PATH = "$JAVA_HOME\bin;$ANDROID_HOME\platform-tools;$NODE_PATH;$env:PATH"
.\gradlew.bat --no-watch-fs --no-daemon assembleArm64Release

Write-Host "`n=== Step 5: Copying APK to Project Root ===" -ForegroundColor Cyan
$sourceApk = "$PROJECT_ROOT\src-tauri\gen\android\app\build\outputs\apk\arm64\release\app-arm64-release.apk"
$destApk = "$PROJECT_ROOT\PassVault-Bluetooth-AutoType-arm64-release.apk"
Copy-Item $sourceApk $destApk -Force

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "BUILD SUCCESSFUL!" -ForegroundColor Green
Write-Host "APK File: $destApk" -ForegroundColor Green
Write-Host "Install : adb install -r `"$destApk`"" -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Green

