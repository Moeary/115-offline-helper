from __future__ import annotations

import asyncio
from unittest.mock import patch

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


def _message(text: str, *, chat_id: int = 11, user_id: int = 22, message_id: int | None = None) -> dict:
    message = {
        "chat": {"id": chat_id},
        "from": {"id": user_id},
        "text": text,
    }
    if message_id is not None:
        message["message_id"] = message_id
    return message


def _callback(
    callback_data: str,
    message_id: int,
    *,
    chat_id: int = 11,
    user_id: int = 22,
    callback_id: str = "callback",
) -> dict:
    return {
        "id": callback_id,
        "from": {"id": user_id},
        "data": callback_data,
        "message": {"message_id": message_id, "chat": {"id": chat_id}},
    }


def test_add_supports_magnet_ed2k_and_reuses_latest_directory_for_old_candidate() -> None:
    store = QueueStore(":memory:")
    transport = FakeTransport()
    service = TelegramService(
        store,
        FakeProvider(),
        transport,
        allowed_chat_ids={11},
        allowed_user_ids={22},
        save_paths=(("0", "根目录"), ("9", "动画")),
        clock=lambda: 50,
    )
    try:
        magnet = "magnet:?xt=urn:btih:" + "c" * 32 + "&dn=Direct"
        direct = asyncio.run(
            service.handle_update({"message": _message("/add " + magnet, message_id=1)})
        )
        assert direct["kind"] == "add"
        direct_job = store.get_job(direct["jobId"])
        assert direct_job is not None
        assert direct_job.intent["linkType"] == "magnet"
        assert direct_job.intent["savePathCid"] == "0"

        # The lookup button was created before the user changed directories;
        # selection must resolve the preference at click time.
        lookup = asyncio.run(
            service.handle_update({"message": _message("/av ABC-123")})
        )
        lookup_message_id = transport.next_id
        candidate_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        directory = asyncio.run(
            service.handle_update({"message": _message("/dir")})
        )
        assert directory["kind"] == "dir"
        directory_message_id = transport.next_id
        directory_data = transport.messages[-1][3]["inline_keyboard"][1][0]["callback_data"]
        selected = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(directory_data, directory_message_id, callback_id="dir")}
            )
        )
        assert selected["savePathCid"] == "9"
        assert store.get_telegram_preference(11, 22)["lastSavePathCid"] == "9"

        chosen = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(candidate_data, lookup_message_id, callback_id="candidate")}
            )
        )
        chosen_job = store.get_job(chosen["jobId"])
        assert chosen_job is not None
        assert chosen_job.intent["savePathCid"] == "9"

        ed2k = "ed2k://|file|Demo%20One.mkv|123|" + "A" * 32 + "|/"
        added_ed2k = asyncio.run(
            service.handle_update({"message": _message("/add " + ed2k, message_id=2)})
        )
        ed2k_job = store.get_job(added_ed2k["jobId"])
        assert ed2k_job is not None
        assert ed2k_job.intent["linkType"] == "ed2k"
        assert ed2k_job.intent["expectedName"] == "Demo One.mkv"
        assert ed2k_job.intent["expectedSize"] == 123
        assert ed2k_job.intent["expectedHash"] == "a" * 32
    finally:
        store.close()


def test_direct_save_paths_use_the_same_ascii_64_digit_cid_contract() -> None:
    store = QueueStore(":memory:")
    try:
        valid_cid = "1" + "2" * 63
        service = TelegramService(
            store,
            FakeProvider(),
            FakeTransport(),
            save_paths=(
                (valid_cid, "valid"),
                ("1" * 65, "too long"),
                ("01", "leading zero"),
                ("１２", "unicode digits"),
            ),
        )
        assert service.save_paths == ((valid_cid, "valid"),)
    finally:
        store.close()


