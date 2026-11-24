"""
Low-latency Gamepad Binary Protocol Parser & Per-Client Watchdog
Wire format (Checkpoint 2): 16-byte Little-Endian fixed frame

Byte Layout:
  [0]     uint8   msg_type   0x01 = input frame, 0x00 = neutral/keep-alive
  [1]     uint8   seq_num    0–255, wraps around
  [2-3]   uint16  buttons    bitmask (LE)
  [4-5]   int16   lx         left stick X  [-32768, 32767] (LE)
  [6-7]   int16   ly         left stick Y  [-32768, 32767] (LE)
  [8-9]   int16   rx         right stick X [-32768, 32767] (LE)
  [10-11] int16   ry         right stick Y [-32768, 32767] (LE)
  [12]    uint8   l2         left trigger  [0, 255]
  [13]    uint8   r2         right trigger [0, 255]
  [14-15] uint16  reserved   must be 0x0000

Total: 16 bytes
"""

import asyncio
import struct
import time
from dataclasses import dataclass
from enum import Enum, auto
from typing import Callable, List, Optional

# -----------------------------------------------------------------------------
# Wire format constants
# -----------------------------------------------------------------------------
PACKET_FORMAT = "<BBHhhhhBBH"
PACKET_SIZE   = struct.calcsize(PACKET_FORMAT)   # 16 bytes

MSG_TYPE_INPUT   = 0x01   # normal input frame
MSG_TYPE_NEUTRAL = 0x00   # explicit neutral / keep-alive (client suspended)

assert PACKET_SIZE == 16, f"Unexpected packet size: {PACKET_SIZE}"


# -----------------------------------------------------------------------------
# Button bitmasks — matches standard Xbox 360 layout
# -----------------------------------------------------------------------------
class ButtonMask:
    A       = 1 << 0
    B       = 1 << 1
    X       = 1 << 2
    Y       = 1 << 3
    LB      = 1 << 4
    RB      = 1 << 5
    BACK    = 1 << 6
    START   = 1 << 7
    GUIDE   = 1 << 8
    THUMBL  = 1 << 9    # L3
    THUMBR  = 1 << 10   # R3
    DPAD_UP    = 1 << 11
    DPAD_DOWN  = 1 << 12
    DPAD_LEFT  = 1 << 13
    DPAD_RIGHT = 1 << 14

BUTTON_NAMES = {
    ButtonMask.A:          "A",
    ButtonMask.B:          "B",
    ButtonMask.X:          "X",
    ButtonMask.Y:          "Y",
    ButtonMask.LB:         "LB",
    ButtonMask.RB:         "RB",
    ButtonMask.BACK:       "BACK",
    ButtonMask.START:      "START",
    ButtonMask.GUIDE:      "GUIDE",
    ButtonMask.THUMBL:     "THUMBL",
    ButtonMask.THUMBR:     "THUMBR",
    ButtonMask.DPAD_UP:    "DPAD_UP",
    ButtonMask.DPAD_DOWN:  "DPAD_DOWN",
    ButtonMask.DPAD_LEFT:  "DPAD_LEFT",
    ButtonMask.DPAD_RIGHT: "DPAD_RIGHT",
}


# -----------------------------------------------------------------------------
# GamepadState dataclass
# -----------------------------------------------------------------------------
@dataclass
class GamepadState:
    sequence: int = 0
    buttons:  int = 0
    lx: int = 0
    ly: int = 0
    rx: int = 0
    ry: int = 0
    lt: int = 0   # l2 in wire format
    rt: int = 0   # r2 in wire format

    def is_pressed(self, mask: int) -> bool:
        return bool(self.buttons & mask)

    def pressed_button_names(self) -> List[str]:
        return [name for mask, name in BUTTON_NAMES.items() if self.buttons & mask]

    @classmethod
    def neutral(cls) -> "GamepadState":
        return cls()

    def __repr__(self) -> str:
        btns = ",".join(self.pressed_button_names()) or "None"
        return (
            f"GamepadState(seq={self.sequence}, btns=[{btns}], "
            f"L=({self.lx},{self.ly}), R=({self.rx},{self.ry}), "
            f"LT={self.lt}, RT={self.rt})"
        )


# -----------------------------------------------------------------------------
# WatchdogState — per-client stream health
# -----------------------------------------------------------------------------
class WatchdogState(Enum):
    ACTIVE = auto()   # frames arriving on time
    STALE  = auto()   # no frame within 250ms → driver zeroed
    STOPPED = auto()  # watchdog shut down (client disconnected)


