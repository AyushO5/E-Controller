/**
 * Haptic Engine — Checkpoint 3
 *
 * Micro-haptics (pointerdown pulses) + bidirectional Host→Client rumble receiver.
 *
 * Platform notes:
 *  - Android Chrome: full navigator.vibrate() support
 *  - iOS Safari: navigator.vibrate is undefined — all calls are silent no-ops
 *  - Rumble throttle: navigator.vibrate() fires at most once per 50ms to
 *    prevent mobile browser vibration-queue lockups
 */
class HapticEngine {
    constructor() {
        /** True only when navigator.vibrate is callable (Android Chrome, Firefox) */
        this.supported = typeof navigator !== 'undefined' &&
                         typeof navigator.vibrate === 'function';
        this.enabled   = true;

        // Rumble throttle state
        this._lastRumbleAt = 0;
        this._RUMBLE_THROTTLE_MS = 50;
    }

    // ── Micro-haptic pulses ───────────────────────────────────────────────

    /**
     * Sharp micro-haptic on pointerdown.
     * @param {'click'|'dpad'|'heavy'|'trigger'} type
     */
    pulse(type = 'click') {
        if (!this.supported || !this.enabled) return;
        try {
            switch (type) {
                case 'click':   navigator.vibrate(12); break;  // face buttons
                case 'dpad':    navigator.vibrate(8);  break;  // d-pad ticks
                case 'heavy':   navigator.vibrate(25); break;  // bumpers / sticks
                case 'trigger': navigator.vibrate(18); break;  // LT / RT
                default:        navigator.vibrate(10); break;
            }
        } catch (_) { /* browser policy block — silent */ }
    }

    // ── Host → Client rumble receiver ─────────────────────────────────────

    /**
     * Handle a rumble packet pushed from the host.
     * Binary frame [0x02, low_freq, high_freq, player_id] is decoded by app.js
     * into a plain object before being passed here.
     *
     * @param {{ lowFreq?: number, highFreq?: number,
     *           duration?: number,
     *           weak?: number, strong?: number }} data
     */
    receiveRumble(data) {
        if (!this.supported || !this.enabled) return;

        // Throttle: ignore if we fired a vibration within the last 50ms
        const now = performance.now();
        if (now - this._lastRumbleAt < this._RUMBLE_THROTTLE_MS) return;

        // Accept both the new binary-decoded fields (lowFreq/highFreq)
        // and the legacy JSON fields (weak/strong) for backwards compat.
        const lowFreq  = data.lowFreq  ?? data.weak   ?? 0;   // [0, 1] or [0, 255]
        const highFreq = data.highFreq ?? data.strong  ?? 0;
        // Normalise to [0, 1] — binary path sends raw 0–255 bytes
        const lo = lowFreq  > 1 ? lowFreq  / 255 : lowFreq;
        const hi = highFreq > 1 ? highFreq / 255 : highFreq;

        if (lo === 0 && hi === 0) {
            try { navigator.vibrate(0); } catch (_) {}
            return;
        }

        const duration = Math.min(Math.max(data.duration ?? 100, 20), 1000);

        try {
            if (hi > 0.5) {
                // Strong motor — solid burst
                navigator.vibrate(duration);
            } else if (lo > 0.1) {
                // Weak (high-frequency) motor — rapid pulse pattern
                // e.g. duration=200 → [15,15,15,15,15,15,…] on/off pairs
                const on  = 15;
                const off = 15;
                const reps = Math.min(Math.ceil(duration / (on + off)), 20);
                const pattern = [];
                for (let i = 0; i < reps; i++) {
                    pattern.push(on);
                    if (i < reps - 1) pattern.push(off);
                }
                navigator.vibrate(pattern);
            } else {
                navigator.vibrate(Math.min(duration, 40));
            }
            this._lastRumbleAt = performance.now();
        } catch (_) {}
    }

    setEnabled(val) {
        this.enabled = Boolean(val);
        if (!this.enabled) {
            try { navigator.vibrate?.(0); } catch (_) {}
        }
    }
}

// Global singleton
window.Haptics = new HapticEngine();
