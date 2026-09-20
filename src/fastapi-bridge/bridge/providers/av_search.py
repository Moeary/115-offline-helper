"""Aggregate AV resource and metadata lookups.

AV search deliberately has two independent concerns: Sukebei/Nyaa-compatible
feeds are the primary resource index, while JavBus is a best-effort metadata
source and a secondary magnet fallback.  Keeping that policy here prevents
the Telegram handler from coupling itself to one provider or making a
metadata outage look like a resource-search outage.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from typing import Any

from ..normalize import dedupe_key, is_magnet, normalize_exact_code
from .base import AvMetadata, MagnetCandidate, ProviderError


def _field(value: object, name: str, default: Any = "") -> Any:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _candidate_values(value: object) -> list[object]:
    candidates = _field(value, "candidates", ())
    if not isinstance(candidates, Sequence) or isinstance(
        candidates, (str, bytes, bytearray)
    ):
        return []
    return list(candidates)


class AvSearchService:
    """Combine a primary resource provider with optional JavBus metadata."""

    def __init__(
        self,
        resource_provider: Any | None,
        metadata_provider: Any | None = None,
    ) -> None:
        self.resource_provider = resource_provider
        self.metadata_provider = metadata_provider

    async def aclose(self) -> None:
        """Close owned provider clients without closing the same object twice."""

        seen: set[int] = set()
        for provider in (self.resource_provider, self.metadata_provider):
            if provider is None or id(provider) in seen:
                continue
            seen.add(id(provider))
            close = getattr(provider, "aclose", None)
            if callable(close):
                await close()

    @staticmethod
    async def _invoke(provider: Any, *, resource: bool, code: str) -> object:
        if provider is None:
            return None
        method_name = "search" if resource else "lookup"
        method = getattr(provider, method_name, None)
        if not callable(method) and resource:
            method = getattr(provider, "lookup", None)
        if not callable(method):
            raise ProviderError("AV provider 未提供可用的查询接口")
        try:
            return await method(code)
        except ProviderError:
            raise
        except Exception as error:
            raise ProviderError("AV provider 请求失败") from error

    @staticmethod
    def _result_details(
        value: object,
        *,
        code: str,
        fallback_title: str = "",
    ) -> tuple[str, str, str, str, list[object]]:
        actual_code = normalize_exact_code(_field(value, "code")) or code
        title = str(_field(value, "title") or fallback_title or "").strip()[:512]
        page_url = str(
            _field(
                value,
                "page_url",
                _field(value, "pageUrl", _field(value, "feed_url", _field(value, "feedUrl"))),
            )
            or ""
        ).strip()[:2048]
        cover_url = str(
            _field(value, "cover_url", _field(value, "coverUrl")) or ""
        ).strip()[:2048]
        candidates = _candidate_values(value)
        return actual_code, title, page_url, cover_url, candidates

    @staticmethod
    def _merge_candidates(*groups: Sequence[object]) -> tuple[MagnetCandidate, ...]:
        merged: list[MagnetCandidate] = []
        seen: set[str] = set()
        for group in groups:
            for raw in group:
                url = str(_field(raw, "url") or "").strip()
                if not is_magnet(url):
                    continue
                # Recompute from the validated Magnet so the two providers
                # share one cross-source identity even if their display
                # metadata uses different dedupe-key conventions.
                key = dedupe_key(url)
                if key in seen:
                    continue
                seen.add(key)
                if isinstance(raw, MagnetCandidate):
                    merged.append(raw)
                    continue
                merged.append(
                    MagnetCandidate(
                        url=url,
                        title=str(_field(raw, "title") or "").strip()[:512],
                        btih=str(_field(raw, "btih") or "").strip().lower(),
                        dedupe_key=key,
                        guid=str(_field(raw, "guid") or "").strip()[:2048],
                        detail_url=str(
                            _field(raw, "detail_url", _field(raw, "detailUrl", ""))
                            or ""
                        ).strip()[:2048],
                    )
                )
        return tuple(merged)

    async def lookup(self, code: str) -> AvMetadata:
        normalized = normalize_exact_code(code)
        if not normalized:
            raise ProviderError("无法识别番号")
        if self.resource_provider is None and self.metadata_provider is None:
            raise ProviderError("AV provider 未配置")

        resource_result, metadata_result = await asyncio.gather(
            self._invoke(self.resource_provider, resource=True, code=normalized),
            self._invoke(self.metadata_provider, resource=False, code=normalized),
            return_exceptions=True,
        )
        if isinstance(resource_result, asyncio.CancelledError):
            raise resource_result
        if isinstance(metadata_result, asyncio.CancelledError):
            raise metadata_result
        resource_error = isinstance(resource_result, Exception)
        metadata_error = isinstance(metadata_result, Exception)
        if resource_error and metadata_error:
            raise ProviderError("AV 资源暂时不可用")

        resource_code, resource_title, resource_url, _resource_cover, resource_candidates = (
            self._result_details(resource_result, code=normalized)
            if not resource_error and resource_result is not None
            else (normalized, "", "", "", [])
        )
        metadata_code, metadata_title, metadata_url, metadata_cover, metadata_candidates = (
            self._result_details(metadata_result, code=normalized)
            if not metadata_error and metadata_result is not None
            else (normalized, "", "", "", [])
        )
        candidates = self._merge_candidates(resource_candidates, metadata_candidates)
        title = metadata_title or resource_title
        if not title:
            title = next(
                (
                    str(_field(candidate, "title") or "").strip()
                    for candidate in resource_candidates + metadata_candidates
                    if str(_field(candidate, "title") or "").strip()
                ),
                normalized,
            )
        return AvMetadata(
            code=metadata_code or resource_code or normalized,
            title=title[:512],
            page_url=metadata_url or resource_url,
            cover_url=metadata_cover,
            candidates=candidates,
        )


__all__ = ["AvSearchService"]
