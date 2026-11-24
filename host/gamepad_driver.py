"""
OS Gamepad Driver Abstraction Layer — Checkpoint 4 (Fixed)

Supports:
  - Linux   : native kernel uinput device (Xbox 360 controller) via evdev.
              Includes try/except fallback for kernels that reject FF_RUMBLE,
              ensuring standard Xbox 360 gamepad creation always succeeds.
              Never calls event_dev.grab() so games receive input uninhibited.
  - Windows : ViGEmBus virtual controller via vgamepad with rumble notification.
  - Fallback: MockGamepadDriver for headless/permission-restricted environments.

Includes ensure_initialized() for re-activation on client handshake.
"""

import asyncio
import logging
import platform
from abc import ABC, abstractmethod
from typing import Callable, Dict, Optional

from protocol import ButtonMask, BUTTON_NAMES, GamepadState

logger = logging.getLogger("GamepadDriver")

RumbleCallback = Optional[Callable[[int, int], None]]   # (low_freq, high_freq)


class BaseGamepadDriver(ABC):
    """Abstract base for all OS virtual gamepad drivers."""

    def __init__(self):
        self.is_mock: bool = False
        self.device_name: str = "Unknown"
        self._prev_state: GamepadState = GamepadState.neutral()
        self.on_rumble: RumbleCallback = None
        self._rumble_loop: Optional[asyncio.AbstractEventLoop] = None

    @abstractmethod
    def update(self, state: GamepadState): ...

    @abstractmethod
    def reset(self): ...

    @abstractmethod
    def close(self): ...

    def ensure_initialized(self):
        """Ensure the underlying virtual device is instantiated and ready."""
        pass

    def set_rumble_callback(
        self,
        cb: RumbleCallback,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ):
        """Register a callback invoked when force feedback occurs."""
        self.on_rumble = cb
        if loop is not None:
            self._rumble_loop = loop
        else:
            try:
                self._rumble_loop = asyncio.get_running_loop()
            except RuntimeError:
                self._rumble_loop = None

    def _fire_rumble(self, low: int, high: int):
        """Call on_rumble thread-safely across worker threads and event loops."""
        if self.on_rumble is None:
            return
        target_loop = self._rumble_loop
        if target_loop is not None and not target_loop.is_closed() and target_loop.is_running():
            target_loop.call_soon_threadsafe(self.on_rumble, low, high)
            return
        try:
            running_loop = asyncio.get_running_loop()
            running_loop.call_soon_threadsafe(self.on_rumble, low, high)
        except RuntimeError:
            self.on_rumble(low, high)


# ---------------------------------------------------------------------------
# Mock driver
# ---------------------------------------------------------------------------
class MockGamepadDriver(BaseGamepadDriver):
    """Console-logging mock driver with test rumble support."""

    def __init__(self, reason: str = ""):
        super().__init__()
        self.is_mock = True
        self.device_name = "Mock Gamepad (Console Logging)"
        print(f"[GamepadDriver] MOCK — {reason or 'User requested'}")

    def ensure_initialized(self):
        self.reset()

    def update(self, state: GamepadState):
        prev = self._prev_state
        for mask, name in BUTTON_NAMES.items():
            now, was = state.is_pressed(mask), prev.is_pressed(mask)
            if now and not was:
                print(f"[OS Gamepad Event] Button {name} -> PRESSED")
            elif not now and was:
                print(f"[OS Gamepad Event] Button {name} -> RELEASED")
        if state.lt != prev.lt:
            print(f"[OS Gamepad Event] Left Trigger  -> {state.lt}/255")
        if state.rt != prev.rt:
            print(f"[OS Gamepad Event] Right Trigger -> {state.rt}/255")
        if abs(state.lx - prev.lx) > 1000 or abs(state.ly - prev.ly) > 1000:
            print(f"[OS Gamepad Event] Left Stick  X:{state.lx:6d} Y:{state.ly:6d}")
        if abs(state.rx - prev.rx) > 1000 or abs(state.ry - prev.ry) > 1000:
            print(f"[OS Gamepad Event] Right Stick X:{state.rx:6d} Y:{state.ry:6d}")
        self._prev_state = state

    def reset(self):
        print("[OS Gamepad Event] Resetting all controls to neutral.")
        self.update(GamepadState.neutral())

    def emit_test_rumble(self, low: int = 128, high: int = 64):
        print(f"[OS Gamepad Rumble] low={low} high={high} (synthetic)")
        self._fire_rumble(low, high)

    def close(self):
        print("[OS Gamepad Event] Closing mock driver.")


