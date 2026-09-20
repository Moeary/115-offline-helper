"""Durable SQLite queue, leases, event idempotency and Telegram callbacks."""

from __future__ import annotations

import hashlib
import json
import math
import re
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


class UnknownAction(QueueError):
    pass


class LeaseConflict(QueueError):
    pass


class StateConflict(QueueError):
    pass


TERMINAL_STATES = frozenset({"completed", "failed", "uncertain", "cancelled"})
JOB_TERMINAL_STATES = TERMINAL_STATES
ACTION_TERMINAL_STATES = frozenset({"applied", "failed", "uncertain", "noop"})
SYNC_DIRECTORIES_ACTION = "sync_directories"
ACTION_ONLY_CANDIDATE_PREFIX = "__bridge_action__:"
DIRECTORY_REGISTRY_STATE_KEY = "directory_registry.v1"
_DIRECTORY_REGISTRY_MAX_BYTES = 1024 * 1024
RUNTIME_CONFIG_STATE_KEY = "runtime_config.v1"
PAIRING_STATE_KEY = "pairing.v1"
BEARER_TOKEN_STATE_KEY = "bearer_token.v1"
TELEGRAM_RUNTIME_CONFIG_STATE_KEY = "runtime.telegram.v1"
_RUNTIME_CONFIG_MAX_BYTES = 256 * 1024
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


def _validate_action_result(value: Any) -> dict[str, Any]:
    """Validate action result JSON before it reaches the durable store."""

    if not isinstance(value, dict):
        raise ValueError("action.result 必须是 JSON 对象")
    max_depth = 6
    max_nodes = 200
    max_string = 4096
    max_bytes = 256 * 1024
    count = 0

    def visit(item: Any, depth: int) -> Any:
        nonlocal count
        count += 1
        if count > max_nodes:
            raise ValueError("action.result 项目数量超出限制")
        if depth > max_depth:
            raise ValueError("action.result 嵌套深度超出限制")
        if isinstance(item, str):
            if len(item) > max_string:
                raise ValueError("action.result 字符串过长")
            return item
        if item is None or isinstance(item, (bool, int)):
            return item
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError("action.result 不得包含非有限浮点数")
            return item
        if isinstance(item, list):
            if len(item) > max_nodes:
                raise ValueError("action.result 数组过长")
            return [visit(child, depth + 1) for child in item]
        if isinstance(item, dict):
            if len(item) > max_nodes:
                raise ValueError("action.result 对象过大")
            result: dict[str, Any] = {}
            for key, child in item.items():
                if not isinstance(key, str) or len(key) > 128:
                    raise ValueError("action.result 键无效")
                result[key] = visit(child, depth + 1)
            return result
        raise ValueError("action.result 只能包含 JSON 值")

    normalized = visit(value, 0)
    try:
        encoded = _json(normalized).encode("utf-8")
    except (TypeError, ValueError, OverflowError):
        raise ValueError("action.result 不是有效 JSON") from None
    if len(encoded) > max_bytes:
        raise ValueError("action.result 过大")
    return normalized


def _now() -> float:
    return time.time()


