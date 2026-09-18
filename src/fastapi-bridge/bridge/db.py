"""Durable SQLite queue, leases, event idempotency and Telegram callbacks."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


class QueueError(RuntimeError):
    """Base class for safe, client-visible queue conflicts."""


class UnknownJob(QueueError):
    pass


class LeaseConflict(QueueError):
    pass


class StateConflict(QueueError):
    pass


TERMINAL_STATES = frozenset({"completed", "failed", "uncertain"})
STATE_TRANSITIONS = {
    # A browser can finish a very fast 115 submission before it has flushed
    # an explicit accepted event.  The event still carries the same lease and
    # task identifier, so accepting these direct transitions avoids wedging a
    # durable outbox after a worker restart.
    "claimed": frozenset(
        {"accepted", "progress", "completed", "failed", "uncertain"}
    ),
    "accepted": frozenset(
        {"accepted", "progress", "completed", "failed", "uncertain"}
    ),
    "progress": frozenset({"progress", "completed", "failed", "uncertain"}),
}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _now() -> float:
    return time.time()


def _token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class JobRecord:
    job_id: str
    lease_id: str | None
    intent: dict[str, Any]
    status: str
    worker_id: str | None
    lease_until: float | None
    attempt_count: int
    task_id: str | None
    remote_id: str | None
    percent: float | None
    message: str | None
    error_code: str | None
    error_message: str | None
    created_at: float
    updated_at: float
    telegram_chat_id: int | None
    telegram_user_id: int | None
    telegram_message_id: int | None
    status_message_id: int | None
    candidate_key: str | None
    last_notified_state: str | None
    last_notified_percent: float | None

    def claim_payload(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "leaseId": self.lease_id or "",
            "intent": self.intent,
            # A claim can be a same-worker recovery after the extension lost
            # its local mapping.  The browser must inspect these fields before
            # deciding whether a 115 submission is safe to start again.
            "status": self.status,
            "recovered": self.status != "claimed" or self.attempt_count > 1,
            "attemptCount": self.attempt_count,
            "taskId": self.task_id,
            "remoteId": self.remote_id,
        }

    def internal_payload(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "status": self.status,
            "intent": self.intent,
            "taskId": self.task_id,
            "remoteId": self.remote_id,
            "percent": self.percent,
            "message": self.message,
            "errorCode": self.error_code,
            "errorMessage": self.error_message,
            "telegramChatId": self.telegram_chat_id,
            "telegramUserId": self.telegram_user_id,
            "telegramMessageId": self.telegram_message_id,
            "statusMessageId": self.status_message_id,
            "candidateKey": self.candidate_key,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class QueueStore:
    """A single-process SQLite store with explicit transaction boundaries.

    The bridge is intentionally a single local process. The lock makes
    concurrent FastAPI worker threads safe, while BEGIN IMMEDIATE keeps claim
    and callback consumption atomic at the database level as well.
    """

    def __init__(
        self,
        path: str | Path,
        *,
        default_lease_seconds: int = 120,
    ) -> None:
        self.path = str(path)
        self.default_lease_seconds = int(default_lease_seconds)
        self._lock = threading.RLock()
        if self.path != ":memory:":
            Path(self.path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(
            self.path,
            timeout=30,
            isolation_level=None,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA busy_timeout = 30000")
        if self.path != ":memory:":
            self._connection.execute("PRAGMA journal_mode = WAL")
        self.initialize()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def initialize(self) -> None:
        with self._lock:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    intent_json TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN (
                            'queued', 'claimed', 'accepted', 'progress',
                            'completed', 'failed', 'uncertain'
                        )
                    ),
                    worker_id TEXT,
                    lease_id TEXT,
                    lease_until REAL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    task_id TEXT,
                    remote_id TEXT,
                    percent REAL,
                    message TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    telegram_chat_id INTEGER,
                    telegram_user_id INTEGER,
                    telegram_message_id INTEGER,
                    status_message_id INTEGER,
                    candidate_key TEXT,
                    last_notified_state TEXT,
                    last_notified_percent REAL
                );

                CREATE INDEX IF NOT EXISTS jobs_claim_idx
                    ON jobs(status, lease_until, created_at);
                CREATE INDEX IF NOT EXISTS jobs_telegram_idx
                    ON jobs(telegram_chat_id, candidate_key, created_at);

                CREATE TABLE IF NOT EXISTS job_events (
                    event_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
                    event_id TEXT NOT NULL,
                    lease_id TEXT NOT NULL,
                    state TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    UNIQUE(job_id, event_id)
                );

                CREATE TABLE IF NOT EXISTS callback_tokens (
                    token_hash TEXT PRIMARY KEY,
                    chat_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    message_id INTEGER NOT NULL,
                    candidate_json TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    used_at REAL
                );
                CREATE INDEX IF NOT EXISTS callback_expiry_idx
                    ON callback_tokens(expires_at, used_at);

                CREATE TABLE IF NOT EXISTS bridge_state (
                    state_key TEXT PRIMARY KEY,
                    state_value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                """
            )

    def _row_to_job(self, row: sqlite3.Row | None) -> JobRecord | None:
        if row is None:
            return None
        return JobRecord(
            job_id=str(row["job_id"]),
            lease_id=str(row["lease_id"]) if row["lease_id"] else None,
            intent=json.loads(row["intent_json"]),
            status=str(row["status"]),
            worker_id=str(row["worker_id"]) if row["worker_id"] else None,
            lease_until=float(row["lease_until"]) if row["lease_until"] is not None else None,
            attempt_count=int(row["attempt_count"] or 0),
            task_id=str(row["task_id"]) if row["task_id"] else None,
            remote_id=str(row["remote_id"]) if row["remote_id"] else None,
            percent=float(row["percent"]) if row["percent"] is not None else None,
            message=str(row["message"]) if row["message"] else None,
            error_code=str(row["error_code"]) if row["error_code"] else None,
            error_message=str(row["error_message"]) if row["error_message"] else None,
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            telegram_chat_id=(
                int(row["telegram_chat_id"])
                if row["telegram_chat_id"] is not None
                else None
            ),
            telegram_user_id=(
                int(row["telegram_user_id"])
                if row["telegram_user_id"] is not None
                else None
            ),
            telegram_message_id=(
                int(row["telegram_message_id"])
                if row["telegram_message_id"] is not None
                else None
            ),
            status_message_id=(
                int(row["status_message_id"])
                if row["status_message_id"] is not None
                else None
            ),
            candidate_key=str(row["candidate_key"]) if row["candidate_key"] else None,
            last_notified_state=(
                str(row["last_notified_state"])
                if row["last_notified_state"]
                else None
            ),
            last_notified_percent=(
                float(row["last_notified_percent"])
                if row["last_notified_percent"] is not None
                else None
            ),
        )

    def _get_job_locked(self, job_id: str) -> JobRecord | None:
        row = self._connection.execute(
            "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        return self._row_to_job(row)

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._lock:
            return self._get_job_locked(str(job_id))

    def list_jobs(
        self,
        *,
        telegram_only: bool = False,
        include_terminal: bool = True,
        changed_only: bool = False,
        limit: int = 500,
    ) -> list[JobRecord]:
        """Return a bounded, oldest-first snapshot for status notifications.

        Telegram status delivery reads the same durable queue as the HTTP
        worker.  Keeping this query on the store avoids a second source of
        truth and lets tests inspect notifications without an HTTP round trip.
        """

        bounded_limit = max(1, min(int(limit), 5000))
        clauses: list[str] = []
        parameters: list[Any] = []
        if telegram_only:
            clauses.append("telegram_chat_id IS NOT NULL")
        if not include_terminal:
            clauses.append("status NOT IN ('completed', 'failed', 'uncertain')")
        if changed_only:
            clauses.append(
                "(status_message_id IS NULL OR last_notified_state IS NULL "
                "OR last_notified_state <> status "
                "OR (last_notified_percent IS NULL AND percent IS NOT NULL) "
                "OR (last_notified_percent IS NOT NULL AND percent IS NULL) "
                "OR (last_notified_percent IS NOT NULL AND percent IS NOT NULL "
                "AND last_notified_percent <> percent))"
            )
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT * FROM jobs
                {where}
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (*parameters, bounded_limit),
            ).fetchall()
            return [record for row in rows if (record := self._row_to_job(row))]

    def enqueue(
        self,
        intent: Mapping[str, Any],
        *,
        candidate_key: str,
        telegram_chat_id: int,
        telegram_user_id: int,
        telegram_message_id: int,
        now: float | None = None,
    ) -> tuple[JobRecord, bool]:
        """Insert a Telegram-selected job, returning (record, inserted)."""

        now = _now() if now is None else float(now)
        candidate_key = str(candidate_key).strip()
        if not candidate_key:
            raise ValueError("candidate_key 不能为空")
        job_id = str(uuid.uuid4())
        normalized_intent = dict(intent)
        normalized_intent["jobId"] = job_id
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                existing_row = self._connection.execute(
                    """
                    SELECT * FROM jobs
                    WHERE telegram_chat_id = ?
                      AND candidate_key = ?
                      AND status <> 'failed'
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (int(telegram_chat_id), candidate_key),
                ).fetchone()
                existing = self._row_to_job(existing_row)
                if existing:
                    self._connection.execute("COMMIT")
                    return existing, False

                self._connection.execute(
                    """
                    INSERT INTO jobs (
                        job_id, intent_json, status, attempt_count,
                        created_at, updated_at,
                        telegram_chat_id, telegram_user_id, telegram_message_id,
                        candidate_key
                    ) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        _json(normalized_intent),
                        now,
                        now,
                        int(telegram_chat_id),
                        int(telegram_user_id),
                        int(telegram_message_id),
                        candidate_key,
                    ),
                )
                record = self._get_job_locked(job_id)
                self._connection.execute("COMMIT")
                assert record is not None
                return record, True
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def consume_callback_and_enqueue(
        self,
        raw_token: str,
        *,
        chat_id: int,
        user_id: int,
        message_id: int,
        intent: Mapping[str, Any],
        candidate_key: str,
        now: float | None = None,
    ) -> tuple[JobRecord, bool] | None:
        """Consume a callback and insert its job in one SQLite transaction.

        Marking a callback used before queue insertion would lose the only
        durable representation of a Telegram selection if the process stopped
        between the two writes.  This method keeps both mutations under one
        ``BEGIN IMMEDIATE`` boundary; a failed insert leaves the button live
        for a later retry.
        """

        candidate_key = str(candidate_key).strip()
        if not candidate_key:
            raise ValueError("candidate_key 不能为空")
        now = _now() if now is None else float(now)
        token_hash = _token_hash(str(raw_token))
        normalized_intent = dict(intent)
        job_id = str(uuid.uuid4())
        normalized_intent["jobId"] = job_id
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                callback = self._connection.execute(
                    "SELECT * FROM callback_tokens WHERE token_hash = ?",
                    (token_hash,),
                ).fetchone()
                if callback is None:
                    self._connection.execute("COMMIT")
                    return None
                if (
                    callback["used_at"] is not None
                    or float(callback["expires_at"]) <= now
                    or int(callback["chat_id"]) != int(chat_id)
                    or int(callback["user_id"]) != int(user_id)
                    or int(callback["message_id"]) != int(message_id)
                ):
                    self._connection.execute("COMMIT")
                    return None
                existing_row = self._connection.execute(
                    """
                    SELECT * FROM jobs
                    WHERE telegram_chat_id = ?
                      AND candidate_key = ?
                      AND status <> 'failed'
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (int(chat_id), candidate_key),
                ).fetchone()
                existing = self._row_to_job(existing_row)
                if existing is not None:
                    self._connection.execute(
                        "UPDATE callback_tokens SET used_at = ? WHERE token_hash = ?",
                        (now, token_hash),
                    )
                    self._connection.execute("COMMIT")
                    return existing, False
                self._connection.execute(
                    """
                    INSERT INTO jobs (
                        job_id, intent_json, status, attempt_count,
                        created_at, updated_at,
                        telegram_chat_id, telegram_user_id, telegram_message_id,
                        candidate_key
                    ) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        _json(normalized_intent),
                        now,
                        now,
                        int(chat_id),
                        int(user_id),
                        int(message_id),
                        candidate_key,
                    ),
                )
                self._connection.execute(
                    "UPDATE callback_tokens SET used_at = ? WHERE token_hash = ?",
                    (now, token_hash),
                )
                record = self._get_job_locked(job_id)
                self._connection.execute("COMMIT")
                assert record is not None
                return record, True
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def claim(
        self,
        worker_id: str,
        *,
        lease_seconds: int | None = None,
        now: float | None = None,
    ) -> JobRecord | None:
        """Claim queued work or recover an expired lease for the same worker.

        An expired lease held by another worker is deliberately never returned
        to a new worker. This prevents an already submitted 115 task from
        being submitted a second time after a browser restart. The extension
        may report an uncertain event for an unresolvable claim.
        """

        worker_id = str(worker_id).strip()
        if not worker_id:
            raise ValueError("worker_id 不能为空")
        seconds = (
            self.default_lease_seconds
            if lease_seconds is None
            else int(lease_seconds)
        )
        if not 15 <= seconds <= 900:
            raise ValueError("lease_seconds 必须在 15 到 900 秒之间")
        now = _now() if now is None else float(now)
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._connection.execute(
                    """
                    SELECT *
                    FROM jobs
                    WHERE status = 'queued'
                       OR (
                           status IN ('claimed', 'accepted', 'progress')
                           AND worker_id = ?
                           AND lease_until IS NOT NULL
                           AND lease_until <= ?
                       )
                    ORDER BY
                        CASE WHEN status = 'queued' THEN 0 ELSE 1 END,
                        created_at ASC
                    LIMIT 1
                    """,
                    (worker_id, now),
                ).fetchone()
                if row is None:
                    self._connection.execute("COMMIT")
                    return None
                old_status = str(row["status"])
                job_id = str(row["job_id"])
                # A recovered claim keeps its lease ID. This lets a browser
                # that was asleep while a lease elapsed flush an already
                # persisted event without turning it into a second submission.
                lease_id = (
                    str(row["lease_id"])
                    if old_status != "queued" and row["lease_id"]
                    else str(uuid.uuid4())
                )
                self._connection.execute(
                    """
                    UPDATE jobs
                    SET status = ?,
                        worker_id = ?,
                        lease_id = ?,
                        lease_until = ?,
                        attempt_count = attempt_count + 1,
                        updated_at = ?
                    WHERE job_id = ?
                    """,
                    (
                        "claimed" if old_status == "queued" else old_status,
                        worker_id,
                        lease_id,
                        now + seconds,
                        now,
                        job_id,
                    ),
                )
                record = self._get_job_locked(job_id)
                self._connection.execute("COMMIT")
                assert record is not None
                return record
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def append_event(
        self,
        job_id: str,
        *,
        lease_id: str,
        event_id: str,
        state: str,
        task_id: str | None = None,
        remote_id: str | None = None,
        percent: float | None = None,
        message: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        now: float | None = None,
    ) -> tuple[JobRecord, bool]:
        """Apply one event; return (current record, idempotent replay)."""

        job_id = str(job_id).strip()
        lease_id = str(lease_id).strip()
        event_id = str(event_id).strip()
        state = str(state).strip().lower()
        if not job_id or not lease_id or not event_id:
            raise ValueError("jobId、leaseId、eventId 不能为空")
        if state not in {"accepted", "progress", "completed", "failed", "uncertain"}:
            raise ValueError("未知任务状态")
        now = _now() if now is None else float(now)
        payload = {
            "schema": 1,
            "leaseId": lease_id,
            "eventId": event_id,
            "state": state,
            "taskId": task_id,
            "remoteId": remote_id,
            "percent": percent,
            "message": message,
            "errorCode": error_code,
            "errorMessage": error_message,
        }
        payload_json = _json(payload)
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                job = self._get_job_locked(job_id)
                if job is None:
                    raise UnknownJob("找不到 bridge job")
                duplicate_row = self._connection.execute(
                    """
                    SELECT payload_json FROM job_events
                    WHERE job_id = ? AND event_id = ?
                    """,
                    (job_id, event_id),
                ).fetchone()
                if duplicate_row is not None:
                    if str(duplicate_row["payload_json"]) != payload_json:
                        raise StateConflict("eventId 已用于另一份事件")
                    self._connection.execute("COMMIT")
                    return job, True

                if job.lease_id != lease_id:
                    raise LeaseConflict("租约无效或已由同一 worker 更新")
                if job.status in TERMINAL_STATES:
                    raise StateConflict("终态任务不可再次变更")
                if state not in STATE_TRANSITIONS.get(job.status, frozenset()):
                    raise StateConflict(f"不允许从 {job.status} 转移到 {state}")
                if state in {"progress", "completed"} and not (
                    task_id or job.task_id
                ):
                    raise StateConflict(f"{state} 事件必须带 taskId")

                next_lease_until = (
                    None
                    if state in TERMINAL_STATES
                    else now + self.default_lease_seconds
                )
                self._connection.execute(
                    """
                    UPDATE jobs
                    SET status = ?,
                        lease_until = ?,
                        task_id = COALESCE(?, task_id),
                        remote_id = COALESCE(?, remote_id),
                        percent = COALESCE(?, percent),
                        message = COALESCE(?, message),
                        error_code = COALESCE(?, error_code),
                        error_message = COALESCE(?, error_message),
                        updated_at = ?
                    WHERE job_id = ?
                    """,
                    (
                        state,
                        next_lease_until,
                        task_id,
                        remote_id,
                        percent,
                        message,
                        error_code,
                        error_message,
                        now,
                        job_id,
                    ),
                )
                self._connection.execute(
                    """
                    INSERT INTO job_events (
                        job_id, event_id, lease_id, state, payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (job_id, event_id, lease_id, state, payload_json, now),
                )
                current = self._get_job_locked(job_id)
                self._connection.execute("COMMIT")
                assert current is not None
                return current, False
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def set_status_message_id(self, job_id: str, message_id: int) -> JobRecord:
        with self._lock:
            self._connection.execute(
                """
                UPDATE jobs SET status_message_id = ?, updated_at = ?
                WHERE job_id = ?
                """,
                (int(message_id), _now(), str(job_id)),
            )
            record = self._get_job_locked(str(job_id))
            if record is None:
                raise UnknownJob("找不到 bridge job")
            return record

    def mark_notified(
        self,
        job_id: str,
        *,
        state: str,
        percent: float | None,
    ) -> JobRecord:
        with self._lock:
            self._connection.execute(
                """
                UPDATE jobs
                SET last_notified_state = ?, last_notified_percent = ?, updated_at = ?
                WHERE job_id = ?
                """,
                (str(state), percent, _now(), str(job_id)),
            )
            record = self._get_job_locked(str(job_id))
            if record is None:
                raise UnknownJob("找不到 bridge job")
            return record

    def create_callback(
        self,
        raw_token: str,
        *,
        chat_id: int,
        user_id: int,
        message_id: int,
        candidate: Mapping[str, Any],
        expires_at: float,
    ) -> None:
        token_hash = _token_hash(str(raw_token))
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO callback_tokens (
                    token_hash, chat_id, user_id, message_id,
                    candidate_json, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    token_hash,
                    int(chat_id),
                    int(user_id),
                    int(message_id),
                    _json(dict(candidate)),
                    float(expires_at),
                ),
            )

    def peek_callback(
        self,
        raw_token: str,
        *,
        chat_id: int,
        user_id: int,
        message_id: int,
        now: float | None = None,
    ) -> dict[str, Any] | None:
        """Read a live callback payload without consuming its one-time token."""

        now = _now() if now is None else float(now)
        token_hash = _token_hash(str(raw_token))
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM callback_tokens WHERE token_hash = ?",
                (token_hash,),
            ).fetchone()
            if row is None:
                return None
            if (
                row["used_at"] is not None
                or float(row["expires_at"]) <= now
                or int(row["chat_id"]) != int(chat_id)
                or int(row["user_id"]) != int(user_id)
                or int(row["message_id"]) != int(message_id)
            ):
                return None
            return json.loads(row["candidate_json"])

    def consume_callback(
        self,
        raw_token: str,
        *,
        chat_id: int,
        user_id: int,
        message_id: int,
        now: float | None = None,
    ) -> dict[str, Any] | None:
        """Consume only a matching, live, one-time callback token."""

        now = _now() if now is None else float(now)
        token_hash = _token_hash(str(raw_token))
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._connection.execute(
                    "SELECT * FROM callback_tokens WHERE token_hash = ?",
                    (token_hash,),
                ).fetchone()
                if row is None:
                    self._connection.execute("COMMIT")
                    return None
                if (
                    row["used_at"] is not None
                    or float(row["expires_at"]) <= now
                    or int(row["chat_id"]) != int(chat_id)
                    or int(row["user_id"]) != int(user_id)
                    or int(row["message_id"]) != int(message_id)
                ):
                    self._connection.execute("COMMIT")
                    return None
                self._connection.execute(
                    """
                    UPDATE callback_tokens SET used_at = ?
                    WHERE token_hash = ?
                    """,
                    (now, token_hash),
                )
                candidate = json.loads(row["candidate_json"])
                self._connection.execute("COMMIT")
                return candidate
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def purge_expired_callbacks(self, *, now: float | None = None) -> int:
        now = _now() if now is None else float(now)
        with self._lock:
            cursor = self._connection.execute(
                """
                DELETE FROM callback_tokens
                WHERE expires_at <= ? OR used_at IS NOT NULL
                """,
                (now,),
            )
            return int(cursor.rowcount)

    def get_state(self, key: str) -> str | None:
        """Read a small durable cursor used by the Telegram poller."""

        with self._lock:
            row = self._connection.execute(
                "SELECT state_value FROM bridge_state WHERE state_key = ?",
                (str(key),),
            ).fetchone()
            return str(row["state_value"]) if row is not None else None

    def set_state(self, key: str, value: str) -> None:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO bridge_state (state_key, state_value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(state_key) DO UPDATE SET
                    state_value = excluded.state_value,
                    updated_at = excluded.updated_at
                """,
                (str(key), str(value), _now()),
            )
