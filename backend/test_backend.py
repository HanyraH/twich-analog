import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main as backend_main
from obs_service import compute_obs_auth


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    test_engine = backend_main.create_engine(
        f"sqlite:///{db_path.as_posix()}",
        connect_args={"check_same_thread": False},
    )
    TestSessionLocal = backend_main.sessionmaker(bind=test_engine, autoflush=False)
    backend_main.Base.metadata.create_all(bind=test_engine)

    def override_get_db():
        with TestSessionLocal() as db:
            yield db

    monkeypatch.setattr(backend_main, "engine", test_engine)
    monkeypatch.setattr(backend_main, "SessionLocal", TestSessionLocal)
    backend_main.app.dependency_overrides[backend_main.get_db] = override_get_db
    with TestClient(backend_main.app) as c:
        yield c
    backend_main.app.dependency_overrides.clear()


def test_auth_stream_key_and_mediamtx_listing(client, monkeypatch):
    reg = client.post("/register", json={"email": "StreamUser@example.com", "password": "password123"})
    assert reg.status_code == 201

    tok_resp = client.post("/login", data={"username": "streamuser@example.com", "password": "password123"})
    assert tok_resp.status_code == 200
    token = tok_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # JWT includes email claim for Go chat server.
    decoded = backend_main.jwt.decode(token, backend_main.SECRET_KEY, algorithms=[backend_main.ALGORITHM])
    assert decoded["email"] == "streamuser@example.com"

    # Fetch and update stream info.
    me_stream = client.get("/streams/me", headers=headers)
    assert me_stream.status_code == 200
    data = me_stream.json()
    assert data["path"] == f"live/{data['stream_key']}"
    assert data["whip_url"].endswith(f"/{data['path']}/whip")

    upd = client.patch("/streams/me", json={"title": "Тестовая демка", "mode": "obs"}, headers=headers)
    assert upd.status_code == 200
    assert upd.json()["title"] == "Тестовая демка"
    assert upd.json()["mode"] == "obs"

    old_key = data["stream_key"]
    rot = client.post("/streams/me/rotate-key", headers=headers)
    assert rot.status_code == 200
    new_key = rot.json()["stream_key"]
    assert new_key != old_key

    # Mock MediaMTX paths/list response.
    monkeypatch.setattr(
        backend_main,
        "_fetch_mediamtx_paths_sync",
        lambda: (
            True,
            [
                {
                    "name": f"live/{new_key}",
                    "ready": True,
                    "readyTime": "2026-11-26T08:00:00Z",
                    "tracks": ["H264", "Opus"],
                    "readers": [{"type": "webRTCSession"}],
                    "bytesReceived": 102400,
                }
            ],
        ),
    )

    listing = client.get("/streams")
    assert listing.status_code == 200
    body = listing.json()
    assert body["mediamtx_online"] is True
    live_paths = [s for s in body["streams"] if s["path"] == f"live/{new_key}"]
    assert len(live_paths) == 1
    assert live_paths[0]["title"] == "Тестовая демка"
    assert live_paths[0]["owner_email"] == "streamuser@example.com"
    assert live_paths[0]["readers_count"] == 1


def test_obs_auth_hash_and_offline_status(client):
    auth = compute_obs_auth("secret", "salt123", "challenge456")
    assert isinstance(auth, str) and len(auth) == 44

    client.post("/register", json={"email": "obs@example.com", "password": "password123"})
    token = client.post("/login", data={"username": "obs@example.com", "password": "password123"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Unreachable OBS port returns connected=False gracefully rather than 500.
    res = client.post("/obs/connect", json={"host": "127.0.0.1", "port": 59999, "password": ""}, headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["connected"] is False
    assert body["error"]