def _token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class JobRecord:
    job_id: str
    parent_job_id: str | None
    retry_count: int
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
            "retryCount": self.retry_count,
            "parentJobId": self.parent_job_id,
            "taskId": self.task_id,
            "remoteId": self.remote_id,
        }

    def internal_payload(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "parentJobId": self.parent_job_id,
            "retryCount": self.retry_count,
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


@dataclass(frozen=True)
class ActionRecord:
    action_id: str
    job_id: str
    action_type: str
    status: str
    request_id: str
    payload: dict[str, Any]
    lease_id: str | None
    worker_id: str | None
    lease_until: float | None
    attempt_count: int
    result: dict[str, Any] | None
    error_code: str | None
    error_message: str | None
    created_at: float
    updated_at: float

    def claim_payload(self) -> dict[str, Any]:
        return {
            "actionId": self.action_id,
            "jobId": self.job_id,
            "actionType": self.action_type,
            "type": self.action_type,
            "status": self.status,
            "requestId": self.request_id,
            "payload": self.payload,
            "leaseId": self.lease_id or "",
            "recovered": self.attempt_count > 1,
            "attemptCount": self.attempt_count,
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
            version_row = self._connection.execute("PRAGMA user_version").fetchone()
            version = int(version_row[0] if version_row else 0)
            jobs_row = self._connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'"
            ).fetchone()
            if jobs_row is None:
                self._create_schema()
            elif version < 2 or not self._jobs_support_v2(str(jobs_row[0] or "")):
                self._migrate_to_v2()
            else:
                self._create_auxiliary_schema()
            self._ensure_action_sync_schema()
            # Keep the existing queue schema version stable; the action
            # constraint migration is intentionally transparent to clients.
            self._connection.execute("PRAGMA user_version = 2")

    def _jobs_support_v2(self, sql: str) -> bool:
        columns = {
            str(row[1])
            for row in self._connection.execute("PRAGMA table_info(jobs)").fetchall()
        }
        return "'cancelled'" in sql.lower() and {
            "parent_job_id",
            "retry_count",
        }.issubset(columns)

    def _create_schema(self) -> None:
        self._connection.executescript(
            """
            CREATE TABLE jobs (
                job_id TEXT PRIMARY KEY,
                parent_job_id TEXT REFERENCES jobs(job_id),
                retry_count INTEGER NOT NULL DEFAULT 0,
                intent_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN (
                        'queued', 'claimed', 'accepted', 'progress',
                        'completed', 'failed', 'uncertain', 'cancelled'
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
            """
        )
        self._create_auxiliary_schema()

    def _migrate_to_v2(self) -> None:
        """Rebuild the v1 jobs CHECK constraint without losing queue rows."""

        old_columns = {
            str(row[1])
            for row in self._connection.execute("PRAGMA table_info(jobs)").fetchall()
        }
        columns = [
            "job_id", "parent_job_id", "retry_count", "intent_json", "status",
            "worker_id", "lease_id", "lease_until", "attempt_count", "task_id",
            "remote_id", "percent", "message", "error_code", "error_message",
            "created_at", "updated_at", "telegram_chat_id", "telegram_user_id",
            "telegram_message_id", "status_message_id", "candidate_key",
            "last_notified_state", "last_notified_percent",
        ]
        # The released v1 schema had every column listed above except the
        # retry lineage fields.  Keep the migration tolerant of older local
        # databases that predate one of the nullable/attempt fields as well;
        # a missing value must still satisfy v2's NOT NULL constraints.
        defaults = {
            "parent_job_id": "NULL",
            "retry_count": "0",
            "attempt_count": "0",
            "intent_json": "'{}'",
            "status": "'queued'",
            "created_at": "0",
            "updated_at": "0",
        }
        expressions = [
            column if column in old_columns else defaults.get(column, "NULL")
            for column in columns
        ]
        self._connection.execute("PRAGMA foreign_keys = OFF")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._connection.execute(
                """
                CREATE TABLE jobs_v2 (
                    job_id TEXT PRIMARY KEY,
                    parent_job_id TEXT REFERENCES jobs_v2(job_id),
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    intent_json TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN (
                            'queued', 'claimed', 'accepted', 'progress',
                            'completed', 'failed', 'uncertain', 'cancelled'
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
                )
                """
            )
            self._connection.execute(
                f"INSERT INTO jobs_v2 ({', '.join(columns)}) "
                f"SELECT {', '.join(expressions)} FROM jobs"
            )
            self._connection.execute("DROP TABLE jobs")
            self._connection.execute("ALTER TABLE jobs_v2 RENAME TO jobs")
            self._connection.execute("COMMIT")
        except Exception:
            self._connection.execute("ROLLBACK")
            raise
        finally:
            self._connection.execute("PRAGMA foreign_keys = ON")
        self._create_auxiliary_schema()

    def _create_auxiliary_schema(self) -> None:
        self._connection.executescript(
            """
            CREATE INDEX IF NOT EXISTS jobs_claim_idx
                ON jobs(status, lease_until, created_at, job_id);
            CREATE INDEX IF NOT EXISTS jobs_telegram_idx
                ON jobs(telegram_chat_id, telegram_user_id, candidate_key, created_at);
            CREATE INDEX IF NOT EXISTS jobs_telegram_page_idx
                ON jobs(telegram_chat_id, telegram_user_id, created_at DESC, job_id DESC);

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

            CREATE TABLE IF NOT EXISTS telegram_preferences (
                chat_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                last_save_path_cid TEXT,
                updated_at REAL NOT NULL,
                PRIMARY KEY(chat_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS retry_requests (
                request_id TEXT PRIMARY KEY,
                source_job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
                new_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id) ON DELETE CASCADE,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS actions (
                action_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
                action_type TEXT NOT NULL CHECK (
                    action_type IN ('cancel_task', 'sync_directories')
                ),
                status TEXT NOT NULL CHECK (
                    status IN ('queued', 'claimed', 'applied', 'failed', 'uncertain', 'noop')
                ),
                request_id TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                worker_id TEXT,
                lease_id TEXT,
                lease_until REAL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                result_json TEXT,
                error_code TEXT,
                error_message TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(job_id, action_type, request_id)
            );
            CREATE INDEX IF NOT EXISTS actions_claim_idx
                ON actions(status, lease_until, created_at, action_id);
            CREATE INDEX IF NOT EXISTS actions_job_idx
                ON actions(job_id, created_at);

            CREATE TABLE IF NOT EXISTS action_events (
                event_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                action_id TEXT NOT NULL REFERENCES actions(action_id) ON DELETE CASCADE,
                event_id TEXT NOT NULL,
                lease_id TEXT NOT NULL,
                state TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                UNIQUE(action_id, event_id)
            );

            CREATE TABLE IF NOT EXISTS action_requests (
                request_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
                action_id TEXT NOT NULL REFERENCES actions(action_id) ON DELETE CASCADE,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS action_requests_action_idx
                ON action_requests(action_id);

            CREATE TABLE IF NOT EXISTS action_notifications (
                action_id TEXT PRIMARY KEY REFERENCES actions(action_id) ON DELETE CASCADE,
                notified_at REAL NOT NULL
            );

            -- Keep idempotency for actions created before this mapping table
            -- existed.  A malformed legacy database with duplicate request
            -- IDs keeps its first durable association.
            INSERT OR IGNORE INTO action_requests(request_id, job_id, action_id, created_at)
                SELECT request_id, job_id, action_id, created_at FROM actions;
            """
        )

    def _ensure_action_sync_schema(self) -> None:
        """Migrate the pre-1.12 action CHECK constraint in-place.

        Released databases only allowed ``cancel_task``.  SQLite cannot alter
        a CHECK constraint, so rebuild just the action tables while retaining
        all action/event/idempotency rows.  New databases already have the
        expanded definition and take the fast path.
        """

        row = self._connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'actions'"
        ).fetchone()
        sql = str(row[0] or "") if row else ""
        if "sync_directories" in sql.lower():
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS action_notifications (
                    action_id TEXT PRIMARY KEY REFERENCES actions(action_id) ON DELETE CASCADE,
                    notified_at REAL NOT NULL
                );
                """
            )
            return

        self._connection.execute("PRAGMA foreign_keys = OFF")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._connection.execute("DROP INDEX IF EXISTS actions_claim_idx")
            self._connection.execute("DROP INDEX IF EXISTS actions_job_idx")
            self._connection.execute("DROP INDEX IF EXISTS action_requests_action_idx")
            # This table is new in the expanded schema and is empty on a
            # legacy database.  Drop the provisional table created by the
            # auxiliary-schema pass before rebuilding its foreign key.
            self._connection.execute("DROP TABLE IF EXISTS action_notifications")
            self._connection.execute(
                "CREATE TABLE action_events_backup AS SELECT * FROM action_events"
            )
            self._connection.execute(
                "CREATE TABLE action_requests_backup AS SELECT * FROM action_requests"
            )
            self._connection.execute("DROP TABLE action_events")
            self._connection.execute("DROP TABLE action_requests")
            self._connection.execute("ALTER TABLE actions RENAME TO actions_legacy")
            self._connection.execute(
                """
                CREATE TABLE actions (
                    action_id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
                    action_type TEXT NOT NULL CHECK (
                        action_type IN ('cancel_task', 'sync_directories')
                    ),
                    status TEXT NOT NULL CHECK (
                        status IN ('queued', 'claimed', 'applied', 'failed', 'uncertain', 'noop')
                    ),
                    request_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    worker_id TEXT,
                    lease_id TEXT,
                    lease_until REAL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    UNIQUE(job_id, action_type, request_id)
                )
                """
            )
            self._connection.execute(
                """
                INSERT INTO actions(
                    action_id, job_id, action_type, status, request_id,
                    payload_json, worker_id, lease_id, lease_until,
                    attempt_count, result_json, error_code, error_message,
                    created_at, updated_at
                )
                SELECT action_id, job_id, action_type, status, request_id,
                       payload_json, worker_id, lease_id, lease_until,
                       attempt_count, result_json, error_code, error_message,
                       created_at, updated_at
                FROM actions_legacy
                """
            )
            self._connection.execute("DROP TABLE actions_legacy")
            self._connection.execute(
                """
                CREATE INDEX actions_claim_idx
                    ON actions(status, lease_until, created_at, action_id)
                """
            )
            self._connection.execute(
                """
                CREATE INDEX actions_job_idx
                    ON actions(job_id, created_at)
                """
            )
            self._connection.execute(
                """
                CREATE TABLE action_events (
                    event_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    action_id TEXT NOT NULL REFERENCES actions(action_id) ON DELETE CASCADE,
                    event_id TEXT NOT NULL,
                    lease_id TEXT NOT NULL,
                    state TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    UNIQUE(action_id, event_id)
                )
                """
            )
            self._connection.execute(
                """
                INSERT INTO action_events
                    SELECT * FROM action_events_backup
                """
            )
            self._connection.execute("DROP TABLE action_events_backup")
            self._connection.execute(
                """
                CREATE TABLE action_requests (
                    request_id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
                    action_id TEXT NOT NULL REFERENCES actions(action_id) ON DELETE CASCADE,
                    created_at REAL NOT NULL
                )
                """
            )
            self._connection.execute(
                """
                INSERT INTO action_requests
                    SELECT * FROM action_requests_backup
                """
            )
            self._connection.execute("DROP TABLE action_requests_backup")
            self._connection.execute(
                """
                CREATE INDEX action_requests_action_idx
                    ON action_requests(action_id)
                """
            )
            self._connection.execute(
                """
                CREATE TABLE action_notifications (
                    action_id TEXT PRIMARY KEY REFERENCES actions(action_id) ON DELETE CASCADE,
                    notified_at REAL NOT NULL
                )
                """
            )
            self._connection.execute("COMMIT")
        except Exception:
            self._connection.execute("ROLLBACK")
            raise
        finally:
            self._connection.execute("PRAGMA foreign_keys = ON")

    def _row_to_job(self, row: sqlite3.Row | None) -> JobRecord | None:
        if row is None:
            return None
        return JobRecord(
            job_id=str(row["job_id"]),
            parent_job_id=(
                str(row["parent_job_id"]) if row["parent_job_id"] else None
            ),
            retry_count=int(row["retry_count"] or 0),
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

    def _row_to_action(self, row: sqlite3.Row | None) -> ActionRecord | None:
        if row is None:
            return None
        return ActionRecord(
            action_id=str(row["action_id"]),
            job_id=str(row["job_id"]),
            action_type=str(row["action_type"]),
            status=str(row["status"]),
            request_id=str(row["request_id"]),
            payload=json.loads(row["payload_json"] or "{}"),
            lease_id=str(row["lease_id"]) if row["lease_id"] else None,
            worker_id=str(row["worker_id"]) if row["worker_id"] else None,
            lease_until=(
                float(row["lease_until"]) if row["lease_until"] is not None else None
            ),
            attempt_count=int(row["attempt_count"] or 0),
            result=json.loads(row["result_json"]) if row["result_json"] else None,
            error_code=str(row["error_code"]) if row["error_code"] else None,
            error_message=(
                str(row["error_message"]) if row["error_message"] else None
            ),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )

    def _get_job_locked(self, job_id: str) -> JobRecord | None:
        row = self._connection.execute(
            "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        return self._row_to_job(row)

    def _get_action_locked(self, action_id: str) -> ActionRecord | None:
        row = self._connection.execute(
            "SELECT * FROM actions WHERE action_id = ?", (action_id,)
        ).fetchone()
        return self._row_to_action(row)

    def _get_action_request_locked(self, request_id: str) -> sqlite3.Row | None:
        return self._connection.execute(
            "SELECT * FROM action_requests WHERE request_id = ?",
            (request_id,),
        ).fetchone()

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._lock:
            return self._get_job_locked(str(job_id))

    def get_telegram_job(
        self,
        job_id: str,
        chat_id: int,
        user_id: int,
    ) -> JobRecord | None:
        """Return a job only when it belongs to the requesting Telegram user."""

        with self._lock:
            row = self._connection.execute(
                """
                SELECT * FROM jobs
                WHERE job_id = ?
                  AND telegram_chat_id = ?
                  AND telegram_user_id = ?
                """,
                (str(job_id).strip(), int(chat_id), int(user_id)),
            ).fetchone()
            return self._row_to_job(row)

    def get_action(self, action_id: str) -> ActionRecord | None:
        with self._lock:
            return self._get_action_locked(str(action_id))

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
        # Directory-sync actions use a synthetic job row so they can reuse
        # the durable action/event protocol.  They must never appear as
        # ordinary download jobs or be claimed by the download worker.
        clauses.append("(candidate_key IS NULL OR candidate_key NOT LIKE ?)")
        parameters.append(f"{ACTION_ONLY_CANDIDATE_PREFIX}%")
        if telegram_only:
            clauses.append("telegram_chat_id IS NOT NULL")
        if not include_terminal:
            clauses.append(
                "status NOT IN ('completed', 'failed', 'uncertain', 'cancelled')"
            )
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

    def list_jobs_page(
        self,
        *,
        statuses: tuple[str, ...] = (),
        limit: int = 100,
        cursor: tuple[float, str] | None = None,
    ) -> tuple[list[JobRecord], tuple[float, str] | None]:
        bounded_limit = max(1, min(int(limit), 100))
        clauses: list[str] = []
        parameters: list[Any] = []
        clauses.append("(candidate_key IS NULL OR candidate_key NOT LIKE ?)")
        parameters.append(f"{ACTION_ONLY_CANDIDATE_PREFIX}%")
        allowed = set(JOB_TERMINAL_STATES) | {
            "queued", "claimed", "accepted", "progress"
        }
        selected = tuple(dict.fromkeys(str(value).strip().lower() for value in statuses if value))
        if selected:
            if any(value not in allowed for value in selected):
                raise ValueError("未知任务状态")
            clauses.append(f"status IN ({','.join('?' for _ in selected)})")
            parameters.extend(selected)
        if cursor is not None:
            try:
                cursor_created_at = float(cursor[0])
                cursor_job_id = str(cursor[1]).strip()
            except (TypeError, ValueError, IndexError, OverflowError):
                raise ValueError("任务游标无效") from None
            if (
                not cursor_job_id
                or len(cursor_job_id) > 128
                or not math.isfinite(cursor_created_at)
            ):
                raise ValueError("任务游标无效")
            clauses.append("(created_at > ? OR (created_at = ? AND job_id > ?))")
            parameters.extend((cursor_created_at, cursor_created_at, cursor_job_id))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT * FROM jobs
                {where}
                ORDER BY created_at ASC, job_id ASC
                LIMIT ?
                """,
                (*parameters, bounded_limit + 1),
            ).fetchall()
            records = [record for row in rows if (record := self._row_to_job(row))]
            next_cursor = None
            if len(records) > bounded_limit:
                records = records[:bounded_limit]
                last = records[-1]
                next_cursor = (last.created_at, last.job_id)
            return records, next_cursor

    def list_telegram_jobs_page(
        self,
        chat_id: int,
        user_id: int,
        limit: int = 10,
        cursor: tuple[float, str] | None = None,
    ) -> tuple[list[JobRecord], tuple[float, str] | None]:
        """Return one user's Telegram jobs, newest first, using a keyset cursor."""

        bounded_limit = max(1, min(int(limit), 100))
        parameters: list[Any] = [int(chat_id), int(user_id), f"{ACTION_ONLY_CANDIDATE_PREFIX}%"]
        clauses = [
            "telegram_chat_id = ?",
            "telegram_user_id = ?",
            "(candidate_key IS NULL OR candidate_key NOT LIKE ?)",
        ]
        if cursor is not None:
            try:
                created_at = float(cursor[0])
                job_id = str(cursor[1]).strip()
            except (TypeError, ValueError, IndexError):
                raise ValueError("Telegram 任务游标无效") from None
            if not job_id or len(job_id) > 128 or not math.isfinite(created_at):
                raise ValueError("Telegram 任务游标无效")
            clauses.append("(created_at < ? OR (created_at = ? AND job_id < ?))")
            parameters.extend((created_at, created_at, job_id))
        where = " AND ".join(clauses)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT * FROM jobs
                WHERE {where}
                ORDER BY created_at DESC, job_id DESC
                LIMIT ?
                """,
                (*parameters, bounded_limit + 1),
            ).fetchall()
            records = [record for row in rows if (record := self._row_to_job(row))]
            next_cursor = None
            if len(records) > bounded_limit:
                records = records[:bounded_limit]
                last = records[-1]
                next_cursor = (last.created_at, last.job_id)
            return records, next_cursor

    def pending_action(self, job_id: str) -> ActionRecord | None:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT * FROM actions
                WHERE job_id = ? AND status IN ('queued', 'claimed')
                ORDER BY created_at ASC, action_id ASC
                LIMIT 1
                """,
                (str(job_id),),
            ).fetchone()
            return self._row_to_action(row)

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
                      AND telegram_user_id = ?
                      AND candidate_key = ?
                      AND status NOT IN ('failed', 'cancelled')
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (int(telegram_chat_id), int(telegram_user_id), candidate_key),
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

    def clone_retry(
        self,
        job_id: str,
        *,
        request_id: str,
        now: float | None = None,
    ) -> tuple[JobRecord, bool]:
        """Clone one explicitly failed job without mutating its history."""

        job_id = str(job_id).strip()
        request_id = str(request_id).strip()
        if not job_id or not request_id:
            raise ValueError("jobId、requestId 不能为空")
        now = _now() if now is None else float(now)
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                previous = self._connection.execute(
                    "SELECT * FROM retry_requests WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                if previous is not None:
                    if str(previous["source_job_id"]) != job_id:
                        raise StateConflict("requestId 已用于另一项任务")
                    record = self._get_job_locked(str(previous["new_job_id"]))
                    if record is None:
                        raise StateConflict("重试请求记录无效")
                    self._connection.execute("COMMIT")
                    return record, True

                source = self._get_job_locked(job_id)
                if source is None:
                    raise UnknownJob("找不到 bridge job")
                if source.status != "failed":
                    raise StateConflict("只有 failed 任务可以重试")
                new_job_id = str(uuid.uuid4())
                intent = dict(source.intent)
                intent["jobId"] = new_job_id
                self._connection.execute(
                    """
                    INSERT INTO jobs (
                        job_id, parent_job_id, retry_count, intent_json, status,
                        attempt_count, created_at, updated_at,
                        telegram_chat_id, telegram_user_id, telegram_message_id,
                        candidate_key
                    ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_job_id,
                        source.job_id,
                        source.retry_count + 1,
                        _json(intent),
                        now,
                        now,
                        source.telegram_chat_id,
                        source.telegram_user_id,
                        source.telegram_message_id,
                        source.candidate_key,
                    ),
                )
                self._connection.execute(
                    """
                    INSERT INTO retry_requests(request_id, source_job_id, new_job_id, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (request_id, source.job_id, new_job_id, now),
                )
                record = self._get_job_locked(new_job_id)
                self._connection.execute("COMMIT")
                assert record is not None
                return record, False
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def request_cancel(
        self,
        job_id: str,
        *,
        request_id: str,
        reason: str = "",
        now: float | None = None,
    ) -> tuple[ActionRecord, bool]:
        """Create an auditable cancel action, or apply it to queued work."""

        job_id = str(job_id).strip()
        request_id = str(request_id).strip()
        if not job_id or not request_id:
            raise ValueError("jobId、requestId 不能为空")
        now = _now() if now is None else float(now)
        payload = {"reason": str(reason or "").strip()}
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                job = self._get_job_locked(job_id)
                if job is None:
                    raise UnknownJob("找不到 bridge job")
                request_row = self._get_action_request_locked(request_id)
                if request_row is not None:
                    if str(request_row["job_id"]) != job_id:
                        raise StateConflict("requestId 已用于另一项动作")
                    mapped = self._get_action_locked(str(request_row["action_id"]))
                    if mapped is None:
                        raise StateConflict("动作请求记录无效")
                    self._connection.execute("COMMIT")
                    return mapped, True
                existing_row = self._connection.execute(
                    """
                    SELECT * FROM actions
                    WHERE job_id = ? AND action_type = 'cancel_task' AND request_id = ?
                    """,
                    (job_id, request_id),
                ).fetchone()
                if existing_row is not None:
                    existing = self._row_to_action(existing_row)
                    self._connection.execute(
                        """
                        INSERT OR IGNORE INTO action_requests(
                            request_id, job_id, action_id, created_at
                        ) VALUES (?, ?, ?, ?)
                        """,
                        (request_id, job_id, existing.action_id, now),
                    )
                    self._connection.execute("COMMIT")
                    assert existing is not None
                    return existing, True
                if job.status in JOB_TERMINAL_STATES:
                    raise StateConflict("终态任务不可取消")
                pending_row = self._connection.execute(
                    """
                    SELECT * FROM actions
                    WHERE job_id = ? AND action_type = 'cancel_task'
                      AND status IN ('queued', 'claimed')
                    ORDER BY created_at ASC, action_id ASC
                    LIMIT 1
                    """,
                    (job_id,),
                ).fetchone()
                if pending_row is not None:
                    pending = self._row_to_action(pending_row)
                    self._connection.execute(
                        """
                        INSERT INTO action_requests(
                            request_id, job_id, action_id, created_at
                        ) VALUES (?, ?, ?, ?)
                        """,
                        (request_id, job_id, pending_row["action_id"], now),
                    )
                    self._connection.execute("COMMIT")
                    assert pending is not None
                    # Reuse one in-flight cancel so a second browser click
                    # cannot leave an orphaned action after the first ACK
                    # clears the job's worker lease.
                    return pending, True
                action_id = str(uuid.uuid4())
                action_status = "applied" if job.status == "queued" else "queued"
                self._connection.execute(
                    """
                    INSERT INTO actions (
                        action_id, job_id, action_type, status, request_id,
                        payload_json, result_json, created_at, updated_at
                    ) VALUES (?, ?, 'cancel_task', ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        action_id,
                        job_id,
                        action_status,
                        request_id,
                        _json(payload),
                        _json({"status": "cancelled"}) if action_status == "applied" else None,
                        now,
                        now,
                    ),
                )
                if action_status == "applied":
                    self._connection.execute(
                        """
                        UPDATE jobs
                        SET status = 'cancelled', worker_id = NULL, lease_id = NULL,
                            lease_until = NULL, updated_at = ?
                        WHERE job_id = ?
                        """,
                        (now, job_id),
                    )
                    event_id = f"system-{action_id}"
                    event_payload = {
                        "schema": 1,
                        "leaseId": "system",
                        "eventId": event_id,
                        "state": "applied",
                        "result": {"status": "cancelled"},
                    }
                    self._connection.execute(
                        """
                        INSERT INTO action_events(
                            action_id, event_id, lease_id, state, payload_json, created_at
                        ) VALUES (?, ?, 'system', 'applied', ?, ?)
                        """,
                        (action_id, event_id, _json(event_payload), now),
                    )
                self._connection.execute(
                    """
                    INSERT INTO action_requests(
                        request_id, job_id, action_id, created_at
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (request_id, job_id, action_id, now),
                )
                action = self._get_action_locked(action_id)
                self._connection.execute("COMMIT")
                assert action is not None
                return action, False
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def request_directory_sync(
        self,
        *,
        chat_id: int,
        user_id: int,
        message_id: int | None = None,
        request_id: str | None = None,
        timeout_seconds: int = 60,
        now: float | None = None,
    ) -> tuple[ActionRecord, bool]:
        """Create an action for the browser to refresh the directory index.

        Directory refresh is not a download job, but it uses the same durable
        action claim/event protocol.  A synthetic, action-only job preserves
        the existing ``actions.job_id`` foreign key and lets old clients keep
        decoding the claim envelope.  Such rows are hidden from the normal
        job queue and are never returned by ``claim``.
        """

        chat = int(chat_id)
        user = int(user_id)
        source_message = None if message_id is None else int(message_id)
        if chat == 0 or user == 0:
            raise ValueError("chat_id、user_id 无效")
        if source_message is not None and source_message < 0:
            raise ValueError("message_id 无效")
        timeout = int(timeout_seconds)
        if not 15 <= timeout <= 900:
            raise ValueError("timeout_seconds 必须在 15 到 900 秒之间")
        now = _now() if now is None else float(now)
        request = str(request_id or "").strip()
        if not request:
            request = f"sync-directories:{chat}:{user}:{source_message or 0}"
        if len(request) > 128:
            raise ValueError("request_id 过长")
        candidate_key = f"{ACTION_ONLY_CANDIDATE_PREFIX}{SYNC_DIRECTORIES_ACTION}:{chat}:{user}"
        payload = {
            "schema": 1,
            "kind": SYNC_DIRECTORIES_ACTION,
            "chatId": chat,
            "userId": user,
            "sourceMessageId": source_message,
            "originalMessageId": source_message,
            "messageId": source_message,
            "telegramMessageId": source_message,
            "statusMessageId": None,
            "timeoutSeconds": timeout,
            "requestedAt": now,
        }
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                mapped = self._get_action_request_locked(request)
                if mapped is not None:
                    existing = self._get_action_locked(str(mapped["action_id"]))
                    if existing is None:
                        raise StateConflict("动作请求记录无效")
                    self._connection.execute("COMMIT")
                    return existing, True

                pending_row = self._connection.execute(
                    """
                    SELECT actions.*
                    FROM actions
                    JOIN jobs ON jobs.job_id = actions.job_id
                    WHERE actions.action_type = ?
                      AND actions.status IN ('queued', 'claimed')
                      AND jobs.telegram_chat_id = ?
                      AND jobs.telegram_user_id = ?
                    ORDER BY actions.created_at ASC, actions.action_id ASC
                    LIMIT 1
                    """,
                    (SYNC_DIRECTORIES_ACTION, chat, user),
                ).fetchone()
                if pending_row is not None:
                    pending = self._row_to_action(pending_row)
                    assert pending is not None
                    self._connection.execute(
                        """
                        INSERT INTO action_requests(
                            request_id, job_id, action_id, created_at
                        ) VALUES (?, ?, ?, ?)
                        """,
                        (request, pending.job_id, pending.action_id, now),
                    )
                    self._connection.execute("COMMIT")
                    return pending, True

                # Keep the public jobId compatible with the browser action
                # envelope (it must begin with an ASCII alphanumeric).  The
                # private candidate key is what marks this synthetic row as
                # action-only for the normal download queue.
                job_id = f"sync-action-{uuid.uuid4()}"
                action_id = str(uuid.uuid4())
                intent = {
                    "jobId": job_id,
                    "sourceSite": "telegram",
                    "actionType": SYNC_DIRECTORIES_ACTION,
                    "processorProfile": "generic",
                }
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
                        _json(intent),
                        now,
                        now,
                        chat,
                        user,
                        source_message,
                        candidate_key,
                    ),
                )
                self._connection.execute(
                    """
                    INSERT INTO actions(
                        action_id, job_id, action_type, status, request_id,
                        payload_json, created_at, updated_at
                    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
                    """,
                    (action_id, job_id, SYNC_DIRECTORIES_ACTION, request, _json(payload), now, now),
                )
                self._connection.execute(
                    """
                    INSERT INTO action_requests(request_id, job_id, action_id, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (request, job_id, action_id, now),
                )
                action = self._get_action_locked(action_id)
                self._connection.execute("COMMIT")
                assert action is not None
                return action, False
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    # Descriptive compatibility spelling used by early action prototypes.
    request_sync_directories = request_directory_sync

    def attach_directory_sync_message(self, action_id: str, message_id: int) -> ActionRecord:
        """Persist the bot message that will be edited with the final tree."""

        action_id = str(action_id).strip()
        message_id = int(message_id)
        if not action_id or message_id < 0:
            raise ValueError("actionId、messageId 无效")
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM actions WHERE action_id = ? AND action_type = ?",
                (action_id, SYNC_DIRECTORIES_ACTION),
            ).fetchone()
            if row is None:
                raise UnknownAction("找不到 directory sync action")
            payload = json.loads(row["payload_json"] or "{}")
            if not isinstance(payload, dict):
                payload = {}
            payload["statusMessageId"] = message_id
            self._connection.execute(
                "UPDATE actions SET payload_json = ?, updated_at = ? WHERE action_id = ?",
                (_json(payload), _now(), action_id),
            )
            action = self._get_action_locked(action_id)
            assert action is not None
            return action

    def list_directory_sync_actions(self) -> list[ActionRecord]:
        """Return terminal sync actions whose Telegram message is unnotified."""

        with self._lock:
            rows = self._connection.execute(
                """
                SELECT actions.*
                FROM actions
                LEFT JOIN action_notifications
                  ON action_notifications.action_id = actions.action_id
                WHERE actions.action_type = ?
                  AND actions.status IN ('applied', 'failed', 'uncertain', 'noop')
                  AND action_notifications.action_id IS NULL
                ORDER BY actions.updated_at ASC, actions.action_id ASC
                LIMIT 500
                """,
                (SYNC_DIRECTORIES_ACTION,),
            ).fetchall()
            return [record for row in rows if (record := self._row_to_action(row))]

    def mark_action_notified(self, action_id: str, *, now: float | None = None) -> None:
        action_id = str(action_id).strip()
        if not action_id:
            raise ValueError("actionId 不能为空")
        timestamp = _now() if now is None else float(now)
        with self._lock:
            self._connection.execute(
                "INSERT OR IGNORE INTO action_notifications(action_id, notified_at) VALUES (?, ?)",
                (action_id, timestamp),
            )

    def expire_directory_sync_actions(
        self, *, now: float | None = None, limit: int = 100
    ) -> int:
        """Close browser sync actions that received no event in time."""

        timestamp = _now() if now is None else float(now)
        bounded_limit = max(1, min(int(limit), 500))
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                rows = self._connection.execute(
                    """
                    SELECT action_id, job_id, lease_id, payload_json
                    FROM actions
                    WHERE action_type = ? AND status IN ('queued', 'claimed')
                    ORDER BY created_at ASC, action_id ASC
                    LIMIT ?
                    """,
                    (SYNC_DIRECTORIES_ACTION, bounded_limit),
                ).fetchall()
                expired: list[sqlite3.Row] = []
                for row in rows:
                    payload = json.loads(row["payload_json"] or "{}")
                    timeout = int(payload.get("timeoutSeconds", 60) or 60) if isinstance(payload, dict) else 60
                    created = self._connection.execute(
                        "SELECT created_at FROM actions WHERE action_id = ?",
                        (row["action_id"],),
                    ).fetchone()
                    if created is not None and float(created[0]) + timeout <= timestamp:
                        expired.append(row)
                for row in expired:
                    action_id = str(row["action_id"])
                    error_payload = {
                        "status": "failed",
                        "errorCode": "sync_timeout",
                        "errorMessage": "Chrome 扩展未响应，目录同步超时",
                    }
                    self._connection.execute(
                        """
                        UPDATE actions
                        SET status = 'failed', lease_until = NULL,
                            result_json = ?, error_code = 'sync_timeout',
                            error_message = ?, updated_at = ?
                        WHERE action_id = ? AND status IN ('queued', 'claimed')
                        """,
                        (_json(error_payload), error_payload["errorMessage"], timestamp, action_id),
                    )
                    event_id = f"system-timeout-{action_id}"
                    self._connection.execute(
                        """
                        INSERT OR IGNORE INTO action_events(
                            action_id, event_id, lease_id, state, payload_json, created_at
                        ) VALUES (?, ?, 'system', 'failed', ?, ?)
                        """,
                        (
                            action_id,
                            event_id,
                            _json({
                                "schema": 1,
                                "leaseId": "system",
                                "eventId": event_id,
                                "state": "failed",
                                "result": error_payload,
                            }),
                            timestamp,
                        ),
                    )
                    self._connection.execute(
                        """
                        UPDATE jobs
                        SET status = 'failed', worker_id = NULL, lease_id = NULL,
                            lease_until = NULL, error_code = 'sync_timeout',
                            error_message = ?, updated_at = ?
                        WHERE job_id = ?
                        """,
                        (error_payload["errorMessage"], timestamp, row["job_id"]),
                    )
                self._connection.execute("COMMIT")
                return len(expired)
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def claim_action(
        self,
        worker_id: str,
        *,
        lease_seconds: int | None = None,
        now: float | None = None,
    ) -> ActionRecord | None:
        worker_id = str(worker_id).strip()
        if not worker_id:
            raise ValueError("worker_id 不能为空")
        seconds = self.default_lease_seconds if lease_seconds is None else int(lease_seconds)
        if not 15 <= seconds <= 900:
            raise ValueError("lease_seconds 必须在 15 到 900 秒之间")
        now = _now() if now is None else float(now)
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._connection.execute(
                    """
                    SELECT actions.*
                    FROM actions
                    JOIN jobs ON jobs.job_id = actions.job_id
                    WHERE (
                        (
                            actions.action_type = ?
                            AND actions.status = 'queued'
                        )
                        OR (
                            actions.action_type = ?
                            AND actions.status = 'claimed'
                            AND actions.worker_id = ?
                            AND actions.lease_until IS NOT NULL
                            AND actions.lease_until <= ?
                        )
                        OR (
                            actions.action_type <> ?
                            AND jobs.worker_id IS NOT NULL
                            AND jobs.worker_id <> ''
                            AND (
                                (actions.status = 'queued' AND jobs.worker_id = ?)
                                OR (
                                    actions.status = 'claimed' AND actions.worker_id = ?
                                    AND actions.lease_until IS NOT NULL
                                    AND actions.lease_until <= ?
                                )
                            )
                        )
                    )
                    ORDER BY actions.created_at ASC, actions.action_id ASC
                    LIMIT 1
                    """,
                    (
                        SYNC_DIRECTORIES_ACTION,
                        SYNC_DIRECTORIES_ACTION,
                        worker_id,
                        now,
                        SYNC_DIRECTORIES_ACTION,
                        worker_id,
                        worker_id,
                        now,
                    ),
                ).fetchone()
                if row is None:
                    self._connection.execute("COMMIT")
                    return None
                old_lease = str(row["lease_id"]) if row["lease_id"] else None
                lease_id = old_lease or str(uuid.uuid4())
                self._connection.execute(
                    """
                    UPDATE actions
                    SET status = 'claimed', worker_id = ?, lease_id = ?,
                        lease_until = ?, attempt_count = attempt_count + 1,
                        updated_at = ?
                    WHERE action_id = ?
                    """,
                    (worker_id, lease_id, now + seconds, now, str(row["action_id"])),
                )
                action = self._get_action_locked(str(row["action_id"]))
                self._connection.execute("COMMIT")
                assert action is not None
                return action
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def append_action_event(
        self,
        action_id: str,
        *,
        lease_id: str,
        event_id: str,
        state: str,
        result: Mapping[str, Any] | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        now: float | None = None,
    ) -> tuple[ActionRecord, bool]:
        action_id = str(action_id).strip()
        lease_id = str(lease_id).strip()
        event_id = str(event_id).strip()
        state = str(state).strip().lower()
        if not action_id or not lease_id or not event_id:
            raise ValueError("actionId、leaseId、eventId 不能为空")
        if state not in ACTION_TERMINAL_STATES:
            raise ValueError("未知动作状态")
        now = _now() if now is None else float(now)
        result_payload = _validate_action_result(
            {} if result is None else dict(result)
        )
        payload = {
            "schema": 1,
            "leaseId": lease_id,
            "eventId": event_id,
            "state": state,
            "result": result_payload,
            "errorCode": error_code,
            "errorMessage": error_message,
        }
        payload_json = _json(payload)
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                action = self._get_action_locked(action_id)
                if action is None:
                    raise UnknownAction("找不到 bridge action")
                duplicate = self._connection.execute(
                    "SELECT payload_json FROM action_events WHERE action_id = ? AND event_id = ?",
                    (action_id, event_id),
                ).fetchone()
                if duplicate is not None:
                    if str(duplicate["payload_json"]) != payload_json:
                        raise StateConflict("eventId 已用于另一份动作事件")
                    self._connection.execute("COMMIT")
                    return action, True
                if action.lease_id != lease_id:
                    raise LeaseConflict("动作租约无效")
                if action.status in ACTION_TERMINAL_STATES:
                    raise StateConflict("动作已结束")
                if action.status != "claimed":
                    raise StateConflict("动作尚未领取")
                if state == "applied" and action.action_type == "cancel_task":
                    job = self._get_job_locked(action.job_id)
                    if job is None:
                        raise UnknownJob("找不到 bridge job")
                    if job.status in {"queued", "claimed", "accepted", "progress"}:
                        self._connection.execute(
                            """
                            UPDATE jobs
                            SET status = 'cancelled', worker_id = NULL, lease_id = NULL,
                                lease_until = NULL, updated_at = ?
                            WHERE job_id = ?
                            """,
                            (now, action.job_id),
                        )
                    # A cancel request can race the final job event.  The
                    # browser has already attempted the local stop, so its
                    # durable ACK must still close the action even when the
                    # job became completed/failed/uncertain first.  Preserve
                    # that terminal job state and record the action outcome.
                if action.action_type == SYNC_DIRECTORIES_ACTION:
                    sync_status = "completed" if state in {"applied", "noop"} else (
                        "uncertain" if state == "uncertain" else "failed"
                    )
                    self._connection.execute(
                        """
                        UPDATE jobs
                        SET status = ?, worker_id = NULL, lease_id = NULL,
                            lease_until = NULL,
                            error_code = ?, error_message = ?, updated_at = ?
                        WHERE job_id = ?
                        """,
                        (
                            sync_status,
                            error_code,
                            error_message,
                            now,
                            action.job_id,
                        ),
                    )
                self._connection.execute(
                    """
                    UPDATE actions
                    SET status = ?, lease_until = NULL, result_json = ?,
                        error_code = ?, error_message = ?, updated_at = ?
                    WHERE action_id = ?
                    """,
                    (
                        state,
                        _json(result_payload),
                        error_code,
                        error_message,
                        now,
                        action_id,
                    ),
                )
                self._connection.execute(
                    """
                    INSERT INTO action_events(
                        action_id, event_id, lease_id, state, payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (action_id, event_id, lease_id, state, payload_json, now),
                )
                current = self._get_action_locked(action_id)
                self._connection.execute("COMMIT")
                assert current is not None
                return current, False
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
                      AND telegram_user_id = ?
                      AND candidate_key = ?
                      AND status NOT IN ('failed', 'cancelled')
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (int(chat_id), int(user_id), candidate_key),
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
                    WHERE (candidate_key IS NULL OR candidate_key NOT LIKE ?)
                      AND (
                           status = 'queued'
                       OR (
                           status IN ('claimed', 'accepted', 'progress')
                           AND worker_id = ?
                           AND lease_until IS NOT NULL
                           AND lease_until <= ?
                       ))
                    ORDER BY
                        CASE WHEN status = 'queued' THEN 0 ELSE 1 END,
                        created_at ASC
                    LIMIT 1
                    """,
                    (f"{ACTION_ONLY_CANDIDATE_PREFIX}%", worker_id, now),
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
                if job.status in JOB_TERMINAL_STATES:
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

    def get_telegram_preference(
        self, chat_id: int, user_id: int
    ) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT chat_id, user_id, last_save_path_cid, updated_at
                FROM telegram_preferences
                WHERE chat_id = ? AND user_id = ?
                """,
                (int(chat_id), int(user_id)),
            ).fetchone()
            if row is None:
                return None
            return {
                "chatId": int(row["chat_id"]),
                "userId": int(row["user_id"]),
                "lastSavePathCid": row["last_save_path_cid"],
                "updatedAt": float(row["updated_at"]),
            }

    def set_telegram_preference(
        self,
        chat_id: int,
        user_id: int,
        last_save_path_cid: str | None,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        value = None if last_save_path_cid in (None, "") else str(last_save_path_cid).strip()
        if value is not None and not re.fullmatch(r"[0-9]+", value):
            raise ValueError("last_save_path_cid 必须是数字 CID")
        timestamp = _now() if now is None else float(now)
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO telegram_preferences(chat_id, user_id, last_save_path_cid, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(chat_id, user_id) DO UPDATE SET
                    last_save_path_cid = excluded.last_save_path_cid,
                    updated_at = excluded.updated_at
                """,
                (int(chat_id), int(user_id), value, timestamp),
            )
        return {
            "chatId": int(chat_id),
            "userId": int(user_id),
            "lastSavePathCid": value,
            "updatedAt": timestamp,
        }

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

    def get_directory_registry(self) -> dict[str, Any] | None:
        """Return the latest validated browser directory snapshot.

        The registry is deliberately kept in ``bridge_state`` rather than a
        second table: it is one replaceable JSON snapshot, not queue data that
        needs relational queries.  A malformed legacy value is treated as an
        unavailable snapshot so Telegram cannot act on untrusted state.
        """

        raw = self.get_state(DIRECTORY_REGISTRY_STATE_KEY)
        if raw is None:
            return None
        try:
            value = json.loads(raw)
            from .schemas import DirectoryRegistryRequest, dump_directory_registry

            validated = DirectoryRegistryRequest.model_validate(value)
            encoded = json.dumps(
                dump_directory_registry(validated),
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
            if len(encoded) > _DIRECTORY_REGISTRY_MAX_BYTES:
                return None
            return dump_directory_registry(validated)
        except (TypeError, ValueError, OverflowError, UnicodeError, json.JSONDecodeError):
            return None

    def set_directory_registry(
        self, registry: Mapping[str, Any] | Any
    ) -> dict[str, Any]:
        """Validate and durably replace the browser directory snapshot."""

        try:
            from .schemas import DirectoryRegistryRequest, dump_directory_registry

            if isinstance(registry, DirectoryRegistryRequest):
                validated = registry
            else:
                validated = DirectoryRegistryRequest.model_validate(registry)
            value = dump_directory_registry(validated)
            encoded = json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
                allow_nan=False,
            ).encode("utf-8")
        except (
            TypeError,
            ValueError,
            OverflowError,
            UnicodeError,
            json.JSONDecodeError,
        ) as error:
            raise ValueError("directory registry 不是安全的 JSON 快照") from error
        if len(encoded) > _DIRECTORY_REGISTRY_MAX_BYTES:
            raise ValueError("directory registry 输入过大")
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO bridge_state (state_key, state_value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(state_key) DO UPDATE SET
                    state_value = excluded.state_value,
                    updated_at = excluded.updated_at
                """,
                (DIRECTORY_REGISTRY_STATE_KEY, encoded.decode("utf-8"), _now()),
            )
        return value


@dataclass(frozen=True)
class TelegramRuntimeConfig:
    """Durable Telegram settings with a deliberately separate secret field."""

    enabled: bool
    bot_token: str
    bot_username: str | None
    owner_bound: bool
    updated_at: float

    @property
    def configured(self) -> bool:
        return bool(self.bot_token)

    def public_payload(self) -> dict[str, Any]:
        """Return the stable API shape; never include ``bot_token``."""

        return {
            "schema": 1,
            "enabled": self.enabled,
            "configured": self.configured,
            "botUsername": self.bot_username,
            "ownerBound": self.owner_bound,
        }


_UNSET = object()


class RuntimeConfigStore:
    """Small, reusable SQLite-backed store for non-queue bridge state.

    Queue rows remain owned by :class:`QueueStore`; this facade uses the
    existing ``bridge_state`` table for replaceable versioned JSON snapshots.
    Secrets can be read by the future Telegram manager through the explicit
    ``get_telegram_config`` method, while HTTP callers use
    ``public_telegram_config`` and never receive the token.
    """

    def __init__(self, queue_store: QueueStore) -> None:
        if not isinstance(queue_store, QueueStore):
            raise TypeError("RuntimeConfigStore 需要 QueueStore")
        self.store = queue_store

    @staticmethod
    def _decode_object(raw: str | None) -> dict[str, Any] | None:
        if raw is None:
            return None
        try:
            value = json.loads(raw)
        except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
            return None
        return dict(value) if isinstance(value, dict) else None

    def _get_object(self, key: str) -> dict[str, Any] | None:
        return self._decode_object(self.store.get_state(key))

    def _set_object(self, key: str, value: Mapping[str, Any]) -> None:
        try:
            encoded = json.dumps(
                dict(value),
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError, OverflowError, UnicodeError) as error:
            raise ValueError("runtime config 不是有效 JSON") from error
        if len(encoded) > _RUNTIME_CONFIG_MAX_BYTES:
            raise ValueError("runtime config 输入过大")
        self.store.set_state(key, encoded.decode("utf-8"))

    def get_bearer_token(self) -> str | None:
        raw = self.store.get_state(BEARER_TOKEN_STATE_KEY)
        if not raw:
            return None
        value = str(raw).strip()
        return value if len(value) >= 32 else None

    def set_bearer_token(self, token: str) -> str:
        value = str(token).strip()
        if len(value) < 32 or len(value) > 512:
            raise ValueError("bearer token 长度必须在 32 到 512 个字符之间")
        if any(ord(character) < 0x21 or ord(character) > 0x7E for character in value):
            raise ValueError("bearer token 只能包含可打印 ASCII 字符")
        self.store.set_state(BEARER_TOKEN_STATE_KEY, value)
        return value

    def get_pairing_state(self) -> dict[str, Any] | None:
        value = self._get_object(PAIRING_STATE_KEY)
        return dict(value) if value is not None else None

    def set_pairing_state(self, state: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(state, Mapping):
            raise ValueError("pairing state 必须是对象")
        normalized: dict[str, Any] = {
            "schema": 1,
            "paired": bool(state.get("paired", False)),
            "failures": max(0, int(state.get("failures", 0) or 0)),
            "closed": bool(state.get("closed", False)),
        }
        for key in ("codeHash", "expiresAt", "pairedAt", "pairedClientId"):
            if key in state and state[key] is not None:
                normalized[key] = state[key]
        self._set_object(PAIRING_STATE_KEY, normalized)
        return normalized

    @staticmethod
    def _validate_bot_token(value: str) -> str:
        token = str(value).strip()
        if len(token) > 512:
            raise ValueError("Telegram botToken 不能超过 512 个字符")
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in token):
            raise ValueError("Telegram botToken 不得包含控制字符")
        return token

    @staticmethod
    def _validate_bot_username(value: str | None) -> str | None:
        if value is None or value == "":
            return None
        username = str(value).strip()
        if len(username) > 64 or any(
            ord(character) < 0x20 or ord(character) == 0x7F for character in username
        ):
            raise ValueError("Telegram botUsername 无效")
        return username

    def get_telegram_config(self) -> TelegramRuntimeConfig:
        value = self._get_object(TELEGRAM_RUNTIME_CONFIG_STATE_KEY) or {}
        token = self._validate_bot_token(str(value.get("botToken", "")))
        username = self._validate_bot_username(value.get("botUsername"))
        try:
            updated_at = float(value.get("updatedAt", 0.0) or 0.0)
        except (TypeError, ValueError):
            updated_at = 0.0
        return TelegramRuntimeConfig(
            enabled=bool(value.get("enabled", False)),
            bot_token=token,
            bot_username=username,
            owner_bound=bool(value.get("ownerBound", False)),
            updated_at=updated_at,
        )

    def ensure_telegram_config(
        self, *, enabled: bool = False, bot_token: str = ""
    ) -> TelegramRuntimeConfig:
        if self.store.get_state(TELEGRAM_RUNTIME_CONFIG_STATE_KEY) is None:
            return self.set_telegram_config(enabled=enabled, bot_token=bot_token)
        return self.get_telegram_config()

    def set_telegram_config(
        self,
        *,
        enabled: bool,
        bot_token: str | None = None,
    ) -> TelegramRuntimeConfig:
        current = self.get_telegram_config()
        token = current.bot_token if bot_token is None else self._validate_bot_token(bot_token)
        if bool(enabled) and not token:
            raise ValueError("启用 Telegram 前必须设置 botToken")
        token_changed = bot_token is not None and token != current.bot_token
        value = {
            "schema": 1,
            "enabled": bool(enabled),
            "botToken": token,
            "botUsername": None if token_changed else current.bot_username,
            "ownerBound": False if token_changed else current.owner_bound,
            "updatedAt": _now(),
        }
        self._set_object(TELEGRAM_RUNTIME_CONFIG_STATE_KEY, value)
        return self.get_telegram_config()

    def update_telegram_identity(
        self,
        *,
        bot_username: str | None | object = _UNSET,
        owner_bound: bool | object = _UNSET,
    ) -> TelegramRuntimeConfig:
        """Update manager-owned identity fields without exposing the token."""

        current = self.get_telegram_config()
        username = (
            current.bot_username
            if bot_username is _UNSET
            else self._validate_bot_username(bot_username)  # type: ignore[arg-type]
        )
        bound = current.owner_bound if owner_bound is _UNSET else bool(owner_bound)
        self._set_object(
            TELEGRAM_RUNTIME_CONFIG_STATE_KEY,
            {
                "schema": 1,
                "enabled": current.enabled,
                "botToken": current.bot_token,
                "botUsername": username,
                "ownerBound": bound,
                "updatedAt": _now(),
            },
        )
        return self.get_telegram_config()

    def public_telegram_config(self) -> dict[str, Any]:
        return self.get_telegram_config().public_payload()
