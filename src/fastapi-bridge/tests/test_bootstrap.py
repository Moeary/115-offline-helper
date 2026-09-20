from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from bridge.app import create_app
from bridge.config import Settings
from bridge.db import QueueStore


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=52115,
        bearer_token="b" * 32,
        token_file=tmp_path / "bearer.token",
        db_path=":memory:",
        cors_origins=(),
        telegram_bot_token="",
        telegram_allowed_chat_ids=frozenset(),
        telegram_allowed_user_ids=frozenset(),
        telegram_polling=False,
        telegram_poll_timeout=25,
        callback_ttl_seconds=900,
        lease_seconds=120,
        javbus_base_url="https://javbus.com",
        javbus_allowed_hosts=frozenset({"javbus.com", "www.javbus.com"}),
        javbus_timeout_seconds=15,
        javbus_max_response_bytes=2_000_000,
        telegram_token_file=tmp_path / "telegram_bot.token",
    )


def test_bootstrap_connect_returns_one_persistent_bearer(tmp_path: Path) -> None:
    store = QueueStore(":memory:")
    app = create_app(_settings(tmp_path), store=store, provider=object())
    try:
        with TestClient(app) as client:
            status = client.get("/bootstrap/status")
            assert status.status_code == 200
            assert status.json()["version"] == "1.14.0"
            assert status.json()["paired"] is False
            assert status.json()["pairingAvailable"] is False
            assert "pairingCode" not in status.json()

            connected = client.post("/bootstrap/connect")
            assert connected.status_code == 200
            token = connected.json()["bearerToken"]
            assert len(token) >= 32
            assert connected.json()["paired"] is True
            assert connected.json()["connected"] is True

            repeated = client.post("/bootstrap/connect")
            assert repeated.status_code == 200
            assert repeated.json()["bearerToken"] == token
            assert "pairingCode" not in repeated.json()

            assert client.get("/v1/health").status_code == 401
            assert client.get(
                "/v1/health", headers={"Authorization": f"Bearer {token}"}
            ).status_code == 200
    finally:
        store.close()


def test_bootstrap_connect_survives_bridge_restart(tmp_path: Path) -> None:
    settings = replace(
        _settings(tmp_path),
        db_path=tmp_path / "bridge.sqlite3",
    )
    first_app = create_app(settings, provider=object())
    with TestClient(first_app) as client:
        first = client.post("/bootstrap/connect")
        assert first.status_code == 200
        token = first.json()["bearerToken"]

    second_app = create_app(settings, provider=object())
    with TestClient(second_app) as client:
        second = client.post("/bootstrap/connect")
        assert second.status_code == 200
        assert second.json()["bearerToken"] == token
        assert client.get(
            "/v1/health", headers={"Authorization": f"Bearer {token}"}
        ).status_code == 200


def test_pairing_window_can_be_reopened_only_explicitly(tmp_path: Path) -> None:
    store = QueueStore(":memory:")
    app = create_app(_settings(tmp_path), store=store, provider=object())
    try:
        with TestClient(app) as client:
            code = app.state.pairing_manager.open_window(force=True)
            assert code
            first = client.post("/bootstrap/pair", json={"pairingCode": code})
            assert first.status_code == 200
            old_token = first.json()["bearerToken"]

            reopened = app.state.pairing_manager.open_window(force=True)
            assert reopened != code
            assert client.get("/bootstrap/status").json()["pairingAvailable"] is True
            second = client.post("/bootstrap/pair", json={"pairingCode": reopened})
            assert second.status_code == 200
            assert second.json()["bearerToken"] != old_token
    finally:
        store.close()


class _RuntimeTransport:
    def __init__(self, token: str) -> None:
        self.token = token

    async def get_me(self):
        return {"id": 11, "is_bot": True, "username": "runtime115_bot"}

    async def aclose(self):
        return None


def test_runtime_telegram_endpoint_validates_and_hides_token(tmp_path: Path) -> None:
    store = QueueStore(":memory:")
    app = create_app(_settings(tmp_path), store=store, provider=object())
    try:
        with TestClient(app) as client:
            pairing_code = app.state.pairing_manager.open_window(force=True)
            paired = client.post("/bootstrap/pair", json={"pairingCode": pairing_code})
            token = paired.json()["bearerToken"]
            app.state.telegram_manager._transport_factory = _RuntimeTransport
            response = client.put(
                "/v1/runtime/telegram",
                headers={"Authorization": f"Bearer {token}"},
                json={"schema": 1, "enabled": False, "botToken": "runtime-secret"},
            )
            assert response.status_code == 200
            payload = response.json()
            assert payload["configured"] is True
            assert payload["enabled"] is False
            assert payload["botUsername"] == "runtime115_bot"
            assert "botToken" not in payload
            read = client.get(
                "/v1/runtime/telegram",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert read.status_code == 200
            assert "runtime-secret" not in read.text
            assert read.json()["ownerBound"] is False
    finally:
        store.close()
