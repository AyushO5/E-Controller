#!/usr/bin/env python3
"""
Virtual Gamepad PC Host Daemon
CLI entry point, startup pre-flight checks, LAN IP detection,
terminal QR code generation, and server orchestration.
"""

import argparse
import asyncio
import gc
import importlib
import ipaddress
import os
import re
import signal
import socket
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

import qrcode

from gamepad_driver import create_gamepad_driver
from server import ControllerServer, build_static_process_request
from tls_certs import build_ssl_context, ensure_lan_certificate

VIGEM_URL = "https://github.com/nefarius/ViGEmBus/releases"
UDEV_RULE_CMD = (
    "echo 'KERNEL==\"uinput\", MODE=\"0660\", GROUP=\"input\", OPTIONS+=\"static_node=uinput\"' "
    "| sudo tee /etc/udev/rules.d/99-uinput.rules "
    "&& sudo udevadm control --reload-rules && sudo udevadm trigger"
)


# ---------------------------------------------------------------------------
# Error box helper (clean messages, never a stack trace)
# ---------------------------------------------------------------------------
def _print_error_box(title: str, lines: List[str]) -> None:
    print("\n" + "=" * 68)
    print(f"  [ERROR] {title}")
    print("-" * 68)
    for line in lines:
        print(f"  {line}")
    print("=" * 68 + "\n")


# ---------------------------------------------------------------------------
# 1. OS gamepad driver & permission pre-flight
# ---------------------------------------------------------------------------
def verify_driver_preflight(force_mock: bool = False) -> str:
    """Validate the OS virtual-gamepad stack. Returns a short label, or exits with a clear message."""
    if force_mock:
        return "Mock Gamepad (--mock)"

    if sys.platform == "win32":
        try:
            vg = importlib.import_module("vgamepad")
        except ImportError:
            _print_error_box("vgamepad is not installed", [
                "Install it with:",
                "    pip install vgamepad",
            ])
            sys.exit(1)

        test_pad = None
        try:
            test_pad = vg.VX360Gamepad()
        except Exception as exc:
            _print_error_box("ViGEmBus driver is missing or failed to initialize", [
                f"Details: {exc}",
                "Install the ViGEmBus driver from:",
                f"    {VIGEM_URL}",
                "Reboot your PC after installing, then start E-Controller again.",
            ])
            sys.exit(1)
        finally:
            # Free the test handle immediately so player slot P1 stays available
            if test_pad is not None:
                try:
                    test_pad.reset()
                    test_pad.update()
                except Exception:
                    pass
                del test_pad
            gc.collect()
        return "ViGEmBus (XInput)"

    if sys.platform.startswith("linux"):
        try:
            evdev = importlib.import_module("evdev")
        except ImportError:
            _print_error_box("evdev is not installed", [
                "Install it with:",
                "    pip install evdev",
            ])
            sys.exit(1)

        if not os.path.exists("/dev/uinput"):
            _print_error_box("/dev/uinput not found", [
                "Load the uinput kernel module with:",
                "    sudo modprobe uinput",
            ])
            sys.exit(1)

        if not os.access("/dev/uinput", os.R_OK | os.W_OK):
            _print_error_box("Permission denied on /dev/uinput", [
                "Quick test (resets on reboot):",
                "    sudo chmod 0666 /dev/uinput",
                "",
                "Permanent fix (udev rule):",
                f"    {UDEV_RULE_CMD}",
                "    sudo usermod -aG input $USER   # then log out and back in",
            ])
            sys.exit(1)

        test_dev = None
        try:
            test_dev = evdev.UInput(
                events={evdev.ecodes.EV_KEY: [evdev.ecodes.BTN_SOUTH]},
                name="E-Controller Preflight Check",
            )
        except Exception as exc:
            _print_error_box("Could not create a uinput test device", [
                f"Details: {exc}",
                "Check /dev/uinput permissions and that the uinput module is loaded.",
            ])
            sys.exit(1)
        finally:
            if test_dev is not None:
                try:
                    test_dev.close()
                except Exception:
                    pass
        return "/dev/uinput (evdev)"

    return "Mock Gamepad"


# ---------------------------------------------------------------------------
# 2. Network: smart LAN IP detection
# ---------------------------------------------------------------------------
_VIRTUAL_HINTS = (
    "wsl", "vethernet", "docker", "hyper-v", "vbox", "virtualbox", "vmware",
    "vmnet", "br-", "veth", "virbr", "tailscale", "loopback", "pseudo",
)


