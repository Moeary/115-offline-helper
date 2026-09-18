"""Telegram Bot API integration for the local bridge.

The service is deliberately built around a small transport protocol.  Tests
can provide an in-memory transport, while production uses the raw HTTPS Bot
API through :class:`HttpTelegramTransport`; no Telegram SDK state is required
and no credentials are written to the queue.
"""

from __future__ import annotations

import asyncio
import math
import re
import secrets
import time
from collections.abc import Mapping, Sequence
from typing import Any, Protocol
from urllib.parse import parse_qs, unquote, urlsplit

import httpx

from .db import JobRecord, QueueStore
from .normalize import (
    dedupe_key,
    is_ed2k,
    is_magnet,
    normalize_exact_code,
    parse_ed2k,
    valid_public_https_url,
)
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
_ADD_COMMAND = re.compile(
    r"^/add(?:@[A-Za-z0-9_]{1,64})?\s+(.+?)\s*$", re.IGNORECASE
)
_DIR_COMMAND = re.compile(r"^/(?:dir|path)(?:@[A-Za-z0-9_]{1,64})?\s*$", re.IGNORECASE)
_JOBS_COMMAND = re.compile(r"^/jobs(?:@[A-Za-z0-9_]{1,64})?\s*$", re.IGNORECASE)
_MAX_CANDIDATES = 24
_MAX_CAPTION = 1024
_MAX_BUTTON_TEXT = 56
_MAX_JOBS = 10
_CALLBACK_KINDS = frozenset({"candidate", "dir", "job_detail", "retry", "cancel"})
_TELEGRAM_SAVE_PATH_CID = re.compile(r"(?:0|[1-9][0-9]{0,63})\Z")


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


