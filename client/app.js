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
    }

    // ─── Boot ────────────────────────────────────────────────────────────────
    init() {
        this._statusBadge   = document.getElementById('status-badge');
        this._latencyEl     = document.getElementById('latency-badge');
        this._driverEl      = document.getElementById('driver-badge');
        this._playerEl      = document.querySelector('.player-pill');
        this._fullscreenBtn = document.getElementById('btn-fullscreen');

        window.TouchEngine.init();

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
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.hostname || '127.0.0.1'}:${p.get('port') || '8765'}`;
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
            this._scheduleReconnect();
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

        const inp  = window.TouchEngine.getState();

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
        this._fullscreenBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            toggle();
        });
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