def test_callback_rejects_cross_owner_or_message_and_replays_only_once() -> None:
    store = QueueStore(":memory:")
    transport = FakeTransport()
    service = TelegramService(
        store,
        FakeProvider(),
        transport,
        allowed_chat_ids={11, 12},
        allowed_user_ids={22, 33},
        clock=lambda: 50,
    )
    try:
        asyncio.run(service.handle_update({"message": _message("/av ABC-123")}))
        message_id = transport.next_id
        callback_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]

        wrong_chat = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(callback_data, message_id, chat_id=12, callback_id="chat")}
            )
        )
        wrong_user = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(callback_data, message_id, user_id=33, callback_id="user")}
            )
        )
        wrong_message = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(callback_data, message_id + 1, callback_id="message")}
            )
        )
        assert wrong_chat["error"] == "callback_expired"
        assert wrong_user["error"] == "callback_expired"
        assert wrong_message["error"] == "callback_expired"
        assert store.list_jobs() == []

        selected = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(callback_data, message_id, callback_id="ok")}
            )
        )
        replay = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(callback_data, message_id, callback_id="replay")}
            )
        )
        assert selected["duplicate"] is False
        assert replay["error"] == "callback_expired"
        assert len(store.list_jobs()) == 1
        assert len(transport.answers) >= 5
    finally:
        store.close()


def test_jobs_are_owner_scoped_and_detail_has_local_and_remote_ids() -> None:
    store = QueueStore(":memory:")
    transport = FakeTransport()
    service = TelegramService(
        store,
        FakeProvider(),
        transport,
        allowed_chat_ids={11},
        allowed_user_ids={22, 33},
        save_paths=(("0", "根目录"),),
        clock=lambda: 50,
    )
    try:
        own, _ = store.enqueue(
            {
                "jobId": "own",
                "url": "magnet:?xt=urn:btih:" + "d" * 32,
                "savePathCid": "0",
            },
            candidate_key="own",
            telegram_chat_id=11,
            telegram_user_id=22,
            telegram_message_id=1,
            now=20,
        )
        other, _ = store.enqueue(
            {"jobId": "other", "url": "magnet:?xt=urn:btih:" + "e" * 32},
            candidate_key="other",
            telegram_chat_id=11,
            telegram_user_id=33,
            telegram_message_id=2,
            now=30,
        )
        claimed = store.claim("worker", now=31)
        assert claimed is not None
        if claimed.job_id != own.job_id:
            # The queue is oldest-first; claim the remaining job as needed.
            claimed = store.claim("worker-2", now=32)
        assert claimed is not None
        accepted, _ = store.append_event(
            claimed.job_id,
            lease_id=claimed.lease_id or "",
            event_id="accepted",
            state="accepted",
            task_id="local-task-1",
            remote_id="remote-task-1",
            now=33,
        )
        assert accepted.job_id == own.job_id or accepted.job_id == other.job_id

        listed = asyncio.run(
            service.handle_update({"message": _message("/jobs", user_id=22)})
        )
        assert listed["kind"] == "jobs"
        jobs_text = transport.messages[-1][2]
        assert "dddddddddddddddddddddddddddddddd" in jobs_text
        assert other.job_id[:12] not in jobs_text
        detail_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        detail = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(detail_data, transport.next_id, user_id=22, callback_id="detail")}
            )
        )
        assert detail["kind"] == "job_detail"
        assert "本地任务" in transport.messages[-1][2]
        assert "远端标识" in transport.messages[-1][2]
    finally:
        store.close()


