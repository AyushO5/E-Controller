/**
 * Virtual Gamepad Client — Checkpoint 3
 * Zero-alloc 60Hz binary transport, SUSPENDED state machine,
 * visibilitychange/blur failsafe, guaranteed return-to-center flush,
 * and exponential-backoff reconnect.
 *
 * Wire frame layout (16 bytes, Little-Endian):
 *   [0]     uint8   msg_type   0x01 = input, 0x00 = neutral/suspended
 *   [1]     uint8   seq_num    0–255 wrapping
 *   [2-3]   uint16  buttons    bitmask
 *   [4-5]   int16   lx
 *   [6-7]   int16   ly
 *   [8-9]   int16   rx
 *   [10-11] int16   ry
 *   [12]    uint8   l2         left trigger
 *   [13]    uint8   r2         right trigger
 *   [14-15] uint16  reserved   0x0000
 */

// ─── Wire protocol constants ─────────────────────────────────────────────────
const MSG_TYPE_INPUT   = 0x01;
const MSG_TYPE_NEUTRAL = 0x00;
const FRAME_SIZE       = 16;        // bytes

// ─── Connection state machine ─────────────────────────────────────────────────
const State = Object.freeze({
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING:   'CONNECTING',
    CONNECTED:    'CONNECTED',
    SUSPENDED:    'SUSPENDED',   // tab hidden / window blurred
    RECONNECTING: 'RECONNECTING',
});

// ─── Exponential-backoff config ───────────────────────────────────────────────
const BACKOFF_MIN_MS  = 500;
const BACKOFF_MAX_MS  = 2000;
const BACKOFF_FACTOR  = 1.6;

// ─── Persisted Quick-Settings defaults ────────────────────────────────────────
const SETTINGS_STORAGE_KEY = 'econtroller_settings_v1';
const DEFAULT_SETTINGS = Object.freeze({
    deadzone:    0.08,     // 8% scaled radial deadzone (0.00–0.25)
    sensitivity: 1.0,      // 100% stick sensitivity multiplier (0.60–1.40)
    curve:       'linear', // 'linear' | 'exponential'
    haptics:     true,
    gyroMode:         'off',      // 'off' | 'right_stick' | 'left_stick_x'
    gyroActivation:   'hold_lt',  // 'hold_lt' | 'hold_clutch' | 'always_on'
    gyroSensitivity:  1.2,        // 0.5 – 3.0
    gyroAntiDeadzone: 0.14,       // 0.00 – 0.25
    gyroInvertY:      false,
});

// ─────────────────────────────────────────────────────────────────────────────
class GamepadApp {
    constructor() {
        this._state = State.DISCONNECTED;
        this.socket = null;

        // ── Zero-alloc frame buffer (pre-allocated once, mutated in-place) ──
        this._buf     = new ArrayBuffer(FRAME_SIZE);
        this._view    = new DataView(this._buf);
        this._u8      = new Uint8Array(this._buf);

        // Pre-build neutral frame bytes once (all zeros → msg_type=0x00)
        this._neutralBuf  = new ArrayBuffer(FRAME_SIZE);
        this._neutralView = new DataView(this._neutralBuf);
        // neutral buf stays all-zero — MSG_TYPE_NEUTRAL(0x00) at [0]

        // Sequence counter (uint8, wraps 0–255)
        this._seq = 0;

        // Reconnect backoff
        this._reconnectTimer   = null;
        this._reconnectDelayMs = BACKOFF_MIN_MS;

        // Ping / RTT
        this._pingTimer = null;

        // rAF timing
        this._lastFrameTs  = 0;
        this._targetMs     = 1000 / 60;   // 60 Hz

        // DOM refs (assigned in init())
        this._statusBadge  = null;
        this._latencyEl    = null;
        this._driverEl     = null;
        this._playerEl     = null;
        this._fullscreenBtn = null;

        // HUD stream state label ('ACTIVE' | 'STALE')
        this._streamState = 'ACTIVE';

        // Stick state tracking for guaranteed return-to-center flushes
        this._prevLx = 0;
        this._prevLy = 0;
        this._prevRx = 0;
        this._prevRy = 0;
        this._flushConsecutiveFrames = 0;

        // Quick-Settings & Screen Wake Lock state
        this._settings = { ...DEFAULT_SETTINGS };
        this._settingsOpen = false;
        this._wakeLock = null;
        this._wakeLockRequested = false;

        // Gyro HUD state
        this._gyroPill = null;
        this._gyroPillActive = false;
        this._gyroClutchBtn = null;
        this._gyroWarningEl = null;
    }