# -----------------------------------------------------------------------------
# ProtocolParser — 16-byte frame unpacker with 8-bit wrap-around seq guard
# -----------------------------------------------------------------------------
class ProtocolParser:
    """Unpacks the new 16-byte wire frames and enforces 8-bit sequence ordering."""

    def __init__(self):
        self.last_seq: Optional[int] = None
        self.total_received:  int = 0
        self.total_dropped:   int = 0

    def unpack(self, data: bytes) -> Optional[GamepadState]:
        """
        Unpack raw bytes → GamepadState.
        Returns None for wrong length, bad msg_type, or out-of-order sequence.
        """
        if len(data) != PACKET_SIZE:
            return None

        msg_type, seq, btns, lx, ly, rx, ry, l2, r2, _reserved = \
            struct.unpack(PACKET_FORMAT, data)

        self.total_received += 1

        # Explicit neutral frame from suspended client — reset & don't apply
        if msg_type == MSG_TYPE_NEUTRAL:
            self.last_seq = seq   # still advance sequence window
            return None           # caller should call driver.reset() separately

        if msg_type != MSG_TYPE_INPUT:
            return None   # unknown msg_type, drop silently

        # 8-bit wrap-around sequence guard: (new - old) & 0xFF < 128 ⟹ newer
        if not self._is_seq_valid(seq):
            self.total_dropped += 1
            return None

        self.last_seq = seq
        return GamepadState(
            sequence=seq,
            buttons=btns,
            lx=lx,
            ly=ly,
            rx=rx,
            ry=ry,
            lt=l2,
            rt=r2,
        )

    def _is_seq_valid(self, seq: int) -> bool:
        if self.last_seq is None:
            return True
        diff = (seq - self.last_seq) & 0xFF
        # diff == 0 → duplicate; diff >= 128 → older/reordered → both drop
        return 0 < diff < 128

    def is_neutral_frame(self, data: bytes) -> bool:
        """Cheap check: returns True if the frame is a client-sent neutral (0x00 msg_type)."""
        return len(data) == PACKET_SIZE and data[0] == MSG_TYPE_NEUTRAL

    def reset(self):
        self.last_seq = None


# -----------------------------------------------------------------------------
# Watchdog — 250ms per-client stale detector
# -----------------------------------------------------------------------------
class Watchdog:
    """
    Per-client async watchdog.
    Transitions to STALE and fires on_stale() if no frame arrives within
    timeout_seconds (default 0.25 s).  Recovers automatically on next feed().
    """

    TIMEOUT_SECONDS = 0.25   # 250 ms

    def __init__(
        self,
        on_stale:     Optional[Callable[[], None]] = None,
        on_recovered: Optional[Callable[[], None]] = None,
        timeout_seconds: float = TIMEOUT_SECONDS,
    ):
        self.timeout_seconds = timeout_seconds
        self.on_stale     = on_stale
        self.on_recovered = on_recovered

        self._state = WatchdogState.STOPPED
        self._last_feed = time.monotonic()
        self._task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    @property
    def state(self) -> WatchdogState:
        return self._state

    # ------------------------------------------------------------------
    def start(self):
        self._state = WatchdogState.ACTIVE
        self._last_feed = time.monotonic()
        self._task = asyncio.create_task(self._loop(), name="watchdog")

    def feed(self):
        """Call this every time a valid (non-neutral) frame is received."""
        self._last_feed = time.monotonic()
        if self._state == WatchdogState.STALE:
            self._state = WatchdogState.ACTIVE
            if self.on_recovered:
                try:
                    self.on_recovered()
                except Exception as exc:
                    print(f"[Watchdog] on_recovered error: {exc}")

    def stop(self):
        self._state = WatchdogState.STOPPED
        if self._task and not self._task.done():
            self._task.cancel()

    # ------------------------------------------------------------------
    async def _loop(self):
        # Poll at half the timeout period for timely detection
        poll_interval = self.timeout_seconds / 2
        while self._state != WatchdogState.STOPPED:
            await asyncio.sleep(poll_interval)
            if self._state == WatchdogState.STOPPED:
                break

            idle = time.monotonic() - self._last_feed
            if idle >= self.timeout_seconds and self._state == WatchdogState.ACTIVE:
                self._state = WatchdogState.STALE
                print(
                    f"[Watchdog] STALE — no frame for {idle*1000:.0f}ms. "
                    f"Zeroing gamepad."
                )
                if self.on_stale:
                    try:
                        self.on_stale()
                    except Exception as exc:
                        print(f"[Watchdog] on_stale error: {exc}")
