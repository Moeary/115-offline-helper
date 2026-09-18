"""FastAPI application for the local Telegram-to-browser queue bridge."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .auth import authenticate
from .config import Settings
from .db import LeaseConflict, QueueStore, StateConflict, UnknownJob
from .providers.javbus import JavBusProvider
from .schemas import ClaimRequest, EventRequest
from .telegram import HttpTelegramTransport, TelegramService


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail="需要有效的 Bearer token",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _job_status_payload(record: Any) -> dict[str, Any]:
    """Serialize status fields safe for the browser worker response."""

    return {
        "jobId": record.job_id,
        "status": record.status,
        "taskId": record.task_id,
        "remoteId": record.remote_id,
        "percent": record.percent,
        "message": record.message,
        "errorCode": record.error_code,
        "errorMessage": record.error_message,
        "updatedAt": record.updated_at,
    }


def create_app(
    settings: Settings | None = None,
    *,
    store: QueueStore | None = None,
    provider: Any | None = None,
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
    owns_telegram_transport = False
    transport = None
    service = telegram_service
    if service is None and settings.telegram_bot_token:
        transport = HttpTelegramTransport(settings.telegram_bot_token)
        owns_telegram_transport = True
        service = TelegramService(
            queue,
            av_provider,
            transport,
            allowed_chat_ids=settings.telegram_allowed_chat_ids,
            allowed_user_ids=settings.telegram_allowed_user_ids,
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
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Accept", "Authorization", "Content-Type"],
            max_age=600,
        )
    app.state.settings = settings
    app.state.store = queue
    app.state.provider = av_provider
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
        return {"schema": 1, "job": _job_status_payload(record)}

    return app


app = None