def _save_path_field(value: object, index: int, name: str) -> object:
    if isinstance(value, (tuple, list)) and len(value) > index:
        return value[index]
    return _field(value, name, "")


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
        save_paths: Sequence[Any] = (),
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
        self.save_paths = tuple(
            (
                str(_save_path_field(item, 0, "cid")).strip(),
                _clip(_save_path_field(item, 1, "name"), 128),
            )
            for item in save_paths
            if _TELEGRAM_SAVE_PATH_CID.fullmatch(
                str(_save_path_field(item, 0, "cid")).strip()
            )
            and _clip(_save_path_field(item, 1, "name"), 128)
        )
        self._save_path_map = {cid: name for cid, name in self.save_paths}
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

    def _latest_directory_registry(self) -> Mapping[str, Any] | None:
        """Read the current browser snapshot without caching it in the service."""

        getter = getattr(self.store, "get_directory_registry", None)
        if not callable(getter):
            return None
        try:
            value = getter()
        except Exception:
            return None
        if not isinstance(value, Mapping):
            return None
        nested = value.get("registry")
        if isinstance(nested, Mapping):
            return nested
        return value

    @staticmethod
    def _registry_path_options(
        registry: Mapping[str, Any],
    ) -> tuple[tuple[str, str], ...]:
        raw_directories = registry.get("directories")
        entries: Sequence[object] = ()
        if isinstance(raw_directories, Sequence) and not isinstance(
            raw_directories, (str, bytes, bytearray)
        ):
            entries = raw_directories
        # Some early browser snapshots represented roots as full entries and
        # kept ``directories`` for descendants.  Use those roots only when
        # they carry a displayable name; string root CIDs remain references.
        if not entries:
            raw_roots = registry.get("roots")
            if isinstance(raw_roots, Sequence) and not isinstance(
                raw_roots, (str, bytes, bytearray)
            ):
                entries = raw_roots

        options: list[tuple[str, str]] = []
        seen_cids: set[str] = set()
        seen_paths: set[str] = set()
        for item in entries:
            cid = str(_field(item, "cid", "") or "").strip()
            name = _clip(_field(item, "name", ""), 128)
            path = str(_field(item, "path", "") or "").strip()
            if not _TELEGRAM_SAVE_PATH_CID.fullmatch(cid) or not name:
                continue
            if cid in seen_cids or (path and path in seen_paths):
                continue
            seen_cids.add(cid)
            if path:
                seen_paths.add(path)
            label = "根目录" if cid == "0" else _clip(path or name, 128)
            options.append((cid, label))
        if options and "0" not in seen_cids:
            options.insert(0, ("0", "根目录"))
        return tuple(options)

    def _path_options(self) -> tuple[tuple[str, str], ...]:
        registry = self._latest_directory_registry()
        if registry is not None:
            return self._registry_path_options(registry)
        return self.save_paths

    def _path_label(self, cid: object) -> str:
        value = str("" if cid is None else cid).strip()
        path_map = dict(self._path_options())
        return path_map.get(value, f"CID {value or '?'}")

    def _preferred_save_path(
        self,
        chat_id: int,
        user_id: int,
        *,
        allow_legacy_root: bool = True,
    ) -> tuple[str | None, bool]:
        """Return the current directory and whether it was user-selected."""

        options = self._path_options()
        registry = self._latest_directory_registry()
        preference = None
        getter = getattr(self.store, "get_telegram_preference", None)
        if callable(getter):
            try:
                value = getter(chat_id, user_id)
                preference = str((value or {}).get("lastSavePathCid") or "").strip()
            except Exception:
                preference = None
        if preference and preference in dict(options):
            return preference, True
        if options:
            return options[0][0], False
        # Keep the old in-process root default for callers that predate the
        # registry API.  An explicitly present (including empty) browser
        # registry never falls through to that implicit CID.
        if registry is None and allow_legacy_root:
            return "0", False
        return None, False

    def _directory_text(self, chat_id: int, user_id: int) -> str:
        options = self._path_options()
        if not options:
            if self._latest_directory_registry() is not None or callable(
                getattr(self.store, "get_directory_registry", None)
            ):
                return "浏览器尚未同步 115 目录，请先打开扩展并同步目录后重试。"
            return "未配置 Telegram 保存目录，请先同步 115 目录或设置 PUSH115_TELEGRAM_SAVE_PATHS。"
        selected, remembered = self._preferred_save_path(chat_id, user_id)
        current = self._path_label(selected)
        source = "上次选择" if remembered else "默认目录"
        return _clip(f"保存目录\n当前：{current}（{source}）\n请选择目录：", 4096)

    def _directory_keyboard(
        self,
        chat_id: int,
        user_id: int,
    ) -> tuple[list[list[dict[str, str]]], list[tuple[str, dict[str, Any]]]]:
        options = self._path_options()
        selected, remembered = self._preferred_save_path(chat_id, user_id)
        rows: list[list[dict[str, str]]] = []
        specs: list[tuple[str, dict[str, Any]]] = []
        for cid, name in options:
            token = self._new_callback_token()
            if cid == selected:
                prefix = "✓ 当前"
            elif not remembered and cid == options[0][0]:
                prefix = "默认"
            else:
                prefix = "目录"
            rows.append(
                [{"text": _clip(f"{prefix} · {name}", _MAX_BUTTON_TEXT), "callback_data": f"{CALLBACK_PREFIX}{token}"}]
            )
            specs.append((token, {"kind": "dir", "cid": cid}))
        return rows, specs

    @staticmethod
    def _new_callback_token() -> str:
        token = secrets.token_urlsafe(18)
        while not _CALLBACK_TOKEN.fullmatch(token):
            token = secrets.token_urlsafe(18)
        return token

    def _job_owner(self, job_id: object, chat_id: int, user_id: int) -> JobRecord | None:
        getter = getattr(self.store, "get_telegram_job", None)
        if callable(getter):
            return getter(str(job_id or "").strip(), chat_id=chat_id, user_id=user_id)
        record = self.store.get_job(str(job_id or "").strip())
        if record is None:
            return None
        if record.telegram_chat_id != chat_id or record.telegram_user_id != user_id:
            return None
        return record

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
        save_path_cid: str | None = None,
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
            "savePathCid": save_path_cid,
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
            token = self._new_callback_token()
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
                    save_path_cid=None,
                    source_site=source_site,
                    media_type=media_type,
                    processor_profile=processor_profile,
                    provider_name=provider_name,
                )
            except (TypeError, ValueError):
                continue
            callback_specs.append(
                (token, {"kind": "candidate", "intent": intent, "candidateKey": candidate_key})
            )
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

    async def _send_directory_picker(
        self,
        chat_id: int,
        user_id: int,
        *,
        prefix: str = "",
    ) -> Mapping[str, Any]:
        rows, specs = self._directory_keyboard(chat_id, user_id)
        text = _clip(f"{prefix}\n{self._directory_text(chat_id, user_id)}".strip(), 4096)
        result = await self.transport.send_message(
            chat_id,
            text,
            reply_markup={"inline_keyboard": rows} if rows else None,
        )
        message_id = _message_id(result)
        if message_id is None:
            raise TelegramError("Telegram 消息缺少 message_id")
        expiry = float(self.clock()) + self.callback_ttl_seconds
        for token, payload in specs:
            self.store.create_callback(
                token,
                chat_id=chat_id,
                user_id=user_id,
                message_id=message_id,
                candidate=payload,
                expires_at=expiry,
            )
        return result

    async def _send_status_message(
        self,
        record: JobRecord,
        *,
        chat_id: int | None = None,
    ) -> JobRecord:
        target_chat = record.telegram_chat_id if chat_id is None else chat_id
        if target_chat is None:
            return record
        status = await self.transport.send_message(target_chat, self._status_text(record))
        status_id = _message_id(status)
        if status_id is None:
            return record
        updated = self.store.set_status_message_id(record.job_id, status_id)
        self.store.mark_notified(
            record.job_id,
            state=updated.status,
            percent=updated.percent,
        )
        return updated

    @staticmethod
    def _job_link_type(job: JobRecord) -> str:
        value = str(job.intent.get("linkType") or "").strip().lower()
        return "ED2K" if value == "ed2k" else "Magnet"

    def _job_title(self, job: JobRecord) -> str:
        return _clip(
            job.intent.get("expectedName")
            or job.intent.get("title")
            or job.intent.get("code")
            or job.intent.get("url")
            or job.job_id,
            512,
        )

    def _job_detail_text(self, job: JobRecord) -> str:
        lines = [
            "任务详情",
            f"ID：{_clip(job.job_id, 32)}",
            f"标题：{self._job_title(job)}",
            f"类型：{self._job_link_type(job)}",
            f"目录：{self._path_label(job.intent.get('savePathCid'))}",
            f"状态：{job.status}",
        ]
        if job.percent is not None:
            lines.append(f"进度：{job.percent:g}%")
        if job.task_id:
            lines.append(f"本地任务：{_clip(job.task_id, 96)}")
        if job.remote_id:
            lines.append(f"远端标识：{_clip(job.remote_id, 96)}")
        if job.error_message and job.status in {"failed", "uncertain"}:
            lines.append(f"错误：{_clip(job.error_message, 800)}")
        if job.message and job.status not in {"failed", "uncertain"}:
            lines.append(f"信息：{_clip(job.message, 800)}")
        return _clip("\n".join(lines), 4096)

    def _job_action_specs(
        self,
        job: JobRecord,
    ) -> list[tuple[str, dict[str, Any], str]]:
        specs: list[tuple[str, dict[str, Any], str]] = []
        if job.status in {"queued", "claimed", "accepted", "progress"}:
            token = self._new_callback_token()
            specs.append((token, {"kind": "cancel", "jobId": job.job_id}, "取消"))
        elif job.status == "failed":
            token = self._new_callback_token()
            specs.append((token, {"kind": "retry", "jobId": job.job_id}, "重试"))
        return specs

    async def _send_job_detail(self, chat_id: int, user_id: int, job: JobRecord) -> Mapping[str, Any]:
        rows: list[list[dict[str, str]]] = []
        specs = self._job_action_specs(job)
        for token, _payload, label in specs:
            rows.append([{"text": label, "callback_data": f"{CALLBACK_PREFIX}{token}"}])
        result = await self.transport.send_message(
            chat_id,
            self._job_detail_text(job),
            reply_markup={"inline_keyboard": rows} if rows else None,
        )
        message_id = _message_id(result)
        if message_id is None:
            raise TelegramError("Telegram 消息缺少 message_id")
        expiry = float(self.clock()) + self.callback_ttl_seconds
        for token, payload, _label in specs:
            self.store.create_callback(
                token,
                chat_id=chat_id,
                user_id=user_id,
                message_id=message_id,
                candidate=payload,
                expires_at=expiry,
            )
        return result

    def _jobs_page_text(self, jobs: Sequence[JobRecord], page: int | None = None) -> str:
        if not jobs:
            return "暂无属于你的 Telegram 任务。"
        heading = "任务列表" if page is None else f"任务列表（第 {page} 页）"
        lines = [heading]
        for index, job in enumerate(jobs, 1):
            lines.append(
                f"{index}. [{job.status}] {_clip(self._job_title(job), 160)} · {_clip(job.job_id, 12)}"
            )
        return _clip("\n".join(lines), 4096)

    async def _send_jobs_page(
        self,
        chat_id: int,
        user_id: int,
        *,
        cursor: tuple[float, str] | None = None,
    ) -> Mapping[str, Any]:
        pager = getattr(self.store, "list_telegram_jobs_page", None)
        if callable(pager):
            jobs, next_cursor = pager(
                chat_id=chat_id,
                user_id=user_id,
                limit=_MAX_JOBS,
                cursor=cursor,
            )
        else:
            jobs = [
                job
                for job in reversed(self.store.list_jobs(telegram_only=True, limit=500))
                if job.telegram_chat_id == chat_id and job.telegram_user_id == user_id
            ][:_MAX_JOBS]
            next_cursor = None
        rows: list[list[dict[str, str]]] = []
        specs: list[tuple[str, dict[str, Any]]] = []
        for job in jobs:
            token = self._new_callback_token()
            rows.append(
                [{"text": _clip(f"详情 · {self._job_title(job)}", _MAX_BUTTON_TEXT), "callback_data": f"{CALLBACK_PREFIX}{token}"}]
            )
            specs.append((token, {"kind": "job_detail", "jobId": job.job_id}))
        if next_cursor is not None:
            token = self._new_callback_token()
            rows.append([{"text": "下一页", "callback_data": f"{CALLBACK_PREFIX}{token}"}])
            # Page navigation stays within the callback-kind allowlist; its
            # server-side cursor never enters Telegram callback_data.
            specs.append((token, {"kind": "job_detail", "cursor": [next_cursor[0], next_cursor[1]]}))
        result = await self.transport.send_message(
            chat_id,
            self._jobs_page_text(jobs),
            reply_markup={"inline_keyboard": rows} if rows else None,
        )
        message_id = _message_id(result)
        if message_id is None:
            raise TelegramError("Telegram 消息缺少 message_id")
        expiry = float(self.clock()) + self.callback_ttl_seconds
        for token, payload in specs:
            self.store.create_callback(
                token,
                chat_id=chat_id,
                user_id=user_id,
                message_id=message_id,
                candidate=payload,
                expires_at=expiry,
            )
        return result

    @staticmethod
    def _direct_title(url: str) -> str:
        parsed = parse_ed2k(url)
        if parsed:
            return _clip(parsed.get("fileName", "ED2K file"), 512)
        try:
            name = unquote(parse_qs(urlsplit(url).query).get("dn", [""])[0]).strip()
        except (TypeError, ValueError):
            name = ""
        return _clip(name or "Magnet", 512)

    async def _handle_add(self, message: Mapping[str, Any], raw_url: str) -> dict[str, Any]:
        chat_id, user_id = self._chat_user(message)
        if chat_id is None or user_id is None:
            return {"handled": True, "error": "invalid_message"}
        save_path_cid, _remembered = self._preferred_save_path(
            chat_id, user_id, allow_legacy_root=False
        )
        if not save_path_cid:
            await self.transport.send_message(chat_id, self._directory_text(chat_id, user_id))
            return {"handled": True, "error": "save_path_unavailable"}
        url = str(raw_url or "").strip()
        if not (is_magnet(url) or is_ed2k(url)):
            await self.transport.send_message(chat_id, "请输入有效的 Magnet 或 ED2K file 链接。")
            return {"handled": True, "error": "invalid_link"}
        raw_intent = {
            "jobId": f"telegram-{self._new_callback_token()}",
            "sourceSite": "telegram",
            "mediaType": "generic",
            "processorProfile": "generic",
            "url": url,
            "title": self._direct_title(url),
            "code": "",
            "metadata": {"provider": "telegram", "monitorDownload": True},
            "savePathCid": save_path_cid,
        }
        try:
            intent = model_dump(IntentModel.model_validate(raw_intent))
        except (TypeError, ValueError):
            await self.transport.send_message(chat_id, "链接格式无效，未加入队列。")
            return {"handled": True, "error": "invalid_link"}
        source_message_id = _message_id(message) or 0
        record, inserted = self.store.enqueue(
            intent,
            candidate_key=dedupe_key(url),
            telegram_chat_id=chat_id,
            telegram_user_id=user_id,
            telegram_message_id=source_message_id,
        )
        await self.transport.send_message(
            chat_id,
            "已加入本地队列。" if inserted else "该链接已在本地队列中。",
        )
        if inserted and record.status_message_id is None:
            try:
                record = await self._send_status_message(record, chat_id=chat_id)
            except Exception:
                pass
        return {
            "handled": True,
            "kind": "add",
            "jobId": record.job_id,
            "duplicate": not inserted,
            "savePathCid": save_path_cid,
        }

    async def _handle_command(self, message: Mapping[str, Any]) -> dict[str, Any]:
        chat_id, user_id = self._chat_user(message)
        if not self.authorized(chat_id, user_id):
            return {"ignored": True, "reason": "unauthorized"}
        text = str(message.get("text", "") or "").strip()
        add_match = _ADD_COMMAND.fullmatch(text)
        if add_match:
            return await self._handle_add(message, add_match.group(1))
        if _DIR_COMMAND.fullmatch(text):
            result = await self._send_directory_picker(chat_id, user_id)
            return {"handled": True, "kind": "dir", "messageId": _message_id(result)}
        if _JOBS_COMMAND.fullmatch(text):
            result = await self._send_jobs_page(chat_id, user_id)
            return {"handled": True, "kind": "jobs", "messageId": _message_id(result)}
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
            await self._answer(callback_id, text="无权限")
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
        # actual candidate consume and queue insertion below are one SQLite
        # transaction; other one-shot actions consume only after their owner
        # and state have been checked.
        try:
            payload = self.store.peek_callback(
                token,
                chat_id=chat_id,
                user_id=user_id,
                message_id=message_id,
                now=float(self.clock()),
            )
        except Exception:
            await self._answer(callback_id, text="队列暂时不可用，请稍后重试")
            return {"handled": True, "error": "queue_unavailable"}
        if not payload:
            await self._answer(callback_id, text="按钮已过期或已使用")
            return {"handled": True, "error": "callback_expired"}
        payload = _as_mapping(payload)
        raw_kind = payload.get("kind")
        kind = raw_kind if isinstance(raw_kind, str) else ""
        payload_keys = set(payload)
        now = float(self.clock())

        if kind not in _CALLBACK_KINDS:
            await self._answer(callback_id, text="按钮已失效")
            return {"handled": True, "error": "invalid_callback"}

        if kind == "candidate":
            if payload_keys != {"kind", "intent", "candidateKey"}:
                await self._answer(callback_id, text="按钮已失效")
                return {"handled": True, "error": "invalid_callback"}
            raw_intent = dict(_as_mapping(payload.get("intent")))
            save_path_cid, _remembered = self._preferred_save_path(chat_id, user_id)
            if not save_path_cid:
                await self._answer(callback_id, text="浏览器尚未同步 115 目录")
                return {"handled": True, "error": "save_path_unavailable"}
            raw_intent["savePathCid"] = save_path_cid
            try:
                validated = IntentModel.model_validate(raw_intent)
                intent = model_dump(validated)
                candidate_key_value = payload.get("candidateKey")
                if not isinstance(candidate_key_value, str):
                    raise ValueError("callback 候选键类型无效")
                candidate_key = candidate_key_value.strip()
                if not candidate_key or len(candidate_key) > 512:
                    raise ValueError("callback 缺少候选键")
            except Exception:
                await self._answer(callback_id, text="按钮已失效")
                return {"handled": True, "error": "invalid_candidate"}
            try:
                result = self.store.consume_callback_and_enqueue(
                    token,
                    chat_id=chat_id,
                    user_id=user_id,
                    message_id=message_id,
                    intent=intent,
                    candidate_key=candidate_key,
                    now=now,
                )
            except Exception:
                # The atomic store transaction leaves this button usable when
                # queue insertion fails; tell Telegram to stop the spinner
                # without burning the durable callback.
                await self._answer(callback_id, text="队列暂时不可用，请稍后重试")
                return {"handled": True, "error": "queue_unavailable"}
            if result is None:
                await self._answer(callback_id, text="按钮已过期或已使用")
                return {"handled": True, "error": "callback_expired"}
            record, inserted = result
            await self._answer(
                callback_id,
                text="已加入本地队列" if inserted else "任务已在本地队列中",
            )
            if inserted and record.status_message_id is None:
                try:
                    record = await self._send_status_message(record, chat_id=chat_id)
                except Exception:
                    # The durable job remains claimable even when Telegram
                    # status delivery is temporarily unavailable.
                    pass
            return {
                "handled": True,
                "kind": "candidate",
                "jobId": record.job_id,
                "duplicate": not inserted,
                "savePathCid": intent.get("savePathCid"),
            }

        if kind == "dir":
            if payload_keys != {"kind", "cid"}:
                await self._answer(callback_id, text="按钮已失效")
                return {"handled": True, "error": "invalid_callback"}
            cid = str(payload.get("cid") or "").strip()
            if cid not in dict(self._path_options()):
                await self._answer(callback_id, text="保存目录已不可用")
                return {"handled": True, "error": "invalid_save_path"}
            setter = getattr(self.store, "set_telegram_preference", None)
            if not callable(setter):
                await self._answer(callback_id, text="保存目录设置不可用")
                return {"handled": True, "error": "save_path_unavailable"}
            try:
                setter(chat_id, user_id, cid, now=now)
            except Exception:
                await self._answer(callback_id, text="保存目录设置失败")
                return {"handled": True, "error": "save_path_unavailable"}
            try:
                try:
                    consumed = self.store.consume_callback(
                        token,
                        chat_id=chat_id,
                        user_id=user_id,
                        message_id=message_id,
                        now=now,
                    )
                except Exception:
                    await self._answer(callback_id, text="队列暂时不可用，请稍后重试")
                    return {"handled": True, "error": "queue_unavailable"}
            except Exception:
                # The preference write is idempotent.  Keep it and let a later
                # click retry token consumption instead of reporting failure.
                await self._answer(callback_id, text="目录已保存，请稍后再试")
                return {"handled": True, "kind": "dir", "savePathCid": cid}
            if consumed is None:
                await self._answer(callback_id, text=f"已选择：{self._path_label(cid)}")
                return {
                    "handled": True,
                    "kind": "dir",
                    "savePathCid": cid,
                    "duplicate": True,
                }
            label = self._path_label(cid)
            await self._answer(callback_id, text=f"已选择：{label}")
            try:
                await self.transport.send_message(chat_id, f"保存目录已切换为：{label}")
            except Exception:
                pass
            return {"handled": True, "kind": "dir", "savePathCid": cid}

        if kind == "job_detail":
            has_cursor = "cursor" in payload
            has_job_id = "jobId" in payload
            if payload_keys not in ({"kind", "cursor"}, {"kind", "jobId"}) or has_cursor == has_job_id:
                await self._answer(callback_id, text="按钮已失效")
                return {"handled": True, "error": "invalid_callback"}
            if has_cursor:
                raw_cursor = payload.get("cursor")
                if not isinstance(raw_cursor, (list, tuple)) or len(raw_cursor) != 2:
                    await self._answer(callback_id, text="按钮已失效")
                    return {"handled": True, "error": "invalid_cursor"}
                try:
                    cursor_time = float(raw_cursor[0])
                    cursor_id = raw_cursor[1]
                    if not isinstance(cursor_id, str):
                        raise ValueError
                    cursor_id = cursor_id.strip()
                    if not math.isfinite(cursor_time):
                        raise ValueError
                    if not cursor_id or len(cursor_id) > 128:
                        raise ValueError
                except (TypeError, ValueError):
                    await self._answer(callback_id, text="按钮已失效")
                    return {"handled": True, "error": "invalid_cursor"}
                try:
                    consumed = self.store.consume_callback(
                        token,
                        chat_id=chat_id,
                        user_id=user_id,
                        message_id=message_id,
                        now=now,
                    )
                except Exception:
                    await self._answer(callback_id, text="队列暂时不可用，请稍后重试")
                    return {"handled": True, "error": "queue_unavailable"}
                if consumed is None:
                    await self._answer(callback_id, text="按钮已过期或已使用")
                    return {"handled": True, "error": "callback_expired"}
                try:
                    result = await self._send_jobs_page(
                        chat_id, user_id, cursor=(cursor_time, cursor_id)
                    )
                except Exception:
                    await self._answer(callback_id, text="任务列表暂时不可用")
                    return {"handled": True, "error": "jobs_unavailable"}
                await self._answer(callback_id, text="已加载下一页")
                return {
                    "handled": True,
                    "kind": "job_detail",
                    "page": True,
                    "messageId": _message_id(result),
                }

            raw_job_id = payload.get("jobId")
            job_id = raw_job_id.strip() if isinstance(raw_job_id, str) else ""
            if not job_id or len(job_id) > 128:
                await self._answer(callback_id, text="按钮已失效")
                return {"handled": True, "error": "invalid_job"}
            job = self._job_owner(job_id, chat_id, user_id)
            if job is None:
                await self._answer(callback_id, text="任务不存在或无权限")
                return {"handled": True, "error": "job_not_found"}
            try:
                consumed = self.store.consume_callback(
                    token,
                    chat_id=chat_id,
                    user_id=user_id,
                    message_id=message_id,
                    now=now,
                )
            except Exception:
                await self._answer(callback_id, text="队列暂时不可用，请稍后重试")
                return {"handled": True, "error": "queue_unavailable"}
            if consumed is None:
                await self._answer(callback_id, text="按钮已过期或已使用")
                return {"handled": True, "error": "callback_expired"}
            try:
                result = await self._send_job_detail(chat_id, user_id, job)
            except Exception:
                await self._answer(callback_id, text="任务详情暂时不可用")
                return {"handled": True, "error": "job_unavailable"}
            await self._answer(callback_id, text="已打开任务详情")
            return {
                "handled": True,
                "kind": "job_detail",
                "jobId": job.job_id,
                "messageId": _message_id(result),
            }

        # retry/cancel callbacks carry a job ID and are accepted only for the
        # originating Telegram user.  The request ID is derived from the
        # one-time token, making the database mutation idempotent as well.
        if payload_keys != {"kind", "jobId"}:
            await self._answer(callback_id, text="按钮已失效")
            return {"handled": True, "error": "invalid_callback"}
        raw_job_id = payload.get("jobId")
        job_id = raw_job_id.strip() if isinstance(raw_job_id, str) else ""
        if not job_id or len(job_id) > 128:
            await self._answer(callback_id, text="按钮已失效")
            return {"handled": True, "error": "invalid_job"}
        job = self._job_owner(job_id, chat_id, user_id)
        if job is None:
            await self._answer(callback_id, text="任务不存在或无权限")
            return {"handled": True, "error": "job_not_found"}

        if kind == "retry":
            if job.status != "failed":
                await self._answer(callback_id, text="只有失败任务可以重试")
                return {"handled": True, "error": "invalid_state"}
            try:
                retry, replay = self.store.clone_retry(
                    job.job_id,
                    request_id=f"telegram-retry-{token}",
                    now=now,
                )
            except Exception:
                await self._answer(callback_id, text="任务当前不可重试")
                return {"handled": True, "error": "invalid_state"}
            try:
                consumed = self.store.consume_callback(
                    token,
                    chat_id=chat_id,
                    user_id=user_id,
                    message_id=message_id,
                    now=now,
                )
            except Exception:
                consumed = None
            await self._answer(callback_id, text="已重新加入本地队列")
            if not replay and retry.status_message_id is None:
                try:
                    await self._send_status_message(retry, chat_id=chat_id)
                except Exception:
                    pass
            return {
                "handled": True,
                "kind": "retry",
                "jobId": retry.job_id,
                "sourceJobId": job.job_id,
                "duplicate": replay or consumed is None,
            }

        if job.status not in {"queued", "claimed", "accepted", "progress"}:
            await self._answer(callback_id, text="任务已结束，无法取消")
            return {"handled": True, "error": "invalid_state"}
        try:
            action, replay = self.store.request_cancel(
                job.job_id,
                request_id=f"telegram-cancel-{token}",
                reason="Telegram 用户请求取消",
                now=now,
            )
        except Exception:
            await self._answer(callback_id, text="任务当前不可取消")
            return {"handled": True, "error": "invalid_state"}
        try:
            consumed = self.store.consume_callback(
                token,
                chat_id=chat_id,
                user_id=user_id,
                message_id=message_id,
                now=now,
            )
        except Exception:
            consumed = None
        current = self._job_owner(job.job_id, chat_id, user_id) or job
        if current.status == "cancelled":
            answer_text = "已取消本地排队任务；不会创建 115 云端离线任务"
        else:
            answer_text = "已请求浏览器停止本地任务/监控；不会取消 115 云端离线任务"
        await self._answer(
            callback_id,
            text=answer_text,
        )
        if not replay:
            try:
                await self._send_status_message(current, chat_id=chat_id)
            except Exception:
                pass
        return {
            "handled": True,
            "kind": "cancel",
            "jobId": job.job_id,
            "actionId": action.action_id,
            "actionStatus": action.status,
            "status": current.status,
            "duplicate": replay or consumed is None,
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
            "cancelled": "本地任务已取消；不会取消 115 云端离线任务",
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
