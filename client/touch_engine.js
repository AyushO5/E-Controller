/**
 * Multi-Touch Pointer Tracking & Floating Joystick Engine — Checkpoint 3
 *
 * Key invariants:
 *  - Every active pointer is tracked strictly by PointerEvent.pointerId
 *  - Simultaneous inputs (LS + RT + A) never collide or cancel each other
 *  - Thumbstick: 0.12 radial deadzone, hard radial clamp, no overflow
 *  - Face buttons support thumb-roll via pointerenter/pointerleave-while-down
 *  - touch-action:none / user-select:none / overscroll-behavior:none on root
 *  - Global pointer tracking on window and zero-touch failsafe
 */

// Button bitmasks matching host protocol.py
const BUTTON_MASKS = {
    A:          1 << 0,
    B:          1 << 1,
    X:          1 << 2,
    Y:          1 << 3,
    LB:         1 << 4,
    RB:         1 << 5,
    BACK:       1 << 6,
    START:      1 << 7,
    GUIDE:      1 << 8,
    THUMBL:     1 << 9,
    THUMBR:     1 << 10,
    DPAD_UP:    1 << 11,
    DPAD_DOWN:  1 << 12,
    DPAD_LEFT:  1 << 13,
    DPAD_RIGHT: 1 << 14,
};

// Haptic type per button group
const HAPTIC_TYPE = {
    A: 'click', B: 'click', X: 'click', Y: 'click',
    LB: 'heavy', RB: 'heavy',
    THUMBL: 'heavy', THUMBR: 'heavy',
    BACK: 'click', START: 'click', GUIDE: 'click',
    DPAD_UP: 'dpad', DPAD_DOWN: 'dpad', DPAD_LEFT: 'dpad', DPAD_RIGHT: 'dpad',
};

class TouchEngine {
    constructor() {
        // Public gamepad state (read by app.js at 60 Hz)
        this.buttons = 0;
        this.lx = 0;  this.ly = 0;
        this.rx = 0;  this.ry = 0;
        this.lt = 0;  this.rt = 0;

        // ── Button pointer tracking ────────────────────────────────────────
        // Maps pointerId → Set<buttonName> (one pointer can hold multiple masks
        // only via thumb-roll, so we track per-button precisely)
        this._ptrToButtons = new Map();   // pointerId → Set<buttonName>
        this._btnToPtr     = new Map();   // buttonName → pointerId
        this._btnElements  = new Map();   // buttonName → Element

        // ── Trigger tracking ──────────────────────────────────────────────
        this._triggerPtrs  = new Map();   // 'lt'|'rt' → pointerId

        // ── Stick tracking ────────────────────────────────────────────────
        this._stickStates  = { left: null, right: null };

        this.DEADZONE        = 0.08;      // configurable 0.00–0.25 scaled radial deadzone
        this.curve           = 'linear';  // 'linear' | 'exponential'
        this.sensitivity     = 1.0;       // configurable 0.6–1.4 multiplier
        this.paused          = false;     // true while settings drawer is open
        this.MAX_STICK_PX    = 48;        // fallback socket radius in CSS pixels

        // Face-button set eligible for thumb-roll (enter/leave while pointer down)
        this._ROLLABLE = new Set(['A', 'B', 'X', 'Y',
                                  'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT']);
    }

    // ── Settings & Pause Control ──────────────────────────────────────────
    applySettings({ deadzone, sensitivity, curve } = {}) {
        if (typeof deadzone === 'number' && !Number.isNaN(deadzone)) {
            this.DEADZONE = Math.max(0.0, Math.min(0.25, deadzone));
        }
        if (typeof sensitivity === 'number' && !Number.isNaN(sensitivity)) {
            this.sensitivity = Math.max(0.6, Math.min(1.4, sensitivity));
        }
        if (curve === 'linear' || curve === 'exponential') {
            this.curve = curve;
        }
    }

