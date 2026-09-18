from __future__ import annotations

from pathlib import Path

import pytest

from bridge.config import Settings


_CONFIG_KEYS = (
    "PUSH115_BRIDGE_HOST",
    "PUSH115_BRIDGE_PORT",
    "PUSH115_BRIDGE_TOKEN",
    "PUSH115_BRIDGE_TOKEN_FILE",
    "PUSH115_BRIDGE_DB",
    "PUSH115_BRIDGE_CORS_ORIGINS",
    "PUSH115_TELEGRAM_POLLING",
    "PUSH115_TELEGRAM_BOT_TOKEN",
    "PUSH115_TELEGRAM_ALLOWED_CHAT_IDS",
    "PUSH115_TELEGRAM_ALLOWED_USER_IDS",
    "PUSH115_JAVBUS_BASE_URL",
    "PUSH115_JAVBUS_ALLOWED_HOSTS",
)


def test_dotenv_is_loaded_and_environment_wins(tmp_path: Path, monkeypatch) -> None:
    for key in _CONFIG_KEYS:
        monkeypatch.delenv(key, raising=False)
    env_file = tmp_path / ".env"
    token_file = tmp_path / "token"
    db_file = tmp_path / "queue.sqlite3"
    token = "e" * 32
    env_file.write_text(
        "\n".join(
            [
                f"PUSH115_BRIDGE_TOKEN={token}",
                f"PUSH115_BRIDGE_TOKEN_FILE={token_file}",
                f"PUSH115_BRIDGE_DB={db_file}",
                "PUSH115_BRIDGE_CORS_ORIGINS=chrome-extension://exampleid",
                "PUSH115_JAVBUS_ALLOWED_HOSTS=javbus.com,www.javbus.com",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PUSH115_BRIDGE_ENV_FILE", str(env_file))
    settings = Settings.from_env()
    assert settings.bearer_token == token
    assert settings.db_path == db_file
    assert settings.cors_origins == ("chrome-extension://exampleid",)
    override = "o" * 32
    monkeypatch.setenv("PUSH115_BRIDGE_TOKEN", override)
    assert Settings.from_env().bearer_token == override


def test_cors_wildcard_is_rejected(monkeypatch, tmp_path: Path) -> None:
    for key in _CONFIG_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("PUSH115_BRIDGE_ENV_FILE", str(tmp_path / "missing.env"))
    monkeypatch.setenv("PUSH115_BRIDGE_TOKEN", "t" * 32)
    monkeypatch.setenv("PUSH115_BRIDGE_CORS_ORIGINS", "*")
    with pytest.raises(ValueError, match="通配符"):
        Settings.from_env()