    // ─── Boot ────────────────────────────────────────────────────────────────
    init() {
        this._statusBadge   = document.getElementById('status-badge');
        this._latencyEl     = document.getElementById('latency-badge');
        this._driverEl      = document.getElementById('driver-badge');
        this._playerEl      = document.querySelector('.player-pill');
        this._fullscreenBtn = document.getElementById('btn-fullscreen');

        this._gyroPill      = document.getElementById('gyro-status-pill');
        this._gyroClutchBtn = document.getElementById('btn-gyro-clutch');
        this._gyroWarningEl = document.getElementById('gyro-sensor-warning');

        window.TouchEngine.init();
        window.GyroEngine?.init({ onWarningChange: (msg) => this._setGyroWarning(msg) });

        this._loadSettings();
        this._applySettings();
        window.GyroEngine?.resumeIfEnabled();
        this._setupSettingsDrawer();
        this._setupWakeLock();
        this._setupFullscreen();
        this._setupGestureLocks();
        this._setupVisibilityFailsafe();   // ← Checkpoint 2
        this._connect();
        this._startRAF();
    }

    // ─── State machine ────────────────────────────────────────────────────────
    get state() { return this._state; }

    _setState(s, label = '') {
        this._state = s;
        if (!this._statusBadge) return;
        this._statusBadge.className = 'notch-pill status-badge ' + s.toLowerCase();
        const textEl = this._statusBadge.querySelector('.status-text');
        if (textEl) textEl.textContent = label || s;
    }

    // ─── WebSocket transport ──────────────────────────────────────────────────
    _wsUrl() {
        const p = new URLSearchParams(window.location.search);
        if (p.has('ws')) return p.get('ws');
        const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.hostname || '127.0.0.1';
        const port = p.get('port') || window.location.port || '8765';
        return `${wsProto}//${host}:${port}`;
    }

    _connect() {
        if (this.socket &&
            (this.socket.readyState === WebSocket.OPEN ||
             this.socket.readyState === WebSocket.CONNECTING)) return;

        this._setState(State.CONNECTING, 'Connecting…');

        try {
            this.socket = new WebSocket(this._wsUrl());
            this.socket.binaryType = 'arraybuffer';

            this.socket.onopen  = () => this._onOpen();
            this.socket.onmessage = (ev) => this._onMessage(ev);
            this.socket.onclose = () => this._onClose();
            this.socket.onerror = () => this.socket?.close();
        } catch (_) {
            this._resetGyro();
            this._scheduleReconnect();
        }
    }

    // ─── Gyro helpers ─────────────────────────────────────────────────────────
    _resetGyro() {
        window.GyroEngine?.resetOutput();
        this._setGyroPillActive(false);
    }

    _setGyroPillActive(on) {
        if (on === this._gyroPillActive) return;
        this._gyroPillActive = on;
        this._gyroPill?.classList.toggle('active', on);
    }

    _setGyroWarning(msg) {
        const el = this._gyroWarningEl;
        if (!el) return;
        el.textContent = msg || '';
        el.hidden = !msg;
    }

    _syncGyroHUD() {
        const s = this._settings;
        const on = s.gyroMode !== 'off';
        this._gyroPill?.classList.toggle('armed', on);
        if (this._gyroClutchBtn) {
            this._gyroClutchBtn.hidden = !(on && s.gyroActivation === 'hold_clutch');
        }
    }

