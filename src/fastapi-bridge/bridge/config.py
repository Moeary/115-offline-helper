"""Environment-backed configuration for the local bridge."""

from __future__ import annotations

import os
import re
import secrets
import hashlib
import hmac
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping
import unicodedata
from urllib.parse import urlsplit


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STATE_DIR = BRIDGE_ROOT / ".state"
DEFAULT_TOKEN_FILE = DEFAULT_STATE_DIR / "bearer.token"
DEFAULT_TELEGRAM_TOKEN_FILE = DEFAULT_STATE_DIR / "telegram_bot.token"
DEFAULT_DB_FILE = DEFAULT_STATE_DIR / "bridge.sqlite3"

# The pairing code is deliberately independent from the bearer token.  It is
# short enough to type locally, but still has 40 bits of entropy before the
# retry limit and five-minute expiry are applied.
PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PAIRING_CODE_LENGTH = 8
PAIRING_CODE_TTL_SECONDS = 5 * 60
PAIRING_MAX_FAILURES = 5


def _read_env_file(path: Path) -> dict[str, str]:
    """Read simple KEY=VALUE pairs without interpolation or code execution."""

    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError, UnicodeError):
        return values
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        name = name.strip()
        if not name or not name.replace("_", "").isalnum():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[name] = value
    return values


def _env(
    name: str,
    default: str = "",
    file_values: Mapping[str, str] | None = None,
) -> str:
    if name in os.environ:
        return os.environ[name].strip()
    return str((file_values or {}).get(name, default)).strip()


def _parse_int_set(value: str) -> frozenset[int]:
    values: set[int] = set()
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            values.add(int(item))
        except ValueError as error:
            raise ValueError(f"{item!r} 不是有效的 Telegram ID") from error
    return frozenset(values)


_TELEGRAM_SAVE_PATH_CID = re.compile(r"(?:0|[1-9][0-9]{0,63})\Z")
_MAX_TELEGRAM_SAVE_PATHS = 50
_MAX_TELEGRAM_SAVE_PATH_NAME = 128


@dataclass(frozen=True)
class TelegramSavePath:
    """One manually configured Telegram save-path option.

    The bridge deliberately keeps the CID as a string.  It never queries 115
    to resolve or validate the directory because it does not hold a 115
    cookie; the extension performs any account-side validation when it claims
    the resulting intent.
    """

    cid: str
    name: str


def _remove_control_characters(value: str) -> str:
    return "".join(
        character
        for character in str(value)
        if unicodedata.category(character) != "Cc"
    )


def _parse_telegram_save_paths(value: str) -> tuple[TelegramSavePath, ...]:
    """Parse ``CID=display name`` entries in their configured order."""

    raw_value = str(value or "").strip()
    if not raw_value:
        return ()

    paths: list[TelegramSavePath] = []
    seen_cids: set[str] = set()
    for raw_entry in raw_value.split(","):
        entry = raw_entry.strip()
        if not entry:
            raise ValueError("PUSH115_TELEGRAM_SAVE_PATHS 不允许空项")
        cid, separator, raw_name = entry.partition("=")
        cid = cid.strip()
        if not separator or not _TELEGRAM_SAVE_PATH_CID.fullmatch(cid):
            raise ValueError(
                "PUSH115_TELEGRAM_SAVE_PATHS 必须使用十进制 CID=显示名格式"
            )
        if cid in seen_cids:
            raise ValueError(f"PUSH115_TELEGRAM_SAVE_PATHS 含有重复 CID：{cid}")
        name = _remove_control_characters(raw_name).strip()
        if not name:
            raise ValueError(f"PUSH115_TELEGRAM_SAVE_PATHS 的 CID {cid} 缺少显示名")
        if len(name) > _MAX_TELEGRAM_SAVE_PATH_NAME:
            raise ValueError(
                f"PUSH115_TELEGRAM_SAVE_PATHS 的显示名不能超过 {_MAX_TELEGRAM_SAVE_PATH_NAME} 个字符"
            )
        seen_cids.add(cid)
        paths.append(TelegramSavePath(cid=cid, name=name))

    if len(paths) > _MAX_TELEGRAM_SAVE_PATHS:
        raise ValueError(
            f"PUSH115_TELEGRAM_SAVE_PATHS 最多允许 {_MAX_TELEGRAM_SAVE_PATHS} 个目录"
        )
    return tuple(paths)


