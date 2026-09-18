from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from bridge.db import QueueStore, StateConflict


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
