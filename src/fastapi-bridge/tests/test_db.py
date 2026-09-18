from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import sqlite3

import pytest

from bridge.db import LeaseConflict, QueueStore, StateConflict


def _intent(index: int) -> dict[str, str]:
    return {
        "jobId": f"source-{index}",
        "url": f"magnet:?xt=urn:btih:{index:032x}",
        "code": f"ABC-{index:03d}",
    }


def test_claim_is_atomic_and_same_worker_recovery_keeps_lease() -> None:
    store = QueueStore(":memory:", default_lease_seconds=30)
    try:
        for index in range(6):
            store.enqueue(
                _intent(index),
                candidate_key=f"btih:{index}",
                telegram_chat_id=1,
                telegram_user_id=2,
                telegram_message_id=index + 1,
                now=10,
            )
        with ThreadPoolExecutor(max_workers=6) as pool:
            records = list(
                pool.map(lambda number: store.claim(f"worker-{number}", now=11), range(6))
            )
        claimed = [record for record in records if record is not None]
        assert len(claimed) == 6
        assert len({record.job_id for record in claimed}) == 6

        first = claimed[0]
        assert first.claim_payload()["recovered"] is False
        recovered = store.claim(
            "worker-0",
            lease_seconds=45,
            now=(first.lease_until or 0) + 1,
        )
        assert recovered is not None
        assert recovered.job_id == first.job_id
        assert recovered.lease_id == first.lease_id
        assert recovered.claim_payload()["recovered"] is True
        assert recovered.claim_payload()["status"] == "claimed"
        assert store.claim("other-worker", now=(recovered.lease_until or 0) + 1) is None
    finally:
        store.close()


def test_events_are_idempotent_and_terminal_states_do_not_downgrade() -> None:
    store = QueueStore(":memory:")
    try:
        job, _ = store.enqueue(
            _intent(1),
            candidate_key="btih:one",
            telegram_chat_id=1,
            telegram_user_id=2,
            telegram_message_id=3,
            now=10,
        )
        claimed = store.claim("worker", now=11)
        assert claimed is not None
        current, replay = store.append_event(
            job.job_id,
            lease_id=claimed.lease_id or "",
            event_id="accepted-1",
            state="accepted",
            task_id="task-1",
            now=12,
        )
        assert current.status == "accepted"
        assert replay is False
        replayed, is_replay = store.append_event(
            job.job_id,
            lease_id=claimed.lease_id or "",
            event_id="accepted-1",
            state="accepted",
            task_id="task-1",
            now=13,
        )
        assert replayed.status == "accepted"
        assert is_replay is True
        completed, _ = store.append_event(
            job.job_id,
            lease_id=claimed.lease_id or "",
            event_id="completed-1",
            state="completed",
            task_id="task-1",
            percent=100,
            now=14,
        )
        assert completed.status == "completed"
        with pytest.raises(StateConflict):
            store.append_event(
                job.job_id,
                lease_id=claimed.lease_id or "",
                event_id="progress-after-terminal",
                state="progress",
                task_id="task-1",
                now=15,
            )
    finally:
        store.close()


def test_callback_replay_is_one_time_and_atomic_with_enqueue() -> None:
    store = QueueStore(":memory:")
    try:
        store.create_callback(
            "callback-token-12345678901234567890",
            chat_id=11,
            user_id=22,
            message_id=33,
            candidate={"intent": _intent(3), "candidateKey": "btih:three"},
            expires_at=100,
        )
        result = store.consume_callback_and_enqueue(
            "callback-token-12345678901234567890",
            chat_id=11,
            user_id=22,
            message_id=33,
            intent=_intent(3),
            candidate_key="btih:three",
            now=50,
        )
        assert result is not None
        record, inserted = result
        assert inserted is True
        assert record.status == "queued"
        assert store.consume_callback_and_enqueue(
            "callback-token-12345678901234567890",
            chat_id=11,
            user_id=22,
            message_id=33,
            intent=_intent(3),
            candidate_key="btih:three",
            now=51,
        ) is None
    finally:
        store.close()


