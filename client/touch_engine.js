/**
 * Multi-Touch Pointer Tracking & Floating Joystick Engine — Checkpoint 3
 *
 * Key invariants:
 *  - Every active pointer is tracked strictly by PointerEvent.pointerId
 *  - Simultaneous inputs (LS + RT + A) never collide or cancel each other
 *  - Thumbstick: 0.12 radial deadzone, hard radial clamp, no overflow
 *  - Face buttons support thumb-roll via pointerenter/pointerleave-while-down
 *  - touch-action:none / user-select:none / overscroll-behavior:none on root
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

        // ── Trigger tracking ──────────────────────────────────────────────
        this._triggerPtrs  = new Map();   // 'lt'|'rt' → pointerId

        // ── Stick tracking ────────────────────────────────────────────────
        this._stickPtrs    = new Map();   // 'left'|'right' → StickState
        // StickState { pointerId, originX, originY, nub }

        this.DEADZONE        = 0.12;   // 12% radial deadzone
        this.MAX_STICK_PX    = 48;     // socket radius in CSS pixels

        // Face-button set eligible for thumb-roll (enter/leave while pointer down)
        this._ROLLABLE = new Set(['A', 'B', 'X', 'Y',
                                  'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT']);
    }

    // ── Init ──────────────────────────────────────────────────────────────
    init() {
        this._lockRootGestures();
        this._bindDigitalButtons();
        this._bindTriggers();
        this._bindSticks();
    }

    // ── Global gesture suppression ────────────────────────────────────────
    _lockRootGestures() {
        const root = document.documentElement;
        // Belt-and-suspenders: also set via JS in case CSS was not applied yet
        root.style.touchAction      = 'none';
        root.style.userSelect       = 'none';
        root.style.overscrollBehavior = 'none';
        document.body.style.touchAction = 'none';
        document.body.style.overscrollBehavior = 'none';
    }

    // ── Digital Buttons ───────────────────────────────────────────────────
    _bindDigitalButtons() {
        document.querySelectorAll('[data-button]').forEach(el => {
            const name = el.dataset.button;
            const mask = BUTTON_MASKS[name];
            if (mask === undefined) return;

            const rollable = this._ROLLABLE.has(name);

            // pointerdown — initial press
            el.addEventListener('pointerdown', e => {
                e.preventDefault(); e.stopPropagation();
                this._pressButton(e.pointerId, name, mask, el);
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
        const zone = document.getElementById(zoneId);
        const nub  = document.getElementById(nubId);
        if (!zone || !nub) return;

        zone.addEventListener('pointerdown', e => {
            e.preventDefault(); e.stopPropagation();
            if (this._stickPtrs.has(side)) return;   // second finger ignored

            const rect = zone.getBoundingClientRect();
            try { zone.setPointerCapture(e.pointerId); } catch (_) {}

            this._stickPtrs.set(side, {
                pointerId: e.pointerId,
                originX: rect.left + rect.width  / 2,
                originY: rect.top  + rect.height / 2,
                nub,
            });
            zone.classList.add('active');
            this._moveStick(side, e.clientX, e.clientY);
        }, { passive: false });

        zone.addEventListener('pointermove', e => {
            const st = this._stickPtrs.get(side);
            if (!st || st.pointerId !== e.pointerId) return;
            e.preventDefault(); e.stopPropagation();
            this._moveStick(side, e.clientX, e.clientY);
        }, { passive: false });

        const up = e => {
            const st = this._stickPtrs.get(side);
            if (!st || st.pointerId !== e.pointerId) return;
            e.preventDefault(); e.stopPropagation();
            this._stickPtrs.delete(side);
            zone.classList.remove('active');
            nub.style.transform = 'translate3d(0px,0px,0px)';
            if (side === 'left') { this.lx = 0; this.ly = 0; }
            else                 { this.rx = 0; this.ry = 0; }
        };
        zone.addEventListener('pointerup',          up, { passive: false });
        zone.addEventListener('pointercancel',       up, { passive: false });
        zone.addEventListener('lostpointercapture',  up, { passive: false });
    }

    _moveStick(side, clientX, clientY) {
        const st = this._stickPtrs.get(side);
        if (!st) return;

        const dx  = clientX - st.originX;
        const dy  = clientY - st.originY;
        const len = Math.hypot(dx, dy);
        const maxR = this.MAX_STICK_PX;

        // Hard radial clamp — nub never overflows the socket
        const scale  = len > maxR ? maxR / len : 1;
        const cx = dx * scale;
        const cy = dy * scale;

        st.nub.style.transform = `translate3d(${cx.toFixed(1)}px,${cy.toFixed(1)}px,0px)`;

        // Deadzone: map [0, maxR] → [0, 1], suppress values below DEADZONE
        const norm = Math.min(len / maxR, 1.0);
        if (norm < this.DEADZONE) {
            if (side === 'left') { this.lx = 0; this.ly = 0; }
            else                 { this.rx = 0; this.ry = 0; }
            return;
        }

        // Smooth linear rescale past deadzone
        const mag   = (norm - this.DEADZONE) / (1.0 - this.DEADZONE);
        const angle = Math.atan2(dy, dx);

        // Clamp to signed 16-bit range; invert Y so "up" is positive
        const ix = Math.round(Math.cos(angle) * mag * 32767);
        const iy = Math.round(-Math.sin(angle) * mag * 32767);

        if (side === 'left') {
            this.lx = Math.max(-32768, Math.min(32767, ix));
            this.ly = Math.max(-32768, Math.min(32767, iy));
        } else {
            this.rx = Math.max(-32768, Math.min(32767, ix));
            this.ry = Math.max(-32768, Math.min(32767, iy));
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
        this.buttons = 0;
        this.lx = 0; this.ly = 0;
        this.rx = 0; this.ry = 0;
        this.lt = 0; this.rt = 0;
        this._ptrToButtons.clear();
        this._btnToPtr.clear();
        this._triggerPtrs.clear();
        // Reset stick nubs visually
        for (const [, st] of this._stickPtrs) {
            st.nub.style.transform = 'translate3d(0px,0px,0px)';
        }
        this._stickPtrs.clear();
        // Clear active class from all interactive elements
        document.querySelectorAll('[data-button].active, .trigger-paddle.active, .stick-well.active')
            .forEach(el => el.classList.remove('active'));
    }
}

// Global singleton
window.TouchEngine = new TouchEngine();