# ---------------------------------------------------------------------------
# Linux — evdev uinput with graceful FF_RUMBLE fallback
# ---------------------------------------------------------------------------
class LinuxUInputGamepad(BaseGamepadDriver):
    """
    Native Linux virtual Xbox 360 controller.
    Wraps FF_RUMBLE setup in a try/except fallback so that if uinput rejects
    rumble capabilities on this kernel, it cleanly falls back to initializing
    a standard Xbox 360 gamepad without rumble.
    Never grabs the device exclusively so games and OS testers read it cleanly.
    """

    def __init__(self):
        super().__init__()
        import evdev
        from evdev import AbsInfo, ecodes

        self.ecodes = ecodes
        self.evdev = evdev
        self.device = None
        self.has_rumble = False
        self._rumble_task: Optional[asyncio.Task] = None
        self._rumble_running = False

        self.button_map: Dict[int, int] = {
            ButtonMask.A:          ecodes.BTN_SOUTH,
            ButtonMask.B:          ecodes.BTN_EAST,
            ButtonMask.X:          ecodes.BTN_NORTH,
            ButtonMask.Y:          ecodes.BTN_WEST,
            ButtonMask.LB:         ecodes.BTN_TL,
            ButtonMask.RB:         ecodes.BTN_TR,
            ButtonMask.BACK:       ecodes.BTN_SELECT,
            ButtonMask.START:      ecodes.BTN_START,
            ButtonMask.GUIDE:      ecodes.BTN_MODE,
            ButtonMask.THUMBL:     ecodes.BTN_THUMBL,
            ButtonMask.THUMBR:     ecodes.BTN_THUMBR,
            ButtonMask.DPAD_UP:    ecodes.BTN_DPAD_UP,
            ButtonMask.DPAD_DOWN:  ecodes.BTN_DPAD_DOWN,
            ButtonMask.DPAD_LEFT:  ecodes.BTN_DPAD_LEFT,
            ButtonMask.DPAD_RIGHT: ecodes.BTN_DPAD_RIGHT,
        }

        self._init_device()

    def _init_device(self):
        """Initialize uinput with FF_RUMBLE fallback to standard Xbox 360 pad."""
        ecodes = self.ecodes
        evdev = self.evdev
        AbsInfo = evdev.AbsInfo

        abs_caps = [
            (ecodes.ABS_X,     AbsInfo(0, -32768, 32767, 16, 128, 0)),
            (ecodes.ABS_Y,     AbsInfo(0, -32768, 32767, 16, 128, 0)),
            (ecodes.ABS_RX,    AbsInfo(0, -32768, 32767, 16, 128, 0)),
            (ecodes.ABS_RY,    AbsInfo(0, -32768, 32767, 16, 128, 0)),
            (ecodes.ABS_Z,     AbsInfo(0, 0,      255,   0,  0,   0)),
            (ecodes.ABS_RZ,    AbsInfo(0, 0,      255,   0,  0,   0)),
            (ecodes.ABS_HAT0X, AbsInfo(0, -1,     1,     0,  0,   0)),
            (ecodes.ABS_HAT0Y, AbsInfo(0, -1,     1,     0,  0,   0)),
        ]

        base_caps = {
            ecodes.EV_KEY: list(self.button_map.values()),
            ecodes.EV_ABS: abs_caps,
        }

        # Step 1: Try creating with EV_FF (FF_RUMBLE)
        device = None
        has_rumble = False
        try:
            ff_caps = dict(base_caps)
            ff_caps[ecodes.EV_FF] = [ecodes.FF_RUMBLE]
            device = evdev.UInput(
                events=ff_caps,
                name="Microsoft X-Box 360 pad",
                vendor=0x045E, product=0x028E, version=0x0114,
            )
            has_rumble = True
            print(f"[GamepadDriver] Created native device with rumble: {device.name} ({device.device.path})")
        except Exception as exc:
            # Fall back to standard Xbox 360 controller without rumble
            print(f"[GamepadDriver] uinput rejected FF_RUMBLE ({exc}). Falling back to standard gamepad.")
            try:
                device = evdev.UInput(
                    events=base_caps,
                    name="Microsoft X-Box 360 pad",
                    vendor=0x045E, product=0x028E, version=0x0114,
                )
                has_rumble = False
                print(f"[GamepadDriver] Created native device (no rumble): {device.name} ({device.device.path})")
            except Exception as e2:
                raise e2

        self.device = device
        self.has_rumble = has_rumble
        self.device_name = f"Linux uinput: {self.device.name} ({self.device.device.path})"

        # Start rumble reader only if rumble capability succeeded
        if self.has_rumble:
            try:
                loop = asyncio.get_running_loop()
                self._start_rumble_reader()
            except RuntimeError:
                pass

    def ensure_initialized(self):
        """Ensure the uinput device is ready."""
        if self.device is None:
            self._init_device()
        self.reset()

    def _start_rumble_reader(self):
        if not self.has_rumble or self.device is None:
            return
        if self._rumble_task and not self._rumble_task.done():
            return
        self._rumble_running = True
        self._rumble_task = asyncio.create_task(
            self._rumble_read_loop(), name="uinput-rumble-reader"
        )

    async def _rumble_read_loop(self):
        """Non-exclusive reader for force-feedback events."""
        if not self.has_rumble or self.device is None:
            return
        try:
            event_dev = self.evdev.InputDevice(self.device.device.path)
            # NEVER call event_dev.grab()! Grab locks out the OS and games.
        except Exception as e:
            logger.debug("Cannot open event device for rumble reading: %s", e)
            return

        try:
            async for event in event_dev.async_read_loop():
                if not self._rumble_running:
                    break
                if event.type == self.ecodes.EV_FF:
                    low = event.value & 0xFF
                    high = (event.value >> 8) & 0xFF
                    self._fire_rumble(low, high)
        except (asyncio.CancelledError, GeneratorExit):
            pass
        except Exception:
            pass
        finally:
            try:
                event_dev.close()
            except Exception:
                pass

    def update(self, state: GamepadState):
        if self.device is None:
            self.ensure_initialized()

        ecodes = self.ecodes
        prev = self._prev_state
        dev = self.device

        for mask, code in self.button_map.items():
            now = state.is_pressed(mask)
            if now != prev.is_pressed(mask):
                dev.write(ecodes.EV_KEY, code, 1 if now else 0)

        if state.lx != prev.lx: dev.write(ecodes.EV_ABS, ecodes.ABS_X,  state.lx)
        if state.ly != prev.ly: dev.write(ecodes.EV_ABS, ecodes.ABS_Y,  max(-32768, min(32767, -state.ly)))
        if state.rx != prev.rx: dev.write(ecodes.EV_ABS, ecodes.ABS_RX, state.rx)
        if state.ry != prev.ry: dev.write(ecodes.EV_ABS, ecodes.ABS_RY, max(-32768, min(32767, -state.ry)))
        if state.lt != prev.lt: dev.write(ecodes.EV_ABS, ecodes.ABS_Z,  state.lt)
        if state.rt != prev.rt: dev.write(ecodes.EV_ABS, ecodes.ABS_RZ, state.rt)

        hat_x = (1 if state.is_pressed(ButtonMask.DPAD_RIGHT) else
                 -1 if state.is_pressed(ButtonMask.DPAD_LEFT) else 0)
        hat_y = (1 if state.is_pressed(ButtonMask.DPAD_DOWN) else
                 -1 if state.is_pressed(ButtonMask.DPAD_UP) else 0)
        phx   = (1 if prev.is_pressed(ButtonMask.DPAD_RIGHT) else
                 -1 if prev.is_pressed(ButtonMask.DPAD_LEFT) else 0)
        phy   = (1 if prev.is_pressed(ButtonMask.DPAD_DOWN) else
                 -1 if prev.is_pressed(ButtonMask.DPAD_UP) else 0)

        if hat_x != phx: dev.write(ecodes.EV_ABS, ecodes.ABS_HAT0X, hat_x)
        if hat_y != phy: dev.write(ecodes.EV_ABS, ecodes.ABS_HAT0Y, hat_y)

        dev.syn()
        self._prev_state = state

    def reset(self):
        if self.device is not None:
            self.update(GamepadState.neutral())

    def close(self):
        self._rumble_running = False
        if self._rumble_task and not self._rumble_task.done():
            self._rumble_task.cancel()
        if self.device is not None:
            try:
                self.reset()
                self.device.close()
                print("[GamepadDriver] Linux uinput closed.")
            except Exception as e:
                print(f"[GamepadDriver] Error closing uinput: {e}")
            finally:
                self.device = None


