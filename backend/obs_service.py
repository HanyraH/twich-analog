"""Lightweight async OBS WebSocket v5 client using Python standard library."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import struct
import uuid
from dataclasses import dataclass, field
from typing import Any


class OBSError(RuntimeError):
    """Raised when OBS WebSocket connection, authentication, or RPC fails."""


class _MinimalWebSocket:
    """Minimal RFC 6455 client over asyncio streams for local OBS WebSocket."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer

    @classmethod
    async def connect(cls, host: str, port: int, timeout: float = 4.0) -> "_MinimalWebSocket":
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port),
                timeout=timeout,
            )
        except OSError as exc:
            raise OBSError(
                f"Не удалось подключиться к OBS WebSocket ({host}:{port}): {exc}"
            ) from exc
        except asyncio.TimeoutError as exc:
            raise OBSError(f"Таймаут подключения к OBS WebSocket ({host}:{port})") from exc

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET / HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"\r\n"
        )
        writer.write(request.encode("ascii"))
        await writer.drain()

        status_line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        if b"101" not in status_line:
            writer.close()
            raise OBSError(f"OBS отклонил WebSocket handshake: {status_line.decode(errors='replace').strip()}")

        headers: dict[str, str] = {}
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=timeout)
            if line in (b"\r\n", b"\n", b""):
                break
            decoded = line.decode("latin-1").strip()
            if ":" in decoded:
                k, v = decoded.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        expected_accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != expected_accept:
            writer.close()
            raise OBSError("Некорректный Sec-WebSocket-Accept от OBS")

        return cls(reader, writer)

    async def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        mask_key = os.urandom(4)
        length = len(payload)

        header = bytearray([0x81])  # FIN + text frame
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))

        header.extend(mask_key)
        masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
        self._writer.write(bytes(header) + masked)
        await self._writer.drain()

    async def _send_pong(self, payload: bytes) -> None:
        mask_key = os.urandom(4)
        length = len(payload)
        header = bytearray([0x8A, 0x80 | length])
        header.extend(mask_key)
        masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
        self._writer.write(bytes(header) + masked)
        await self._writer.drain()

    async def recv_text(self, timeout: float = 4.0) -> str:
        fragments: list[bytes] = []
        while True:
            b1, b2 = await asyncio.wait_for(self._reader.readexactly(2), timeout=timeout)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F

            if length == 126:
                length = struct.unpack("!H", await self._reader.readexactly(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", await self._reader.readexactly(8))[0]

            mask_key = await self._reader.readexactly(4) if masked else b""
            data = await self._reader.readexactly(length) if length else b""
            if masked:
                data = bytes(b ^ mask_key[i % 4] for i, b in enumerate(data))

            if opcode == 0x8:  # close
                raise OBSError("OBS закрыл WebSocket соединение")
            if opcode == 0x9:  # ping
                await self._send_pong(data)
                continue
            if opcode == 0xA:  # pong
                continue

            fragments.append(data)
            if fin:
                return b"".join(fragments).decode("utf-8")

    async def close(self) -> None:
        try:
            self._writer.close()
            await self._writer.wait_closed()
        except OSError:
            pass


@dataclass
class OBSConfig:
    host: str = "127.0.0.1"
    port: int = 4455
    password: str = ""
    configured: bool = False


def compute_obs_auth(password: str, salt: str, challenge: str) -> str:
    """Compute OBS WebSocket v5 auth response string."""
    secret = base64.b64encode(
        hashlib.sha256((password + salt).encode("utf-8")).digest()
    ).decode("ascii")
    return base64.b64encode(
        hashlib.sha256((secret + challenge).encode("utf-8")).digest()
    ).decode("ascii")


@dataclass
class OBSManager:
    """Tracks OBS connection config per user and executes OBS WebSocket v5 requests."""

    configs: dict[int, OBSConfig] = field(default_factory=dict)

    def get_config(self, user_id: int) -> OBSConfig:
        return self.configs.get(user_id, OBSConfig())

    def set_config(self, user_id: int, host: str, port: int, password: str) -> OBSConfig:
        cfg = OBSConfig(
            host=host.strip() or "127.0.0.1",
            port=port,
            password=password,
            configured=True,
        )
        self.configs[user_id] = cfg
        return cfg

    async def _open_session(self, cfg: OBSConfig) -> _MinimalWebSocket:
        ws = await _MinimalWebSocket.connect(cfg.host, cfg.port)
        try:
            hello_raw = await ws.recv_text()
            hello = json.loads(hello_raw)
            if hello.get("op") != 0:
                raise OBSError("Ожидался Hello (op=0) от OBS WebSocket")

            identify_data: dict[str, Any] = {"rpcVersion": 1}
            auth_info = hello.get("d", {}).get("authentication")
            if auth_info:
                if not cfg.password:
                    raise OBSError("OBS требует пароль WebSocket (укажите пароль в настройках OBS)")
                identify_data["authentication"] = compute_obs_auth(
                    cfg.password,
                    auth_info["salt"],
                    auth_info["challenge"],
                )

            await ws.send_text(json.dumps({"op": 1, "d": identify_data}))
            identified_raw = await ws.recv_text()
            identified = json.loads(identified_raw)
            if identified.get("op") != 2:
                raise OBSError("Авторизация в OBS WebSocket не пройдена (проверьте пароль)")
            return ws
        except Exception:
            await ws.close()
            raise

    async def _request(
        self,
        ws: _MinimalWebSocket,
        request_type: str,
        request_data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        req_id = uuid.uuid4().hex
        payload: dict[str, Any] = {
            "op": 6,
            "d": {
                "requestType": request_type,
                "requestId": req_id,
            },
        }
        if request_data is not None:
            payload["d"]["requestData"] = request_data

        await ws.send_text(json.dumps(payload))

        while True:
            msg = json.loads(await ws.recv_text())
            if msg.get("op") != 7:
                continue
            data = msg.get("d", {})
            if data.get("requestId") != req_id:
                continue
            status = data.get("requestStatus", {})
            if not status.get("result"):
                comment = status.get("comment") or f"OBS error code {status.get('code')}"
                raise OBSError(f"{request_type}: {comment}")
            return data.get("responseData") or {}

    async def get_status(self, user_id: int) -> dict[str, Any]:
        cfg = self.get_config(user_id)
        try:
            ws = await self._open_session(cfg)
        except OBSError as exc:
            return {
                "connected": False,
                "host": cfg.host,
                "port": cfg.port,
                "error": str(exc),
                "scenes": [],
                "current_scene": None,
                "streaming": False,
                "recording": False,
            }

        try:
            version = await self._request(ws, "GetVersion")
            stream_status = await self._request(ws, "GetStreamStatus")
            record_status = await self._request(ws, "GetRecordStatus")
            scene_list = await self._request(ws, "GetSceneList")
            scenes = [s.get("sceneName", "") for s in scene_list.get("scenes", []) if s.get("sceneName")]
            scenes.reverse()
            return {
                "connected": True,
                "host": cfg.host,
                "port": cfg.port,
                "obs_version": version.get("obsVersion"),
                "websocket_version": version.get("obsWebSocketVersion"),
                "scenes": scenes,
                "current_scene": scene_list.get("currentProgramSceneName"),
                "streaming": bool(stream_status.get("outputActive")),
                "stream_timecode": stream_status.get("outputTimecode"),
                "recording": bool(record_status.get("outputActive")),
                "error": None,
            }
        finally:
            await ws.close()

    async def _configure_webrtc_encoder(self, ws: _MinimalWebSocket) -> None:
        """Configure OBS output/encoder for WebRTC (no B-frames, low latency)."""
        params = [
            ("Output", "Mode", "Simple"),
            ("Output", "LowLatencyEnable", "true"),
            ("SimpleOutput", "UseAdvanced", "true"),
            ("SimpleOutput", "StreamEncoder", "x264"),
            ("SimpleOutput", "Preset", "veryfast"),
            ("SimpleOutput", "Profile", "baseline"),
            ("SimpleOutput", "Tune", "zerolatency"),
            ("SimpleOutput", "KeyintSec", "1"),
            ("SimpleOutput", "x264Opts", "bframes=0"),
        ]
        for category, name, value in params:
            try:
                await self._request(
                    ws,
                    "SetProfileParameter",
                    {
                        "parameterCategory": category,
                        "parameterName": name,
                        "parameterValue": value,
                    },
                )
            except OBSError:
                pass

    async def configure_stream(self, user_id: int, rtmp_server: str, stream_key: str) -> dict[str, Any]:
        cfg = self.get_config(user_id)
        ws = await self._open_session(cfg)
        try:
            await self._request(
                ws,
                "SetStreamServiceSettings",
                {
                    "streamServiceType": "rtmp_custom",
                    "streamServiceSettings": {
                        "server": rtmp_server,
                        "key": stream_key,
                    },
                },
            )
            stream_status = await self._request(ws, "GetStreamStatus")
            if not stream_status.get("outputActive"):
                await self._configure_webrtc_encoder(ws)
        finally:
            await ws.close()
        return await self.get_status(user_id)

    async def set_streaming(self, user_id: int, active: bool) -> dict[str, Any]:
        cfg = self.get_config(user_id)
        ws = await self._open_session(cfg)
        try:
            await self._request(ws, "StartStream" if active else "StopStream")
        finally:
            await ws.close()
        return await self.get_status(user_id)

    async def set_scene(self, user_id: int, scene_name: str) -> dict[str, Any]:
        cfg = self.get_config(user_id)
        ws = await self._open_session(cfg)
        try:
            await self._request(ws, "SetCurrentProgramScene", {"sceneName": scene_name})
        finally:
            await ws.close()
        return await self.get_status(user_id)

    async def start_monitor_demo(
        self,
        user_id: int,
        rtmp_server: str,
        stream_key: str,
        scene_name: str = "Демка монитора",
        input_name: str = "Экран (демо)",
    ) -> dict[str, Any]:
        cfg = self.get_config(user_id)
        ws = await self._open_session(cfg)
        try:
            stream_status = await self._request(ws, "GetStreamStatus")
            output_active = bool(stream_status.get("outputActive"))

            if not output_active:
                await self._request(
                    ws,
                    "SetStreamServiceSettings",
                    {
                        "streamServiceType": "rtmp_custom",
                        "streamServiceSettings": {
                            "server": rtmp_server,
                            "key": stream_key,
                        },
                    },
                )
                await self._configure_webrtc_encoder(ws)

            scene_list = await self._request(ws, "GetSceneList")
            existing_scenes = {
                s.get("sceneName") for s in scene_list.get("scenes", []) if s.get("sceneName")
            }
            if scene_name not in existing_scenes:
                await self._request(ws, "CreateScene", {"sceneName": scene_name})

            items_resp = await self._request(ws, "GetSceneItemList", {"sceneName": scene_name})
            scene_items = items_resp.get("sceneItems") or []
            has_monitor = any(
                item.get("inputKind") == "monitor_capture" for item in scene_items
            )

            if not has_monitor:
                inputs_resp = await self._request(ws, "GetInputList")
                existing_inputs = {
                    inp.get("inputName"): inp.get("inputKind")
                    for inp in (inputs_resp.get("inputs") or [])
                    if inp.get("inputName")
                }
                if input_name in existing_inputs:
                    await self._request(
                        ws,
                        "CreateSceneItem",
                        {
                            "sceneName": scene_name,
                            "sourceName": input_name,
                            "sceneItemEnabled": True,
                        },
                    )
                else:
                    await self._request(
                        ws,
                        "CreateInput",
                        {
                            "sceneName": scene_name,
                            "inputName": input_name,
                            "inputKind": "monitor_capture",
                            "inputSettings": {},
                            "sceneItemEnabled": True,
                        },
                    )

            await self._request(ws, "SetCurrentProgramScene", {"sceneName": scene_name})

            if not output_active:
                await self._request(ws, "StartStream")
        finally:
            await ws.close()
        return await self.get_status(user_id)