def _parse_cors_origins(value: str) -> tuple[str, ...]:
    origins: list[str] = []
    for item in value.split(","):
        origin = item.strip()
        if not origin:
            continue
        if origin == "*":
            raise ValueError("PUSH115_BRIDGE_CORS_ORIGINS 不允许使用通配符")
        try:
            parsed = urlsplit(origin)
            port = parsed.port
        except ValueError as error:
            raise ValueError("PUSH115_BRIDGE_CORS_ORIGINS 含有无效来源") from error
        if (
            parsed.scheme.lower() not in {"chrome-extension", "http", "https"}
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.path
            or parsed.query
            or parsed.fragment
            or (port is None and parsed.scheme.lower() in {"http", "https"} and not parsed.hostname)
        ):
            raise ValueError("PUSH115_BRIDGE_CORS_ORIGINS 必须是明确的来源 origin")
        origins.append(origin)
    return tuple(dict.fromkeys(origins))


def _safe_path(value: str, default: Path) -> Path:
    if not value:
        return default
    candidate = Path(value).expanduser()
    return candidate if candidate.is_absolute() else BRIDGE_ROOT / candidate


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


def persist_secret(path: str | Path, value: str) -> None:
    """Persist a local secret with the same permissions as the token file.

    This small public wrapper lets the pairing manager rotate the bearer token
    without exposing the lower-level file-writing helper to the application.
    """

    _write_secret(Path(path), value)


