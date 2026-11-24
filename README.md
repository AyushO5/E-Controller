# 🎮 Virtual Gamepad — Phone-to-PC Low-Latency Controller

Turn any smartphone browser on your local network into a native **Xbox 360-compatible gamepad** recognized by every game, Steam, and Windows/Linux input stack — with no app install, no USB cable, and sub-10 ms Wi-Fi latency.

```
Phone browser  ──WebSocket──►  Python daemon  ──uinput/ViGEmBus──►  Any game
     60 Hz binary frames        host/main.py         OS driver
```

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [Requirements](#requirements)
3. [Linux Setup](#linux-setup)
4. [Windows Setup](#windows-setup)
5. [Running the Daemon](#running-the-daemon)
6. [Connecting Your Phone](#connecting-your-phone)
7. [iOS "Add to Home Screen" Fullscreen Mode](#ios-add-to-home-screen-fullscreen-mode)
8. [USB Tethering for Sub-5 ms Latency](#usb-tethering-for-sub-5-ms-latency)
9. [Wire Protocol Reference](#wire-protocol-reference)
10. [Project Structure](#project-structure)
11. [Troubleshooting](#troubleshooting)

---

## How It Works

```
┌─────────────────────────────────┐       ┌──────────────────────────────────┐
│          Phone Browser           │       │         PC Host Daemon           │
│                                  │       │                                  │
│  touch_engine.js                 │       │  protocol.py                     │
│   • PointerEvent multi-touch     │       │   • 16-byte struct unpack        │
│   • 0.12 radial deadzone         │  WS   │   • 8-bit seq wrap-around guard  │
│   • Thumb-roll face buttons      │──────►│   • 250ms watchdog / STALE state │
│                                  │       │                                  │
│  app.js  (60 Hz rAF loop)        │       │  gamepad_driver.py               │
│   • Zero-alloc 16-byte frames    │       │   • Linux: uinput Xbox 360 pad   │
│   • SUSPENDED / STALE state      │◄──────│   • Windows: ViGEmBus vgamepad   │
│   • Expo-backoff reconnect       │  WS   │   • Mock: console logging        │
│                                  │       │                                  │
│  haptics.js                      │       │  server.py                       │
│   • 12ms micro-haptic pulses     │       │   • aiohttp HTTP :8080           │
│   • 50ms rumble throttle         │       │   • websockets WS :8765          │
│   • iOS no-op safe               │       │   • Binary rumble push [0x02]    │
└─────────────────────────────────┘       └──────────────────────────────────┘
```

**Binary wire frame** (16 bytes, Little-Endian):

| Byte(s) | Type   | Field     | Notes                        |
|---------|--------|-----------|------------------------------|
| 0       | uint8  | msg_type  | `0x01` = input, `0x00` = neutral |
| 1       | uint8  | seq_num   | 0–255 wrapping, guards reorders |
| 2–3     | uint16 | buttons   | bitmask (A/B/X/Y/LB/RB/…)   |
| 4–5     | int16  | lx        | left stick X [-32768, 32767] |
| 6–7     | int16  | ly        | left stick Y (up = positive) |
| 8–9     | int16  | rx        | right stick X                |
| 10–11   | int16  | ry        | right stick Y                |
| 12      | uint8  | l2        | left trigger [0, 255]        |
| 13      | uint8  | r2        | right trigger [0, 255]       |
| 14–15   | uint16 | reserved  | always `0x0000`              |

---

## Requirements

| Component | Version |
|-----------|---------|
| Python    | ≥ 3.11  |
| websockets | ≥ 12.0 |
| aiohttp   | ≥ 3.9   |
| qrcode    | ≥ 7.4   |
| **Linux** evdev | ≥ 1.7 |
| **Windows** vgamepad | ≥ 0.1 |

Install host dependencies:

```bash
pip install websockets aiohttp qrcode evdev   # Linux
pip install websockets aiohttp qrcode vgamepad # Windows
```

---

## Linux Setup

### 1. Grant `/dev/uinput` write permission

The kernel `uinput` module creates virtual input devices. Without write access the daemon falls back to Mock (console-logging) mode.

**Option A — Persistent udev rule (recommended, survives reboots):**

```bash
# Create rule
echo 'KERNEL=="uinput", GROUP="input", MODE="0660"' \
    | sudo tee /etc/udev/rules.d/50-uinput.rules

# Reload rules
sudo udevadm control --reload-rules
sudo udevadm trigger

# Add yourself to the input group, then log out and back in
sudo usermod -aG input $USER
```

**Option B — One-shot (until next reboot):**

```bash
sudo chmod 666 /dev/uinput
```

### 2. Load the `uinput` kernel module (if not already loaded)

```bash
sudo modprobe uinput

# To auto-load on boot:
echo 'uinput' | sudo tee /etc/modules-load.d/uinput.conf
```

### 3. Verify the virtual gamepad appears

After starting the daemon (see below), use `jstest` to confirm the controller is recognized:

```bash
# Install joystick testing tools
sudo apt install joystick

# List connected joysticks
ls /dev/input/js*

# Interactive test — press buttons and move sticks on your phone
jstest /dev/input/js0
```

You should see axis and button events fire in real time as you interact with the phone UI.

Alternatively, use `evtest` for lower-level verification:

```bash
sudo apt install evtest
sudo evtest
# Select "Microsoft X-Box 360 pad" from the list
```

**Steam:** The virtual gamepad is automatically recognized as an Xbox 360 controller. Enable `Settings → Controller → Xbox Configuration Support`.

---

## Windows Setup

### 1. Install ViGEmBus (virtual gamepad kernel driver)

ViGEmBus is an open-source kernel driver that creates virtual Xbox/DualShock controllers recognized by Windows at the DirectInput/XInput level.

1. Download the latest installer from:  
   **https://github.com/nefarius/ViGEmBus/releases**  
   (look for `ViGEmBus_Setup_<version>.exe`)
2. Run the installer as Administrator and restart Windows if prompted.

### 2. Install the Python wrapper

```powershell
pip install vgamepad
```

### 3. Verify the virtual gamepad

After starting the daemon:

1. Press `Win + R`, type `joy.cpl`, press Enter.
2. You should see **"Xbox 360 Controller"** listed.
3. Click **Properties** → move sticks and press buttons on your phone → watch the crosshair and button indicators respond in real time.

For XInput games and Steam, no additional configuration is needed — the controller is natively enumerated as a standard Xbox 360 gamepad.

---

## Running the Daemon

```bash
# From the project root
cd phone-controller
python host/main.py
```

The terminal displays a **QR code** for instant phone connection and shows:
- Detected LAN IP address
- Active driver (native or mock mode)
- Live input events as they arrive

### CLI options

```
python host/main.py --help

  --http-port  HTTP port for the web UI   (default: 8080)
  --ws-port    WebSocket input port       (default: 8765)
  --host       Bind address               (default: 0.0.0.0)
  --ip         Override advertised LAN IP (overrides auto-detect)
  --mock       Force Mock driver (console logging, no OS gamepad)
```

### Native gamepad mode (Linux)

Ensure `/dev/uinput` is writable (see Linux Setup above), then:

```bash
python host/main.py
# → [GamepadDriver] Created: Linux uinput: Microsoft X-Box 360 pad (/dev/input/eventN)
```

### Mock / test mode

```bash
python host/main.py --mock
# → [MOCK MODE] Inputs will log to console instead of OS device.
```

---

## Connecting Your Phone

> **Prerequisite:** Phone and PC must be on the same Wi-Fi network (or USB tethering, see below).

1. **Scan the QR code** shown in the terminal with your phone camera, or
2. Open your phone browser and go to: `http://<LAN_IP>:8080`

The virtual gamepad loads instantly — no installation required. The status pill at the top shows:

| Pill state | Meaning |
|------------|---------|
| `P1 • 🟢 Connected • 4 ms` | Stream active, low latency |
| `P1 • 🟡 STALE` | No frame for >250ms — gamepad zeroed |
| `P1 • 🔴 Disconnected` | WebSocket dropped — auto-reconnecting |
| `Suspended` | Tab backgrounded — neutral frame sent, gamepad zeroed |

---

## iOS "Add to Home Screen" Fullscreen Mode

Safari on iOS supports full-screen PWA mode when the page is added to the Home Screen, eliminating the browser chrome (address bar, navigation buttons) for an immersive experience.

1. Open `http://<LAN_IP>:8080` in **Safari** on your iPhone/iPad.
2. Tap the **Share** button (box with arrow).
3. Tap **"Add to Home Screen"** → **Add**.
4. Launch the app from your Home Screen — it opens fullscreen in landscape.

**Why this works:**  
`manifest.json` declares `"display": "fullscreen"` and `"orientation": "landscape"`.  
`index.html` contains `<meta name="apple-mobile-web-app-capable" content="yes">` and `viewport-fit=cover`.  
Safe-area padding (`env(safe-area-inset-*)`) ensures controls are never clipped by the Dynamic Island or notch.

> **Note:** `navigator.vibrate()` is not supported on iOS Safari — haptic feedback silently no-ops. All gameplay functionality is fully intact.

---

## USB Tethering for Sub-5 ms Latency

Wi-Fi introduces 5–20 ms of wireless latency. For competitive play or rhythm games, **USB tethering** routes the WebSocket over a physical USB connection and typically achieves **1–4 ms RTT**.

### Android USB Tethering

1. Connect your Android phone to the PC with a USB cable.
2. On the phone: **Settings → Network & Internet → Hotspot & Tethering → USB Tethering** → enable it.
3. The phone creates a new network adapter on the PC (usually `192.168.42.1` or `192.168.0.1`).

**Find the USB network IP:**
```bash
# Linux
ip addr show   # look for a new interface (e.g. enp0s20f0u1)

# Windows
ipconfig        # look for "USB RNDIS Adapter" or similar
```

4. Start the daemon with the USB IP:
```bash
python host/main.py --ip 192.168.42.1
```

5. On the phone, open:  
   `http://192.168.42.1:8080`

### iPhone Personal Hotspot (USB)

1. Connect iPhone to PC via USB and trust the computer.
2. On iPhone: **Settings → Personal Hotspot** → enable.
3. On Linux: install `ipheth` and `usbmuxd`:
   ```bash
   sudo apt install usbmuxd
   sudo usbmuxd
   ```
4. On Windows: install **iTunes** (the USB driver is bundled).
5. Find the assigned IP and use it as above.

---

## Wire Protocol Reference

### Input frame (Phone → Host, 16 bytes)

```
Offset  Size  Type    Field      Description
  0       1   uint8   msg_type   0x01 = input frame, 0x00 = neutral/suspend
  1       1   uint8   seq_num    monotonic, 0-255 wrapping
  2       2   uint16  buttons    bitmask (little-endian)
  4       2   int16   lx         left stick X  [-32768, 32767]
  6       2   int16   ly         left stick Y  [up = +32767]
  8       2   int16   rx         right stick X
 10       2   int16   ry         right stick Y
 12       1   uint8   l2         left trigger  [0, 255]
 13       1   uint8   r2         right trigger [0, 255]
 14       2   uint16  reserved   0x0000
```

**Button bitmask:**

| Bit | Button    | Bit | Button     |
|-----|-----------|-----|------------|
| 0   | A         | 8   | GUIDE      |
| 1   | B         | 9   | L3 (LS click) |
| 2   | X         | 10  | R3 (RS click) |
| 3   | Y         | 11  | DPAD_UP    |
| 4   | LB        | 12  | DPAD_DOWN  |
| 5   | RB        | 13  | DPAD_LEFT  |
| 6   | BACK      | 14  | DPAD_RIGHT |
| 7   | START     |     |            |

### Rumble frame (Host → Phone, 4 bytes)

```
Offset  Size  Type    Field       Description
  0       1   uint8   msg_type    0x02 = rumble
  1       1   uint8   low_freq    low-frequency motor intensity [0, 255]
  2       1   uint8   high_freq   high-frequency motor intensity [0, 255]
  3       1   uint8   player_id   1–4 (matches P1–P4 slot)
```

### Sequence guard

Out-of-order and duplicate frames are dropped using an 8-bit wrap-around comparison:

```python
diff = (new_seq - last_seq) & 0xFF
valid = 0 < diff < 128    # diff=0 → duplicate; diff≥128 → old/reordered
```

### Failsafe state machine

```
                 ┌───────────────────────────────┐
                 │                               ▼
DISCONNECTED ──► CONNECTING ──► CONNECTED ──► SUSPENDED
     ▲                │             │             │
     └────────────────┘             │             │
                                    ▼             │
                               RECONNECTING ◄─────┘
                                    │
                                    └──► (expo backoff 500ms→2000ms)
```

**Watchdog (host-side):**
- 250ms timeout per client
- On `STALE`: `driver.reset()` + push `{"type":"status","state":"STALE"}` to phone
- On recovery: push `{"type":"status","state":"ACTIVE"}`

---

## Project Structure

```
phone-controller/
├── host/
│   ├── main.py              # CLI entry-point, QR code, LAN IP detection
│   ├── server.py            # aiohttp HTTP :8080 + websockets WS :8765
│   ├── protocol.py          # 16-byte unpacker, 8-bit seq guard, 250ms watchdog
│   ├── gamepad_driver.py    # Linux uinput / Windows ViGEmBus / Mock abstraction
│   └── requirements.txt
└── client/
    ├── index.html           # Matte-black hardware controller layout (PWA)
    ├── manifest.json        # fullscreen + landscape PWA manifest
    ├── styles.css           # Tactile 3D depth, STALE amber pulse, hit-slop zones
    ├── app.js               # 60Hz rAF loop, state machine, WS transport
    ├── touch_engine.js      # Multi-touch tracking, thumb-roll, deadzone math
    └── haptics.js           # Micro-haptic pulses + 50ms-throttled rumble receiver
```

---

## Troubleshooting

### "Permission denied: /dev/uinput"
Run the udev rule setup from [Linux Setup](#linux-setup). Log out and back in after adding yourself to the `input` group.

### Virtual gamepad not visible in `jstest` / `joy.cpl`
- Confirm the daemon logged `[GamepadDriver] Created: Linux uinput…` (not MOCK).
- On Linux: `ls /dev/input/js*` — if empty, try `sudo modprobe uinput`.
- On Windows: confirm ViGEmBus is installed (`Device Manager → System Devices → ViGEm Bus Device`).

### Phone connects but inputs don't register in-game
- Check the game is using **XInput** (not DirectInput). Most modern PC games support XInput.
- On Linux: test with `jstest /dev/input/js0` while pressing buttons on the phone.
- In Steam: `Settings → Controller → Desktop Configuration` and verify the gamepad is listed.

### High latency (>20 ms)
- Use **USB tethering** (see [above](#usb-tethering-for-sub-5-ms-latency)) — typical Wi-Fi adds 8–15 ms.
- Ensure your phone and PC are on 5 GHz Wi-Fi, not 2.4 GHz.
- Avoid connecting through a Wi-Fi range extender or powerline adapter.

### Phone screen goes to sleep mid-game
- Enable **"Keep screen on while charging"** in your phone's Developer Options.
- Or use a screen wakelock: in Chrome for Android the screen stays on automatically while a WebSocket is active.

### iOS Safari — no vibration / haptic feedback
This is a **browser limitation** — `navigator.vibrate()` is not supported on iOS Safari. All gameplay input functionality is fully intact; only tactile feedback is absent. Use Android Chrome for haptic support.

### "Connecting…" never changes to "Connected"
1. Confirm PC firewall allows inbound connections on ports **8080** and **8765**.
2. On Linux: `sudo ufw allow 8080/tcp && sudo ufw allow 8765/tcp`
3. On Windows: add inbound firewall rules for ports 8080 and 8765 in `Windows Defender Firewall → Advanced Settings`.
