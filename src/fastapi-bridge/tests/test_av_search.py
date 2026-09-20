from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from bridge.providers.av_search import AvSearchService
from bridge.providers.base import AvMetadata, MagnetCandidate, ProviderError


def _candidate(letter: str, title: str) -> MagnetCandidate:
    btih = letter * 32
    return MagnetCandidate(
        url=f"magnet:?xt=urn:btih:{btih}",
        title=title,
        btih=btih,
        dedupe_key=f"btih:{btih}",
    )


class ResourceProvider:
    def __init__(self, result=None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error

    async def search(self, code: str):
        if self.error:
            raise self.error
        return self.result


class MetadataProvider:
    def __init__(self, result=None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error

    async def lookup(self, code: str):
        if self.error:
            raise self.error
        return self.result


def test_av_search_prefers_sukebei_resources_and_enriches_with_javbus() -> None:
    resource = ResourceProvider(
        SimpleNamespace(
            feed_url="https://sukebei.nyaa.si/?page=rss&q=ABF-386",
            candidates=(_candidate("a", "Sukebei release"),),
        )
    )
    metadata = MetadataProvider(
        AvMetadata(
            code="ABF-386",
            title="ABF-386 Metadata",
            page_url="https://javbus.com/ABF-386",
            cover_url="https://images.example/abf.jpg",
            candidates=(_candidate("b", "JavBus fallback"),),
        )
    )

    result = asyncio.run(AvSearchService(resource, metadata).lookup("abf-386"))

    assert result.code == "ABF-386"
    assert result.title == "ABF-386 Metadata"
    assert result.page_url == "https://javbus.com/ABF-386"
    assert result.cover_url.endswith("abf.jpg")
    assert [item.btih for item in result.candidates] == ["a" * 32, "b" * 32]


def test_av_search_keeps_resources_when_javbus_is_unavailable() -> None:
    resource = ResourceProvider(
        SimpleNamespace(candidates=(_candidate("c", "Sukebei only"),))
    )
    metadata = MetadataProvider(error=ProviderError("JavBus unavailable"))

    result = asyncio.run(AvSearchService(resource, metadata).lookup("ABC-123"))

    assert result.code == "ABC-123"
    assert result.title == "Sukebei only"
    assert len(result.candidates) == 1


def test_av_search_uses_javbus_magnets_when_sukebei_is_unavailable() -> None:
    resource = ResourceProvider(error=ProviderError("Sukebei unavailable"))
    metadata = MetadataProvider(
        AvMetadata(
            code="ABC-123",
            title="Metadata fallback",
            page_url="https://javbus.com/ABC-123",
            cover_url="",
            candidates=(_candidate("d", "JavBus magnet"),),
        )
    )

    result = asyncio.run(AvSearchService(resource, metadata).lookup("ABC-123"))

    assert result.title == "Metadata fallback"
    assert result.candidates[0].btih == "d" * 32


def test_av_search_fails_only_when_both_sources_fail() -> None:
    service = AvSearchService(
        ResourceProvider(error=ProviderError("resource")),
        MetadataProvider(error=ProviderError("metadata")),
    )

    with pytest.raises(ProviderError):
        asyncio.run(service.lookup("ABC-123"))