def load_or_create_token(path: Path = DEFAULT_TOKEN_FILE) -> str:
    """Load a token or create it with the OS CSPRNG.

    The token is printed only by the explicit --print-token command. Normal
    service startup never logs its value.
    """

    try:
        existing = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        existing = ""
    if existing:
        return existing
    token = secrets.token_urlsafe(32)
    _write_secret(path, token)
    return token


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    bearer_token: str
    token_file: Path
    db_path: Path
    cors_origins: tuple[str, ...]
    telegram_bot_token: str
    telegram_allowed_chat_ids: frozenset[int]
    telegram_allowed_user_ids: frozenset[int]
    telegram_polling: bool
    telegram_poll_timeout: int
    callback_ttl_seconds: int
    lease_seconds: int
    javbus_base_url: str
    javbus_allowed_hosts: frozenset[str]
    javbus_timeout_seconds: float
    javbus_max_response_bytes: int
    nyaa_base_url: str = "https://nyaa.si"
    nyaa_allowed_hosts: frozenset[str] = field(
        default_factory=lambda: frozenset({"nyaa.si", "www.nyaa.si"})
    )
    nyaa_timeout_seconds: float = 15.0
    nyaa_max_response_bytes: int = 2_000_000
    nyaa_max_results: int = 20
    telegram_save_paths: tuple[TelegramSavePath, ...] = field(default_factory=tuple)
    telegram_token_file: Path = DEFAULT_TELEGRAM_TOKEN_FILE
    sukebei_base_url: str = "https://sukebei.nyaa.si"
    sukebei_allowed_hosts: frozenset[str] = field(
        default_factory=lambda: frozenset({"sukebei.nyaa.si"})
    )
    sukebei_timeout_seconds: float = 15.0
    sukebei_max_response_bytes: int = 2_000_000
    sukebei_max_results: int = 20

    @classmethod
    def from_env(cls) -> "Settings":
        env_file_value = os.environ.get("PUSH115_BRIDGE_ENV_FILE", "")
        env_file = _safe_path(env_file_value, BRIDGE_ROOT / ".env")
        file_values = _read_env_file(env_file)
        env = lambda name, default="": _env(name, default, file_values)

        host = env("PUSH115_BRIDGE_HOST", "127.0.0.1")
        port = int(env("PUSH115_BRIDGE_PORT", "52115"))
        if host != "127.0.0.1" or port != 52115:
            raise ValueError("bridge 只允许绑定 127.0.0.1:52115")

        token_file = _safe_path(env("PUSH115_BRIDGE_TOKEN_FILE"), DEFAULT_TOKEN_FILE)
        bearer_token = env("PUSH115_BRIDGE_TOKEN") or load_or_create_token(token_file)
        if len(bearer_token) < 32:
            raise ValueError("PUSH115_BRIDGE_TOKEN 至少需要 32 个字符")
        telegram_token_file = _safe_path(
            env("PUSH115_TELEGRAM_TOKEN_FILE"), DEFAULT_TELEGRAM_TOKEN_FILE
        )

        db_path = _safe_path(env("PUSH115_BRIDGE_DB"), DEFAULT_DB_FILE)
        origins = _parse_cors_origins(env("PUSH115_BRIDGE_CORS_ORIGINS"))
        base_url = env("PUSH115_JAVBUS_BASE_URL", "https://javbus.com").rstrip("/")
        parsed_base = urlsplit(base_url)
        if parsed_base.scheme.lower() != "https" or not parsed_base.hostname:
            raise ValueError("PUSH115_JAVBUS_BASE_URL 必须是 HTTPS 地址")
        configured_hosts = {
            item.strip().lower().rstrip(".")
            for item in env("PUSH115_JAVBUS_ALLOWED_HOSTS", "").split(",")
            if item.strip()
        }
        configured_hosts.add(parsed_base.hostname.lower().rstrip("."))
        if parsed_base.hostname.lower().rstrip(".") in {"javbus.com", "www.javbus.com"}:
            configured_hosts.update({"javbus.com", "www.javbus.com"})

        nyaa_base_url = env("PUSH115_NYAA_BASE_URL", "https://nyaa.si").rstrip("/")
        parsed_nyaa = urlsplit(nyaa_base_url)
        if (
            parsed_nyaa.scheme.lower() != "https"
            or not parsed_nyaa.hostname
            or parsed_nyaa.username
            or parsed_nyaa.password
            or parsed_nyaa.query
            or parsed_nyaa.fragment
        ):
            raise ValueError("PUSH115_NYAA_BASE_URL 必须是无凭据的 HTTPS 地址")
        nyaa_hosts = {
            item.strip().lower().rstrip(".")
            for item in env("PUSH115_NYAA_ALLOWED_HOSTS", "").split(",")
            if item.strip()
        }
        nyaa_hosts.add(parsed_nyaa.hostname.lower().rstrip("."))
        if parsed_nyaa.hostname.lower().rstrip(".") in {"nyaa.si", "www.nyaa.si"}:
            nyaa_hosts.update({"nyaa.si", "www.nyaa.si"})

        sukebei_base_url = env(
            "PUSH115_SUKEBEI_BASE_URL", "https://sukebei.nyaa.si"
        ).rstrip("/")
        parsed_sukebei = urlsplit(sukebei_base_url)
        if (
            parsed_sukebei.scheme.lower() != "https"
            or not parsed_sukebei.hostname
            or parsed_sukebei.username
            or parsed_sukebei.password
            or parsed_sukebei.query
            or parsed_sukebei.fragment
        ):
            raise ValueError("PUSH115_SUKEBEI_BASE_URL 必须是无凭据的 HTTPS 地址")
        sukebei_hosts = {
            item.strip().lower().rstrip(".")
            for item in env("PUSH115_SUKEBEI_ALLOWED_HOSTS", "").split(",")
            if item.strip()
        }
        sukebei_hosts.add(parsed_sukebei.hostname.lower().rstrip("."))

        telegram_polling = env("PUSH115_TELEGRAM_POLLING", "0").lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        telegram_token = env("PUSH115_TELEGRAM_BOT_TOKEN")
        allowed_chats = _parse_int_set(env("PUSH115_TELEGRAM_ALLOWED_CHAT_IDS"))
        allowed_users = _parse_int_set(env("PUSH115_TELEGRAM_ALLOWED_USER_IDS"))
        telegram_save_paths = _parse_telegram_save_paths(
            env("PUSH115_TELEGRAM_SAVE_PATHS")
        )
        lease_seconds = int(env("PUSH115_BRIDGE_LEASE_SECONDS", "120"))
        if not 15 <= lease_seconds <= 900:
            raise ValueError("租约时间必须在 15 到 900 秒之间")
        callback_ttl = int(env("PUSH115_TELEGRAM_CALLBACK_TTL_SECONDS", "900"))
        if not 60 <= callback_ttl <= 86400:
            raise ValueError("callback TTL 必须在 60 到 86400 秒之间")

        return cls(
            host=host,
            port=port,
            bearer_token=bearer_token,
            token_file=token_file,
            db_path=db_path,
            cors_origins=origins,
            telegram_bot_token=telegram_token,
            telegram_allowed_chat_ids=allowed_chats,
            telegram_allowed_user_ids=allowed_users,
            telegram_polling=telegram_polling,
            telegram_poll_timeout=max(
                1, min(50, int(env("PUSH115_TELEGRAM_POLL_TIMEOUT", "25")))
            ),
            callback_ttl_seconds=callback_ttl,
            lease_seconds=lease_seconds,
            javbus_base_url=base_url,
            javbus_allowed_hosts=frozenset(configured_hosts),
            javbus_timeout_seconds=max(
                1.0, min(60.0, float(env("PUSH115_JAVBUS_TIMEOUT_SECONDS", "15")))
            ),
            javbus_max_response_bytes=max(
                32_768,
                min(
                    8_000_000,
                    int(env("PUSH115_JAVBUS_MAX_RESPONSE_BYTES", "2000000")),
                ),
            ),
            nyaa_base_url=nyaa_base_url,
            nyaa_allowed_hosts=frozenset(nyaa_hosts),
            nyaa_timeout_seconds=max(
                1.0, min(60.0, float(env("PUSH115_NYAA_TIMEOUT_SECONDS", "15")))
            ),
            nyaa_max_response_bytes=max(
                32_768,
                min(
                    8_000_000,
                    int(env("PUSH115_NYAA_MAX_RESPONSE_BYTES", "2000000")),
                ),
            ),
            nyaa_max_results=max(
                1, min(100, int(env("PUSH115_NYAA_MAX_RESULTS", "20")))
            ),
            sukebei_base_url=sukebei_base_url,
            sukebei_allowed_hosts=frozenset(sukebei_hosts),
            sukebei_timeout_seconds=max(
                1.0, min(60.0, float(env("PUSH115_SUKEBEI_TIMEOUT_SECONDS", "15")))
            ),
            sukebei_max_response_bytes=max(
                32_768,
                min(
                    8_000_000,
                    int(env("PUSH115_SUKEBEI_MAX_RESPONSE_BYTES", "2000000")),
                ),
            ),
            sukebei_max_results=max(
                1, min(100, int(env("PUSH115_SUKEBEI_MAX_RESULTS", "20")))
            ),
            telegram_save_paths=telegram_save_paths,
            telegram_token_file=telegram_token_file,
        )


