from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient

from bridge.app import _decode_cursor, _encode_cursor, create_app
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


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_cursor_accepts_only_canonical_padding_and_numeric_timestamp() -> None:
    unpadded = _encode_cursor((12.5, "job")) or ""
    expected_padding = "=" * (-len(unpadded) % 4)
    valid = unpadded + expected_padding
    assert _decode_cursor(unpadded) == (12.5, "job")
    assert _decode_cursor(valid) == (12.5, "job")
    wrong_padding = unpadded + ("=" if expected_padding else "=")
    if wrong_padding == valid:
        wrong_padding += "="
    with pytest.raises(ValueError):
        _decode_cursor(wrong_padding)
    for raw in (["12.5", "job"], [True, "job"]):
        malformed = base64.urlsafe_b64encode(
            json.dumps(raw, separators=(",", ":")).encode("utf-8")
        ).decode("ascii").rstrip("=")
        with pytest.raises(ValueError):
            _decode_cursor(malformed)


def _enqueue(store: QueueStore, index: int, *, now: float) -> object:
    record, _ = store.enqueue(
        {
            "jobId": f"source-{index}",
            "url": f"magnet:?xt=urn:btih:{index:032x}",
            "code": f"ABC-{index:03d}",
        },
        candidate_key=f"api:{index}",
        telegram_chat_id=1,
        telegram_user_id=2,
        telegram_message_id=index + 1,
        now=now,
    )
    return record


def _failed(store: QueueStore, index: int, *, now: float) -> object:
    record = _enqueue(store, index, now=now)
    claimed = store.claim(f"worker-{index}", now=now + 1)
    assert claimed is not None
    failed, _ = store.append_event(
        record.job_id,
        lease_id=claimed.lease_id or "",
        event_id=f"failed-{index}",
        state="failed",
        task_id=f"task-{index}",
        error_code="REMOTE_REJECTED",
        now=now + 2,
    )
    return failed


def test_jobs_list_keyset_status_filter_invalid_cursor_and_auth() -> None:
    token = "l" * 32
    store = QueueStore(":memory:")
    for index in range(3):
        _enqueue(store, index, now=float(index + 1))
    app = create_app(_settings(token), store=store, provider=object())
    try:
        with TestClient(app) as client:
            assert client.get("/v1/jobs").status_code == 401
            first = client.get("/v1/jobs?limit=2", headers=_auth(token))
            assert first.status_code == 200
            body = first.json()
            assert len(body["jobs"]) == 2
            assert body["nextCursor"]
            second = client.get(
                f"/v1/jobs?limit=2&cursor={body['nextCursor']}",
                headers=_auth(token),
            )
            assert second.status_code == 200
            assert len(second.json()["jobs"]) == 1
            assert client.get(
                "/v1/jobs?status=completed", headers=_auth(token)
            ).json()["jobs"] == []
            invalid = client.get("/v1/jobs?cursor=not-a-cursor", headers=_auth(token))
            assert invalid.status_code == 422
    finally:
        store.close()


def test_api_retry_clone_request_id_idempotency_and_terminal_conflicts() -> None:
    token = "r" * 32
    store = QueueStore(":memory:")
    failed = _failed(store, 20, now=10)
    other_failed = _failed(store, 21, now=20)
    completed_source = _enqueue(store, 22, now=30)
    claimed = store.claim("completed-worker", now=31)
    assert claimed is not None
    completed, _ = store.append_event(
        completed_source.job_id,
        lease_id=claimed.lease_id or "",
        event_id="completed-22",
        state="completed",
        task_id="task-22",
        percent=100,
        now=32,
    )
    app = create_app(_settings(token), store=store, provider=object())
    try:
        with TestClient(app) as client:
            first = client.post(
                f"/v1/jobs/{failed.job_id}/retry",
                headers=_auth(token),
                json={"schema": 1, "requestId": "retry-api-1"},
            )
            assert first.status_code == 200
            new_job = first.json()["job"]
            assert new_job["status"] == "queued"
            assert new_job["parentJobId"] == failed.job_id
            repeated = client.post(
                f"/v1/jobs/{failed.job_id}/retry",
                headers=_auth(token),
                json={"schema": 1, "requestId": "retry-api-1"},
            )
            assert repeated.status_code == 200
            assert repeated.json()["idempotent"] is True
            assert repeated.json()["job"]["jobId"] == new_job["jobId"]
            cross_job = client.post(
                f"/v1/jobs/{other_failed.job_id}/retry",
                headers=_auth(token),
                json={"schema": 1, "requestId": "retry-api-1"},
            )
            assert cross_job.status_code == 409
            assert client.post(
                f"/v1/jobs/{completed.job_id}/retry",
                headers=_auth(token),
                json={"schema": 1, "requestId": "retry-completed"},
            ).status_code == 409
            assert client.post(
                f"/v1/jobs/{failed.job_id}/cancel",
                headers=_auth(token),
                json={"schema": 1, "requestId": "cancel-failed"},
            ).status_code == 409
    finally:
        store.close()


