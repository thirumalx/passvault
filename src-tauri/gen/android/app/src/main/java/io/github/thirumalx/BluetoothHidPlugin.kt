package io.github.thirumalx

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppQosSettings
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors

@TauriPlugin
class BluetoothHidPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        private const val TAG = "PassVaultBluetoothHid"

        // USB HID Keyboard Report Descriptor (Usage Page 0x01 Generic Desktop, Usage 0x06 Keyboard)
        private val HID_KEYBOARD_REPORT_DESCRIPTOR = byteArrayOf(
            0x05.toByte(), 0x01.toByte(), // USAGE_PAGE (Generic Desktop)
            0x09.toByte(), 0x06.toByte(), // USAGE (Keyboard)
            0xA1.toByte(), 0x01.toByte(), // COLLECTION (Application)
            0x05.toByte(), 0x07.toByte(), //   USAGE_PAGE (Keyboard)
            0x19.toByte(), 0xE0.toByte(), //   USAGE_MINIMUM (Keyboard LeftControl)
            0x29.toByte(), 0xE7.toByte(), //   USAGE_MAXIMUM (Keyboard Right GUI)
            0x15.toByte(), 0x00.toByte(), //   LOGICAL_MINIMUM (0)
            0x25.toByte(), 0x01.toByte(), //   LOGICAL_MAXIMUM (1)
            0x75.toByte(), 0x01.toByte(), //   REPORT_SIZE (1)
            0x95.toByte(), 0x08.toByte(), //   REPORT_COUNT (8)
            0x81.toByte(), 0x02.toByte(), //   INPUT (Data,Var,Abs)
            0x95.toByte(), 0x01.toByte(), //   REPORT_COUNT (1)
            0x75.toByte(), 0x08.toByte(), //   REPORT_SIZE (8)
            0x81.toByte(), 0x01.toByte(), //   INPUT (Cnst,Ary,Abs)
            0x95.toByte(), 0x05.toByte(), //   REPORT_COUNT (5)
            0x75.toByte(), 0x01.toByte(), //   REPORT_SIZE (1)
            0x05.toByte(), 0x08.toByte(), //   USAGE_PAGE (LEDs)
            0x19.toByte(), 0x01.toByte(), //   USAGE_MINIMUM (Num Lock)
            0x29.toByte(), 0x05.toByte(), //   USAGE_MAXIMUM (Kana)
            0x91.toByte(), 0x02.toByte(), //   OUTPUT (Data,Var,Abs)
            0x95.toByte(), 0x01.toByte(), //   REPORT_COUNT (1)
            0x75.toByte(), 0x03.toByte(), //   REPORT_SIZE (3)
            0x91.toByte(), 0x01.toByte(), //   OUTPUT (Cnst,Ary,Abs)
            0x95.toByte(), 0x06.toByte(), //   REPORT_COUNT (6)
            0x75.toByte(), 0x08.toByte(), //   REPORT_SIZE (8)
            0x15.toByte(), 0x00.toByte(), //   LOGICAL_MINIMUM (0)
            0x25.toByte(), 0x65.toByte(), //   LOGICAL_MAXIMUM (101)
            0x05.toByte(), 0x07.toByte(), //   USAGE_PAGE (Keyboard)
            0x19.toByte(), 0x00.toByte(), //   USAGE_MINIMUM (Reserved)
            0x29.toByte(), 0x65.toByte(), //   USAGE_MAXIMUM (Keyboard Application)
            0x81.toByte(), 0x00.toByte(), //   INPUT (Data,Ary,Abs)
            0xC0.toByte()                 // END_COLLECTION
        )
    }

    private var hidDevice: BluetoothHidDevice? = null
    private var connectedHost: BluetoothDevice? = null
    private var isRegistered = false
    private val executor = Executors.newSingleThreadExecutor()

    private val profileListener = object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
            if (profile == BluetoothProfile.HID_DEVICE) {
                hidDevice = proxy as BluetoothHidDevice
                Log.d(TAG, "Bluetooth HID Device profile connected")
                registerHidApp()
            }
        }

        override fun onServiceDisconnected(profile: Int) {
            if (profile == BluetoothProfile.HID_DEVICE) {
                Log.d(TAG, "Bluetooth HID Device profile disconnected")
                hidDevice = null
                connectedHost = null
                isRegistered = false
                emitStatus()
            }
        }
    }

    private val hidCallback = object : BluetoothHidDevice.Callback() {
        override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, registered: Boolean) {
            super.onAppStatusChanged(pluggedDevice, registered)
            isRegistered = registered
            if (registered && pluggedDevice != null) {
                connectedHost = pluggedDevice
            }
            emitStatus()
        }

        override fun onConnectionStateChanged(device: BluetoothDevice?, state: Int) {
            super.onConnectionStateChanged(device, state)
            Log.d(TAG, "Connection state changed: $state for ${device?.name ?: device?.address}")
            if (state == BluetoothProfile.STATE_CONNECTED) {
                connectedHost = device
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                if (connectedHost?.address == device?.address) {
                    connectedHost = null
                }
            }
            emitStatus()
        }
    }

    override fun load(webView: android.webkit.WebView) {
        super.load(webView)
        initBluetooth()
    }

    private fun hasBluetoothPermissions(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val connectGranted = ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED
            return connectGranted
        }
        return true
    }

    @SuppressLint("MissingPermission")
    private fun initBluetooth() {
        if (!hasBluetoothPermissions()) {
            Log.w(TAG, "Bluetooth permissions not granted yet")
            return
        }
        try {
            val bluetoothManager = activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            val adapter = bluetoothManager?.adapter ?: BluetoothAdapter.getDefaultAdapter()
            adapter?.getProfileProxy(activity, profileListener, BluetoothProfile.HID_DEVICE)
        } catch (e: Exception) {
            Log.e(TAG, "Error initializing Bluetooth HID: ${e.message}", e)
        }
    }

    @SuppressLint("MissingPermission")
    private fun registerHidApp() {
        if (!hasBluetoothPermissions()) return
        try {
            val sdpSettings = BluetoothHidDeviceAppSdpSettings(
                "PassVault Keyboard",
                "PassVault Wireless Auto-Type Keyboard",
                "PassVault",
                BluetoothHidDevice.SUBCLASS1_KEYBOARD,
                HID_KEYBOARD_REPORT_DESCRIPTOR
            )
            val qos = BluetoothHidDeviceAppQosSettings(
                BluetoothHidDeviceAppQosSettings.SERVICE_BEST_EFFORT,
                800, 9, 0, 11250, BluetoothHidDeviceAppQosSettings.MAX
            )
            hidDevice?.registerApp(sdpSettings, qos, null, executor, hidCallback)
        } catch (e: Exception) {
            Log.e(TAG, "Error registering HID App: ${e.message}", e)
        }
    }

    @SuppressLint("MissingPermission")
    private fun emitStatus() {
        val js = JSObject().apply {
            put("isAvailable", true)
            put("connected", connectedHost != null)
            put("deviceName", if (hasBluetoothPermissions()) (connectedHost?.name ?: "") else "")
            put("deviceAddress", connectedHost?.address ?: "")
            put("registered", isRegistered)
            put("hasPermissions", hasBluetoothPermissions())
        }
        try {
            trigger("bluetoothStatusChange", js)
        } catch (_: Exception) {}
    }

    @Command
    fun getStatus(invoke: Invoke) {
        val js = JSObject().apply {
            put("isAvailable", true)
            put("connected", connectedHost != null)
            put("deviceName", if (hasBluetoothPermissions()) (connectedHost?.name ?: "") else "")
            put("deviceAddress", connectedHost?.address ?: "")
            put("registered", isRegistered)
            put("hasPermissions", hasBluetoothPermissions())
        }
        invoke.resolve(js)
    }

    @Command
    override fun requestPermissions(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_ADVERTISE
                ),
                101
            )
        }
        initBluetooth()
        invoke.resolve(JSObject().apply { put("requested", true) })
    }

    @Command
    fun typeCredentials(invoke: Invoke) {
        val args = invoke.getArgs()
        val username = args.getString("username", "") ?: ""
        val password = args.getString("password", "") ?: ""
        val connType = args.getString("connection_type", "web") ?: "web"
        val delay = args.optLong("inter_key_delay_ms", 25L)

        val host = connectedHost
        if (host == null) {
            invoke.reject("No Bluetooth host connected. Please pair your phone with your PC via Bluetooth first.")
            return
        }

        executor.execute {
            try {
                // 1. If username present, type it
                if (username.isNotEmpty()) {
                    typeString(host, username, delay)
                    if (connType.equals("putty", ignoreCase = true) ||
                        connType.equals("terminal", ignoreCase = true) ||
                        connType.equals("powershell", ignoreCase = true) ||
                        connType.equals("ssh", ignoreCase = true)) {
                        // In Terminal: hit Enter to reach password prompt
                        Thread.sleep(100)
                        sendKey(host, 0x28.toByte(), 0) // Enter
                        Thread.sleep(800) // Wait for SSH/shell password prompt
                    } else {
                        // In Web / PAM: hit Tab to jump to password field
                        Thread.sleep(100)
                        sendKey(host, 0x2B.toByte(), 0) // Tab
                        Thread.sleep(200)
                    }
                }

                // 2. If password present, type it
                if (password.isNotEmpty()) {
                    typeString(host, password, delay)
                    if (connType.equals("putty", ignoreCase = true) ||
                        connType.equals("terminal", ignoreCase = true) ||
                        connType.equals("powershell", ignoreCase = true) ||
                        connType.equals("ssh", ignoreCase = true)) {
                        Thread.sleep(150)
                        sendKey(host, 0x28.toByte(), 0) // Enter to submit terminal login
                    }
                }

                invoke.resolve(JSObject().apply { put("success", true) })
            } catch (e: Exception) {
                invoke.reject("Typing failed: ${e.message}")
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun typeString(device: BluetoothDevice, text: String, charDelay: Long) {
        for (ch in text) {
            val keyInfo = charToHidCode(ch)
            if (keyInfo != null) {
                sendKey(device, keyInfo.keyCode, keyInfo.modifier)
                Thread.sleep(charDelay)
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun sendKey(device: BluetoothDevice, keyCode: Byte, modifier: Byte) {
        // Press key
        val pressReport = byteArrayOf(modifier, 0, keyCode, 0, 0, 0, 0, 0)
        hidDevice?.sendReport(device, 0, pressReport)
        Thread.sleep(15)

        // Release key
        val releaseReport = byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0)
        hidDevice?.sendReport(device, 0, releaseReport)
        Thread.sleep(10)
    }

    private data class HidKey(val keyCode: Byte, val modifier: Byte = 0)

    private fun charToHidCode(c: Char): HidKey? {
        return when (c) {
            in 'a'..'z' -> HidKey((0x04 + (c - 'a')).toByte())
            in 'A'..'Z' -> HidKey((0x04 + (c - 'A')).toByte(), 0x02) // Shift modifier
            in '1'..'9' -> HidKey((0x1E + (c - '1')).toByte())
            '0' -> HidKey(0x27.toByte())
            '!' -> HidKey(0x1E.toByte(), 0x02)
            '@' -> HidKey(0x1F.toByte(), 0x02)
            '#' -> HidKey(0x20.toByte(), 0x02)
            '$' -> HidKey(0x21.toByte(), 0x02)
            '%' -> HidKey(0x22.toByte(), 0x02)
            '^' -> HidKey(0x23.toByte(), 0x02)
            '&' -> HidKey(0x24.toByte(), 0x02)
            '*' -> HidKey(0x25.toByte(), 0x02)
            '(' -> HidKey(0x26.toByte(), 0x02)
            ')' -> HidKey(0x27.toByte(), 0x02)
            '\n' -> HidKey(0x28.toByte()) // Enter
            '\t' -> HidKey(0x2B.toByte()) // Tab
            ' ' -> HidKey(0x2C.toByte())  // Space
            '-' -> HidKey(0x2D.toByte())
            '_' -> HidKey(0x2D.toByte(), 0x02)
            '=' -> HidKey(0x2E.toByte())
            '+' -> HidKey(0x2E.toByte(), 0x02)
            '[' -> HidKey(0x2F.toByte())
            '{' -> HidKey(0x2F.toByte(), 0x02)
            ']' -> HidKey(0x30.toByte())
            '}' -> HidKey(0x30.toByte(), 0x02)
            '\\' -> HidKey(0x31.toByte())
            '|' -> HidKey(0x31.toByte(), 0x02)
            ';' -> HidKey(0x33.toByte())
            ':' -> HidKey(0x33.toByte(), 0x02)
            '\'' -> HidKey(0x34.toByte())
            '"' -> HidKey(0x34.toByte(), 0x02)
            '`' -> HidKey(0x35.toByte())
            '~' -> HidKey(0x35.toByte(), 0x02)
            ',' -> HidKey(0x36.toByte())
            '<' -> HidKey(0x36.toByte(), 0x02)
            '.' -> HidKey(0x37.toByte())
            '>' -> HidKey(0x37.toByte(), 0x02)
            '/' -> HidKey(0x38.toByte())
            '?' -> HidKey(0x38.toByte(), 0x02)
            else -> null
        }
    }
}