def require_allowlisted(value: int, allowed: Iterable[int]) -> bool:
    return int(value) in set(allowed)


class PairingError(ValueError):
    """Base class for errors raised while consuming a pairing window."""


class PairingWindowClosed(PairingError):
    """The bridge is already paired or its current window is unavailable."""


class PairingCodeInvalid(PairingError):
    """The supplied code is invalid; the attempt has been counted."""


@dataclass(frozen=True)
class PairingStatus:
    paired: bool
    pairing_available: bool
    expires_at: float | None
    failures: int
    max_failures: int = PAIRING_MAX_FAILURES

    def as_dict(self) -> dict[str, object]:
        return {
            "schema": 1,
            "version": "1.16.0",
            "paired": self.paired,
            "pairingAvailable": self.pairing_available,
            "expiresAt": self.expires_at,
            "failuresRemaining": max(0, self.max_failures - self.failures),
        }


def normalize_pairing_code(value: str) -> str:
    """Normalize a human-entered Crockford/Base32 code.

    Display separators and ASCII whitespace are ignored.  Crockford's
    unambiguous aliases (O/0 and I/L/1) are accepted on input, while generated
    codes never contain the ambiguous letters.
    """

    if not isinstance(value, str):
        raise PairingCodeInvalid("配对码格式无效")
    compact = "".join(character for character in value.upper() if not character.isspace())
    compact = compact.replace("-", "").replace("_", "")
    compact = compact.translate(str.maketrans({"O": "0", "I": "1", "L": "1"}))
    if len(compact) != PAIRING_CODE_LENGTH or any(
        character not in PAIRING_CODE_ALPHABET for character in compact
    ):
        raise PairingCodeInvalid("配对码格式无效")
    return compact


def _pairing_code_hash(code: str) -> str:
    return hashlib.sha256(
        ("115-offline-helper-pairing-v1:" + code).encode("ascii")
    ).hexdigest()


