# 🎮 E-Controller

**Turn your smartphone into a low-latency wireless Xbox 360 controller for Windows & Linux—no mobile app installation required.**

E-Controller streams mobile multi-touch inputs from any modern web browser to your PC over local Wi-Fi using an ultra-compact **16-byte binary WebSocket protocol**. The lightweight Python daemon intercepts these packets and injects native OS-level Xbox 360 controller events via **ViGEmBus** on Windows or **uinput** on Linux, making it instantly compatible with Steam and all PC games.



---

## ✨ Engineering Highlights

- **Low-Latency Binary Protocol:** Packs all 16 buttons, 2 triggers, and 4 thumbstick axes into a fixed **16-byte binary frame** over `TCP_NODELAY` WebSockets—eliminating JSON overhead for responsive, single-digit millisecond input on a clean local Wi-Fi network.
- **Zero-App Mobile Client:** Scan the terminal QR code to launch immediately in Safari or Chrome, with **Add to Home Screen (PWA)** support for distraction-free fullscreen play.
- **Custom "Carbon & Volt" Ergonomic UI:** Asymmetric Xbox layout with swept wing triggers, circular-dish D-Pad, anti-misclick spacing, and live latency/player-slot telemetry.
- **Anti-Stick Input Engine:** Combines global `PointerEvent` capture, zero-touch emergency resets, and a **250ms host watchdog timer** so buttons or sticks never stay stuck if the phone locks or drops a packet.
- **Multi-Controller Ready:** Automatically assigns player slots (`P1`–`P4`) for local couch co-op sessions.

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────┐
│              Smartphone Browser (Client)               │
│  • Mobile Multi-Touch Engine (PointerEvents)           │
│  • Carbon & Volt Tactile Ergonomic UI                  │
│  • Zero-alloc 16-byte binary frame builder             │
└───────────────────────────┬────────────────────────────┘
                            │
                            │  16-Byte Binary WebSocket over Local Wi-Fi
                            │  (TCP_NODELAY · ws://<LAN_IP>:8765)
                            ▼
┌────────────────────────────────────────────────────────┐
│               Python Host Server (Daemon)              │
│  • aiohttp HTTP Server (:8080)                         │
│  • websockets Binary Protocol Receiver                 │
│  • 250ms Watchdog & Neutral State Failsafe             │
│  • Auto-reconnecting P1–P4 slot allocation             │
└───────────────────────────┬────────────────────────────┘
                            │
                            │  Kernel-level Virtual Input Injection
                            ▼
        ┌───────────────────┴───────────────────┐
        │                                       │
     [Windows]                               [Linux]
  ViGEmBus (vgamepad)                  /dev/uinput (evdev)
        │                                       │
        └───────────────────┬───────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│                    PC Game / Steam                     │
│       Native Microsoft Xbox 360 Controller Event       │
└────────────────────────────────────────────────────────┘
```

---

## 🚀 3-Minute Quickstart

### Step 1: Install OS Virtual Gamepad Driver

#### Windows
Download and run the installer for **ViGEmBus**:
- 📥 **[Download ViGEmBus Setup (v1.22.0+)](https://github.com/nefarius/ViGEmBus/releases)**

#### Linux
Load the `uinput` kernel module and ensure user permissions:
```bash
sudo modprobe uinput
echo 'KERNEL=="uinput", GROUP="input", MODE="0660"' | sudo tee /etc/udev/rules.d/50-uinput.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo usermod -aG input $USER
# Log out and back in for group permissions to apply
```

---

### Step 2: Clone & Set Up the Python Host

Clone the repository:
```bash
git clone https://github.com/AyushO5/E-Controller.git
cd E-Controller
```

#### Windows (PowerShell)
> **Note:** If script execution is restricted on your machine, run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` before activating the virtual environment.

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r host/requirements.txt
```

#### Linux (Bash / Zsh)
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r host/requirements.txt
```

---

### Step 3: Launch & Connect Your Phone

Run the host daemon:

```bash
# Windows
python host/main.py

# Linux
python3 host/main.py
```

1. **Firewall Notice:** When prompted by Windows Defender Firewall, check **both Private and Public networks** to allow Python to communicate with devices on your Wi-Fi network.
2. **Scan QR Code:** A QR code will display in your terminal with your local IP address (e.g. `http://192.168.1.X:8080`). Scan it with your phone's camera, or manually type the URL into mobile Safari or Chrome.
3. **Start Playing:** The HUD status badge will switch to **Connected [P1]**, and inputs will register immediately in your games!

---

## 💡 Pro Tips

- **Add to Home Screen (PWA Mode):**
  - **iOS Safari:** Tap the **Share** button (`⎋`) → scroll down and tap **Add to Home Screen**.
  - **Android Chrome:** Tap the three dots (`⋮`) → select **Install app** or **Add to Home screen**.
  - *Why?* Running as a standalone PWA completely removes browser address bars, prevents accidental swipe-to-navigate gestures, and gives you edge-to-edge landscape play.
- **Connect Before Starting Games:** While hotplugging is supported, many game engines (and emulators like RPCS3/Dolphin) only scan for gamepads at launch. Connect your phone first, verify in the dashboard, then start your game.
- **Verify Input in Windows (`joy.cpl`):** Press `Win + R`, type `joy.cpl`, and hit Enter. Select **Controller (XBOX 360 For Windows)** and click **Properties** to see live visual button highlights and thumbstick movement.

---

## 🛠️ Troubleshooting

| Issue / Symptom | Probable Cause | Recommended Fix |
|---|---|---|
| **Phone browser times out or cannot reach URL** | Wi-Fi AP Isolation or Firewall blocking traffic | 1. Ensure your phone and PC are connected to the exact same Wi-Fi network (not guest Wi-Fi).<br>2. Disable **AP Isolation / Client Isolation** in your router settings.<br>3. Verify Windows Firewall allows inbound connections on ports **8080** (HTTP) and **8765** (WebSocket). |
| **Controller missing in `joy.cpl` or games don't detect it** | ViGEmBus driver not installed or launched after game | 1. Verify [ViGEmBus](https://github.com/nefarius/ViGEmBus/releases) is installed on your PC.<br>2. Restart the daemon and connect your phone *before* starting the game. |
| **Left stick moves Windows mouse cursor or clicks Desktop** | Steam "Desktop Configuration" taking priority | Open Steam → **Settings** → **Controller** → **Desktop Layout** → click **Edit** and set the template to **Disabled** or unbind the joystick mouse controls. |
| **Controls feel delayed or sluggish** | High network jitter / 2.4 GHz interference | Connect your PC via Ethernet cable to the router and connect your phone to the **5 GHz** Wi-Fi band. |

---

## 🗺️ Roadmap (v2.0)

- [ ] **Gyroscope Aiming & Steering:** Motion-controlled camera aiming and tilt steering using phone accelerometer/gyroscope with a hold-to-clutch recenter toggle.
- [ ] **Genre Layout Presets:** Instant switching between layout profiles (FPS, Arcade Fighter, Racing with analog slider triggers, and Sim Button Box).
- [ ] **Standalone Windows Executable (`.exe`):** Single-click pre-compiled bundle with a system-tray icon and automatic QR popup for zero-command setup.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
