"""
Async HTTP + WebSocket Server — Checkpoint 4 (Fixed)

Additions:
  - Immediate virtual gamepad device initialization upon client connection (HELLO handshake).
  - Bidirectional rumble: driver.on_rumble → binary frame [0x02, low, high, player]
    sent back to the connected WebSocket client.
  - Status push: server pushes {"type":"status","state":"ACTIVE"|"STALE"} on
    watchdog transitions so the HUD pill updates in real time.
  - Player-slot assignment (P1–P4) sent in welcome and status messages.
"""

import asyncio
import json
import logging
import struct
from pathlib import Path
from typing import Dict, Optional, Set

from aiohttp import web
import websockets

from gamepad_driver import BaseGamepadDriver, create_gamepad_driver
from protocol import MSG_TYPE_NEUTRAL, ProtocolParser, Watchdog

logger = logging.getLogger("Server")

# Rumble binary frame constants
RUMBLE_MSG_TYPE = 0x02
RUMBLE_FRAME_FORMAT = "BBBB"   # msg_type, low_freq, high_freq, player_id
RUMBLE_FRAME_SIZE   = struct.calcsize(RUMBLE_FRAME_FORMAT)   # 4 bytes


def _is_ws_open(websocket) -> bool:
    """Return True if websocket is open across websockets versions (<13 and >=13)."""
    state = getattr(websocket, "state", None)
    if state is not None:
        return getattr(state, "name", None) == "OPEN"
    return bool(getattr(websocket, "open", False))


