"""WebSocket chat server compatible with the Go chat hub protocol."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import jwt
from jwt.exceptions import InvalidTokenError
import uvicorn

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
load_dotenv()

SECRET_KEY = os.environ["JWT_SECRET_KEY"]
ALGORITHM = "HS256"
CHAT_PORT = int(os.getenv("CHAT_PORT", "8081"))
HISTORY_LIMIT = max(1, int(os.getenv("CHAT_HISTORY_LIMIT", "50")))


def normalize_room(raw: str | None) -> str:
    room = (raw or "").strip().strip("/")
    if not room:
        return "live/stream"
    return room[:120]


def verify_user(token: str | None) -> tuple[str, str] | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except InvalidTokenError:
        return None
    user_id = str(payload.get("sub") or "")
    email = str(payload.get("email") or "").strip()
    if not user_id:
        return None
    username = email.split("@", 1)[0] if "@" in email else (email or f"user_{user_id}")
    return user_id, username


class ChatHub:
    def __init__(self, history_limit: int = 50) -> None:
        self.history_limit = history_limit
        self.rooms: dict[str, set[WebSocket]] = {}
        self.history: dict[str, deque[dict]] = {}

    async def connect(self, ws: WebSocket, room: str) -> tuple[list[dict], int]:
        await ws.accept()
        clients = self.rooms.setdefault(room, set())
        others = list(clients)
        clients.add(ws)
        hist = list(self.history.setdefault(room, deque(maxlen=self.history_limit)))
        online = len(clients)
        await self._broadcast_raw(others, {"type": "presence", "room": room, "online": online})
        return hist, online

    async def disconnect(self, ws: WebSocket, room: str) -> None:
        clients = self.rooms.get(room)
        if not clients or ws not in clients:
            return
        clients.discard(ws)
        online = len(clients)
        targets = list(clients)
        await self._broadcast_raw(targets, {"type": "presence", "room": room, "online": online})

    async def broadcast_message(self, room: str, msg: dict) -> None:
        hist = self.history.setdefault(room, deque(maxlen=self.history_limit))
        hist.append(msg)
        targets = list(self.rooms.get(room, set()))
        await self._broadcast_raw(targets, msg)

    async def _broadcast_raw(self, targets: list[WebSocket], payload: dict) -> None:
        if not targets:
            return
        text = json.dumps(payload, ensure_ascii=False)
        for client in targets:
            try:
                await client.send_text(text)
            except Exception:
                pass


hub = ChatHub(HISTORY_LIMIT)
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "rooms": {room: len(clients) for room, clients in hub.rooms.items()},
    }


@app.websocket("/ws")
async def websocket_chat(ws: WebSocket):
    room = normalize_room(ws.query_params.get("room"))
    token = (ws.query_params.get("token") or "").strip()
    user = verify_user(token) if token else None
    if token and user is None:
        await ws.close(code=1008, reason="unauthorized")
        return

    history, online = await hub.connect(ws, room)
    await ws.send_text(
        json.dumps(
            {
                "type": "history",
                "room": room,
                "messages": history,
                "online": online,
            },
            ensure_ascii=False,
        )
    )

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            if data.get("type") != "message":
                continue
            if user is None:
                await ws.send_text(
                    json.dumps(
                        {
                            "type": "error",
                            "room": room,
                            "message": "Войдите в аккаунт, чтобы писать в чат",
                        },
                        ensure_ascii=False,
                    )
                )
                continue
            text = str(data.get("text") or "").strip()
            if not text:
                continue
            text = text[:500]
            user_id, username = user
            msg = {
                "type": "message",
                "id": uuid.uuid4().hex[:16],
                "room": room,
                "user_id": user_id,
                "username": username,
                "text": text,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            await hub.broadcast_message(room, msg)
    except WebSocketDisconnect:
        await hub.disconnect(ws, room)
    except Exception:
        await hub.disconnect(ws, room)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=CHAT_PORT)
