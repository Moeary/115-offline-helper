"""FastAPI application for the local Telegram-to-browser queue bridge."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import math
import re
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .auth import authenticate
from .config import Settings
from .db import (
    ActionRecord,
    LeaseConflict,
    QueueStore,
    StateConflict,
    UnknownAction,
    UnknownJob,
)
from .providers.javbus import JavBusProvider
from .providers.nyaa import NyaaRssProvider
from .schemas import (
    ActionClaimRequest,
    ActionCommandRequest,
    ActionEventRequest,
    ClaimRequest,
    DirectoryRegistryRequest,
    EventRequest,
)
from .telegram import HttpTelegramTransport, TelegramService


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail="需要有效的 Bearer token",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _action_payload(record: ActionRecord) -> dict[str, Any]:
    return {
        "actionId": record.action_id,
        "jobId": record.job_id,
        "actionType": record.action_type,
        "type": record.action_type,
        "status": record.status,
        "requestId": record.request_id,
        "attemptCount": record.attempt_count,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    }


def _job_status_payload(record: Any, *, include_intent: bool = True) -> dict[str, Any]:
    """Serialize status fields safe for the browser worker response."""

    return {
        "jobId": record.job_id,
        "parentJobId": record.parent_job_id,
        "retryCount": record.retry_count,
        "status": record.status,
        **({"intent": record.intent} if include_intent else {}),
        "attemptCount": record.attempt_count,
        "taskId": record.task_id,
        "remoteId": record.remote_id,
        "percent": record.percent,
        "message": record.message,
        "errorCode": record.error_code,
        "errorMessage": record.error_message,
        "updatedAt": record.updated_at,
    }


def _encode_cursor(value: tuple[float, str] | None) -> str | None:
    if value is None:
        return None
    raw = json.dumps([float(value[0]), str(value[1])], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(value: str | None) -> tuple[float, str] | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError("cursor 无效")
    if len(value) > 512:
        raise ValueError("cursor 无效")
    # ``urlsafe_b64decode`` is permissive by default: it silently discards
    # characters outside the alphabet.  A cursor is an opaque server value,
    # so accepting a damaged token could make a client jump to an unintended
    # page.  The API emits unpadded Base64, while accepting valid terminal
    # padding keeps older clients compatible.
    if not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", value) or (
        "=" in value and not value.endswith("=")
    ):
        raise ValueError("cursor 无效")
    try:
        unpadded = value.rstrip("=")
        if len(unpadded) % 4 == 1:
            raise ValueError("cursor 无效")
        supplied_padding = value[len(unpadded):]
        expected_padding = "=" * (-len(unpadded) % 4)
        if supplied_padding not in ("", expected_padding):
            raise ValueError("cursor 无效")
        padded = unpadded + expected_padding
        decoded = json.loads(
            base64.b64decode(padded.encode("ascii"), altchars=b"-_", validate=True)
        )
        if not isinstance(decoded, list) or len(decoded) != 2:
            raise ValueError("cursor 无效")
        if isinstance(decoded[0], bool) or not isinstance(decoded[0], (int, float)):
            raise ValueError("cursor 无效")
        timestamp = float(decoded[0])
        if not isinstance(decoded[1], str):
            raise ValueError("cursor 无效")
        job_id = decoded[1].strip()
    except (
        ValueError,
        TypeError,
        IndexError,
        KeyError,
        UnicodeDecodeError,
        UnicodeEncodeError,
        OverflowError,
        binascii.Error,
        json.JSONDecodeError,
    ):
        raise ValueError("cursor 无效") from None
    if not math.isfinite(timestamp) or not job_id or len(job_id) > 128:
        raise ValueError("cursor 无效")
    return timestamp, job_id


def _directory_registry_revision(registry: Any) -> int | None:
    if not isinstance(registry, dict):
        return None
    value = registry.get("revision")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def create_app(
    settings: Settings | None = None,
    *,
    store: QueueStore | None = None,
    provider: Any | None = None,
    anime_provider: Any | None = None,
    telegram_service: TelegramService | None = None,
) -> FastAPI:
    """Create an isolated app instance suitable for production or tests.

    Dependencies can be injected by tests without making network calls.  The
    default factory constructs a JavBus provider and, when configured, a raw
    Telegram Bot API transport.  No polling task starts until the application
    lifespan is entered and ``telegram_polling`` is enabled.
    """

    settings = settings or Settings.from_env()
    owns_store = store is None
    owns_provider = provider is None
    queue = store or QueueStore(settings.db_path, default_lease_seconds=settings.lease_seconds)
    av_provider = provider or JavBusProvider(
        settings.javbus_base_url,
        allowed_hosts=settings.javbus_allowed_hosts,
        timeout_seconds=settings.javbus_timeout_seconds,
        max_response_bytes=settings.javbus_max_response_bytes,
    )
    owns_anime_provider = False
    nyaa_provider = anime_provider
    owns_telegram_transport = False
    transport = None
    service = telegram_service
    if service is None and settings.telegram_bot_token:
        if nyaa_provider is None:
            nyaa_provider = NyaaRssProvider(
                settings.nyaa_base_url,
                allowed_hosts=settings.nyaa_allowed_hosts,
                timeout_seconds=settings.nyaa_timeout_seconds,
                max_response_bytes=settings.nyaa_max_response_bytes,
                max_results=settings.nyaa_max_results,
            )
            owns_anime_provider = True
        transport = HttpTelegramTransport(settings.telegram_bot_token)
        owns_telegram_transport = True
        service = TelegramService(
            queue,
            av_provider,
            transport,
            anime_provider=nyaa_provider,
            allowed_chat_ids=settings.telegram_allowed_chat_ids,
            allowed_user_ids=settings.telegram_allowed_user_ids,
            save_paths=settings.telegram_save_paths,
            callback_ttl_seconds=settings.callback_ttl_seconds,
            poll_timeout=settings.telegram_poll_timeout,
        )

    poll_task: asyncio.Task[Any] | None = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal poll_task
        if service is not None and settings.telegram_polling:
            poll_task = asyncio.create_task(service.run_forever())
        try:
            yield
        finally:
            if service is not None:
                service.stop()
            if poll_task is not None:
                poll_task.cancel()
                try:
                    await poll_task
                except asyncio.CancelledError:
                    pass
                poll_task = None
            if owns_telegram_transport and transport is not None:
                await transport.aclose()
            if owns_provider and hasattr(av_provider, "aclose"):
                await av_provider.aclose()
            if owns_anime_provider and nyaa_provider is not None and hasattr(nyaa_provider, "aclose"):
                await nyaa_provider.aclose()
            if owns_store:
                queue.close()

    app = FastAPI(
        title="115 Offline Helper Bridge",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "PUT", "OPTIONS"],
            allow_headers=["Accept", "Authorization", "Content-Type"],
            max_age=600,
        )
    app.state.settings = settings
    app.state.store = queue
    app.state.provider = av_provider
    app.state.anime_provider = nyaa_provider
    app.state.telegram = service

    async def require_auth(authorization: str | None = Header(default=None)) -> None:
        if not authenticate(authorization, settings.bearer_token):
            raise _unauthorized()

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"schema": 1, "ok": True}

    @app.get("/v1/health")
    async def v1_health(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {"schema": 1, "ok": True}

    @app.get("/v1/runtime/directories")
    async def get_directory_registry(
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        getter = getattr(queue, "get_directory_registry", None)
        registry = getter() if callable(getter) else None
        return {
            "schema": 1,
            "registry": registry,
            "revision": _directory_registry_revision(registry),
        }

    @app.put("/v1/runtime/directories")
    async def put_directory_registry(
        payload: DirectoryRegistryRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        incoming = payload.model_dump(by_alias=True)
        getter = getattr(queue, "get_directory_registry", None)
        current = getter() if callable(getter) else None
        current_revision = _directory_registry_revision(current)
        if current_revision is not None:
            if payload.revision < current_revision:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "directory_registry_stale",
                        "message": "directory registry revision 已过期",
                        "revision": current_revision,
                    },
                )
            if payload.revision == current_revision:
                if current == incoming:
                    return {
                        "schema": 1,
                        "registry": current,
                        "revision": current_revision,
                        "idempotent": True,
                    }
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "directory_registry_revision_conflict",
                        "message": "相同 revision 的 directory registry 内容不同",
                        "revision": current_revision,
                    },
                )
        setter = getattr(queue, "set_directory_registry", None)
        if not callable(setter):
            raise HTTPException(status_code=503, detail="directory registry 不可用")
        try:
            stored = setter(incoming)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {
            "schema": 1,
            "registry": stored,
            "revision": payload.revision,
            "updated": True,
            "idempotent": False,
        }

    @app.get("/v1/jobs")
    async def list_jobs(
        status: str | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=512),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        statuses = tuple(
            item.strip().lower() for item in str(status or "").split(",") if item.strip()
        )
        try:
            decoded_cursor = _decode_cursor(cursor)
            records, next_cursor = queue.list_jobs_page(
                statuses=statuses,
                limit=limit,
                cursor=decoded_cursor,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        jobs: list[dict[str, Any]] = []
        for record in records:
            item = _job_status_payload(record)
            pending = queue.pending_action(record.job_id)
            item["pendingAction"] = _action_payload(pending) if pending else None
            jobs.append(item)
        return {
            "schema": 1,
            "jobs": jobs,
            "nextCursor": _encode_cursor(next_cursor),
        }

    @app.post("/v1/jobs/claim")
    async def claim_job(
        payload: ClaimRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        try:
            record = queue.claim(
                payload.worker_id,
                lease_seconds=payload.lease_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {
            "schema": 1,
            "job": record.claim_payload() if record is not None else None,
        }

    @app.post("/v1/jobs/{job_id}/retry")
    async def retry_job(
        job_id: str,
        payload: ActionCommandRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        try:
            record, replay = queue.clone_retry(
                job_id,
                request_id=payload.request_id,
            )
        except UnknownJob as error:
            raise HTTPException(status_code=404, detail="找不到 bridge job") from error
        except StateConflict as error:
            raise HTTPException(status_code=409, detail="任务状态不允许重试") from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {
            "schema": 1,
            "idempotent": replay,
            "job": _job_status_payload(record),
        }

    @app.post("/v1/jobs/{job_id}/cancel")
    async def cancel_job(
        job_id: str,
        payload: ActionCommandRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        try:
            action, replay = queue.request_cancel(
                job_id,
                request_id=payload.request_id,
                reason=payload.reason,
            )
        except UnknownJob as error:
            raise HTTPException(status_code=404, detail="找不到 bridge job") from error
        except StateConflict as error:
            raise HTTPException(status_code=409, detail="任务状态不允许取消") from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        record = queue.get_job(job_id)
        assert record is not None
        return {
            "schema": 1,
            "idempotent": replay,
            "action": _action_payload(action),
            "job": _job_status_payload(record),
        }

    @app.post("/v1/actions/claim")
    async def claim_action(
        payload: ActionClaimRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        try:
            action = queue.claim_action(
                payload.worker_id,
                lease_seconds=payload.lease_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        if action is None:
            return {"schema": 1, "action": None}
        job = queue.get_job(action.job_id)
        response = action.claim_payload()
        if job is not None:
            response["job"] = _job_status_payload(job)
        return {"schema": 1, "action": response}

    @app.post("/v1/actions/{action_id}/events")
    async def append_action_event(
        action_id: str,
        payload: ActionEventRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        try:
            action, replay = queue.append_action_event(
                action_id,
                lease_id=payload.lease_id,
                event_id=payload.event_id,
                state=payload.state,
                result=payload.result,
                error_code=payload.error_code,
                error_message=payload.error_message,
            )
        except UnknownAction as error:
            raise HTTPException(status_code=404, detail="找不到 bridge action") from error
        except (LeaseConflict, StateConflict) as error:
            raise HTTPException(status_code=409, detail="动作租约或状态冲突") from error
        except (UnknownJob, ValueError) as error:
            status_code = 404 if isinstance(error, UnknownJob) else 422
            raise HTTPException(status_code=status_code, detail=str(error)) from error
        record = queue.get_job(action.job_id)
        return {
            "schema": 1,
            "actionId": action.action_id,
            "eventId": payload.event_id,
            "state": action.status,
            "idempotent": replay,
            "action": _action_payload(action),
            "job": _job_status_payload(record) if record else None,
        }

    @app.post("/v1/jobs/{job_id}/events")
    async def append_job_event(
        job_id: str,
        payload: EventRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        try:
            record, replay = queue.append_event(
                job_id,
                lease_id=payload.lease_id,
                event_id=payload.event_id,
                state=payload.state,
                task_id=payload.task_id,
                remote_id=payload.remote_id,
                percent=payload.percent,
                message=payload.message,
                error_code=payload.error_code,
                error_message=payload.error_message,
            )
        except UnknownJob as error:
            raise HTTPException(status_code=404, detail="找不到 bridge job") from error
        except (LeaseConflict, StateConflict) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {
            "schema": 1,
            "jobId": record.job_id,
            "eventId": payload.event_id,
            "state": record.status,
            "idempotent": replay,
            "job": _job_status_payload(record),
        }

    @app.get("/v1/jobs/{job_id}")
    async def get_job(
        job_id: str,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        record = queue.get_job(job_id)
        if record is None:
            raise HTTPException(status_code=404, detail="找不到 bridge job")
        payload = _job_status_payload(record)
        pending = queue.pending_action(record.job_id)
        payload["pendingAction"] = _action_payload(pending) if pending else None
        return {"schema": 1, "job": payload}

    return app


app = None
