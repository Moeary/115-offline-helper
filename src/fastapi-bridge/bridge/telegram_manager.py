"""Runtime lifecycle for the optional Telegram integration.

The queue bridge itself remains useful without Telegram.  This manager keeps
the Bot API credential and polling task outside the immutable bootstrap
settings so the extension can configure, stop, and restart Telegram without
restarting FastAPI.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import secrets
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Callable

from .telegram import HttpTelegramTransport, TelegramError, TelegramService


_OWNER_STATE_KEY = "telegram.owner"
_CONFIG_STATE_KEY = "telegram.runtime.v1"
_BOT_USERNAME = re.compile(r"^[A-Za-z0-9_]{3,64}$")


def _write_secret(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(value + "\n")
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _read_secret(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except (FileNotFoundError, OSError, UnicodeError):
        return ""


class TelegramManager:
    """Configure and own one dynamically replaceable Telegram service."""

    def __init__(
        self,
        store: Any,
        provider: Any,
        *,
        anime_provider: Any | None = None,
        token_file: str | Path,
        initial_token: str = "",
        enabled: bool = False,
        allowed_chat_ids: Sequence[int] = (),
        allowed_user_ids: Sequence[int] = (),
        save_paths: Sequence[Any] = (),
        callback_ttl_seconds: int = 900,
        poll_timeout: int = 25,
        transport_factory: Callable[[str], Any] = HttpTelegramTransport,
        service_factory: Callable[..., TelegramService] = TelegramService,
    ) -> None:
        self.store = store
        self.provider = provider
        self.anime_provider = anime_provider
        self.token_file = Path(token_file)
        self._initial_token = str(initial_token or "").strip()
        self._enabled = bool(enabled)
        self._allowed_chat_ids = tuple(allowed_chat_ids)
        self._allowed_user_ids = tuple(allowed_user_ids)
        self._save_paths = tuple(save_paths)
        self._callback_ttl_seconds = int(callback_ttl_seconds)
        self._poll_timeout = int(poll_timeout)
        self._transport_factory = transport_factory
        self._service_factory = service_factory
        self._token = ""
        self._bot_username = ""
        self._transport: Any | None = None
        self._service: TelegramService | None = None
        self._poll_task: asyncio.Task[Any] | None = None
        self._lock = asyncio.Lock()
        self._claim_nonce = ""
        self._last_error = ""

        raw_config = self._get_state(_CONFIG_STATE_KEY)
        if isinstance(raw_config, Mapping):
            self._enabled = bool(raw_config.get("enabled", self._enabled))
            self._bot_username = self._safe_username(raw_config.get("botUsername"))
        self._token = _read_secret(self.token_file) or self._initial_token
        if self._token:
            self._new_claim_nonce()

    def _get_state(self, key: str) -> Any:
        getter = getattr(self.store, "get_state", None)
        if not callable(getter):
            return None
        try:
            raw = getter(key)
        except Exception:
            return None
        if raw is None:
            return None
        if isinstance(raw, (dict, list)):
            return raw
        try:
            return json.loads(str(raw))
        except (TypeError, ValueError, json.JSONDecodeError):
            return raw

    def _set_state(self, key: str, value: Any) -> None:
        setter = getattr(self.store, "set_state", None)
        if callable(setter):
            setter(key, json.dumps(value, ensure_ascii=False, separators=(",", ":")))

    @staticmethod
    def _safe_username(value: object) -> str:
        username = str(value or "").strip().lstrip("@").strip()
        return username if _BOT_USERNAME.fullmatch(username) else ""

    def _new_claim_nonce(self) -> str:
        self._claim_nonce = secrets.token_urlsafe(24)
        return self._claim_nonce

    def _owner(self) -> dict[str, int] | None:
        value = self._get_state(_OWNER_STATE_KEY)
        if not isinstance(value, Mapping):
            return None
        try:
            chat_id = int(value.get("chatId", value.get("chat_id")))
            user_id = int(value.get("userId", value.get("user_id")))
        except (TypeError, ValueError):
            return None
        return {"chatId": chat_id, "userId": user_id}

    def claim_owner(self, nonce: object, chat_id: object, user_id: object) -> bool:
        """Atomically-ish consume the current in-memory claim nonce."""

        candidate = str(nonce or "").strip()
        if not candidate or not self._claim_nonce or self._owner() is not None:
            return False
        if not hmac.compare_digest(candidate, self._claim_nonce):
            return False
        try:
            normalized_chat = int(chat_id)
            normalized_user = int(user_id)
        except (TypeError, ValueError):
            return False
        self._set_state(
            _OWNER_STATE_KEY,
            {"chatId": normalized_chat, "userId": normalized_user},
        )
        self._claim_nonce = ""
        return True

    def _claim_url(self) -> str | None:
        owner = self._owner()
        if owner is not None or not self._bot_username or not self._claim_nonce:
            return None
        return f"https://t.me/{self._bot_username}?start=claim_{self._claim_nonce}"

    def status(self) -> dict[str, Any]:
        owner = self._owner()
        payload: dict[str, Any] = {
            "schema": 1,
            "enabled": bool(self._enabled),
            "configured": bool(self._token),
            "botUsername": self._bot_username or None,
            "ownerBound": owner is not None,
            "claimUrl": self._claim_url(),
        }
        if self._last_error:
            payload["error"] = self._last_error
        return payload

    @property
    def token(self) -> str:
        """Return the active token to the local runtime store only.

        The HTTP layer never serializes this property; it exists so the
        SQLite runtime metadata can stay in sync with the 0600 token file.
        """

        return self._token

    @property
    def service(self) -> TelegramService | None:
        return self._service

    async def _validate_token(self, token: str) -> tuple[Any, str]:
        transport = self._transport_factory(token)
        try:
            get_me = getattr(transport, "get_me", None)
            if not callable(get_me):
                raise TelegramError("Telegram transport 不支持 getMe")
            metadata = await get_me()
            if not isinstance(metadata, Mapping):
                raise TelegramError("Telegram getMe 返回格式无效")
            username = self._safe_username(metadata.get("username"))
            if not username:
                raise TelegramError("Telegram bot 缺少有效 username")
            return transport, username
        except Exception:
            close = getattr(transport, "aclose", None)
            if callable(close):
                try:
                    await close()
                except Exception:
                    pass
            raise

    def _build_service(self) -> TelegramService:
        if self._transport is None:
            raise RuntimeError("Telegram transport 尚未配置")
        return self._service_factory(
            self.store,
            self.provider,
            self._transport,
            anime_provider=self.anime_provider,
            allowed_chat_ids=self._allowed_chat_ids,
            allowed_user_ids=self._allowed_user_ids,
            save_paths=self._save_paths,
            callback_ttl_seconds=self._callback_ttl_seconds,
            poll_timeout=self._poll_timeout,
            owner_getter=self._owner,
            claim_handler=self.claim_owner,
            bot_username=self._bot_username,
        )

    def _persist_config(self) -> None:
        self._set_state(
            _CONFIG_STATE_KEY,
            {
                "enabled": bool(self._enabled),
                "botUsername": self._bot_username or None,
            },
        )

    async def _stop_locked(self, *, close_transport: bool = False) -> None:
        service = self._service
        if service is not None:
            service.stop()
        task = self._poll_task
        self._poll_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        self._service = None
        if close_transport and self._transport is not None:
            close = getattr(self._transport, "aclose", None)
            if callable(close):
                try:
                    await close()
                except Exception:
                    pass
            self._transport = None

    async def _start_locked(self) -> None:
        if not self._token:
            raise ValueError("Telegram Bot token 尚未配置")
        if self._transport is None:
            self._transport, self._bot_username = await self._validate_token(self._token)
        self._service = self._build_service()
        self._poll_task = asyncio.create_task(self._service.run_forever())

    async def restore(self) -> dict[str, Any]:
        """Validate the persisted credential and restore enabled polling."""

        async with self._lock:
            if not self._token:
                self._enabled = False
                self._persist_config()
                return self.status()
            try:
                # RuntimeConfigStore is the durable source for the dynamic
                # setup, while the token file is the local secret fallback.
                # If the credential came from SQLite or the legacy .env path,
                # materialize it for future restarts without ever returning it
                # through the status payload.
                if not _read_secret(self.token_file):
                    _write_secret(self.token_file, self._token)
                self._transport, self._bot_username = await self._validate_token(self._token)
                if not self._claim_nonce and self._owner() is None:
                    self._new_claim_nonce()
                self._last_error = ""
                if self._enabled:
                    await self._start_locked()
            except Exception:
                self._last_error = "Telegram token 验证失败"
                self._enabled = False
            self._persist_config()
            return self.status()

    async def configure(
        self,
        token: str | None = None,
        *,
        enabled: bool | None = None,
    ) -> dict[str, Any]:
        """Validate a new token, replace the service, and optionally start it."""

        supplied = None if token is None else str(token).strip()
        async with self._lock:
            next_token = self._token if supplied in (None, "") else supplied
            if not next_token:
                if enabled is False:
                    self._enabled = False
                    await self._stop_locked()
                    self._persist_config()
                    return self.status()
                raise ValueError("Telegram Bot token 不能为空")

            # Stopping an already configured bot is a local state change. Do
            # not require a fresh network round trip just to stop polling.
            if supplied in (None, "") and enabled is False:
                self._enabled = False
                await self._stop_locked()
                self._persist_config()
                return self.status()

            token_changed = bool(supplied) and not hmac.compare_digest(
                supplied, self._token
            )
            new_transport, username = await self._validate_token(next_token)
            await self._stop_locked(close_transport=True)
            self._token = next_token
            self._bot_username = username
            self._transport = new_transport
            if token_changed or self._owner() is None:
                self._set_state(_OWNER_STATE_KEY, None)
                self._new_claim_nonce()
            self._enabled = bool(True if enabled is None else enabled)
            self._last_error = ""
            _write_secret(self.token_file, self._token)
            if self._enabled:
                await self._start_locked()
            self._persist_config()
            return self.status()

    async def start(self) -> dict[str, Any]:
        async with self._lock:
            self._enabled = True
            if self._service is None:
                if self._transport is None:
                    self._transport, self._bot_username = await self._validate_token(self._token)
                await self._start_locked()
            self._persist_config()
            return self.status()

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            self._enabled = False
            await self._stop_locked()
            self._persist_config()
            return self.status()

    async def restart(self) -> dict[str, Any]:
        async with self._lock:
            await self._stop_locked(close_transport=True)
            self._transport, self._bot_username = await self._validate_token(self._token)
            self._enabled = True
            await self._start_locked()
            self._persist_config()
            return self.status()

    async def close(self) -> None:
        async with self._lock:
            await self._stop_locked(close_transport=True)
