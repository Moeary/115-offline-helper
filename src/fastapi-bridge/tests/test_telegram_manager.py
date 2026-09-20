from __future__ import annotations

import asyncio

import pytest

from bridge.db import QueueStore
from bridge.telegram import TelegramError, TelegramService
from bridge.telegram_manager import TelegramManager


class FakeManagerTransport:
    def __init__(self, token: str, *, username: str = "demo115_bot") -> None:
        self.token = token
        self.username = username
        self.closed = False
        self.messages: list[tuple[int, str]] = []
        self.commands: list[dict[str, str]] = []

    async def get_me(self):
        if self.token == "bad":
            raise TelegramError("invalid token")
        return {"id": 123, "is_bot": True, "username": self.username}

    async def set_my_commands(self, commands):
        self.commands = [dict(item) for item in commands]
        return True

    async def get_updates(self, *, offset, timeout):
        return []

    async def send_message(self, chat_id, text, *, reply_markup=None):
        self.messages.append((int(chat_id), str(text)))
        return {"message_id": len(self.messages)}

    async def send_photo(self, chat_id, photo, caption, *, reply_markup=None):
        return {"message_id": 1}

    async def answer_callback_query(self, callback_query_id, *, text=None, show_alert=False):
        return None

    async def edit_message_text(self, chat_id, message_id, text, *, reply_markup=None):
        return {"message_id": int(message_id)}

    async def aclose(self):
        self.closed = True


def _factory(token: str):
    return FakeManagerTransport(token)


def test_manager_configures_without_exposing_token(tmp_path) -> None:
    async def scenario() -> None:
        store = QueueStore(":memory:")
        manager = TelegramManager(
            store,
            object(),
            token_file=tmp_path / "telegram_bot.token",
            transport_factory=_factory,
        )
        try:
            status = await manager.configure("123456:secret", enabled=False)
            assert status["configured"] is True
            assert status["enabled"] is False
            assert status["botUsername"] == "demo115_bot"
            assert status["ownerBound"] is False
            assert "secret" not in str(status)
            assert (tmp_path / "telegram_bot.token").read_text().strip() == "123456:secret"
            assert "claimUrl" not in status
            assert manager.bind_owner(11, 22) is True
            assert manager.status()["ownerBound"] is True
            assert manager.bind_owner(99, 100) is False
            assert [item["command"] for item in manager._transport.commands] == [
                "start", "av", "anime", "dir", "add", "jobs", "help"
            ]
        finally:
            await manager.close()
            store.close()

    asyncio.run(scenario())


def test_manager_rejects_invalid_token_and_keeps_old_configuration(tmp_path) -> None:
    async def scenario() -> None:
        store = QueueStore(":memory:")
        manager = TelegramManager(
            store,
            object(),
            token_file=tmp_path / "telegram_bot.token",
            transport_factory=_factory,
        )
        try:
            await manager.configure("good-token", enabled=False)
            with pytest.raises(TelegramError):
                await manager.configure("bad", enabled=False)
            assert manager.status()["botUsername"] == "demo115_bot"
            assert manager.status()["configured"] is True
            assert (tmp_path / "telegram_bot.token").read_text().strip() == "good-token"
        finally:
            await manager.close()
            store.close()

    asyncio.run(scenario())


def test_service_auto_claims_first_start_and_scopes_owner(tmp_path) -> None:
    async def scenario() -> None:
        store = QueueStore(":memory:")
        manager = TelegramManager(
            store,
            object(),
            token_file=tmp_path / "telegram_bot.token",
            transport_factory=_factory,
        )
        try:
            await manager.configure("good-token", enabled=False)
            transport = FakeManagerTransport("good-token")
            service = TelegramService(
                store,
                object(),
                transport,
                owner_getter=manager._owner,
                owner_setter=manager.bind_owner,
            )
            result = await service.handle_update(
                {
                    "message": {
                        "chat": {"id": 11},
                        "from": {"id": 22},
                        "text": "/start",
                    }
                }
            )
            assert result["kind"] == "owner_claim"
            assert manager.status()["ownerBound"] is True
            assert service.authorized(11, 22) is True
            assert service.authorized(11, 23) is False
            assert service.authorized(99, 22) is False
        finally:
            await manager.close()
            store.close()

    asyncio.run(scenario())