def test_changed_job_query_does_not_starve_after_many_notified_history_rows() -> None:
    store = QueueStore(":memory:")
    try:
        for index in range(501):
            job, _ = store.enqueue(
                _intent(index),
                candidate_key=f"history:{index}",
                telegram_chat_id=1,
                telegram_user_id=2,
                telegram_message_id=index + 1,
                now=float(index),
            )
            claimed = store.claim(f"history-worker-{index}", now=float(index) + 1)
            assert claimed is not None
            accepted, _ = store.append_event(
                job.job_id,
                lease_id=claimed.lease_id or "",
                event_id=f"history-accepted-{index}",
                state="accepted",
                task_id=f"history-task-{index}",
                now=float(index) + 2,
            )
            completed, _ = store.append_event(
                job.job_id,
                lease_id=accepted.lease_id or "",
                event_id=f"history-completed-{index}",
                state="completed",
                task_id=f"history-task-{index}",
                percent=100,
                now=float(index) + 3,
            )
            store.set_status_message_id(completed.job_id, index + 10000)
            store.mark_notified(completed.job_id, state="completed", percent=100)
        fresh, _ = store.enqueue(
            _intent(900),
            candidate_key="fresh",
            telegram_chat_id=1,
            telegram_user_id=2,
            telegram_message_id=900,
            now=1000,
        )
        changed = store.list_jobs(
            telegram_only=True,
            changed_only=True,
            limit=500,
        )
        assert [record.job_id for record in changed] == [fresh.job_id]
    finally:
        store.close()