class ControllerServer:
    def __init__(
        self,
        driver: BaseGamepadDriver,
        client_dir: Path,
        host: str = "0.0.0.0",
        http_port: int = 8080,
        ws_port: int = 8765,
        force_mock: bool = False,
    ):
        self.driver      = driver
        self.client_dir  = client_dir
        self.host        = host
        self.http_port   = http_port
        self.ws_port     = ws_port
        self.force_mock  = force_mock

        self.http_runner: Optional[web.AppRunner] = None
        self.ws_server   = None
        self.active_websockets: Set = set()
        self._ws_players: Dict = {}

        # Player slot counter (wraps P1–P4)
        self._player_counter = 0

    def _attach_rumble_callback(self):
        """Attach server-wide rumble callback with the active event loop."""
        if self.driver is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        self.driver.set_rumble_callback(self._on_driver_rumble, loop=loop)

    def _on_driver_rumble(self, low: int, high: int):
        """Broadcast 4-byte binary rumble frames to all connected open clients."""
        if not self._ws_players:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        for ws, player_slot in list(self._ws_players.items()):
            if not _is_ws_open(ws):
                continue
            frame = struct.pack(
                RUMBLE_FRAME_FORMAT,
                RUMBLE_MSG_TYPE,
                low & 0xFF,
                high & 0xFF,
                player_slot & 0xFF,
            )
            loop.create_task(self._send_rumble_frame(ws, frame))

    def ensure_driver_ready(self):
        """Ensure virtual gamepad device is initialized and active."""
        if self.driver is None:
            self.driver = create_gamepad_driver(force_mock=self.force_mock)
            self._attach_rumble_callback()
        elif self.driver.is_mock and not self.force_mock:
            # Check if user granted permissions since daemon start
            new_driver = create_gamepad_driver(force_mock=False)
            if not new_driver.is_mock:
                print(f"[GamepadDriver] Permitted! Upgraded to native device: {new_driver.device_name}")
                try:
                    self.driver.close()
                except Exception:
                    pass
                self.driver = new_driver
                self._attach_rumble_callback()
            else:
                self.driver.ensure_initialized()
        else:
            self.driver.ensure_initialized()

    # ------------------------------------------------------------------
    # HTTP static serving
    # ------------------------------------------------------------------
    async def _handle_index(self, request: web.Request) -> web.FileResponse:
        return web.FileResponse(
            self.client_dir / "index.html",
            headers=self._no_cache_headers(),
        )

    async def _handle_static(self, request: web.Request) -> web.StreamResponse:
        filename  = request.match_info.get("filename", "")
        safe_path = (self.client_dir / filename).resolve()
        base      = self.client_dir.resolve()
        if not safe_path.is_relative_to(base) or not safe_path.is_file():
            return web.Response(status=404, text="Not Found")
        return web.FileResponse(safe_path, headers=self._no_cache_headers())

    @staticmethod
    def _no_cache_headers() -> dict:
        return {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        }

    # ------------------------------------------------------------------
    # WebSocket handler — one per connected client
    # ------------------------------------------------------------------
    async def _ws_handler(self, websocket):
        remote    = websocket.remote_address
        client_id = f"{remote[0]}:{remote[1]}" if remote else "unknown"

        # Assign player slot P1–P4
        self._player_counter = (self._player_counter % 4) + 1
        player_slot = self._player_counter
        player_label = f"P{player_slot}"
        print(f"[WS] {player_label} connected ← {client_id}")

        # Ensure the virtual gamepad device is initialized immediately upon client connection
        try:
            self.ensure_driver_ready()
        except Exception as e:
            print(f"[GamepadDriver] Init error on connection: {e}")

        # Per-client parser & watchdog
        parser   = ProtocolParser()
        watchdog = Watchdog(
            on_stale     = self._make_stale_cb(client_id, websocket, player_slot),
            on_recovered = self._make_recovered_cb(client_id, websocket, player_slot),
            timeout_seconds=0.25,
        )

        self.active_websockets.add(websocket)
        self._ws_players[websocket] = player_slot
        watchdog.start()
        watchdog.feed()

        # Welcome / HELLO handshake response
        try:
            await websocket.send(json.dumps({
                "type":   "welcome",
                "driver": self.driver.device_name,
                "is_mock": self.driver.is_mock,
                "proto":  3,
                "player": player_label,
            }))
        except Exception:
            pass

        try:
            async for message in websocket:
                if isinstance(message, bytes):
                    await self._handle_binary(message, parser, watchdog, client_id)
                elif isinstance(message, str):
                    await self._handle_text(message, websocket, player_label)

        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as exc:
            print(f"[WS] Error from {client_id}: {exc}")
        finally:
            print(f"[WS] {player_label} disconnected ← {client_id}")
            watchdog.stop()
            self.active_websockets.discard(websocket)
            self._ws_players.pop(websocket, None)
            if not self.active_websockets:
                self.driver.reset()

    async def _send_rumble_frame(self, websocket, frame: bytes):
        """Send a 4-byte rumble binary frame; silently drops if socket is closed."""
        try:
            if _is_ws_open(websocket):
                await websocket.send(frame)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Binary frame handling
    # ------------------------------------------------------------------
    async def _handle_binary(self, data: bytes, parser: ProtocolParser,
                             watchdog: Watchdog, client_id: str):
        if parser.is_neutral_frame(data):
            print(f"[WS] Neutral frame ← {client_id}  → zeroing gamepad.")
            self.driver.reset()
            watchdog.feed()
            return

        state = parser.unpack(data)
        if state is not None:
            watchdog.feed()
            self.driver.update(state)

    # ------------------------------------------------------------------
    # JSON text frame handling
    # ------------------------------------------------------------------
    async def _handle_text(self, message: str, websocket, player_label: str = "P1"):
        try:
            data = json.loads(message)
        except json.JSONDecodeError:
            return

        mtype = (data.get("type") or "").lower()
        if mtype in ("hello", "welcome"):
            self.ensure_driver_ready()
            await websocket.send(json.dumps({
                "type":   "welcome",
                "driver": self.driver.device_name,
                "is_mock": self.driver.is_mock,
                "proto":  3,
                "player": player_label,
            }))
            return

        if mtype == "ping":
            await websocket.send(
                json.dumps({"type": "pong", "t": data.get("t", 0)})
            )
        elif mtype == "rumble_request":
            await websocket.send(json.dumps({
                "type":    "rumble",
                "lowFreq": data.get("weak",   0.5),
                "highFreq":data.get("strong", 0.5),
                "duration":data.get("duration", 150),
            }))

    # ------------------------------------------------------------------
    # Watchdog callbacks — push status updates to HUD pill
    # ------------------------------------------------------------------
    def _make_stale_cb(self, client_id: str, ws, player_slot: int):
        def _on_stale():
            print(f"[Watchdog] STALE ← {client_id}  → reset()")
            self.driver.reset()
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(self._push_status(ws, "STALE", player_slot))
            except RuntimeError:
                pass
        return _on_stale

    def _make_recovered_cb(self, client_id: str, ws, player_slot: int):
        def _on_recovered():
            print(f"[Watchdog] Recovered ← {client_id}")
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(self._push_status(ws, "ACTIVE", player_slot))
            except RuntimeError:
                pass
        return _on_recovered

    async def _push_status(self, websocket, state: str, player_slot: int):
        try:
            if _is_ws_open(websocket):
                await websocket.send(json.dumps({
                    "type":   "status",
                    "state":  state,
                    "player": f"P{player_slot}",
                }))
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def start_http(self):
        app = web.Application()
        app.router.add_get("/", self._handle_index)
        app.router.add_get("/{filename:.+}", self._handle_static)
        self.http_runner = web.AppRunner(app)
        await self.http_runner.setup()
        await web.TCPSite(self.http_runner, self.host, self.http_port).start()
        print(f"[HTTP] Static server on http://{self.host}:{self.http_port}")

    async def start_ws(self):
        self.ws_server = await websockets.serve(
            self._ws_handler,
            self.host,
            self.ws_port,
            ping_interval=10,
            ping_timeout=5,
            max_size=1024,
        )
        print(f"[WS] Input server on ws://{self.host}:{self.ws_port}")

    async def start(self):
        self._attach_rumble_callback()
        await self.start_http()
        await self.start_ws()

    async def stop(self):
        print("\n[Server] Shutting down…")
        if self.ws_server:
            self.ws_server.close()
            await self.ws_server.wait_closed()
        if self.http_runner:
            await self.http_runner.cleanup()
        self.driver.close()
        print("[Server] Done.")
