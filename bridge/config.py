"""Environment-backed configuration for the local bridge."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
DEFAULT_STATE_DIR = ROOT / ".state"
DEFAULT_TOKEN_FILE = DEFAULT_STATE_DIR / "bearer.token"
DEFAULT_DB_FILE = DEFAULT_STATE_DIR / "bridge.sqlite3"


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
    return Path(value).expanduser() if value else default


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

    @classmethod
    def from_env(cls) -> "Settings":
        env_file_value = os.environ.get("PUSH115_BRIDGE_ENV_FILE", "")
        env_file = _safe_path(env_file_value, ROOT / ".env")
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

        telegram_polling = env("PUSH115_TELEGRAM_POLLING", "0").lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        telegram_token = env("PUSH115_TELEGRAM_BOT_TOKEN")
        allowed_chats = _parse_int_set(env("PUSH115_TELEGRAM_ALLOWED_CHAT_IDS"))
        allowed_users = _parse_int_set(env("PUSH115_TELEGRAM_ALLOWED_USER_IDS"))
        if telegram_polling and (not telegram_token or not allowed_chats):
            raise ValueError(
                "启用 Telegram polling 时必须设置 Bot token 和非空 chat allowlist"
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
        )


def require_allowlisted(value: int, allowed: Iterable[int]) -> bool:
    return int(value) in set(allowed)