# ---------------------------------------------------------------------------
# Windows — vgamepad with notification callback
# ---------------------------------------------------------------------------
class WindowsVGamepad(BaseGamepadDriver):
    """Windows ViGEmBus virtual Xbox 360 controller with rumble notification."""

    def __init__(self):
        super().__init__()
        import vgamepad as vg
        self.vg = vg
        self.gamepad = None
        self.device_name = "Windows ViGEmBus: Xbox 360 Gamepad"

        self.button_map = {
            ButtonMask.A:          vg.XUSB_BUTTON.XUSB_GAMEPAD_A,
            ButtonMask.B:          vg.XUSB_BUTTON.XUSB_GAMEPAD_B,
            ButtonMask.X:          vg.XUSB_BUTTON.XUSB_GAMEPAD_X,
            ButtonMask.Y:          vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,
            ButtonMask.LB:         vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
            ButtonMask.RB:         vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
            ButtonMask.BACK:       vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,
            ButtonMask.START:      vg.XUSB_BUTTON.XUSB_GAMEPAD_START,
            ButtonMask.GUIDE:      vg.XUSB_BUTTON.XUSB_GAMEPAD_GUIDE,
            ButtonMask.THUMBL:     vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB,
            ButtonMask.THUMBR:     vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB,
            ButtonMask.DPAD_UP:    vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,
            ButtonMask.DPAD_DOWN:  vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
            ButtonMask.DPAD_LEFT:  vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,
            ButtonMask.DPAD_RIGHT: vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
        }

        self._init_gamepad()

    def _init_gamepad(self):
        self.gamepad = self.vg.VX360Gamepad()
        try:
            self.gamepad.register_notification(callback=self._rumble_cb)
        except Exception:
            pass
        print(f"[GamepadDriver] Created: {self.device_name}")

    def ensure_initialized(self):
        if self.gamepad is None:
            self._init_gamepad()
        self.reset()

    def _rumble_cb(self, client, target, large_motor, small_motor, led_number, user_data):
        self._fire_rumble(int(large_motor), int(small_motor))

    def update(self, state: GamepadState):
        if self.gamepad is None:
            self.ensure_initialized()

        pad = self.gamepad
        prev = self._prev_state
        for mask, btn in self.button_map.items():
            now = state.is_pressed(mask)
            if now != prev.is_pressed(mask):
                pad.press_button(btn) if now else pad.release_button(btn)
        pad.left_joystick(x_value=state.lx, y_value=state.ly)
        pad.right_joystick(x_value=state.rx, y_value=state.ry)
        pad.left_trigger(value=state.lt)
        pad.right_trigger(value=state.rt)
        pad.update()
        self._prev_state = state

    def reset(self):
        if self.gamepad is not None:
            self.gamepad.reset()
            self.gamepad.update()
            self._prev_state = GamepadState.neutral()

    def close(self):
        if self.gamepad is not None:
            try:
                self.gamepad.unregister_notification()
            except Exception:
                pass
            try:
                self.reset()
                del self.gamepad
                print("[GamepadDriver] Windows vgamepad released.")
            except Exception as e:
                print(f"[GamepadDriver] Error closing vgamepad: {e}")
            finally:
                self.gamepad = None


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------
def create_gamepad_driver(force_mock: bool = False) -> BaseGamepadDriver:
    if force_mock:
        return MockGamepadDriver("--mock flag")

    os_name = platform.system()

    if os_name == "Linux":
        try:
            return LinuxUInputGamepad()
        except PermissionError:
            print("\n" + "=" * 68)
            print("[WARNING] /dev/uinput not writable. Add a persistent udev rule:")
            print("  echo 'KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\"' \\")
            print("    | sudo tee /etc/udev/rules.d/50-uinput.rules")
            print("  sudo udevadm control --reload-rules && sudo udevadm trigger")
            print("  sudo usermod -aG input $USER   # then log out and back in")
            print("Falling back to MOCK driver.")
            print("=" * 68 + "\n")
            return MockGamepadDriver("PermissionError on /dev/uinput")
        except Exception as exc:
            print(f"[WARNING] uinput init failed ({exc}). Using MOCK driver.")
            return MockGamepadDriver(str(exc))

    elif os_name == "Windows":
        try:
            return WindowsVGamepad()
        except ImportError:
            print("\n" + "=" * 68)
            print("[WARNING] vgamepad / ViGEmBus not found. To install:")
            print("  1. ViGEmBus: https://github.com/nefarius/ViGEmBus/releases")
            print("  2. pip install vgamepad")
            print("Falling back to MOCK driver.")
            print("=" * 68 + "\n")
            return MockGamepadDriver("vgamepad not installed")
        except Exception as exc:
            print(f"[WARNING] vgamepad init failed ({exc}). Using MOCK driver.")
            return MockGamepadDriver(str(exc))

    else:
        print(f"[INFO] OS '{os_name}' has no native driver. Using MOCK.")
        return MockGamepadDriver(f"Unsupported OS: {os_name}")
