from __future__ import annotations

import asyncio

import pytest

pydantic = pytest.importorskip("pydantic")

from bridge.db import QueueStore
from bridge.providers.base import AvMetadata, MagnetCandidate
from bridge.providers.nyaa import NyaaSearchResult
from bridge.telegram import TelegramService


class FakeTransport:
    def __init__(self) -> None:
        self.next_id = 100
        self.messages: list[tuple[str, int, str, object]] = []
        self.answers: list[str] = []
        self.edits: list[tuple[int, int, str]] = []

    async def get_updates(self, *, offset, timeout):
        return []

    async def send_message(self, chat_id, text, *, reply_markup=None):
        self.next_id += 1
        self.messages.append(("message", chat_id, text, reply_markup))
        return {"message_id": self.next_id}

    async def send_photo(self, chat_id, photo, caption, *, reply_markup=None):
        self.next_id += 1
        self.messages.append(("photo", chat_id, caption, reply_markup))
        return {"message_id": self.next_id}

    async def answer_callback_query(self, callback_query_id, *, text=None, show_alert=False):
        self.answers.append(str(text or ""))

    async def edit_message_text(self, chat_id, message_id, text, *, reply_markup=None):
        self.edits.append((chat_id, message_id, text))
        return {"message_id": message_id}


class FakeProvider:
    async def lookup(self, code):
        return AvMetadata(
            code=code,
            title="Demo",
            page_url="https://javbus.com/ABC-123",
            cover_url="",
            candidates=(
                MagnetCandidate(
                    url="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    title="Demo 1080p",
                    btih="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    dedupe_key="btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                ),
            ),
        )


class FakeAnimeProvider:
    async def search(self, keyword):
        return NyaaSearchResult(
            keyword=keyword,
            feed_url="https://nyaa.si/?page=rss&q=demo",
            candidates=(
                MagnetCandidate(
                    url="magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    title="[Group] Demo 01",
                    btih="b" * 32,
                    dedupe_key="btih:" + "b" * 32,
                    guid="https://nyaa.si/view/2001",
                    detail_url="https://nyaa.si/view/2001",
                ),
            ),
        )


def test_av_selection_is_bound_to_user_and_one_time() -> None:
    store = QueueStore(":memory:")
    transport = FakeTransport()
    service = TelegramService(
        store,
        FakeProvider(),
        transport,
        allowed_chat_ids={11},
        allowed_user_ids={22},
        clock=lambda: 50,
    )
    try:
        result = asyncio.run(service.handle_update(
            {"update_id": 1, "message": {"chat": {"id": 11}, "from": {"id": 22}, "text": "/av ABC-123"}}
        ))
        assert result["handled"] is True
        keyboard = transport.messages[0][3]
        callback_data = keyboard["inline_keyboard"][0][0]["callback_data"]
        callback = {
            "id": "cb-1",
            "from": {"id": 22},
            "data": callback_data,
            "message": {"message_id": 101, "chat": {"id": 11}},
        }
        selected = asyncio.run(service.handle_update({"update_id": 2, "callback_query": callback}))
        assert selected["duplicate"] is False
        assert len(store.list_jobs()) == 1
        replay = asyncio.run(service.handle_update({"update_id": 3, "callback_query": callback}))
        assert replay["error"] == "callback_expired"
        assert len(store.list_jobs()) == 1

        unauthorized = asyncio.run(service.handle_update(
            {"update_id": 4, "message": {"chat": {"id": 99}, "from": {"id": 22}, "text": "/av ABC-123"}}
        ))
        assert unauthorized["reason"] == "unauthorized"
    finally:
        store.close()


def test_anime_search_uses_explicit_anime_intent_profile() -> None:
    store = QueueStore(":memory:")
    transport = FakeTransport()
    service = TelegramService(
        store,
        FakeProvider(),
        transport,
        anime_provider=FakeAnimeProvider(),
        allowed_chat_ids={11},
        allowed_user_ids={22},
        clock=lambda: 50,
    )
    try:
        result = asyncio.run(service.handle_update(
            {"update_id": 1, "message": {"chat": {"id": 11}, "from": {"id": 22}, "text": "/anime Demo"}}
        ))
        assert result["kind"] == "anime"
        keyboard = transport.messages[0][3]
        callback = {
            "id": "cb-anime",
            "from": {"id": 22},
            "data": keyboard["inline_keyboard"][0][0]["callback_data"],
            "message": {"message_id": 101, "chat": {"id": 11}},
        }
        selected = asyncio.run(service.handle_update({"update_id": 2, "callback_query": callback}))
        assert selected["duplicate"] is False
        job = store.list_jobs()[0]
        assert job.intent["sourceSite"] == "nyaa"
        assert job.intent["mediaType"] == "anime"
        assert job.intent["processorProfile"] == "anime"
        assert job.intent["code"] == ""
        assert job.intent["metadata"]["provider"] == "nyaa"
        assert job.intent["metadata"]["originalTitle"] == "[Group] Demo 01"
        assert job.intent["metadata"]["btih"] == "b" * 32
    finally:
        store.close()
