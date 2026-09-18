"""Telegram Bot API integration for the local bridge.

The service is deliberately built around a small transport protocol.  Tests
can provide an in-memory transport, while production uses the raw HTTPS Bot
API through :class:`HttpTelegramTransport`; no Telegram SDK state is required
and no credentials are written to the queue.
"""

from __future__ import annotations

import asyncio
import re
import secrets
import time
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

import httpx

from .db import JobRecord, QueueStore
from .normalize import is_magnet, normalize_exact_code, valid_public_https_url
from .providers.base import AvMetadata, MagnetCandidate, ProviderError
from .schemas import IntentModel, model_dump


CALLBACK_PREFIX = "av1:"
_CALLBACK_TOKEN = re.compile(r"^[A-Za-z0-9_-]{20,48}$")
_AV_COMMAND = re.compile(
    r"^/av(?:@[A-Za-z0-9_]{1,64})?\s+(\S+)$", re.IGNORECASE
)
_ANIME_COMMAND = re.compile(
    r"^/anime(?:@[A-Za-z0-9_]{1,64})?\s+(.+?)\s*$", re.IGNORECASE
)
_MAX_CANDIDATES = 24
_MAX_CAPTION = 1024
_MAX_BUTTON_TEXT = 56


class TelegramError(RuntimeError):
    """A sanitized Telegram transport failure."""


