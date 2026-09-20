from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from bridge.providers.base import ProviderError
from bridge.providers.nyaa import (
    NyaaCompatibleRssProvider,
    NyaaProvider,
    NyaaRSSProvider,
    NyaaRssProvider,
    SukebeiRssProvider,
)


class FakeResponse:
    def __init__(self, url: str, content: bytes, status_code: int = 200, headers=None) -> None:
        self.url = url
        self.content = content
        self.text = content.decode("utf-8", errors="replace")
        self.status_code = status_code
        self.headers = headers or {"content-type": "application/rss+xml"}


class FakeClient:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def get(self, url: str, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def test_nyaa_rss_parses_detail_url_and_deduplicates_btih() -> None:
    fixture = Path(__file__).parent / "fixtures" / "nyaa-search.xml"
    source = fixture.read_bytes()
    client = FakeClient(FakeResponse("https://nyaa.si/?page=rss", source))
    provider = NyaaRssProvider(client=client, max_results=10)

    result = asyncio.run(provider.search("demo episode"))

    assert len(result.candidates) == 3
    assert result.candidates[0].btih == "a" * 40
    assert result.candidates[0].detail_url == "https://nyaa.si/view/1001"
    assert result.candidates[1].btih == "c" * 40
    assert result.candidates[1].url == "magnet:?xt=urn:btih:" + "c" * 40
    assert result.candidates[1].detail_url == "https://nyaa.si/view/1002"
    assert result.candidates[2].guid == "https://nyaa.si/view/1003"
    assert "page=rss" in client.calls[0][0]
    assert "c=1_0" in client.calls[0][0]
    assert "q=demo+episode" in client.calls[0][0]


def test_nyaa_compatible_provider_defaults_to_nyaa_category() -> None:
    provider = NyaaCompatibleRssProvider(client=FakeClient(FakeResponse("https://nyaa.si/", b"")))

    assert provider.category == "1_0"
    assert provider.feed_url("demo episode") == (
        "https://nyaa.si/?page=rss&f=0&c=1_0&q=demo+episode"
    )


def test_nyaa_compatible_provider_supports_sukebei_category() -> None:
    provider = NyaaCompatibleRssProvider(
        "https://sukebei.nyaa.si",
        category="0_0",
        client=FakeClient(FakeResponse("https://sukebei.nyaa.si/", b"")),
    )

    assert provider.feed_url("demo") == (
        "https://sukebei.nyaa.si/?page=rss&f=0&c=0_0&q=demo"
    )


def test_sukebei_provider_defaults_to_sukebei_host() -> None:
    provider = SukebeiRssProvider(
        client=FakeClient(FakeResponse("https://sukebei.nyaa.si/", b"")),
    )

    assert provider.category == "0_0"
    assert provider.feed_url("demo") == (
        "https://sukebei.nyaa.si/?page=rss&f=0&c=0_0&q=demo"
    )


def test_nyaa_provider_legacy_names_remain_exact_aliases() -> None:
    assert NyaaRssProvider is NyaaCompatibleRssProvider
    assert NyaaProvider is NyaaCompatibleRssProvider
    assert NyaaRSSProvider is NyaaCompatibleRssProvider


def test_nyaa_category_rejects_query_injection() -> None:
    with pytest.raises(ValueError):
        NyaaCompatibleRssProvider(category="0_0&q=evil")


def test_nyaa_rss_rejects_unallowlisted_redirect_and_oversized_response() -> None:
    redirect_client = FakeClient(
        FakeResponse(
            "https://nyaa.si/?page=rss",
            b"",
            302,
            {"location": "https://example.invalid/feed"},
        )
    )
    provider = NyaaRssProvider(client=redirect_client)
    with pytest.raises(ProviderError):
        asyncio.run(provider.search("demo"))

    oversized = FakeClient(
        FakeResponse("https://nyaa.si/?page=rss", b"x" * 40_000)
    )
    provider = NyaaRssProvider(client=oversized, max_response_bytes=32_768)
    with pytest.raises(ProviderError):
        asyncio.run(provider.search("demo"))