def _score_lan_candidate(ip_str: str, iface_hint: str = "", is_default_route: bool = False) -> Optional[int]:
    """Score an IPv4 candidate; None means unusable."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return None
    if ip.version != 4 or ip.is_loopback or ip.is_unspecified or ip.is_link_local \
            or ip.is_multicast or ip.is_reserved:
        return None

    octets = [int(o) for o in ip_str.split(".")]
    score = 0
    if octets[0] == 192 and octets[1] == 168:
        score += 60
    elif octets[0] == 10:
        score += 50
    elif octets[0] == 172 and 16 <= octets[1] <= 31:
        score += 30
    else:
        score += 5

    # Typical virtual-adapter ranges
    if (octets[0], octets[1]) == (192, 168) and octets[2] == 56:
        score -= 100
    if (octets[0], octets[1]) == (172, 17):
        score -= 100

    hint = iface_hint.lower()
    if any(h in hint for h in _VIRTUAL_HINTS):
        score -= 100
    elif any(h in hint for h in ("wi-fi", "wifi", "wlan", "wireless", "ethernet", "eth", "en0", "en1")):
        score += 20

    if is_default_route:
        score += 25
    return score


def _interface_candidates() -> List[Tuple[str, str]]:
    """Return (ip, interface_hint) pairs from the OS (best effort)."""
    found: List[Tuple[str, str]] = []
    try:
        if sys.platform == "win32":
            out = subprocess.run(["ipconfig"], capture_output=True, text=True, timeout=1.5).stdout
            adapter = ""
            for line in out.splitlines():
                if line and not line.startswith(" ") and line.rstrip().endswith(":"):
                    adapter = line.strip().rstrip(":")
                m = re.search(r"IPv4[^:]*:\s*([\d.]+)", line)
                if m:
                    found.append((m.group(1), adapter))
        elif sys.platform.startswith("linux"):
            out = subprocess.run(["ip", "-o", "-4", "addr", "show", "up"],
                                 capture_output=True, text=True, timeout=1.5).stdout
            for line in out.splitlines():
                m = re.match(r"\d+:\s+(\S+)\s+inet\s+([\d.]+)", line)
                if m:
                    found.append((m.group(2), m.group(1)))
    except Exception:
        pass
    return found


def detect_lan_ip(override_ip: str = "") -> Tuple[str, bool]:
    """Return (ip, ok). ok is False when no usable Wi-Fi/LAN address was found."""
    if override_ip:
        return override_ip, _score_lan_candidate(override_ip) is not None

    candidates: dict = {}

    def add(ip: str, hint: str = "", default_route: bool = False):
        score = _score_lan_candidate(ip, hint, default_route)
        if score is not None and (ip not in candidates or score > candidates[ip]):
            candidates[ip] = score

    for probe in ("8.8.8.8", "1.1.1.1", "192.168.1.1", "10.0.0.1"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(0.5)
            s.connect((probe, 80))
            add(s.getsockname()[0], "", True)
            s.close()
        except Exception:
            pass

    for ip, hint in _interface_candidates():
        add(ip, hint)

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except Exception:
        pass

    if not candidates:
        return "127.0.0.1", False

    best_ip = max(candidates, key=candidates.get)
    return best_ip, True


def get_lan_ip() -> str:
    """Detect the machine's primary local area network (LAN) IPv4 address."""
    return detect_lan_ip()[0]


# ---------------------------------------------------------------------------
# 3. Port conflict pre-flight
# ---------------------------------------------------------------------------
def _port_in_use_box(label: str, port: int, flag: str, exc: Exception) -> None:
    _print_error_box(f"{label} port {port} is already in use", [
        "Another program (possibly an older E-Controller instance that is still running)",
        f"is occupying port {port}.",
        "Close it, or choose a different port with:",
        f"    {flag} <port>",
        f"Details: {exc}",
    ])


def verify_ports_preflight(bind_host: str, port: int, ws_port: Optional[int] = None) -> None:
    ports = [("Unified HTTP/WS", port, "--port")]
    if ws_port is not None and ws_port != port:
        ports = [("HTTP", port, "--http-port"), ("WebSocket", ws_port, "--ws-port")]

    for label, p, flag in ports:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE") and sys.platform == "win32":
                s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            elif sys.platform != "win32":
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((bind_host, p))
        except OSError as exc:
            _port_in_use_box(label, p, flag, exc)
            sys.exit(1)
        finally:
            s.close()