class TelegramTransport(Protocol):
    async def get_updates(self, *, offset: int | None, timeout: int) -> list[dict[str, Any]]:
        ...

    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        reply_markup: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        ...

    async def send_photo(
        self,
        chat_id: int,
        photo: str,
        caption: str,
        *,
        reply_markup: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        ...

    async def answer_callback_query(
        self,
        callback_query_id: str,
        *,
        text: str | None = None,
        show_alert: bool = False,
    ) -> Any:
        ...

    async def edit_message_text(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        *,
        reply_markup: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        ...


class HttpTelegramTransport:
    """Small raw Bot API client with bounded, non-verbose errors."""

    def __init__(
        self,
        token: str,
        *,
        timeout_seconds: float = 30.0,
        client: httpx.AsyncClient | None = None,
        api_base_url: str = "https://api.telegram.org",
    ) -> None:
        token = str(token or "").strip()
        if not token:
            raise ValueError("Telegram Bot token 不能为空")
        base = str(api_base_url or "https://api.telegram.org").rstrip("/")
        if not base.startswith("https://"):
            raise ValueError("Telegram API 必须使用 HTTPS")
        self._token = token
        self._base_url = base
        self._timeout_seconds = max(1.0, min(float(timeout_seconds), 120.0))
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(self._timeout_seconds),
            follow_redirects=False,
            headers={"Accept": "application/json"},
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def request(self, method: str, payload: Mapping[str, Any] | None = None) -> Any:
        """Call one Bot API method without putting the token in error text."""

        method = str(method or "").strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{1,64}", method):
            raise TelegramError("Telegram 方法名无效")
        try:
            response = await self._client.post(
                f"{self._base_url}/bot{self._token}/{method}",
                json=dict(payload or {}),
                follow_redirects=False,
            )
        except TypeError:
            # Lightweight fake httpx clients often omit follow_redirects.
            try:
                response = await self._client.post(
                    f"{self._base_url}/bot{self._token}/{method}",
                    json=dict(payload or {}),
                )
            except Exception as error:
                raise TelegramError("Telegram 网络请求失败") from error
        except Exception as error:
            raise TelegramError("Telegram 网络请求失败") from error
        status = int(getattr(response, "status_code", 0) or 0)
        if status < 200 or status >= 300:
            raise TelegramError(f"Telegram HTTP 请求失败（{status}）")
        try:
            body = response.json()
        except Exception as error:
            raise TelegramError("Telegram 返回格式无效") from error
        if not isinstance(body, Mapping) or body.get("ok") is not True:
            # The Bot API description can contain request details; never copy
            # it into local logs or user-facing status messages.
            raise TelegramError("Telegram 请求未被接受")
        return body.get("result")

    async def get_updates(
        self,
        *,
        offset: int | None,
        timeout: int,
    ) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {
            "timeout": max(0, min(int(timeout), 50)),
            "allowed_updates": ["message", "callback_query"],
        }
        if offset is not None:
            payload["offset"] = int(offset)
        result = await self.request("getUpdates", payload)
        if not isinstance(result, Sequence) or isinstance(result, (str, bytes, bytearray)):
            raise TelegramError("Telegram updates 返回格式无效")
        return [dict(item) for item in result if isinstance(item, Mapping)]

    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        reply_markup: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        payload: dict[str, Any] = {"chat_id": int(chat_id), "text": str(text)[:4096]}
        if reply_markup is not None:
            payload["reply_markup"] = dict(reply_markup)
        result = await self.request("sendMessage", payload)
        return result if isinstance(result, Mapping) else {}

    async def send_photo(
        self,
        chat_id: int,
        photo: str,
        caption: str,
        *,
        reply_markup: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        payload: dict[str, Any] = {
            "chat_id": int(chat_id),
            "photo": str(photo),
            "caption": str(caption)[:_MAX_CAPTION],
        }
        if reply_markup is not None:
            payload["reply_markup"] = dict(reply_markup)
        result = await self.request("sendPhoto", payload)
        return result if isinstance(result, Mapping) else {}

    async def answer_callback_query(
        self,
        callback_query_id: str,
        *,
        text: str | None = None,
        show_alert: bool = False,
    ) -> Any:
        payload: dict[str, Any] = {
            "callback_query_id": str(callback_query_id),
            "show_alert": bool(show_alert),
        }
        if text:
            payload["text"] = str(text)[:200]
        return await self.request("answerCallbackQuery", payload)

    async def edit_message_text(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        *,
        reply_markup: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        payload: dict[str, Any] = {
            "chat_id": int(chat_id),
            "message_id": int(message_id),
            "text": str(text)[:4096],
        }
        if reply_markup is not None:
            payload["reply_markup"] = dict(reply_markup)
        result = await self.request("editMessageText", payload)
        return result if isinstance(result, Mapping) else {}


def _as_mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _field(value: object, name: str, default: Any = "") -> Any:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _int(value: object) -> int | None:
    try:
        return int(value) if value is not None and str(value).strip() else None
    except (TypeError, ValueError):
        return None


def _message_id(value: object) -> int | None:
    if isinstance(value, int):
        return value
    return _int(_field(value, "message_id", _field(value, "messageId", None)))


def _clip(value: object, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= limit else f"{text[: max(0, limit - 1)]}…"


class TelegramService:
    """Handle `/av` commands, one-time selection callbacks, and status edits."""

    def __init__(
        self,
        store: QueueStore,
        provider: Any,
        transport: TelegramTransport,
        *,
        anime_provider: Any | None = None,
        allowed_chat_ids: Sequence[int] | set[int] | frozenset[int] = (),
        allowed_user_ids: Sequence[int] | set[int] | frozenset[int] = (),
        callback_ttl_seconds: int = 900,
        poll_timeout: int = 25,
        clock: Any = time.time,
    ) -> None:
        self.store = store
        self.provider = provider
        self.anime_provider = anime_provider
        self.transport = transport
        self.allowed_chat_ids = frozenset(int(item) for item in allowed_chat_ids)
        self.allowed_user_ids = frozenset(int(item) for item in allowed_user_ids)
        self.callback_ttl_seconds = max(60, min(int(callback_ttl_seconds), 86400))
        self.poll_timeout = max(0, min(int(poll_timeout), 50))
        self.clock = clock
        saved_offset = None
        get_state = getattr(store, "get_state", None)
        if callable(get_state):
            try:
                raw_offset = get_state("telegram.update_offset")
                saved_offset = _int(raw_offset)
            except Exception:
                saved_offset = None
        self._next_update_id: int | None = saved_offset
        self._poll_stop = asyncio.Event()
        self._status_lock = asyncio.Lock()

    def authorized(self, chat_id: object, user_id: object) -> bool:
        chat = _int(chat_id)
        user = _int(user_id)
        if chat is None or user is None or chat not in self.allowed_chat_ids:
            return False
        return not self.allowed_user_ids or user in self.allowed_user_ids

    async def _answer(
        self,
        callback_id: object,
        *,
        text: str | None = None,
        show_alert: bool = False,
    ) -> None:
        value = str(callback_id or "").strip()
        if not value:
            return
        try:
            await self.transport.answer_callback_query(
                value, text=text, show_alert=show_alert
            )
        except Exception:
            # A callback answer is best effort.  It must never turn a durable
            # queue insertion into a failed operation.
            return

    @staticmethod
    def _chat_user(message: Mapping[str, Any]) -> tuple[int | None, int | None]:
        chat = _as_mapping(message.get("chat"))
        sender = _as_mapping(message.get("from"))
        return _int(chat.get("id")), _int(sender.get("id"))

    @staticmethod
    def _callback_message(update: Mapping[str, Any]) -> tuple[Mapping[str, Any], int | None, int | None]:
        callback = _as_mapping(update.get("callback_query"))
        message = _as_mapping(callback.get("message"))
        chat = _as_mapping(message.get("chat"))
        sender = _as_mapping(callback.get("from"))
        return message, _int(chat.get("id")), _int(sender.get("id"))

    @staticmethod
    def _metadata_details(metadata: object) -> tuple[str, str, str, str, list[object]]:
        keyword = _field(metadata, "keyword")
        code = _clip(_field(metadata, "code"), 64)
        title = _clip(_field(metadata, "title") or keyword, 512)
        page_url = _clip(
            _field(
                metadata,
                "page_url",
                _field(metadata, "pageUrl", _field(metadata, "feed_url", _field(metadata, "feedUrl"))),
            ),
            2048,
        )
        cover_url = _clip(_field(metadata, "cover_url", _field(metadata, "coverUrl")), 2048)
        candidates = _field(metadata, "candidates", ())
        if not candidates and isinstance(metadata, Sequence) and not isinstance(
            metadata, (str, bytes, bytearray)
        ):
            candidates = metadata
        if not isinstance(candidates, Sequence) or isinstance(candidates, (str, bytes, bytearray)):
            candidates = []
        return code, title, page_url, cover_url, list(candidates)

    @staticmethod
    def _candidate_details(candidate: object) -> tuple[str, str, str, str]:
        url = str(_field(candidate, "url", "") or "").strip()
        title = _clip(_field(candidate, "title", ""), 512)
        btih = str(_field(candidate, "btih", "") or "").strip().lower()
        key = str(_field(candidate, "dedupe_key", _field(candidate, "dedupeKey", "")) or "").strip()
        return url, title, btih, key

    def _caption(self, code: str, title: str, *, prefix: str = "") -> str:
        lines = [value for value in (prefix, code, title) if value]
        return _clip("\n".join(lines), _MAX_CAPTION)

    def _intent(
        self,
        *,
        code: str,
        title: str,
        page_url: str,
        cover_url: str,
        candidate: object,
        callback_token: str,
        source_site: str = "javbus",
        media_type: str = "jav",
        processor_profile: str = "jav",
        provider_name: str = "javbus",
    ) -> tuple[dict[str, Any], str]:
        url, candidate_title, btih, candidate_key = self._candidate_details(candidate)
        if not candidate_key:
            candidate_key = f"url:{url}"
        guid = _clip(_field(candidate, "guid"), 2048)
        detail_url = _clip(
            _field(candidate, "detail_url", _field(candidate, "detailUrl")),
            2048,
        )
        is_anime = source_site == "nyaa"
        raw_intent = {
            "jobId": f"callback-{callback_token}",
            "sourceSite": source_site,
            "mediaType": media_type,
            "processorProfile": processor_profile,
            "url": url,
            "title": (candidate_title or title or "Nyaa torrent") if is_anime else (title or candidate_title or code),
            "code": code,
            "metadata": {
                "provider": provider_name,
                "pageUrl": page_url,
                "coverUrl": cover_url,
                "candidateTitle": candidate_title,
                "btih": btih,
                "monitorDownload": True,
            },
            "savePathCid": "0",
        }
        if is_anime:
            raw_intent["metadata"].update(
                {
                    "originalTitle": candidate_title or title or "Nyaa torrent",
                    "guid": guid,
                    "detailUrl": detail_url or guid,
                }
            )
        validated = IntentModel.model_validate(raw_intent)
        return model_dump(validated), candidate_key

    async def _send_result_for_user(
        self,
        chat_id: int,
        user_id: int,
        *,
        code: str,
        title: str,
        page_url: str,
        cover_url: str,
        candidates: Sequence[object],
        source_site: str = "javbus",
        media_type: str = "jav",
        processor_profile: str = "jav",
        provider_name: str = "javbus",
    ) -> Mapping[str, Any]:
        """Send a lookup and bind each opaque callback to its command user."""

        # The user binding is supplied at insertion time so callback rows are
        # impossible to create without explicit Telegram ownership.
        if not valid_public_https_url(cover_url):
            cover_url = ""
        rows: list[list[dict[str, str]]] = []
        callback_specs: list[tuple[str, dict[str, Any]]] = []
        for candidate in list(candidates)[:_MAX_CANDIDATES]:
            url, candidate_title, _btih, _key = self._candidate_details(candidate)
            if not url:
                continue
            token = secrets.token_urlsafe(18)
            while not _CALLBACK_TOKEN.fullmatch(token):
                token = secrets.token_urlsafe(18)
            if not is_magnet(url):
                continue
            try:
                intent, candidate_key = self._intent(
                    code=code,
                    title=title,
                    page_url=page_url,
                    cover_url=cover_url,
                    candidate=candidate,
                    callback_token=token,
                    source_site=source_site,
                    media_type=media_type,
                    processor_profile=processor_profile,
                    provider_name=provider_name,
                )
            except (TypeError, ValueError):
                continue
            callback_specs.append((token, {"intent": intent, "candidateKey": candidate_key}))
            rows.append(
                [{"text": _clip(candidate_title or url, _MAX_BUTTON_TEXT), "callback_data": f"{CALLBACK_PREFIX}{token}"}]
            )
        reply_markup: Mapping[str, Any] | None = {"inline_keyboard": rows} if rows else None
        caption = self._caption(code, title)
        if cover_url:
            try:
                result = await self.transport.send_photo(
                    chat_id, cover_url, caption, reply_markup=reply_markup
                )
            except Exception:
                result = await self.transport.send_message(
                    chat_id, caption, reply_markup=reply_markup
                )
        else:
            result = await self.transport.send_message(
                chat_id, caption, reply_markup=reply_markup
            )
        message_id = _message_id(result)
        if message_id is None:
            raise TelegramError("Telegram 消息缺少 message_id")
        expiry = float(self.clock()) + self.callback_ttl_seconds
        for token, candidate_payload in callback_specs:
            self.store.create_callback(
                token,
                chat_id=chat_id,
                user_id=user_id,
                message_id=message_id,
                candidate=candidate_payload,
                expires_at=expiry,
            )
        return result

    async def _handle_command(self, message: Mapping[str, Any]) -> dict[str, Any]:
        chat_id, user_id = self._chat_user(message)
        if not self.authorized(chat_id, user_id):
            return {"ignored": True, "reason": "unauthorized"}
        text = str(message.get("text", "") or "").strip()
        match = _AV_COMMAND.fullmatch(text)
        anime_match = _ANIME_COMMAND.fullmatch(text)
        if not match and not anime_match:
            return {"ignored": True, "reason": "unsupported_command"}
        if anime_match:
            keyword = _clip(anime_match.group(1), 256)
            if not keyword:
                await self.transport.send_message(chat_id, "请输入搜索关键词，例如 /anime One Piece")
                return {"handled": True, "error": "invalid_keyword"}
            if self.anime_provider is None:
                await self.transport.send_message(chat_id, "Nyaa 搜索未配置，请先配置 Anime provider。")
                return {"handled": True, "error": "provider_unavailable"}
            try:
                metadata = await self.anime_provider.search(keyword)
            except ProviderError:
                await self.transport.send_message(chat_id, "Nyaa 暂时无法查询，请稍后重试。")
                return {"handled": True, "error": "provider_unavailable"}
            except Exception:
                await self.transport.send_message(chat_id, "Nyaa 查询失败，请稍后重试。")
                return {"handled": True, "error": "provider_error"}
            _unused_code, _unused_title, feed_url, _unused_cover, candidates = self._metadata_details(metadata)
            if not candidates:
                await self.transport.send_message(chat_id, "Nyaa 没有找到匹配的资源。")
                return {"handled": True, "kind": "anime", "candidateCount": 0}
            result = await self._send_result_for_user(
                chat_id,
                user_id,
                code="",
                title=keyword,
                page_url=feed_url,
                cover_url="",
                candidates=candidates,
                source_site="nyaa",
                media_type="anime",
                processor_profile="anime",
                provider_name="nyaa",
            )
            return {
                "handled": True,
                "kind": "anime",
                "keyword": keyword,
                "candidateCount": len(candidates),
                "messageId": _message_id(result),
            }
        code = normalize_exact_code(match.group(1))
        if not code:
            await self.transport.send_message(chat_id, "请输入有效的番号，例如 /av ABC-123")
            return {"handled": True, "error": "invalid_code"}
        try:
            metadata = await self.provider.lookup(code)
        except ProviderError:
            await self.transport.send_message(chat_id, "JavBus 暂时无法查询该番号，请稍后重试。")
            return {"handled": True, "error": "provider_unavailable"}
        except Exception:
            await self.transport.send_message(chat_id, "查询失败，请稍后重试。")
            return {"handled": True, "error": "provider_error"}
        actual_code, title, page_url, cover_url, candidates = self._metadata_details(metadata)
        actual_code = normalize_exact_code(actual_code) or code
        result = await self._send_result_for_user(
            chat_id,
            user_id,
            code=actual_code,
            title=title or actual_code,
            page_url=page_url,
            cover_url=cover_url,
            candidates=candidates,
        )
        return {
            "handled": True,
            "kind": "av",
            "code": actual_code,
            "candidateCount": len(candidates),
            "messageId": _message_id(result),
        }

    async def _handle_callback(self, callback: Mapping[str, Any]) -> dict[str, Any]:
        message = _as_mapping(callback.get("message"))
        chat = _as_mapping(message.get("chat"))
        sender = _as_mapping(callback.get("from"))
        chat_id = _int(chat.get("id"))
        user_id = _int(sender.get("id"))
        callback_id = callback.get("id")
        if not self.authorized(chat_id, user_id):
            return {"ignored": True, "reason": "unauthorized"}
        raw_data = str(callback.get("data", "") or "")
        if not raw_data.startswith(CALLBACK_PREFIX):
            await self._answer(callback_id, text="按钮已失效")
            return {"handled": True, "error": "invalid_callback"}
        token = raw_data[len(CALLBACK_PREFIX) :]
        if not _CALLBACK_TOKEN.fullmatch(token):
            await self._answer(callback_id, text="按钮已失效")
            return {"handled": True, "error": "invalid_callback"}
        message_id = _int(message.get("message_id"))
        if chat_id is None or user_id is None or message_id is None:
            await self._answer(callback_id, text="按钮已失效")
            return {"handled": True, "error": "invalid_callback"}
        # Validate the opaque payload before mutating the callback row.  The
        # actual consume and queue insertion below are one SQLite transaction.
        # Thus a crash or DB error cannot burn a button without a durable job.
        candidate = self.store.peek_callback(
            token,
            chat_id=chat_id,
            user_id=user_id,
            message_id=message_id,
            now=float(self.clock()),
        )
        if not candidate:
            await self._answer(callback_id, text="按钮已过期或已使用")
            return {"handled": True, "error": "callback_expired"}
        raw_intent = _as_mapping(candidate.get("intent"))
        try:
            validated = IntentModel.model_validate(raw_intent)
            intent = model_dump(validated)
            candidate_key = str(candidate.get("candidateKey") or "").strip()
            if not candidate_key:
                raise ValueError("callback 缺少候选键")
        except Exception:
            return {"handled": True, "error": "invalid_candidate"}
        result = self.store.consume_callback_and_enqueue(
            token,
            chat_id=chat_id,
            user_id=user_id,
            message_id=message_id,
            intent=intent,
            candidate_key=candidate_key,
            now=float(self.clock()),
        )
        if result is None:
            await self._answer(callback_id, text="按钮已过期或已使用")
            return {"handled": True, "error": "callback_expired"}
        record, inserted = result
        await self._answer(callback_id, text="已加入本地队列")
        if inserted and record.status_message_id is None:
            try:
                status = await self.transport.send_message(
                    chat_id,
                    self._status_text(record),
                )
                status_id = _message_id(status)
                if status_id is not None:
                    record = self.store.set_status_message_id(record.job_id, status_id)
                    self.store.mark_notified(
                        record.job_id,
                        state=record.status,
                        percent=record.percent,
                    )
            except Exception:
                # The durable job remains claimable even when Telegram status
                # delivery is temporarily unavailable.
                pass
        return {
            "handled": True,
            "kind": "callback",
            "jobId": record.job_id,
            "duplicate": not inserted,
        }

    async def handle_update(self, update: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(update, Mapping):
            return {"ignored": True, "reason": "invalid_update"}
        callback = update.get("callback_query")
        if isinstance(callback, Mapping):
            return await self._handle_callback(callback)
        message = update.get("message")
        if isinstance(message, Mapping):
            return await self._handle_command(message)
        return {"ignored": True, "reason": "unsupported_update"}

    @staticmethod
    def _status_text(job: JobRecord) -> str:
        labels = {
            "queued": "已加入本地队列，等待浏览器领取",
            "claimed": "浏览器已领取，准备提交到 115",
            "accepted": "已提交到 115，等待下载",
            "progress": "115 任务进行中",
            "completed": "115 任务已完成",
            "failed": "115 任务失败",
            "uncertain": "提交结果不明确，已停止自动重试",
        }
        text = labels.get(job.status, "任务状态已更新")
        if job.percent is not None and job.status in {"progress", "completed"}:
            text += f"（{job.percent:g}%）"
        if job.message:
            text += f"\n{_clip(job.message, 800)}"
        if job.error_message and job.status in {"failed", "uncertain"}:
            text += f"\n{_clip(job.error_message, 800)}"
        return _clip(text, 4096)

    async def notify_status_once(self) -> int:
        """Deliver changed queue states to their originating Telegram chats."""

        delivered = 0
        async with self._status_lock:
            jobs = self.store.list_jobs(
                telegram_only=True,
                include_terminal=True,
                changed_only=True,
                limit=500,
            )
            for job in jobs:
                if job.telegram_chat_id is None or job.telegram_user_id is None:
                    continue
                if not self.authorized(job.telegram_chat_id, job.telegram_user_id):
                    continue
                if (
                    job.last_notified_state == job.status
                    and job.last_notified_percent == job.percent
                    and job.status_message_id is not None
                ):
                    continue
                text = self._status_text(job)
                try:
                    status_id = job.status_message_id
                    if status_id is not None and hasattr(self.transport, "edit_message_text"):
                        await self.transport.edit_message_text(
                            job.telegram_chat_id,
                            status_id,
                            text,
                        )
                    else:
                        sent = await self.transport.send_message(
                            job.telegram_chat_id,
                            text,
                        )
                        status_id = _message_id(sent)
                        if status_id is not None:
                            self.store.set_status_message_id(job.job_id, status_id)
                    self.store.mark_notified(
                        job.job_id,
                        state=job.status,
                        percent=job.percent,
                    )
                    delivered += 1
                except Exception:
                    # Keep last_notified unchanged so the next polling cycle
                    # retries the status without duplicating successful edits.
                    continue
        return delivered

    async def poll_once(self) -> dict[str, int]:
        updates = await self.transport.get_updates(
            offset=self._next_update_id,
            timeout=self.poll_timeout,
        )
        handled = 0
        for update in updates:
            update_id = _int(update.get("update_id"))
            if update_id is not None:
                self._next_update_id = max(self._next_update_id or 0, update_id + 1)
            try:
                result = await self.handle_update(update)
                if result.get("handled"):
                    handled += 1
            except Exception:
                # One malformed update must not prevent later updates from
                # advancing the offset.
                continue
            finally:
                set_state = getattr(self.store, "set_state", None)
                if update_id is not None and callable(set_state):
                    try:
                        set_state("telegram.update_offset", str(self._next_update_id))
                    except Exception:
                        pass
        notified = await self.notify_status_once()
        return {"updates": len(updates), "handled": handled, "notified": notified}

    async def run_forever(self, stop_event: asyncio.Event | None = None) -> None:
        stop = stop_event or self._poll_stop
        while not stop.is_set():
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    continue

    def stop(self) -> None:
        self._poll_stop.set()
