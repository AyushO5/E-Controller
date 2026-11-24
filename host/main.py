#!/usr/bin/env python3
"""
Virtual Gamepad PC Host Daemon
CLI entry point, LAN IP detection, terminal QR code generation, and server orchestration.
"""

import argparse
import asyncio
import os
import signal
import socket
import sys
from pathlib import Path

import qrcode

from gamepad_driver import create_gamepad_driver
from server import ControllerServer


def get_lan_ip() -> str:
    """Detect the machine's primary local area network (LAN) IPv4 address."""
    try:
        # Connect to a public DNS IP (doesn't send any traffic, just routes)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        ip = socket.gethostbyname(hostname)
        if not ip.startswith("127."):
            return ip
    except Exception:
        pass

    return "127.0.0.1"


def print_banner(lan_ip: str, http_port: int, ws_port: int, driver_name: str, is_mock: bool):
    """Render terminal dashboard with ASCII art and QR code."""
    query = f"?port={ws_port}" if ws_port != 8765 else ""
    url = f"http://{lan_ip}:{http_port}{query}"
    ws_url = f"ws://{lan_ip}:{ws_port}"

    print("\n" + "═" * 68)
    print("   🎮  VIRTUAL GAMEPAD - MOBILE TO PC HOST DAEMON  🎮")
    print("═" * 68)
    print(f"  • Gamepad Driver : {driver_name}")
    if is_mock:
        print("    └─ [MOCK MODE] Inputs will log to console instead of OS device.")
        print("       (Run with `sudo chmod 666 /dev/uinput` for native OS gamepad)")
    else:
        print("    └─ [NATIVE MODE] Active OS-level virtual Xbox 360 controller.")
    print(f"  • HTTP Server    : {url}")
    print(f"  • WebSocket URL  : {ws_url}")
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
    parser.add_argument("--http-port", type=int, default=8080, help="HTTP static server port (default: 8080)")
    parser.add_argument("--ws-port", type=int, default=8765, help="WebSocket server port (default: 8765)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Binding host IP (default: 0.0.0.0)")
    parser.add_argument("--ip", type=str, default="", help="Override advertised LAN IP for QR code")
    parser.add_argument("--mock", action="store_true", help="Force Mock Gamepad driver (console logging)")
    args = parser.parse_args()

    lan_ip = args.ip if args.ip else get_lan_ip()
    client_dir = Path(__file__).resolve().parent.parent / "client"

    if not client_dir.exists():
        print(f"[Error] Client directory not found at: {client_dir}")
        sys.exit(1)

    # Initialize Gamepad Driver
    driver = create_gamepad_driver(force_mock=args.mock)

    # Initialize Server
    server = ControllerServer(
        driver=driver,
        client_dir=client_dir,
        host=args.host,
        http_port=args.http_port,
        ws_port=args.ws_port,
        force_mock=args.mock,
    )

    print_banner(lan_ip, args.http_port, args.ws_port, driver.device_name, driver.is_mock)

    # Start servers
    await server.start()

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
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        print("\nDaemon terminated by user.")


if __name__ == "__main__":
    main()