class PairingManager:
    """Own the one-time local pairing window and the active bearer token.

    ``runtime_store`` is intentionally duck-typed.  The concrete
    :class:`bridge.db.RuntimeConfigStore` is used by the app, while tests or a
    future Telegram manager can provide a small compatible store.  The code
    itself remains in memory only; the SQLite state contains its hash and
    expiry so a restart cannot accidentally resurrect a consumed code.
    """

    def __init__(
        self,
        runtime_store: object,
        *,
        token_file: str | Path | None,
        initial_token: str,
        auto_open_pairing: bool = False,
        clock: callable = time.time,
        code_factory: callable | None = None,
        token_factory: callable | None = None,
        ttl_seconds: int = PAIRING_CODE_TTL_SECONDS,
        max_failures: int = PAIRING_MAX_FAILURES,
    ) -> None:
        if not initial_token or len(str(initial_token)) < 32:
            raise ValueError("bearer token 至少需要 32 个字符")
        if ttl_seconds <= 0 or max_failures <= 0:
            raise ValueError("配对窗口参数必须为正数")
        self.runtime_store = runtime_store
        self.token_file = Path(token_file) if token_file else None
        self._clock = clock
        self._code_factory = code_factory or self._generate_code
        self._token_factory = token_factory or (lambda: secrets.token_urlsafe(32))
        self.ttl_seconds = int(ttl_seconds)
        self.max_failures = int(max_failures)
        self._lock = threading.RLock()
        self._current_code: str | None = None
        self._current_token = str(initial_token)

        stored_token = self._get_stored_bearer_token()
        if stored_token:
            self._current_token = stored_token
        state = self._get_pairing_state()
        if bool(state.get("paired")):
            self._current_code = None
            return
        # Normal bridge startup no longer opens a short-lived pairing window.
        # The old pairing API remains available for an explicit migration
        # command/test by calling ``open_window``.
        if auto_open_pairing:
            self._open_window_locked(now=self._now())

    @staticmethod
    def _generate_code() -> str:
        raw = "".join(
            secrets.choice(PAIRING_CODE_ALPHABET)
            for _ in range(PAIRING_CODE_LENGTH)
        )
        return raw

    def _now(self) -> float:
        return float(self._clock())

    def _get_stored_bearer_token(self) -> str | None:
        getter = getattr(self.runtime_store, "get_bearer_token", None)
        value = getter() if callable(getter) else None
        return str(value) if value else None

    def _get_pairing_state(self) -> dict[str, object]:
        getter = getattr(self.runtime_store, "get_pairing_state", None)
        value = getter() if callable(getter) else None
        return dict(value) if isinstance(value, Mapping) else {}

    def _save_pairing_state(self, state: Mapping[str, object]) -> None:
        setter = getattr(self.runtime_store, "set_pairing_state", None)
        if not callable(setter):
            raise RuntimeError("runtime store 不支持 pairing state")
        setter(dict(state))

    @property
    def current_token(self) -> str:
        with self._lock:
            return self._current_token

    @property
    def bearer_token(self) -> str:
        return self.current_token

    @property
    def current_code(self) -> str | None:
        """Return the display code for the local CLI, never an HTTP payload."""

        with self._lock:
            self._refresh_expiry_locked(self._now())
            if self._current_code is None:
                return None
            raw = self._current_code
            return f"{raw[:4]}-{raw[4:]}"

    @property
    def pairing_code(self) -> str | None:
        return self.current_code

    def _refresh_expiry_locked(self, now: float) -> dict[str, object]:
        state = self._get_pairing_state()
        if bool(state.get("paired")):
            self._current_code = None
            return state
        expires_at = state.get("expiresAt")
        try:
            expired = expires_at is not None and now >= float(expires_at)
        except (TypeError, ValueError):
            expired = True
        failures = int(state.get("failures", 0) or 0)
        if expired or failures >= self.max_failures:
            self._current_code = None
            state = {
                "schema": 1,
                "paired": False,
                "codeHash": state.get("codeHash"),
                "expiresAt": expires_at,
                "failures": failures,
                "closed": True,
            }
            self._save_pairing_state(state)
        return state

    def status(self, *, now: float | None = None) -> PairingStatus:
        with self._lock:
            state = self._refresh_expiry_locked(self._now() if now is None else float(now))
            paired = bool(state.get("paired"))
            failures = int(state.get("failures", 0) or 0)
            expires_at = state.get("expiresAt")
            try:
                expiry = float(expires_at) if expires_at is not None else None
            except (TypeError, ValueError):
                expiry = None
            available = (
                not paired
                and self._current_code is not None
                and failures < self.max_failures
                and expiry is not None
                and (self._now() if now is None else float(now)) < expiry
            )
            return PairingStatus(
                paired=paired,
                pairing_available=available,
                expires_at=expiry,
                failures=failures,
                max_failures=self.max_failures,
            )

    def open_window(self, *, now: float | None = None, force: bool = False) -> str:
        """Open a new window for an unpaired bridge and return its display code."""

        with self._lock:
            state = self._get_pairing_state()
            if bool(state.get("paired")) and not force:
                raise PairingWindowClosed("Bridge 已完成配对")
            self._open_window_locked(now=self._now() if now is None else float(now))
            return self.current_code or ""

    def _open_window_locked(self, *, now: float) -> None:
        raw_code = normalize_pairing_code(str(self._code_factory()))
        self._current_code = raw_code
        self._save_pairing_state(
            {
                "schema": 1,
                "paired": False,
                "codeHash": _pairing_code_hash(raw_code),
                "expiresAt": now + self.ttl_seconds,
                "failures": 0,
                "closed": False,
            }
        )

    def pair(self, code: str, *, client_id: str = "") -> str:
        """Consume ``code`` and rotate/persist the bearer token once."""

        with self._lock:
            now = self._now()
            state = self._refresh_expiry_locked(now)
            if bool(state.get("paired")):
                raise PairingWindowClosed("Bridge 已完成配对")
            if self._current_code is None or not self.status(now=now).pairing_available:
                raise PairingWindowClosed("配对窗口已关闭或已过期")
            try:
                normalized = normalize_pairing_code(code)
            except PairingCodeInvalid:
                normalized = ""
            expected = str(state.get("codeHash") or "")
            valid = bool(normalized) and hmac.compare_digest(
                _pairing_code_hash(normalized), expected
            )
            if not valid:
                failures = int(state.get("failures", 0) or 0) + 1
                self._save_pairing_state(
                    {
                        **state,
                        "failures": failures,
                        "closed": failures >= self.max_failures,
                    }
                )
                if failures >= self.max_failures:
                    self._current_code = None
                raise PairingCodeInvalid("配对码无效")

            token = str(self._token_factory())
            if len(token) < 32:
                raise ValueError("token_factory 返回的 bearer token 过短")
            persist = getattr(self.runtime_store, "set_bearer_token", None)
            if callable(persist):
                persist(token)
            if self.token_file is not None:
                persist_secret(self.token_file, token)
            self._current_token = token
            safe_client_id = str(client_id or "").strip()[:128]
            self._save_pairing_state(
                {
                    "schema": 1,
                    "paired": True,
                    "pairedAt": now,
                    "pairedClientId": safe_client_id,
                    "failures": int(state.get("failures", 0) or 0),
                    "closed": True,
                }
            )
            self._current_code = None
            return token

    def connect(self, *, client_id: str = "local") -> str:
        """Return the durable local bearer credential.

        ``/bootstrap/connect`` is the normal localhost onboarding path.  It
        deliberately does not rotate the token and does not require a
        human-entered pairing code.  Marking the legacy pairing state as
        paired prevents an old pairing window from becoming an alternate
        route after the browser has connected.
        """

        with self._lock:
            now = self._now()
            token = self._current_token
            if not token or len(token) < 32:
                raise ValueError("bearer token 至少需要 32 个字符")
            persist = getattr(self.runtime_store, "set_bearer_token", None)
            if callable(persist):
                persist(token)
            if self.token_file is not None:
                persist_secret(self.token_file, token)
            current = self._get_pairing_state()
            safe_client_id = str(client_id or "local").strip()[:128] or "local"
            if not bool(current.get("paired")):
                self._save_pairing_state(
                    {
                        "schema": 1,
                        "paired": True,
                        "pairedAt": now,
                        "pairedClientId": safe_client_id,
                        "closed": True,
                        "bootstrap": "connect",
                    }
                )
            self._current_code = None
            return token