def test_failed_retry_and_queued_or_claimed_cancel_are_idempotent() -> None:
    store = QueueStore(":memory:")
    transport = FakeTransport()
    service = TelegramService(
        store,
        FakeProvider(),
        transport,
        allowed_chat_ids={11},
        allowed_user_ids={22},
        save_paths=(("0", "根目录"),),
        clock=lambda: 50,
    )
    try:
        failed, _ = store.enqueue(
            {"jobId": "failed", "url": "magnet:?xt=urn:btih:" + "f" * 32},
            candidate_key="failed",
            telegram_chat_id=11,
            telegram_user_id=22,
            telegram_message_id=1,
            now=10,
        )
        failed_claim = store.claim("failed-worker", now=11)
        assert failed_claim is not None
        failed, _ = store.append_event(
            failed.job_id,
            lease_id=failed_claim.lease_id or "",
            event_id="failed",
            state="failed",
            error_code="REMOTE_REJECTED",
            now=12,
        )
        asyncio.run(service.handle_update({"message": _message("/jobs")}))
        detail_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        asyncio.run(
            service.handle_update(
                {"callback_query": _callback(detail_data, transport.next_id, callback_id="failed-detail")}
            )
        )
        retry_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        retried = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(retry_data, transport.next_id, callback_id="retry")}
            )
        )
        assert retried["duplicate"] is False
        assert store.get_job(retried["jobId"]).parent_job_id == failed.job_id
        replay = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(retry_data, transport.next_id, callback_id="retry-replay")}
            )
        )
        assert replay["error"] == "callback_expired"

        queued, _ = store.enqueue(
            {"jobId": "queued", "url": "magnet:?xt=urn:btih:" + "1" * 32},
            candidate_key="queued",
            telegram_chat_id=11,
            telegram_user_id=22,
            telegram_message_id=2,
            now=60,
        )
        asyncio.run(service.handle_update({"message": _message("/jobs")}))
        # Newest job is the queued one.
        detail_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        asyncio.run(
            service.handle_update(
                {"callback_query": _callback(detail_data, transport.next_id, callback_id="queued-detail")}
            )
        )
        cancel_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        cancelled = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(cancel_data, transport.next_id, callback_id="cancel-queued")}
            )
        )
        assert cancelled["actionStatus"] == "applied"
        assert store.get_job(queued.job_id).status == "cancelled"
        assert "不会创建 115 云端离线任务" in transport.answers[-1]

        claimed_job, _ = store.enqueue(
            {"jobId": "claimed", "url": "magnet:?xt=urn:btih:" + "2" * 32},
            candidate_key="claimed",
            telegram_chat_id=11,
            telegram_user_id=22,
            telegram_message_id=3,
            now=70,
        )
        claimed = store.claim("claim-worker", now=71)
        while claimed is not None and claimed.job_id != claimed_job.job_id:
            claimed = store.claim("claim-worker", now=71)
        assert claimed is not None and claimed.job_id == claimed_job.job_id
        asyncio.run(service.handle_update({"message": _message("/jobs")}))
        detail_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        asyncio.run(
            service.handle_update(
                {"callback_query": _callback(detail_data, transport.next_id, callback_id="claimed-detail")}
            )
        )
        cancel_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        pending = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(cancel_data, transport.next_id, callback_id="cancel-claimed")}
            )
        )
        assert pending["actionStatus"] == "queued"
        assert store.get_job(claimed_job.job_id).status == "claimed"
        assert "已请求浏览器停止本地任务/监控" in transport.answers[-1]
    finally:
        store.close()


def test_candidate_queue_failure_keeps_callback_reusable() -> None:
    store = QueueStore(":memory:")
    transport = FakeTransport()
    service = TelegramService(
        store,
        FakeProvider(),
        transport,
        allowed_chat_ids={11},
        allowed_user_ids={22},
        save_paths=(("0", "根目录"),),
        clock=lambda: 50,
    )
    try:
        asyncio.run(service.handle_update({"message": _message("/av ABC-123")}))
        callback_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        message_id = transport.next_id
        original = store.consume_callback_and_enqueue
        with patch.object(store, "consume_callback_and_enqueue", side_effect=RuntimeError("db")):
            failed = asyncio.run(
                service.handle_update(
                    {"callback_query": _callback(callback_data, message_id, callback_id="fault")}
                )
            )
        assert failed["error"] == "queue_unavailable"
        assert store.list_jobs() == []
        store.consume_callback_and_enqueue = original
        succeeded = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(callback_data, message_id, callback_id="retry")}
            )
        )
        assert succeeded["duplicate"] is False
        assert len(store.list_jobs()) == 1
    finally:
        store.close()


def test_cancelled_status_notification_and_same_link_can_be_added_again() -> None:
    store = QueueStore(":memory:")
    transport = FakeTransport()
    service = TelegramService(
        store,
        FakeProvider(),
        transport,
        allowed_chat_ids={11},
        allowed_user_ids={22},
        save_paths=(("0", "根目录"),),
        clock=lambda: 50,
    )
    try:
        magnet = "magnet:?xt=urn:btih:" + "a" * 32
        first = asyncio.run(
            service.handle_update({"message": _message("/add " + magnet, message_id=1)})
        )
        first_job = store.get_job(first["jobId"])
        assert first_job is not None and first_job.status_message_id is not None
        action, _ = store.request_cancel(first_job.job_id, request_id="notify-cancel", now=60)
        assert action.status == "applied"
        assert asyncio.run(service.notify_status_once()) == 1
        assert "不会取消 115 云端离线任务" in transport.edits[-1][2]

        second = asyncio.run(
            service.handle_update({"message": _message("/add " + magnet, message_id=2)})
        )
        assert second["duplicate"] is False
        assert second["jobId"] != first_job.job_id
    finally:
        store.close()