    _onOpen() {
        this._reconnectDelayMs = BACKOFF_MIN_MS;   // reset backoff on success
        this._setState(State.CONNECTED, 'Connected');
        // Transmit HELLO handshake to host immediately upon connection
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'hello', client: 'web', proto: 3 }));
        }
        this._startPing();
    }

    _onClose() {
        this._stopPing();
        this._resetGyro();
        // Don't override SUSPENDED — it handles its own reconnect path
        if (this._state !== State.SUSPENDED) {
            this._setState(State.RECONNECTING, 'Reconnecting…');
        }
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        const delay = this._reconnectDelayMs;
        // Exponential backoff, capped at BACKOFF_MAX_MS
        this._reconnectDelayMs = Math.min(
            Math.round(this._reconnectDelayMs * BACKOFF_FACTOR),
            BACKOFF_MAX_MS,
        );
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connect();
        }, delay);
    }

    _onMessage(ev) {
        if (typeof ev.data === 'string') {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'pong') {
                    const rtt = Math.max(1, Math.round(performance.now() - (msg.t || 0)));
                    if (this._latencyEl) this._latencyEl.textContent = `${rtt} ms`;
                } else if (msg.type === 'welcome') {
                    if (this._driverEl) {
                        this._driverEl.textContent = msg.is_mock ? 'Mock Gamepad' : 'OS Xbox 360';
                        this._driverEl.title = msg.driver || '';
                    }
                    // Update player slot from server
                    if (msg.player && this._playerEl) {
                        this._playerEl.textContent = msg.player;
                    }
                } else if (msg.type === 'status') {
                    // Server pushed STALE / ACTIVE watchdog transition
                    this._streamState = msg.state || 'ACTIVE';
                    if (msg.player && this._playerEl) {
                        this._playerEl.textContent = msg.player;
                    }
                    this._applyStreamStateToHUD();
                } else if (msg.type === 'rumble') {
                    // Legacy JSON rumble (testing / iOS workaround)
                    window.Haptics?.receiveRumble(msg);
                }
            } catch (_) {}
            return;
        }

        // Binary rumble frame: [0x02, low_freq, high_freq, player_id] (4 bytes)
        if (ev.data instanceof ArrayBuffer && ev.data.byteLength === 4) {
            const v = new DataView(ev.data);
            if (v.getUint8(0) === 0x02) {
                window.Haptics?.receiveRumble({
                    lowFreq:  v.getUint8(1),
                    highFreq: v.getUint8(2),
                    duration: 150,
                });
            }
        }
    }

    _applyStreamStateToHUD() {
        if (!this._statusBadge) return;
        const isStale = this._streamState === 'STALE';
        // Toggle a 'stale' class on the badge for CSS styling
        this._statusBadge.classList.toggle('stale', isStale);
    }

    // ─── Ping / RTT ───────────────────────────────────────────────────────────
    _startPing() {
        this._stopPing();
        this._pingTimer = setInterval(() => {
            if (this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'ping', t: performance.now() }));
            }
        }, 1000);
    }

    _stopPing() {
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    }

    // ─── 60 Hz rAF send loop (zero allocations) ───────────────────────────────
    _startRAF() {
        const tick = (ts) => {
            if (ts - this._lastFrameTs >= this._targetMs - 1) {
                this._lastFrameTs = ts;
                this._sendFrame();
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    /**
     * Force-flush return-to-center frame immediately and guarantee for at least 2 consecutive
     * frames so a single jittery Wi-Fi packet never leaves vgamepad holding the last stick angle.
     */
    flushReturnToCenter() {
        this._flushConsecutiveFrames = Math.max(this._flushConsecutiveFrames, 2);
        this._sendFrame(/*force=*/ true);
    }

    _sendFrame(force = false) {
        if (this._state === State.SUSPENDED) return;   // neutral already sent
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

        const te = window.TouchEngine;
        const gyroOut = window.GyroEngine ? window.GyroEngine.sample(te.lt / 255) : null;
        this._setGyroPillActive(Boolean(gyroOut && gyroOut.sending));
        const inp  = te.getBlendedState(gyroOut);

        // Detect transition from non-zero to (0, 0) on either stick
        const leftReturnedToCenter  = (this._prevLx !== 0 || this._prevLy !== 0) && (inp.lx === 0 && inp.ly === 0);
        const rightReturnedToCenter = (this._prevRx !== 0 || this._prevRy !== 0) && (inp.rx === 0 && inp.ry === 0);

        if (leftReturnedToCenter || rightReturnedToCenter) {
            this._flushConsecutiveFrames = Math.max(this._flushConsecutiveFrames, 2);
        }

        const isFlushing = this._flushConsecutiveFrames > 0;
        if (isFlushing && !force) {
            this._flushConsecutiveFrames--;
        }

        this._prevLx = inp.lx;
        this._prevLy = inp.ly;
        this._prevRx = inp.rx;
        this._prevRy = inp.ry;

        const v    = this._view;
        const seq  = this._seq;

        // Mutate the pre-allocated buffer in-place — zero heap allocations
        v.setUint8(0,  MSG_TYPE_INPUT);
        v.setUint8(1,  seq);
        v.setUint16(2, inp.buttons & 0xFFFF,  true);  // LE
        v.setInt16(4,  inp.lx,                true);
        v.setInt16(6,  inp.ly,                true);
        v.setInt16(8,  inp.rx,                true);
        v.setInt16(10, inp.ry,                true);
        v.setUint8(12, inp.lt & 0xFF);
        v.setUint8(13, inp.rt & 0xFF);
        v.setUint16(14, 0,                    true);  // reserved

        this._seq = (seq + 1) & 0xFF;   // 8-bit wrap

        this.socket.send(this._buf);
    }

    // ─── Checkpoint 2: visibility / blur failsafe ─────────────────────────────
    _setupVisibilityFailsafe() {
        // Page hidden (tab switch, app switcher, screen off)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this._suspend('Tab hidden');
            } else {
                this._resume();
                if (this._wakeLockRequested) {
                    this._requestWakeLock();
                }
            }
        });

        // Window loses focus (notification pull-down, home swipe mid-game)
        window.addEventListener('blur', () => this._suspend('Window blur'));
        window.addEventListener('focus', () => this._resume());
    }

    _suspend(reason = '') {
        if (this._state === State.SUSPENDED) return;
        console.log(`[GamepadApp] SUSPENDED (${reason}) — sending neutral frame.`);
        this._setState(State.SUSPENDED, 'Suspended');
        this._stopPing();
        this._flushConsecutiveFrames = 0;
        this._prevLx = 0;
        this._prevLy = 0;
        this._prevRx = 0;
        this._prevRy = 0;
        this._resetGyro();
        window.TouchEngine?.releaseAll();   // clear all held buttons/sticks
        this._sendNeutralFrame();   // zero all axes/buttons on host immediately
    }

    _resume() {
        if (this._state !== State.SUSPENDED) return;
        console.log('[GamepadApp] Resuming from SUSPENDED.');
        this._flushConsecutiveFrames = 0;
        this._prevLx = 0;
        this._prevLy = 0;
        this._prevRx = 0;
        this._prevRy = 0;
        if (this.socket?.readyState === WebSocket.OPEN) {
            this._setState(State.CONNECTED, 'Connected');
            this._startPing();
        } else {
            this._setState(State.RECONNECTING, 'Reconnecting…');
            this._scheduleReconnect();
        }
    }

    /** Transmit a zeroed 16-byte frame with msg_type=0x00 to zero the host. */
    _sendNeutralFrame() {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        // neutralBuf is pre-built as all zeros → msg_type = MSG_TYPE_NEUTRAL (0x00)
        this.socket.send(this._neutralBuf);
    }

    // ─── Fullscreen ───────────────────────────────────────────────────────────
    _setupFullscreen() {
        if (!this._fullscreenBtn) return;
        const toggle = async () => {
            try {
                if (!document.fullscreenElement) {
                    await document.documentElement.requestFullscreen();
                    await screen.orientation?.lock?.('landscape').catch(() => {});
                } else {
                    await document.exitFullscreen();
                }
            } catch (_) {}
        };
        this._fullscreenBtn.addEventListener('click', toggle);
    }

    // ─── Quick-Settings Persistence & Drawer ──────────────────────────────────
    _loadSettings() {
        try {
            const raw = window.localStorage?.getItem(SETTINGS_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (typeof parsed.deadzone === 'number' && !Number.isNaN(parsed.deadzone)) {
                this._settings.deadzone = Math.max(0.0, Math.min(0.25, parsed.deadzone));
            }
            if (typeof parsed.sensitivity === 'number' && !Number.isNaN(parsed.sensitivity)) {
                this._settings.sensitivity = Math.max(0.6, Math.min(1.4, parsed.sensitivity));
            }
            if (parsed.curve === 'linear' || parsed.curve === 'exponential') {
                this._settings.curve = parsed.curve;
            }
            if (typeof parsed.haptics === 'boolean') {
                this._settings.haptics = parsed.haptics;
            }
            if (['off', 'right_stick', 'left_stick_x'].includes(parsed.gyroMode)) {
                this._settings.gyroMode = parsed.gyroMode;
            }
            if (['hold_lt', 'hold_clutch', 'always_on'].includes(parsed.gyroActivation)) {
                this._settings.gyroActivation = parsed.gyroActivation;
            }
            if (typeof parsed.gyroSensitivity === 'number' && Number.isFinite(parsed.gyroSensitivity)) {
                this._settings.gyroSensitivity = Math.max(0.5, Math.min(3.0, parsed.gyroSensitivity));
            }
            if (typeof parsed.gyroAntiDeadzone === 'number' && Number.isFinite(parsed.gyroAntiDeadzone)) {
                this._settings.gyroAntiDeadzone = Math.max(0.0, Math.min(0.25, parsed.gyroAntiDeadzone));
            }
            if (typeof parsed.gyroInvertY === 'boolean') {
                this._settings.gyroInvertY = parsed.gyroInvertY;
            }
        } catch (_) {}
    }

    _saveSettings() {
        try {
            window.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this._settings));
        } catch (_) {}
    }

    _applySettings() {
        window.TouchEngine?.applySettings({
            deadzone:    this._settings.deadzone,
            sensitivity: this._settings.sensitivity,
            curve:       this._settings.curve,
        });
        window.Haptics?.setEnabled(this._settings.haptics);
        window.GyroEngine?.applySettings({
            mode:         this._settings.gyroMode,
            activation:   this._settings.gyroActivation,
            sensitivity:  this._settings.gyroSensitivity,
            antiDeadzone: this._settings.gyroAntiDeadzone,
            invertY:      this._settings.gyroInvertY,
        });
        this._syncGyroHUD();
    }

    _setupSettingsDrawer() {
        const gearBtn    = document.getElementById('btn-settings');
        const closeBtn   = document.getElementById('btn-settings-close');
        const backdrop   = document.getElementById('settings-backdrop');
        const drawer     = document.getElementById('settings-drawer');
        const dzSlider   = document.getElementById('setting-deadzone');
        const dzVal      = document.getElementById('val-deadzone');
        const sensSlider = document.getElementById('setting-sensitivity');
        const sensVal    = document.getElementById('val-sensitivity');
        const btnLinear  = document.getElementById('btn-curve-linear');
        const btnPrec    = document.getElementById('btn-curve-precision');
        const hapToggle  = document.getElementById('setting-haptics');
        const resetBtn   = document.getElementById('btn-settings-reset');
        const gModeBtns  = document.querySelectorAll('[data-gyro-mode]');
        const gActBtns   = document.querySelectorAll('[data-gyro-act]');
        const gSens      = document.getElementById('setting-gyro-sens');
        const gSensVal   = document.getElementById('val-gyro-sens');
        const gAdz       = document.getElementById('setting-gyro-antidz');
        const gAdzVal    = document.getElementById('val-gyro-antidz');
        const gInvert    = document.getElementById('setting-gyro-inverty');
        const gCalib     = document.getElementById('btn-gyro-calibrate');

        if (!gearBtn || !drawer || !backdrop) return;

        const syncUI = () => {
            const dzPct = Math.round(this._settings.deadzone * 100);
            const sensPct = Math.round(this._settings.sensitivity * 100);
            if (dzSlider)   dzSlider.value = String(dzPct);
            if (dzVal)      dzVal.textContent = `${dzPct}%`;
            if (sensSlider) sensSlider.value = String(sensPct);
            if (sensVal)    sensVal.textContent = `${sensPct}%`;

            const isExp = this._settings.curve === 'exponential';
            if (btnLinear) {
                btnLinear.classList.toggle('active', !isExp);
                btnLinear.setAttribute('aria-pressed', String(!isExp));
            }
            if (btnPrec) {
                btnPrec.classList.toggle('active', isExp);
                btnPrec.setAttribute('aria-pressed', String(isExp));
            }
            if (hapToggle) hapToggle.checked = this._settings.haptics;

            gModeBtns.forEach((b) => {
                const on = b.dataset.gyroMode === this._settings.gyroMode;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', String(on));
            });
            gActBtns.forEach((b) => {
                const on = b.dataset.gyroAct === this._settings.gyroActivation;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', String(on));
            });
            if (gSens)    gSens.value = String(this._settings.gyroSensitivity);
            if (gSensVal) gSensVal.textContent = `${this._settings.gyroSensitivity.toFixed(1)}x`;
            const adzPct = Math.round(this._settings.gyroAntiDeadzone * 100);
            if (gAdz)     gAdz.value = String(adzPct);
            if (gAdzVal)  gAdzVal.textContent = `${adzPct}%`;
            if (gInvert)  gInvert.checked = this._settings.gyroInvertY;
        };

        const setOpen = (open) => {
            this._settingsOpen = Boolean(open);
            drawer.classList.toggle('open', this._settingsOpen);
            backdrop.classList.toggle('open', this._settingsOpen);
            drawer.setAttribute('aria-hidden', String(!this._settingsOpen));
            backdrop.setAttribute('aria-hidden', String(!this._settingsOpen));
            gearBtn.setAttribute('aria-expanded', String(this._settingsOpen));
            window.TouchEngine?.setPaused(this._settingsOpen);
            window.GyroEngine?.setPaused(this._settingsOpen);
            if (this._settingsOpen) this._setGyroPillActive(false);
        };

        syncUI();

        gearBtn.addEventListener('click', () => setOpen(!this._settingsOpen));
        closeBtn?.addEventListener('click', () => setOpen(false));
        backdrop.addEventListener('click', () => setOpen(false));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._settingsOpen) setOpen(false);
        });

        dzSlider?.addEventListener('input', () => {
            const pct = Number(dzSlider.value);
            this._settings.deadzone = Math.max(0, Math.min(25, pct)) / 100;
            if (dzVal) dzVal.textContent = `${Math.round(this._settings.deadzone * 100)}%`;
            this._applySettings();
            this._saveSettings();
        });

        sensSlider?.addEventListener('input', () => {
            const pct = Number(sensSlider.value);
            this._settings.sensitivity = Math.max(60, Math.min(140, pct)) / 100;
            if (sensVal) sensVal.textContent = `${Math.round(this._settings.sensitivity * 100)}%`;
            this._applySettings();
            this._saveSettings();
        });

        const setCurve = (curve) => {
            this._settings.curve = curve;
            syncUI();
            this._applySettings();
            this._saveSettings();
        };
        btnLinear?.addEventListener('click', () => setCurve('linear'));
        btnPrec?.addEventListener('click', () => setCurve('exponential'));

        hapToggle?.addEventListener('change', () => {
            this._settings.haptics = Boolean(hapToggle.checked);
            this._applySettings();
            this._saveSettings();
        });

        // ── Gyro controls ──
        gModeBtns.forEach((btn) => btn.addEventListener('click', () => {
            const mode = btn.dataset.gyroMode;
            this._settings.gyroMode = mode;
            this._applySettings();
            if (mode !== 'off') {
                // Synchronous inside the tap handler: required for iOS permission prompts
                window.GyroEngine?.enableFromUserGesture(mode);
            } else {
                window.GyroEngine?.clearWarning();
                this._resetGyro();
            }
            syncUI();
            this._saveSettings();
        }));

        gActBtns.forEach((btn) => btn.addEventListener('click', () => {
            this._settings.gyroActivation = btn.dataset.gyroAct;
            this._applySettings();
            syncUI();
            this._saveSettings();
        }));

        gSens?.addEventListener('input', () => {
            this._settings.gyroSensitivity = Math.max(0.5, Math.min(3.0, Number(gSens.value)));
            if (gSensVal) gSensVal.textContent = `${this._settings.gyroSensitivity.toFixed(1)}x`;
            this._applySettings();
            this._saveSettings();
        });

        gAdz?.addEventListener('input', () => {
            this._settings.gyroAntiDeadzone = Math.max(0, Math.min(25, Number(gAdz.value))) / 100;
            if (gAdzVal) gAdzVal.textContent = `${Math.round(this._settings.gyroAntiDeadzone * 100)}%`;
            this._applySettings();
            this._saveSettings();
        });

        gInvert?.addEventListener('change', () => {
            this._settings.gyroInvertY = Boolean(gInvert.checked);
            this._applySettings();
            this._saveSettings();
        });

        gCalib?.addEventListener('click', () => {
            window.GyroEngine?.recalibrate();
            gCalib.classList.add('calibrated');
            gCalib.textContent = 'Calibrated ✓';
            setTimeout(() => {
                gCalib.classList.remove('calibrated');
                gCalib.textContent = 'Recenter / Calibrate';
            }, 1200);
        });

        resetBtn?.addEventListener('click', () => {
            this._settings = { ...DEFAULT_SETTINGS };
            window.GyroEngine?.clearWarning();
            this._resetGyro();
            syncUI();
            this._applySettings();
            this._saveSettings();
        });
    }

    // ─── Screen Wake Lock ─────────────────────────────────────────────────────
    _setupWakeLock() {
        const acquireOnce = () => {
            this._wakeLockRequested = true;
            this._requestWakeLock();
        };
        window.addEventListener('pointerdown', acquireOnce, { once: true, passive: true });
        window.addEventListener('touchstart',  acquireOnce, { once: true, passive: true });
    }

    async _requestWakeLock() {
        if (document.hidden || this._wakeLock) return;
        if (typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
            return;
        }
        try {
            const sentinel = await navigator.wakeLock.request('screen');
            this._wakeLock = sentinel;
            sentinel.addEventListener('release', () => {
                if (this._wakeLock === sentinel) {
                    this._wakeLock = null;
                }
            });
        } catch (_) {
            // Unsupported, low-battery policy, or page not active — fail silently
        }
    }

    // ─── Gesture locks (pinch-zoom, bounce scroll) ────────────────────────────
    _setupGestureLocks() {
        for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
            document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
        }
    }
}

// Boot on DOM ready
window.addEventListener('DOMContentLoaded', () => {
    window.App = new GamepadApp();
    window.App.init();
});