# ---------------------------------------------------------------------------
# 4. Startup banner
# ---------------------------------------------------------------------------
def print_banner(lan_ip: str, port: int, driver_name: str, is_mock: bool,
                 driver_label: str = "", lan_ok: Optional[bool] = None,
                 use_https: bool = False, cert_path: Optional[Path] = None):
    """Render terminal dashboard with pre-flight summary and single unified URL + QR code."""
    http_scheme = "https" if use_https else "http"
    ws_scheme = "wss" if use_https else "ws"
    url = f"{http_scheme}://{lan_ip}:{port}"
    ws_url = f"{ws_scheme}://{lan_ip}:{port}"
    proto_summary = f"{http_scheme.upper()} + {ws_scheme.upper()}"

    print("\n" + "═" * 68)
    print("   🎮  VIRTUAL GAMEPAD - MOBILE TO PC HOST DAEMON  🎮")
    print("═" * 68)
    print(f"  • Gamepad Driver : {driver_name}")
    if is_mock:
        print("    └─ [MOCK MODE] Inputs will log to console instead of OS device.")
        print("       (Run with `sudo chmod 666 /dev/uinput` for native OS gamepad)")
    else:
        print("    └─ [NATIVE MODE] Active OS-level virtual Xbox 360 controller.")
    print(f"  • Unified URL    : {url}")
    print(f"  • WebSocket      : {ws_url}  (same port)")
    print("─" * 68)

    # Compact pre-flight summary right above the QR code
    if driver_label:
        print(f"  [OK] Driver:  {driver_label}")
    if lan_ok is None or lan_ok:
        print(f"  [OK] Network: {lan_ip}:{port} ({proto_summary} unified single-port)")
    else:
        print(f"  [WARN] Network: {lan_ip} — No active Wi-Fi/LAN IP found! Connect to Wi-Fi before scanning.")
    if use_https:
        print("  [OK] TLS: self-signed certificate — accept the browser warning once on connect")
        print("       (Safari: Show Details → visit this website) to unlock UI + WSS + Gyro.")
        if cert_path:
            print(f"       Certificate: {cert_path}")
    if sys.platform == "win32":
        print("  Tip: If your phone times out, allow Python through Windows Firewall on both Private & Public networks.")
    print("─" * 68)
    print("  📱 SCAN WITH YOUR PHONE'S CAMERA TO CONNECT:")
    print("─" * 68 + "\n")

    try:
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ascii(invert=True)
    except Exception as e:
        print(f"  [QR generation error: {e}]")

    print("\n" + "─" * 68)
    print(f"  Or open in your phone's browser:  {url}")
    print("  Press Ctrl+C to stop daemon.")
    print("═" * 68 + "\n")


async def async_main():
    parser = argparse.ArgumentParser(description="Phone-to-PC Virtual Gamepad Host Daemon")
    parser.add_argument("-p", "--port", type=int, default=None,
                        help="Unified HTTP + WebSocket port (default: 8765)")
    parser.add_argument("--ws-port", type=int, default=None,
                        help="Alias for --port (default: 8765)")
    parser.add_argument("--http-port", type=int, default=None,
                        help="Legacy alias for --port in unified single-port mode")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Binding host IP (default: 0.0.0.0)")
    parser.add_argument("--ip", type=str, default="", help="Override advertised LAN IP for QR code")
    parser.add_argument("--mock", action="store_true", help="Force Mock Gamepad driver (console logging)")
    parser.add_argument("--https", action="store_true",
                        help="Enable HTTPS and WSS using an auto-generated self-signed LAN certificate")
    args = parser.parse_args()

    port = args.port or args.ws_port or args.http_port or 8765

    client_dir = Path(__file__).resolve().parent.parent / "client"
    if not client_dir.exists():
        print(f"[Error] Client directory not found at: {client_dir}")
        sys.exit(1)

    # Pre-flight checks (each exits cleanly with a readable message on failure)
    driver_label = verify_driver_preflight(force_mock=args.mock)
    lan_ip, lan_ok = detect_lan_ip(args.ip)
    verify_ports_preflight(args.host, port)

    ssl_context = None
    cert_path = None
    if args.https:
        try:
            cert_path, key_path, created = ensure_lan_certificate(lan_ip)
            ssl_context = build_ssl_context(cert_path, key_path)
            if created:
                print(f"[TLS] Generated self-signed certificate for {lan_ip} → {cert_path}")
        except Exception as exc:
            _print_error_box("Could not initialize HTTPS certificate", [
                f"Details: {exc}",
                "Install the `cryptography` package (pip install cryptography) or OpenSSL,",
                "or run without --https.",
            ])
            sys.exit(1)

    # Defer virtual-device creation until the first phone connects so P1 stays free
    driver = create_gamepad_driver(force_mock=args.mock, defer_init=True)

    # Unified HTTP + WebSocket server on a single port via websockets process_request
    static_handler = build_static_process_request(client_dir)
    server = ControllerServer(
        driver=driver,
        client_dir=client_dir,
        host=args.host,
        http_port=port,
        ws_port=port,
        force_mock=args.mock,
        ssl_context=ssl_context,
        unified=True,
        process_request=static_handler,
    )

    # Start unified server before printing the QR code so bind failures never show a broken banner
    try:
        await server.start()
    except OSError as exc:
        _port_in_use_box("Unified HTTP/WS", port, "--port", exc)
        sys.exit(1)

    print_banner(lan_ip, port, driver.device_name, driver.is_mock,
                 driver_label=driver_label, lan_ok=lan_ok,
                 use_https=args.https, cert_path=cert_path)

    # Setup shutdown event
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    def signal_handler():
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, signal_handler)
        except NotImplementedError:
            # Windows does not support add_signal_handler in all event loops
            pass

    try:
        await stop_event.wait()
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    finally:
        await server.stop()


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        print("\nDaemon terminated by user.")


if __name__ == "__main__":
    main()