def test_api_queued_cancel_claimed_cancel_action_and_event_idempotency() -> None:
    token = "c" * 32
    store = QueueStore(":memory:")
    # claim() takes the oldest queued job; create the active fixture first so
    # the separately named queued fixture remains available for direct cancel.
    active = _enqueue(store, 31, now=10)
    queued = _enqueue(store, 30, now=20)
    active_claim = store.claim("job-worker", now=21)
    assert active_claim is not None
    app = create_app(_settings(token), store=store, provider=object())
    try:
        with TestClient(app) as client:
            direct = client.post(
                f"/v1/jobs/{queued.job_id}/cancel",
                headers=_auth(token),
                json={"schema": 1, "requestId": "cancel-queued-api"},
            )
            assert direct.status_code == 200
            assert direct.json()["action"]["status"] == "applied"
            assert direct.json()["job"]["status"] == "cancelled"
            assert client.get(
                f"/v1/jobs/{queued.job_id}", headers=_auth(token)
            ).json()["job"]["status"] == "cancelled"
            direct_repeat = client.post(
                f"/v1/jobs/{queued.job_id}/cancel",
                headers=_auth(token),
                json={"schema": 1, "requestId": "cancel-queued-api"},
            )
            assert direct_repeat.status_code == 200
            assert direct_repeat.json()["idempotent"] is True

            pending = client.post(
                f"/v1/jobs/{active.job_id}/cancel",
                headers=_auth(token),
                json={"schema": 1, "requestId": "cancel-active-api", "reason": "user"},
            )
            assert pending.status_code == 200
            assert pending.json()["action"]["status"] == "queued"
            pending_repeat = client.post(
                f"/v1/jobs/{active.job_id}/cancel",
                headers=_auth(token),
                json={"schema": 1, "requestId": "cancel-active-api-repeat"},
            )
            assert pending_repeat.status_code == 200
            assert pending_repeat.json()["idempotent"] is True
            assert pending_repeat.json()["action"]["actionId"] == pending.json()["action"]["actionId"]
            wrong_worker = client.post(
                "/v1/actions/claim",
                headers=_auth(token),
                json={"schema": 1, "workerId": "action-worker", "leaseSeconds": 120},
            )
            assert wrong_worker.status_code == 200
            assert wrong_worker.json()["action"] is None
            action_claim = client.post(
                "/v1/actions/claim",
                headers=_auth(token),
                json={"schema": 1, "workerId": "job-worker", "leaseSeconds": 120},
            )
            assert action_claim.status_code == 200
            action = action_claim.json()["action"]
            assert action["type"] == "cancel_task"
            event = {
                "schema": 1,
                "leaseId": action["leaseId"],
                "eventId": "cancel-event-api",
                "state": "applied",
                "result": {"ok": True},
            }
            applied = client.post(
                f"/v1/actions/{action['actionId']}/events",
                headers=_auth(token),
                json=event,
            )
            assert applied.status_code == 200
            assert applied.json()["job"]["status"] == "cancelled"
            replay = client.post(
                f"/v1/actions/{action['actionId']}/events",
                headers=_auth(token),
                json=event,
            )
            assert replay.status_code == 200
            assert replay.json()["idempotent"] is True
            cancel_replay = client.post(
                f"/v1/jobs/{active.job_id}/cancel",
                headers=_auth(token),
                json={"schema": 1, "requestId": "cancel-active-api-repeat"},
            )
            assert cancel_replay.status_code == 200
            assert cancel_replay.json()["idempotent"] is True
            assert cancel_replay.json()["action"]["actionId"] == action["actionId"]
            conflict = client.post(
                f"/v1/actions/{action['actionId']}/events",
                headers=_auth(token),
                json={**event, "result": {"ok": False}},
            )
            assert conflict.status_code == 409
            late = client.post(
                f"/v1/jobs/{active.job_id}/events",
                headers=_auth(token),
                json={
                    "schema": 1,
                    "leaseId": active_claim.lease_id,
                    "eventId": "late-after-cancel",
                    "state": "progress",
                    "taskId": "task-late",
                },
            )
            assert late.status_code == 409
            listed = client.get(
                "/v1/jobs?status=cancelled", headers=_auth(token)
            ).json()["jobs"]
            assert {item["jobId"] for item in listed} == {queued.job_id, active.job_id}
    finally:
        store.close()


def test_api_cancel_ack_after_job_terminal_event_is_idempotently_accepted() -> None:
    token = "z" * 32
    store = QueueStore(":memory:")
    active = _enqueue(store, 40, now=10)
    claimed = store.claim("job-worker", now=11)
    assert claimed is not None
    app = create_app(_settings(token), store=store, provider=object())
    try:
        with TestClient(app) as client:
            pending = client.post(
                f"/v1/jobs/{active.job_id}/cancel",
                headers=_auth(token),
                json={"schema": 1, "requestId": "cancel-race-api"},
            )
            assert pending.status_code == 200
            action_id = pending.json()["action"]["actionId"]
            action_claim = client.post(
                "/v1/actions/claim",
                headers=_auth(token),
                json={"schema": 1, "workerId": "job-worker", "leaseSeconds": 120},
            )
            assert action_claim.status_code == 200
            action = action_claim.json()["action"]
            assert action["actionId"] == action_id

            completed, _ = store.append_event(
                active.job_id,
                lease_id=claimed.lease_id or "",
                event_id="completed-before-cancel-api",
                state="completed",
                task_id="task-race-api",
                percent=100,
                now=12,
            )
            assert completed.status == "completed"
            event = {
                "schema": 1,
                "leaseId": action["leaseId"],
                "eventId": "cancel-race-api-event",
                "state": "applied",
                "result": {"noop": True},
            }
            result = client.post(
                f"/v1/actions/{action_id}/events",
                headers=_auth(token),
                json=event,
            )
            assert result.status_code == 200
            assert result.json()["action"]["status"] == "applied"
            assert result.json()["job"]["status"] == "completed"
            replay = client.post(
                f"/v1/actions/{action_id}/events",
                headers=_auth(token),
                json=event,
            )
            assert replay.status_code == 200
            assert replay.json()["idempotent"] is True
    finally:
        store.close()