    setPaused(paused) {
        this.paused = Boolean(paused);
        if (this.paused) {
            this.forceResetZeroTouch();
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────
    init() {
        this._lockRootGestures();
        this._bindDigitalButtons();
        this._bindTriggers();
        this._bindSticks();
        this._bindZeroTouchFailsafe();
    }

    // ── Global gesture suppression & iOS Safari hardening ─────────────────
    _lockRootGestures() {
        const root = document.documentElement;
        const body = document.body;
        const shell = document.getElementById('controller-shell') || document.querySelector('.controller-shell');

        // Apply touch-action: none; user-select: none; -webkit-user-select: none;
        // -webkit-touch-callout: none; overscroll-behavior: none;
        // to html, body, root controller wrapper, and every stick/button element
        const targets = [
            root, body, shell,
            ...document.querySelectorAll(
                '.trigger-paddle, .bumper-paddle, .console-btn, .guide-jewel, ' +
                '.thumbstick-housing, .stick-well, .stick-nub, .stick-concave-cap, ' +
                '.dpad-housing, .dpad-btn, .action-diamond-housing, .face-btn, [data-button], .fullscreen-pill'
            )
        ].filter(Boolean);

        targets.forEach(el => {
            el.style.touchAction = 'none';
            el.style.userSelect = 'none';
            el.style.webkitUserSelect = 'none';
            el.style.webkitTouchCallout = 'none';
            el.style.overscrollBehavior = 'none';
        });

        // Attach { passive: false } touchstart and touchmove listeners to the root
        // controller container that call e.preventDefault() so Safari never turns
        // fast thumb drags near the screen edges into back/forward page swipes
        if (shell) {
            const blockSafariGestures = e => {
                if (e.target && e.target.closest && e.target.closest('#btn-fullscreen, .fullscreen-pill, #btn-settings, #settings-drawer, #settings-backdrop')) {
                    return;
                }
                e.preventDefault();
            };
            shell.addEventListener('touchstart', blockSafariGestures, { passive: false });
            shell.addEventListener('touchmove', blockSafariGestures, { passive: false });
        }
    }

    // ── Digital Buttons ───────────────────────────────────────────────────
    _bindDigitalButtons() {
        document.querySelectorAll('[data-button]').forEach(el => {
            const name = el.dataset.button;
            const mask = BUTTON_MASKS[name];
            if (mask === undefined) return;

            this._btnElements.set(name, el);
            const rollable = this._ROLLABLE.has(name);

            // pointerdown — initial press (skip capture on rollable buttons so thumb-roll works)
            el.addEventListener('pointerdown', e => {
                if (this.paused) return;
                e.preventDefault(); e.stopPropagation();
                this._pressButton(e.pointerId, name, mask, el, rollable);
            }, { passive: false });

            // pointerup / cancel / lostcapture — release
            const release = e => {
                e.preventDefault(); e.stopPropagation();
                this._releaseButton(e.pointerId, name, mask, el);
            };
            el.addEventListener('pointerup',         release, { passive: false });
            el.addEventListener('pointercancel',      release, { passive: false });
            el.addEventListener('lostpointercapture', release, { passive: false });

            // Thumb-roll: pointerenter while another pointer is already moving over face buttons
            if (rollable) {
                el.addEventListener('pointerenter', e => {
                    if (this.paused) return;
                    // Only activate if the pointer is currently held down (buttons !== 0)
                    if (e.buttons === 0) return;
                    e.preventDefault();
                    // If this pointer is already tracked on another button, roll to this one
                    const prevBtns = this._ptrToButtons.get(e.pointerId);
                    if (prevBtns && !prevBtns.has(name)) {
                        this._pressButton(e.pointerId, name, mask, el, /*noCapture*/ true);
                    } else if (!prevBtns) {
                        // Fresh roll-in without an initial pointerdown on us
                        this._pressButton(e.pointerId, name, mask, el, /*noCapture*/ true);
                    }
                }, { passive: false });

                el.addEventListener('pointerleave', e => {
                    if (e.buttons === 0) return;
                    e.preventDefault();
                    this._releaseButton(e.pointerId, name, mask, el);
                }, { passive: false });
            }
        });

        // Global release fallback so uncaptured rollable buttons never stick if pointer lifts off-button
        const releaseAllForPointer = e => {
            const held = this._ptrToButtons.get(e.pointerId);
            if (!held || held.size === 0) return;
            for (const name of Array.from(held)) {
                const mask = BUTTON_MASKS[name];
                const el = this._btnElements.get(name);
                if (mask !== undefined && el) {
                    this._releaseButton(e.pointerId, name, mask, el);
                }
            }
        };
        window.addEventListener('pointerup',     releaseAllForPointer, { passive: false });
        window.addEventListener('pointercancel', releaseAllForPointer, { passive: false });
    }

    _pressButton(pointerId, name, mask, el, noCapture = false) {
        // Pointer capture keeps delivery even when thumb drifts off-element
        if (!noCapture && el.setPointerCapture) {
            try { el.setPointerCapture(pointerId); } catch (_) {}
        }

        // Record pointerId → Set<name> bidirectional mapping
        if (!this._ptrToButtons.has(pointerId)) {
            this._ptrToButtons.set(pointerId, new Set());
        }
        this._ptrToButtons.get(pointerId).add(name);
        this._btnToPtr.set(name, pointerId);

        // Set bitmask
        this.buttons |= mask;
        el.classList.add('active');

        // Haptic
        window.Haptics?.pulse(HAPTIC_TYPE[name] ?? 'click');
    }

    _releaseButton(pointerId, name, mask, el) {
        const owned = this._ptrToButtons.get(pointerId);
        if (!owned || !owned.has(name)) return;

        owned.delete(name);
        if (owned.size === 0) this._ptrToButtons.delete(pointerId);

        // Keep button pressed if another active pointer is still holding it
        let holderPtr = null;
        for (const [pid, btns] of this._ptrToButtons) {
            if (btns.has(name)) {
                holderPtr = pid;
                break;
            }
        }
        if (holderPtr !== null) {
            this._btnToPtr.set(name, holderPtr);
            return;
        }

        this._btnToPtr.delete(name);
        this.buttons &= ~mask;
        el.classList.remove('active');
    }

    // ── Analog Triggers ───────────────────────────────────────────────────
    _bindTriggers() {
        this._setupTrigger('trigger-lt', 'lt');
        this._setupTrigger('trigger-rt', 'rt');
    }

    _setupTrigger(elId, side) {
        const el = document.getElementById(elId);
        if (!el) return;

        const isLeft = side === 'lt';

        el.addEventListener('pointerdown', e => {
            if (this.paused) return;
            e.preventDefault(); e.stopPropagation();
            if (this._triggerPtrs.has(side)) return;   // already held
            try { el.setPointerCapture(e.pointerId); } catch (_) {}
            this._triggerPtrs.set(side, e.pointerId);
            el.classList.add('active');
            if (isLeft) this.lt = 255; else this.rt = 255;
            window.Haptics?.pulse('trigger');
        }, { passive: false });

        const up = e => {
            e.preventDefault(); e.stopPropagation();
            if (this._triggerPtrs.get(side) !== e.pointerId) return;
            this._triggerPtrs.delete(side);
            el.classList.remove('active');
            if (isLeft) this.lt = 0; else this.rt = 0;
        };
        el.addEventListener('pointerup',          up, { passive: false });
        el.addEventListener('pointercancel',       up, { passive: false });
        el.addEventListener('lostpointercapture',  up, { passive: false });
    }

    // ── Thumbsticks ───────────────────────────────────────────────────────
    _bindSticks() {
        this._setupStick('left-stick-zone',  'left-stick-nub',  'left');
        this._setupStick('right-stick-zone', 'right-stick-nub', 'right');
    }

    _setupStick(zoneId, nubId, side) {
        const socketElement = document.getElementById(zoneId);
        const nub           = document.getElementById(nubId);
        if (!socketElement || !nub) return;

        const stickState = {
            side,
            socketElement,
            nub,
            activePointerId: null,
            originX: 0,
            originY: 0,
            maxR: 0,
        };
        this._stickStates[side] = stickState;

        // On stick pointerdown, record activePointerId = e.pointerId and call
        // socketElement.setPointerCapture(e.pointerId) inside a try/catch
        socketElement.addEventListener('pointerdown', e => {
            if (this.paused) return;
            e.preventDefault();
            e.stopPropagation();
            if (stickState.activePointerId !== null) return;   // second finger ignored

            stickState.activePointerId = e.pointerId;
            try {
                socketElement.setPointerCapture(e.pointerId);
            } catch (_) {}

            const rect = socketElement.getBoundingClientRect();
            const nubRect = nub.getBoundingClientRect();
            stickState.originX = rect.left + rect.width  / 2;
            stickState.originY = rect.top  + rect.height / 2;
            stickState.maxR    = Math.max(16, (rect.width - nubRect.width) / 2);

            socketElement.classList.add('active');
            this._moveStick(side, e.clientX, e.clientY);
        }, { passive: false });

        // Handle pointermove on window, matching strictly by e.pointerId === activePointerId
        const onPointerMove = e => {
            if (stickState.activePointerId === null || e.pointerId !== stickState.activePointerId) return;
            e.preventDefault();
            e.stopPropagation();
            this._moveStick(side, e.clientX, e.clientY);
        };

        // Handle pointerup, pointercancel, and lostpointercapture on window (not just the stick element),
        // matching strictly by e.pointerId === activePointerId
        const onPointerRelease = e => {
            if (stickState.activePointerId === null || e.pointerId !== stickState.activePointerId) return;
            e.preventDefault();
            e.stopPropagation();
            this._releaseStick(side);
        };

        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerRelease, { passive: false });
        window.addEventListener('pointercancel', onPointerRelease, { passive: false });
        window.addEventListener('lostpointercapture', onPointerRelease, { passive: false });
        socketElement.addEventListener('lostpointercapture', onPointerRelease, { passive: false });
    }

    _releaseStick(side) {
        const st = this._stickStates[side];
        if (!st) return;

        // Whenever pointerup, pointercancel, or lostpointercapture fires, immediately clear
        // activePointerId = null, reset thumb cap transform to translate(0px, 0px), and set (x, y) to (0, 0)
        st.activePointerId = null;
        st.socketElement.classList.remove('active');
        st.nub.style.transform = 'translate(0px, 0px)';

        const wasNonZero = side === 'left'
            ? (this.lx !== 0 || this.ly !== 0)
            : (this.rx !== 0 || this.ry !== 0);

        if (side === 'left') {
            this.lx = 0;
            this.ly = 0;
        } else {
            this.rx = 0;
            this.ry = 0;
        }

        if (wasNonZero) {
            window.App?.flushReturnToCenter?.();
        }
    }

    _moveStick(side, clientX, clientY) {
        const st = this._stickStates[side];
        if (!st) return;

        const dx  = clientX - st.originX;
        const dy  = clientY - st.originY;
        const len = Math.hypot(dx, dy);
        const maxR = st.maxR || this.MAX_STICK_PX;

        // Hard radial clamp — nub never overflows the socket
        const scale  = len > maxR ? maxR / len : 1;
        const cx = dx * scale;
        const cy = dy * scale;

        st.nub.style.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px)`;

        // Scaled radial deadzone: map [DEADZONE, 1.0] → [0.0, 1.0] smoothly
        const r = Math.min(len / maxR, 1.0);
        if (len === 0 || r < this.DEADZONE) {
            const wasNonZero = side === 'left'
                ? (this.lx !== 0 || this.ly !== 0)
                : (this.rx !== 0 || this.ry !== 0);

            if (side === 'left') { this.lx = 0; this.ly = 0; }
            else                 { this.rx = 0; this.ry = 0; }

            if (wasNonZero) {
                window.App?.flushReturnToCenter?.();
            }
            return;
        }

        const m = this.DEADZONE < 1.0 ? (r - this.DEADZONE) / (1.0 - this.DEADZONE) : 0;
        const curved = this.curve === 'exponential' ? Math.pow(m, 1.65) : m;
        const angle  = Math.atan2(dy, dx);

        // Apply sensitivity multiplier and clamp normalized axes to [-1.0, 1.0]; invert Y so "up" is positive
        const nx = Math.max(-1.0, Math.min(1.0,  Math.cos(angle) * curved * this.sensitivity));
        const ny = Math.max(-1.0, Math.min(1.0, -Math.sin(angle) * curved * this.sensitivity));

        // Convert to signed 16-bit range [-32768, 32767]
        const ix = Math.round(nx * 32767);
        const iy = Math.round(ny * 32767);

        if (side === 'left') {
            this.lx = Math.max(-32768, Math.min(32767, ix));
            this.ly = Math.max(-32768, Math.min(32767, iy));
        } else {
            this.rx = Math.max(-32768, Math.min(32767, ix));
            this.ry = Math.max(-32768, Math.min(32767, iy));
        }
    }

    // ── Zero-Touch Failsafe (iOS Safari gesture recovery) ───────────────────
    _bindZeroTouchFailsafe() {
        const onZeroTouch = e => {
            if (!this.paused && e.touches && e.touches.length === 0) {
                this.forceResetZeroTouch();
            }
        };
        window.addEventListener('touchend', onZeroTouch, { passive: true });
        window.addEventListener('touchcancel', onZeroTouch, { passive: true });
    }

    forceResetZeroTouch() {
        const hadNonZeroStick = (this.lx !== 0 || this.ly !== 0 || this.rx !== 0 || this.ry !== 0);

        // Force-reset both Left and Right sticks to (0, 0)
        if (this._stickStates.left) {
            this._releaseStick('left');
        } else {
            this.lx = 0; this.ly = 0;
        }

        if (this._stickStates.right) {
            this._releaseStick('right');
        } else {
            this.rx = 0; this.ry = 0;
        }

        // Clear all active button flags
        this.buttons = 0;
        this.lt = 0;
        this.rt = 0;
        this._ptrToButtons.clear();
        this._btnToPtr.clear();
        this._triggerPtrs.clear();

        // Clear visual active states
        document.querySelectorAll(
            '[data-button].active, .trigger-paddle.active, .bumper-paddle.active, ' +
            '.console-btn.active, .guide-jewel.active, .stick-well.active'
        ).forEach(el => el.classList.remove('active'));

        if (hadNonZeroStick) {
            window.App?.flushReturnToCenter?.();
        }
    }

    // ── Public API for app.js ─────────────────────────────────────────────
    getState() {
        return {
            buttons: this.buttons,
            lx: this.lx, ly: this.ly,
            rx: this.rx, ry: this.ry,
            lt: this.lt, rt: this.rt,
        };
    }

    /** Force-release every tracked pointer (called by app.js on SUSPEND). */
    releaseAll() {
        this.forceResetZeroTouch();
    }
}

// Global singleton
window.TouchEngine = new TouchEngine();
