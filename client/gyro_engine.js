/**
 * Gyro Engine v2.0 — Motion Aiming (Right Stick) & Tilt Steering (Left Stick X)
 *
 * Output is normalized floats in [-1, 1] (gx/gy), additively blended onto touch
 * sticks by TouchEngine.getBlendedState(). The 16-byte wire frame is unchanged.
 */
const GYRO_EMA_ALPHA          = 0.4;
const GYRO_NOISE_FLOOR_DEG_S  = 2.0;
const GYRO_AIM_FULL_SCALE     = 100.0;  // excess deg/s at 1.0x sensitivity => full deflection
const GYRO_STEER_MAX_DEG      = 35.0;
const GYRO_STEER_DEADBAND_DEG = 0.4;
const GYRO_LT_THRESHOLD       = 0.15;
const GYRO_SENSOR_WATCHDOG_MS = 1500;
const GYRO_STALL_MS           = 150;

const GYRO_MSG_INSECURE = 'Motion sensors blocked: mobile browsers require HTTPS (or a browser insecure-origin sensor flag) when connecting over a LAN IP.';
const GYRO_MSG_NO_EVENTS = 'No motion sensor events detected. Mobile browsers require HTTPS (or a browser sensor flag) for gyroscope access on LAN IPs, and sensor permissions must be allowed.';
const GYRO_MSG_DENIED = 'Motion sensor permission was denied. Allow Motion & Orientation access in your browser/site settings, then toggle Gyro Mode again.';

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class GyroEngine {
    constructor() {
        this.mode        = 'off';       // 'off' | 'right_stick' | 'left_stick_x'
        this.activation  = 'hold_lt';   // 'hold_lt' | 'hold_clutch' | 'always_on'
        this.sensitivity = 1.2;
        this.antiDeadzone = 0.14;
        this.invertY     = false;

        this._out = { lx: 0, ly: 0, rx: 0, ry: 0, active: false, sending: false };

        this._emaYaw = 0;  this._emaPitch = 0;  this._lastMotionTs = 0;
        this._latestRollDeg = 0;  this._rollZeroDeg = 0;
        this._hasOrientationSample = false;  this._needsRollCalibration = true;

        this._clutchHeld = false;  this._clutchPtrId = null;
        this._prevGateOpen = false;  this._paused = false;

        this._receivedMotion = false;  this._receivedOrientation = false;
        this._sensorWarning = '';  this._sensorCheckTimer = null;
        this._onWarningChange = null;
        this._listening = false;  this._inited = false;
        this._clutchEl = null;

        this._cosA = 0;  this._sinA = 1;
        this._updateAngle();

        this._onMotion = (ev) => this._onDeviceMotion(ev);
        this._onOrient = (ev) => this._onDeviceOrientation(ev);
    }

    // ── Setup ─────────────────────────────────────────────────────────────
    init({ onWarningChange } = {}) {
        this._onWarningChange = typeof onWarningChange === 'function' ? onWarningChange : null;
        if (this._inited || typeof window === 'undefined') return;
        this._inited = true;

        const onOrientChange = () => {
            this._updateAngle();
            this._emaYaw = 0; this._emaPitch = 0;
            this._needsRollCalibration = true;
        };
        try { window.screen?.orientation?.addEventListener?.('change', onOrientChange); } catch (_) {}
        window.addEventListener('orientationchange', onOrientChange);

        document.addEventListener('visibilitychange', () => { if (document.hidden) this.resetOutput(); });
        window.addEventListener('blur', () => this.resetOutput());

        this._bindClutchButton();
    }

    applySettings({ mode, activation, sensitivity, antiDeadzone, invertY } = {}) {
        if (mode === 'off' || mode === 'right_stick' || mode === 'left_stick_x') {
            if (mode !== this.mode) {
                this._emaYaw = 0; this._emaPitch = 0;
                this._needsRollCalibration = true;
            }
            this.mode = mode;
        }
        if (activation === 'hold_lt' || activation === 'hold_clutch' || activation === 'always_on') {
            this.activation = activation;
        }
        if (_isNum(sensitivity))  this.sensitivity  = _clamp(sensitivity, 0.5, 3.0);
        if (_isNum(antiDeadzone)) this.antiDeadzone = _clamp(antiDeadzone, 0.0, 0.25);
        if (typeof invertY === 'boolean') this.invertY = invertY;
    }

    setPaused(paused) {
        this._paused = Boolean(paused);
        if (this._paused) this.resetOutput();
    }

    // ── Screen orientation (90 vs 270) ────────────────────────────────────
    _getOrientationAngle() {
        let a = null;
        try {
            const so = typeof screen !== 'undefined' ? screen.orientation : null;
            if (so && _isNum(so.angle)) a = so.angle;
        } catch (_) {}
        if (a === null && typeof window !== 'undefined' && _isNum(window.orientation)) a = window.orientation;
        if (a === null) a = 90;
        return ((a % 360) + 360) % 360;
    }

    _updateAngle() {
        const rad = this._getOrientationAngle() * Math.PI / 180;
        // Round to kill 1e-16 residue so 90/270 are exact mirror images
        this._cosA = Math.round(Math.cos(rad) * 1e9) / 1e9;
        this._sinA = Math.round(Math.sin(rad) * 1e9) / 1e9;
    }

    // ── Sensor listeners & permission ─────────────────────────────────────
    _attachListeners() {
        if (this._listening || typeof window === 'undefined') return;
        window.addEventListener('devicemotion', this._onMotion);
        window.addEventListener('deviceorientation', this._onOrient);
        this._listening = true;
    }

    /** Call synchronously from a user tap handler. */
    enableFromUserGesture(targetMode) {
        if (typeof window === 'undefined') return;
        this._updateAngle();
        const reqs = [];
        try {
            if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
                reqs.push(DeviceMotionEvent.requestPermission());
            }
        } catch (e) { reqs.push(Promise.reject(e)); }
        try {
            if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                reqs.push(DeviceOrientationEvent.requestPermission());
            }
        } catch (e) { reqs.push(Promise.reject(e)); }

        this._attachListeners();
        this._receivedMotion = false;
        this._receivedOrientation = false;
        this._needsRollCalibration = true;
        this._hasOrientationSample = false;
        this._startSensorCheck(targetMode || this.mode);

        if (reqs.length) {
            Promise.all(reqs).then((res) => {
                if (res.some((r) => r === 'denied')) this._setWarning(GYRO_MSG_DENIED);
            }).catch(() => this._setWarning(GYRO_MSG_DENIED));
        }
    }

    /** Resume listening at boot when persisted mode is active (no gesture available). */
    resumeIfEnabled() {
        if (this.mode === 'off') return;
        this._attachListeners();
        this._startSensorCheck(this.mode);
    }

    _startSensorCheck(mode) {
        if (this._sensorCheckTimer) { clearTimeout(this._sensorCheckTimer); this._sensorCheckTimer = null; }
        this._setWarning('');
        if (typeof window !== 'undefined' && window.isSecureContext === false) {
            this._setWarning(GYRO_MSG_INSECURE);
        }
        this._sensorCheckTimer = setTimeout(() => {
            this._sensorCheckTimer = null;
            if (this.mode === 'off') return;
            const got = (this.mode === 'left_stick_x') ? this._receivedOrientation : this._receivedMotion;
            if (!got && !this._sensorWarning) this._setWarning(GYRO_MSG_NO_EVENTS);
            else if (!got && this._sensorWarning === GYRO_MSG_INSECURE) { /* keep insecure message */ }
        }, GYRO_SENSOR_WATCHDOG_MS);
    }

    clearWarning() {
        if (this._sensorCheckTimer) { clearTimeout(this._sensorCheckTimer); this._sensorCheckTimer = null; }
        this._setWarning('');
    }

    _setWarning(msg) {
        if (msg === this._sensorWarning) return;
        this._sensorWarning = msg;
        if (this._onWarningChange) { try { this._onWarningChange(msg); } catch (_) {} }
    }

    _sensorOk() {
        // Valid events arrived: clear any warning unless context is insecure & nothing real arrived
        if (this._sensorWarning && (typeof window === 'undefined' || window.isSecureContext !== false)) {
            this._setWarning('');
        }
    }

    // ── devicemotion: angular velocity → aim ──────────────────────────────
    _onDeviceMotion(ev) {
        const rr = ev && ev.rotationRate;
        if (!rr || !(_isNum(rr.alpha) || _isNum(rr.beta) || _isNum(rr.gamma))) return;
        this._receivedMotion = true;
        this._lastMotionTs = _now();
        this._sensorOk();

        const alpha = Number(rr.alpha) || 0;
        const beta  = Number(rr.beta)  || 0;
        const gamma = Number(rr.gamma) || 0;
        const cosA = this._cosA, sinA = this._sinA;

        const omegaR = beta * cosA - gamma * sinA;   // pitch
        const omegaU = beta * sinA + gamma * cosA;   // screen-up axis
        const omegaF = alpha;                        // screen-normal axis

        let rawYaw;
        const g = ev.accelerationIncludingGravity;
        if (g && _isNum(g.x) && _isNum(g.y) && _isNum(g.z) && Math.hypot(g.x, g.y) > 2.0) {
            const gU = Math.abs(g.x * sinA + g.y * cosA);
            const gF = Math.abs(g.z);
            const h = Math.hypot(gU, gF) || 1;
            rawYaw = (-omegaU) * (gU / h) + (-omegaF) * (gF / h);
        } else if (beta === 0 && gamma === 0 && alpha !== 0) {
            rawYaw = -omegaF;
        } else {
            rawYaw = -omegaU;
        }
        const rawPitch = omegaR;

        this._emaYaw   = GYRO_EMA_ALPHA * rawYaw   + (1 - GYRO_EMA_ALPHA) * this._emaYaw;
        this._emaPitch = GYRO_EMA_ALPHA * rawPitch + (1 - GYRO_EMA_ALPHA) * this._emaPitch;
    }

    // ── deviceorientation: roll → steer ───────────────────────────────────
    _onDeviceOrientation(ev) {
        if (!ev || !(_isNum(ev.beta) || _isNum(ev.gamma))) return;
        this._receivedOrientation = true;
        this._sensorOk();

        const bRad = (Number(ev.beta)  || 0) * Math.PI / 180;
        const gRad = (Number(ev.gamma) || 0) * Math.PI / 180;
        const ux = -Math.cos(bRad) * Math.sin(gRad);
        const uy = Math.sin(bRad);
        const uR = ux * this._cosA - uy * this._sinA;
        const rollDeg = Math.asin(_clamp(-uR, -1, 1)) * (180 / Math.PI);

        this._latestRollDeg = rollDeg;
        this._hasOrientationSample = true;
        if (this._needsRollCalibration) {
            this._rollZeroDeg = rollDeg;
            this._needsRollCalibration = false;
        }
    }

    recalibrate() {
        this._emaYaw = 0; this._emaPitch = 0;
        if (this._hasOrientationSample) {
            this._rollZeroDeg = this._latestRollDeg;
            this._needsRollCalibration = false;
        } else {
            this._needsRollCalibration = true;
        }
    }

    // ── Clutch button ─────────────────────────────────────────────────────
    _bindClutchButton() {
        const el = document.getElementById('btn-gyro-clutch');
        if (!el) return;
        this._clutchEl = el;

        el.addEventListener('pointerdown', (e) => {
            if (this._paused) return;
            e.preventDefault(); e.stopPropagation();
            if (this._clutchPtrId !== null) return;
            this._clutchPtrId = e.pointerId;
            try { el.setPointerCapture(e.pointerId); } catch (_) {}
            this._clutchHeld = true;
            el.classList.add('active');
            this.recalibrate();
            window.Haptics?.pulse('click');
        }, { passive: false });

        const release = (e) => {
            if (this._clutchPtrId === null || e.pointerId !== this._clutchPtrId) return;
            e.preventDefault?.(); e.stopPropagation?.();
            this._releaseClutch();
        };
        el.addEventListener('pointerup', release, { passive: false });
        el.addEventListener('pointercancel', release, { passive: false });
        el.addEventListener('lostpointercapture', release, { passive: false });
        window.addEventListener('pointerup', release, { passive: false });
        window.addEventListener('pointercancel', release, { passive: false });
    }

    _releaseClutch() {
        this._clutchPtrId = null;
        this._clutchHeld = false;
        this._clutchEl?.classList.remove('active');
        this._emaYaw = 0; this._emaPitch = 0;
        this._needsRollCalibration = true;
        const o = this._out;
        const wasNonZero = o.lx !== 0 || o.ly !== 0 || o.rx !== 0 || o.ry !== 0;
        o.lx = o.ly = o.rx = o.ry = 0; o.active = false; o.sending = false;
        if (wasNonZero) window.App?.flushReturnToCenter?.();
    }

    // ── Failsafe ──────────────────────────────────────────────────────────
    resetOutput() {
        const o = this._out;
        o.lx = o.ly = o.rx = o.ry = 0;
        o.active = false; o.sending = false;
        this._emaYaw = 0; this._emaPitch = 0;
        this._clutchHeld = false; this._clutchPtrId = null;
        this._prevGateOpen = false;
        this._needsRollCalibration = true;
        this._clutchEl?.classList.remove('active');
    }

    // ── Per-frame sampling (zero-alloc) ───────────────────────────────────
    sample(ltNormalized = 0) {
        const o = this._out;
        if (this.mode === 'off' || this._paused) {
            o.lx = o.ly = o.rx = o.ry = 0; o.active = false; o.sending = false;
            this._prevGateOpen = false;
            return o;
        }

        let gateOpen;
        if (this.activation === 'always_on')       gateOpen = true;
        else if (this.activation === 'hold_clutch') gateOpen = this._clutchHeld === true;
        else                                        gateOpen = ltNormalized > GYRO_LT_THRESHOLD;

        if (!this._prevGateOpen && gateOpen) {
            this._emaYaw = 0; this._emaPitch = 0;
            if (this.mode === 'left_stick_x') this.recalibrate();
        } else if (this._prevGateOpen && !gateOpen) {
            this._emaYaw = 0; this._emaPitch = 0;
            if (this.activation === 'hold_clutch') this._needsRollCalibration = true;
        }
        this._prevGateOpen = gateOpen;

        o.lx = o.ly = o.rx = o.ry = 0;
        o.active = gateOpen;
        if (!gateOpen) { o.sending = false; return o; }

        if (this.mode === 'right_stick') {
            if (_now() - this._lastMotionTs > GYRO_STALL_MS) { this._emaYaw = 0; this._emaPitch = 0; }
            const speed = Math.hypot(this._emaYaw, this._emaPitch);
            if (speed >= GYRO_NOISE_FLOOR_DEG_S) {
                const norm = Math.min(1.0, ((speed - GYRO_NOISE_FLOOR_DEG_S) * this.sensitivity) / GYRO_AIM_FULL_SCALE);
                const ad = this.antiDeadzone;
                const outMag = Math.min(1.0, ad + (1.0 - ad) * norm);
                let rx = (this._emaYaw / speed) * outMag;
                let ry = (this._emaPitch / speed) * outMag;
                if (this.invertY) ry = -ry;
                o.rx = _clamp(rx, -1, 1);
                o.ry = _clamp(ry, -1, 1);
            }
        } else if (this.mode === 'left_stick_x') {
            if (this._hasOrientationSample) {
                const delta = this._latestRollDeg - this._rollZeroDeg;
                o.lx = Math.abs(delta) < GYRO_STEER_DEADBAND_DEG ? 0 : _clamp(delta / GYRO_STEER_MAX_DEG, -1, 1);
            }
        }

        o.sending = Math.abs(o.lx) > 0.001 || Math.abs(o.rx) > 0.001 || Math.abs(o.ry) > 0.001;
        return o;
    }
}

if (typeof window !== 'undefined') window.GyroEngine = new GyroEngine();
if (typeof module !== 'undefined' && module.exports) module.exports = { GyroEngine };
