from __future__ import annotations

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


def test_bootstrap_pair_is_one_time_and_rotates_bearer(tmp_path: Path) -> None:
    store = QueueStore(":memory:")
    app = create_app(_settings(tmp_path), store=store, provider=object())
    try:
        with TestClient(app) as client:
            status = client.get("/bootstrap/status")
            assert status.status_code == 200
            assert status.json()["version"] == "1.11.0"
            assert status.json()["paired"] is False
            assert status.json()["pairingAvailable"] is True
            assert "pairingCode" not in status.json()

            code = app.state.pairing_manager.current_code
            assert code and len(code.replace("-", "")) == 8
            paired = client.post(
                "/bootstrap/pair",
                json={"schema": 1, "pairingCode": code, "clientId": "test"},
            )
            assert paired.status_code == 200
            token = paired.json()["bearerToken"]
            assert len(token) >= 32
            assert paired.json()["paired"] is True
            assert paired.json()["pairingAvailable"] is False

            assert client.get("/v1/health").status_code == 401
            assert client.get(
                "/v1/health", headers={"Authorization": f"Bearer {token}"}
            ).status_code == 200
            again = client.post(
                "/bootstrap/pair",
                json={"schema": 1, "pairingCode": code},
            )
            assert again.status_code == 409
    finally:
        store.close()


def test_pairing_window_can_be_reopened_only_explicitly(tmp_path: Path) -> None:
    store = QueueStore(":memory:")
    app = create_app(_settings(tmp_path), store=store, provider=object())
    try:
        with TestClient(app) as client:
            code = app.state.pairing_manager.current_code
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
            pairing_code = app.state.pairing_manager.current_code
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
