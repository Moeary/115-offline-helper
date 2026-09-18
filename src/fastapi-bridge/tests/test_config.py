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
    "PUSH115_TELEGRAM_SAVE_PATHS",
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
                "PUSH115_TELEGRAM_SAVE_PATHS=0=根目录,123=动画",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PUSH115_BRIDGE_ENV_FILE", str(env_file))
    settings = Settings.from_env()
    assert settings.bearer_token == token
    assert settings.db_path == db_file
    assert settings.cors_origins == ("chrome-extension://exampleid",)
    assert [(item.cid, item.name) for item in settings.telegram_save_paths] == [
        ("0", "根目录"),
        ("123", "动画"),
    ]
    override = "o" * 32
    monkeypatch.setenv("PUSH115_BRIDGE_TOKEN", override)
    assert Settings.from_env().bearer_token == override
    monkeypatch.setenv("PUSH115_TELEGRAM_SAVE_PATHS", "456=覆盖")
    assert [(item.cid, item.name) for item in Settings.from_env().telegram_save_paths] == [
        ("456", "覆盖"),
    ]


def test_telegram_save_paths_keep_order_and_remove_control_characters(
    monkeypatch, tmp_path: Path
) -> None:
    for key in _CONFIG_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("PUSH115_BRIDGE_ENV_FILE", str(tmp_path / "missing.env"))
    monkeypatch.setenv("PUSH115_BRIDGE_TOKEN", "t" * 32)
    monkeypatch.setenv(
        "PUSH115_TELEGRAM_SAVE_PATHS", " 0 = 根\n目录 , 12 = 动画\t专区 "
    )
    settings = Settings.from_env()
    assert [(item.cid, item.name) for item in settings.telegram_save_paths] == [
        ("0", "根目录"),
        ("12", "动画专区"),
    ]


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ("1=one,1=again", "重复 CID"),
        ("-1=negative", "十进制 CID"),
        ("01=leading-zero", "十进制 CID"),
        ("1" * 65 + "=too-long", "十进制 CID"),
        ("1", "十进制 CID"),
        ("1=", "缺少显示名"),
        ("1=   ", "缺少显示名"),
    ],
)
def test_telegram_save_paths_reject_invalid_entries(
    value: str, message: str, monkeypatch, tmp_path: Path
) -> None:
    for key in _CONFIG_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("PUSH115_BRIDGE_ENV_FILE", str(tmp_path / "missing.env"))
    monkeypatch.setenv("PUSH115_BRIDGE_TOKEN", "t" * 32)
    monkeypatch.setenv("PUSH115_TELEGRAM_SAVE_PATHS", value)
    with pytest.raises(ValueError, match=message):
        Settings.from_env()


def test_telegram_save_paths_reject_more_than_fifty_entries(
    monkeypatch, tmp_path: Path
) -> None:
    for key in _CONFIG_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("PUSH115_BRIDGE_ENV_FILE", str(tmp_path / "missing.env"))
    monkeypatch.setenv("PUSH115_BRIDGE_TOKEN", "t" * 32)
    monkeypatch.setenv(
        "PUSH115_TELEGRAM_SAVE_PATHS",
        ",".join(f"{index}=目录{index}" for index in range(51)),
    )
    with pytest.raises(ValueError, match="最多允许 50"):
        Settings.from_env()


def test_telegram_polling_requires_a_non_empty_save_path_allowlist(
    monkeypatch, tmp_path: Path
) -> None:
    for key in _CONFIG_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("PUSH115_BRIDGE_ENV_FILE", str(tmp_path / "missing.env"))
    monkeypatch.setenv("PUSH115_BRIDGE_TOKEN", "t" * 32)
    monkeypatch.setenv("PUSH115_TELEGRAM_POLLING", "1")
    monkeypatch.setenv("PUSH115_TELEGRAM_BOT_TOKEN", "123456:bot")
    monkeypatch.setenv("PUSH115_TELEGRAM_ALLOWED_CHAT_IDS", "123")
    with pytest.raises(ValueError, match="保存目录 allowlist"):
        Settings.from_env()


def test_cors_wildcard_is_rejected(monkeypatch, tmp_path: Path) -> None:
    for key in _CONFIG_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("PUSH115_BRIDGE_ENV_FILE", str(tmp_path / "missing.env"))
    monkeypatch.setenv("PUSH115_BRIDGE_TOKEN", "t" * 32)
    monkeypatch.setenv("PUSH115_BRIDGE_CORS_ORIGINS", "*")
    with pytest.raises(ValueError, match="通配符"):
        Settings.from_env()
