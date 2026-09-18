"""Provider data contracts independent of any HTTP or Telegram library."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class ProviderError(RuntimeError):
    """A safe provider failure with no response body or credential details."""


@dataclass(frozen=True)
class MagnetCandidate:
    url: str
    title: str
    btih: str
    dedupe_key: str

    def as_dict(self) -> dict[str, str]:
        return {
            "url": self.url,
            "title": self.title,
            "btih": self.btih,
            "dedupeKey": self.dedupe_key,
        }


@dataclass(frozen=True)
class AvMetadata:
    code: str
    title: str
    page_url: str
    cover_url: str
    candidates: tuple[MagnetCandidate, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "code": self.code,
            "title": self.title,
            "pageUrl": self.page_url,
            "coverUrl": self.cover_url,
            "candidates": [candidate.as_dict() for candidate in self.candidates],
        }


class AvProvider(Protocol):
    async def lookup(self, code: str) -> AvMetadata:
        ...