def _telegram_registry(revision: int, entries: list[dict]) -> dict:
    return {
        "schema": 1,
        "revision": revision,
        "scannedAt": 1700000000000 + revision,
        "roots": ["0"],
        "directories": entries,
    }


def test_telegram_reads_dynamic_registry_without_restart_and_keeps_static_fallback() -> None:
    store = QueueStore(":memory:")
    transport = FakeTransport()
    service = TelegramService(
        store,
        FakeProvider(),
        transport,
        allowed_chat_ids={11},
        allowed_user_ids={22},
        save_paths=(("0", "旧根目录"),),
        clock=lambda: 50,
    )
    try:
        static = asyncio.run(service.handle_update({"message": _message("/dir")}))
        assert static["kind"] == "dir"
        assert "旧根目录" in transport.messages[-1][2]

        store.set_directory_registry(
            _telegram_registry(
                1,
                [
                    {"cid": "0", "parentCid": None, "name": "根目录", "path": "/", "depth": 0},
                    {"cid": "9", "parentCid": "0", "name": "动画", "path": "/动画", "depth": 1},
                ],
            )
        )
        first = asyncio.run(service.handle_update({"message": _message("/dir")}))
        assert first["kind"] == "dir"
        first_keyboard = transport.messages[-1][3]["inline_keyboard"]
        assert any("动画" in row[0]["text"] for row in first_keyboard)
        assert all("旧根目录" not in row[0]["text"] for row in first_keyboard)

        store.set_directory_registry(
            _telegram_registry(
                2,
                [
                    {"cid": "0", "parentCid": None, "name": "根目录", "path": "/", "depth": 0},
                    {"cid": "11", "parentCid": "0", "name": "新目录", "path": "/新目录", "depth": 1},
                ],
            )
        )
        latest = asyncio.run(service.handle_update({"message": _message("/dir")}))
        assert latest["kind"] == "dir"
        latest_keyboard = transport.messages[-1][3]["inline_keyboard"]
        assert any("新目录" in row[0]["text"] for row in latest_keyboard)
        assert all("动画" not in row[0]["text"] for row in latest_keyboard)
    finally:
        store.close()


def test_telegram_empty_registry_prompts_sync_and_blocks_add_and_candidate() -> None:
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
        store.set_directory_registry(_telegram_registry(1, []))
        directory = asyncio.run(service.handle_update({"message": _message("/dir")}))
        assert directory["kind"] == "dir"
        assert "浏览器尚未同步 115 目录" in transport.messages[-1][2]

        magnet = "magnet:?xt=urn:btih:" + "f" * 32
        added = asyncio.run(
            service.handle_update({"message": _message("/add " + magnet, message_id=1)})
        )
        assert added["error"] == "save_path_unavailable"
        assert "浏览器尚未同步 115 目录" in transport.messages[-1][2]
        assert store.list_jobs() == []

        store.set_directory_registry(
            _telegram_registry(
                2,
                [
                    {"cid": "0", "parentCid": None, "name": "根目录", "path": "/", "depth": 0},
                ],
            )
        )
        lookup = asyncio.run(service.handle_update({"message": _message("/av ABC-123")}))
        assert lookup["kind"] == "av"
        candidate_data = transport.messages[-1][3]["inline_keyboard"][0][0]["callback_data"]
        lookup_message_id = transport.next_id
        store.set_directory_registry(_telegram_registry(3, []))
        selected = asyncio.run(
            service.handle_update(
                {"callback_query": _callback(candidate_data, lookup_message_id, callback_id="empty")}
            )
        )
        assert selected["error"] == "save_path_unavailable"
        assert store.list_jobs() == []
    finally:
        store.close()
