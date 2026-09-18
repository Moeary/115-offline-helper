from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("pydantic")
from fastapi.testclient import TestClient

from bridge.app import create_app
from bridge.config import Settings
from bridge.db import QueueStore


def _settings(token: str) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=52115,
        bearer_token=token,
        token_file="token",
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
    )


def test_api_auth_claim_and_idempotent_events() -> None:
    token = "t" * 32
    store = QueueStore(":memory:")
    store.enqueue(
        {
            "url": "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "code": "ABC-123",
        },
        candidate_key="btih:a",
        telegram_chat_id=1,
        telegram_user_id=2,
        telegram_message_id=3,
    )
    app = create_app(_settings(token), store=store, provider=object())
    with TestClient(app) as client:
        assert client.post("/v1/jobs/claim", json={"schema": 1, "workerId": "w"}).status_code == 401
        response = client.post(
            "/v1/jobs/claim",
            headers={"Authorization": f"Bearer {token}"},
            json={"schema": 1, "workerId": "w", "leaseSeconds": 120},
        )
        assert response.status_code == 200
        claim = response.json()["job"]
        event = {
            "schema": 1,
            "leaseId": claim["leaseId"],
            "eventId": "event-1",
            "state": "accepted",
            "taskId": "task-1",
        }
        first = client.post(
            f"/v1/jobs/{claim['jobId']}/events",
            headers={"Authorization": f"Bearer {token}"},
            json=event,
        )
        second = client.post(
            f"/v1/jobs/{claim['jobId']}/events",
            headers={"Authorization": f"Bearer {token}"},
            json=event,
        )
        assert first.status_code == 200
        assert second.status_code == 200
        assert second.json()["idempotent"] is True
    store.close()