def test_v1_database_migrates_without_losing_jobs_or_events(tmp_path) -> None:
    path = tmp_path / "bridge.sqlite3"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued','claimed','accepted','progress','completed','failed','uncertain')),
            worker_id TEXT, lease_id TEXT, lease_until REAL,
            attempt_count INTEGER NOT NULL DEFAULT 0, task_id TEXT, remote_id TEXT,
            percent REAL, message TEXT, error_code TEXT, error_message TEXT,
            created_at REAL NOT NULL, updated_at REAL NOT NULL,
            telegram_chat_id INTEGER, telegram_user_id INTEGER, telegram_message_id INTEGER,
            status_message_id INTEGER, candidate_key TEXT,
            last_notified_state TEXT, last_notified_percent REAL
        );
        CREATE TABLE job_events (
            event_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            event_id TEXT NOT NULL, lease_id TEXT NOT NULL, state TEXT NOT NULL,
            payload_json TEXT NOT NULL, created_at REAL NOT NULL,
            UNIQUE(job_id, event_id)
        );
        CREATE TABLE callback_tokens (
            token_hash TEXT PRIMARY KEY, chat_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
            candidate_json TEXT NOT NULL, expires_at REAL NOT NULL, used_at REAL
        );
        CREATE TABLE bridge_state (
            state_key TEXT PRIMARY KEY, state_value TEXT NOT NULL, updated_at REAL NOT NULL
        );
        INSERT INTO jobs(job_id, intent_json, status, created_at, updated_at)
        VALUES ('legacy-job', '{"jobId":"legacy-job","url":"magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', 'queued', 1, 1);
        INSERT INTO job_events(job_id, event_id, lease_id, state, payload_json, created_at)
        VALUES ('legacy-job', 'legacy-event', 'legacy-lease', 'accepted', '{}', 2);
        INSERT INTO callback_tokens(token_hash, chat_id, user_id, message_id, candidate_json, expires_at)
        VALUES ('legacy-token', 11, 22, 33, '{"candidate":"legacy"}', 999);
        INSERT INTO bridge_state(state_key, state_value, updated_at)
        VALUES ('legacy-state', 'cursor-1', 3);
        """
    )
    connection.close()

    store = QueueStore(path)
    try:
        job = store.get_job("legacy-job")
        assert job is not None
        assert job.status == "queued"
        assert job.parent_job_id is None
        assert job.retry_count == 0
        assert store._connection.execute("PRAGMA user_version").fetchone()[0] == 2
        assert store._connection.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 1
        assert store._connection.execute("SELECT COUNT(*) FROM callback_tokens").fetchone()[0] == 1
        assert store.get_state("legacy-state") == "cursor-1"
        assert not store._connection.execute("PRAGMA foreign_key_check").fetchall()
        store.initialize()
        assert store.get_job("legacy-job") is not None
        assert not store._connection.execute("PRAGMA foreign_key_check").fetchall()
        tables = {
            row[0]
            for row in store._connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert {
            "actions",
            "action_events",
            "action_requests",
            "telegram_preferences",
        }.issubset(tables)
    finally:
        store.close()


def test_retry_clones_failed_job_and_request_id_is_idempotent() -> None:
    store = QueueStore(":memory:")
    try:
        source, _ = store.enqueue(
            _intent(10), candidate_key="retry", telegram_chat_id=1,
            telegram_user_id=2, telegram_message_id=3, now=10,
        )
        claimed = store.claim("worker", now=11)
        assert claimed is not None
        failed, _ = store.append_event(
            source.job_id, lease_id=claimed.lease_id or "", event_id="failed",
            state="failed", task_id="task", error_code="REMOTE_REJECTED", now=12,
        )
        retry, replay = store.clone_retry(failed.job_id, request_id="retry-1", now=13)
        same, same_replay = store.clone_retry(failed.job_id, request_id="retry-1", now=14)
        assert replay is False
        assert same_replay is True
        assert same.job_id == retry.job_id
        assert retry.parent_job_id == failed.job_id
        assert retry.status == "queued"
        assert retry.intent["jobId"] == retry.job_id
    finally:
        store.close()


def test_cancel_action_claim_apply_replay_and_worker_lease_rules() -> None:
    store = QueueStore(":memory:", default_lease_seconds=15)
    try:
        job, _ = store.enqueue(
            _intent(11), candidate_key="cancel", telegram_chat_id=1,
            telegram_user_id=2, telegram_message_id=3, now=10,
        )
        claimed = store.claim("worker", now=11)
        assert claimed is not None
        action, replay = store.request_cancel(job.job_id, request_id="cancel-1", now=12)
        assert replay is False
        assert action.status == "queued"
        mapped, mapped_replay = store.request_cancel(
            job.job_id, request_id="cancel-2", now=12.5
        )
        assert mapped_replay is True
        assert mapped.action_id == action.action_id
        assert store.claim_action("other", now=(action.created_at + 20)) is None
        store._connection.execute(
            "UPDATE jobs SET worker_id = NULL WHERE job_id = ?", (job.job_id,)
        )
        assert store.claim_action("worker", now=(action.created_at + 20)) is None
        store._connection.execute(
            "UPDATE jobs SET worker_id = ? WHERE job_id = ?", ("worker", job.job_id)
        )
        owner = store.claim_action("worker", now=(action.created_at + 20))
        assert owner is not None
        assert owner.action_id == action.action_id
        assert owner.lease_id
        assert store.claim_action("other", now=(owner.lease_until or 0) + 1) is None
        same_worker_recovery = store.claim_action("worker", now=(owner.lease_until or 0) + 1)
        assert same_worker_recovery is not None
        assert same_worker_recovery.lease_id == owner.lease_id
        applied, event_replay = store.append_action_event(
            action.action_id, lease_id=same_worker_recovery.lease_id or "",
            event_id="cancel-event", state="applied", result={"ok": True}, now=30,
        )
        assert event_replay is False
        assert applied.status == "applied"
        assert store.get_job(job.job_id).status == "cancelled"
        mapped_again, mapped_again_replay = store.request_cancel(
            job.job_id, request_id="cancel-2", now=31
        )
        assert mapped_again_replay is True
        assert mapped_again.action_id == action.action_id
        repeated, replayed = store.append_action_event(
            action.action_id, lease_id=same_worker_recovery.lease_id or "",
            event_id="cancel-event", state="applied", result={"ok": True}, now=31,
        )
        assert repeated.status == "applied"
        assert replayed is True
        with pytest.raises((StateConflict, LeaseConflict)):
            store.append_event(
                job.job_id, lease_id=claimed.lease_id or "", event_id="late",
                state="progress", task_id="task", now=32,
            )
    finally:
        store.close()


def test_cancel_ack_after_terminal_job_event_closes_action_without_overwriting_job() -> None:
    store = QueueStore(":memory:")
    try:
        job, _ = store.enqueue(
            _intent(13), candidate_key="cancel-race", telegram_chat_id=1,
            telegram_user_id=2, telegram_message_id=3, now=10,
        )
        claimed = store.claim("worker", now=11)
        assert claimed is not None
        action, _ = store.request_cancel(job.job_id, request_id="cancel-race", now=12)
        action_claim = store.claim_action("worker", now=13)
        assert action_claim is not None
        completed, _ = store.append_event(
            job.job_id,
            lease_id=claimed.lease_id or "",
            event_id="completed-before-cancel-ack",
            state="completed",
            task_id="task",
            percent=100,
            now=14,
        )
        assert completed.status == "completed"
        applied, replay = store.append_action_event(
            action.action_id,
            lease_id=action_claim.lease_id or "",
            event_id="cancel-race-ack",
            state="applied",
            result={"noop": True},
            now=15,
        )
        assert replay is False
        assert applied.status == "applied"
        assert store.get_job(job.job_id).status == "completed"
    finally:
        store.close()


def test_cancel_requests_reuse_one_inflight_action_per_job() -> None:
    store = QueueStore(":memory:")
    try:
        job, _ = store.enqueue(
            _intent(14), candidate_key="cancel-dedupe", telegram_chat_id=1,
            telegram_user_id=2, telegram_message_id=3, now=10,
        )
        claimed = store.claim("worker", now=11)
        assert claimed is not None
        first, first_replay = store.request_cancel(
            job.job_id, request_id="cancel-one", now=12
        )
        second, second_replay = store.request_cancel(
            job.job_id, request_id="cancel-two", now=13
        )
        assert first_replay is False
        assert second_replay is True
        assert second.action_id == first.action_id
        assert store._connection.execute(
            "SELECT COUNT(*) FROM actions WHERE job_id = ?", (job.job_id,)
        ).fetchone()[0] == 1
        action_claim = store.claim_action("worker", now=14)
        assert action_claim is not None
        applied, _ = store.append_action_event(
            action_claim.action_id,
            lease_id=action_claim.lease_id or "",
            event_id="cancel-one-applied",
            state="applied",
            result={"ok": True},
            now=15,
        )
        assert applied.status == "applied"
        assert store.get_job(job.job_id).status == "cancelled"
    finally:
        store.close()


def test_action_result_persistence_rejects_unbounded_json() -> None:
    store = QueueStore(":memory:")
    try:
        job, _ = store.enqueue(
            _intent(15), candidate_key="action-result", telegram_chat_id=1,
            telegram_user_id=2, telegram_message_id=3, now=10,
        )
        claimed = store.claim("worker", now=11)
        assert claimed is not None
        action, _ = store.request_cancel(job.job_id, request_id="result", now=12)
        action_claim = store.claim_action("worker", now=13)
        assert action_claim is not None
        with pytest.raises(ValueError):
            store.append_action_event(
                action.action_id,
                lease_id=action_claim.lease_id or "",
                event_id="too-many-result-nodes",
                state="failed",
                result={str(index): index for index in range(201)},
                now=14,
            )
    finally:
        store.close()


def test_queued_cancel_is_atomic_and_audited() -> None:
    store = QueueStore(":memory:")
    try:
        job, _ = store.enqueue(
            _intent(12), candidate_key="queued-cancel", telegram_chat_id=1,
            telegram_user_id=2, telegram_message_id=3, now=10,
        )
        action, _ = store.request_cancel(job.job_id, request_id="cancel-queued", now=11)
        assert action.status == "applied"
        assert store.get_job(job.job_id).status == "cancelled"
        row = store._connection.execute(
            "SELECT state FROM action_events WHERE action_id = ?", (action.action_id,)
        ).fetchone()
        assert row[0] == "applied"
    finally:
        store.close()


def test_telegram_jobs_are_user_scoped_and_cancelled_candidates_can_requeue() -> None:
    store = QueueStore(":memory:")
    try:
        first, first_inserted = store.enqueue(
            _intent(20),
            candidate_key="shared-candidate",
            telegram_chat_id=11,
            telegram_user_id=22,
            telegram_message_id=1,
            now=10,
        )
        other, other_inserted = store.enqueue(
            _intent(21),
            candidate_key="shared-candidate",
            telegram_chat_id=11,
            telegram_user_id=33,
            telegram_message_id=2,
            now=11,
        )
        assert first_inserted is True
        assert other_inserted is True
        assert first.job_id != other.job_id
        assert store.get_telegram_job(first.job_id, 11, 33) is None
        assert store.get_telegram_job(first.job_id, 11, 22).job_id == first.job_id

        cancelled_action, _ = store.request_cancel(
            first.job_id, request_id="telegram-cancel", now=12
        )
        assert cancelled_action.status == "applied"
        replacement, replacement_inserted = store.enqueue(
            _intent(22),
            candidate_key="shared-candidate",
            telegram_chat_id=11,
            telegram_user_id=22,
            telegram_message_id=3,
            now=13,
        )
        assert replacement_inserted is True
        assert replacement.job_id != first.job_id

        duplicate, duplicate_inserted = store.enqueue(
            _intent(23),
            candidate_key="shared-candidate",
            telegram_chat_id=11,
            telegram_user_id=33,
            telegram_message_id=4,
            now=14,
        )
        assert duplicate_inserted is False
        assert duplicate.job_id == other.job_id

        page, cursor = store.list_telegram_jobs_page(11, 22, limit=1)
        assert [record.job_id for record in page] == [replacement.job_id]
        assert cursor is not None
        older, no_cursor = store.list_telegram_jobs_page(11, 22, limit=1, cursor=cursor)
        assert [record.job_id for record in older] == [first.job_id]
        assert no_cursor is None
        assert store.list_telegram_jobs_page(11, 33)[0][0].job_id == other.job_id
        with pytest.raises(ValueError):
            store.list_telegram_jobs_page(11, 22, cursor=(float("nan"), "x"))
    finally:
        store.close()
