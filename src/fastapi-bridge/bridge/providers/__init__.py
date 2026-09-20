"""Replaceable metadata providers used by the Telegram command handler."""

from .base import AvMetadata, MagnetCandidate, ProviderError
from .av_search import AvSearchService
from .javbus import JavBusProvider
from .nyaa import (
    NyaaCompatibleRssProvider,
    NyaaProvider,
    NyaaRSSProvider,
    NyaaRssProvider,
    NyaaSearchResult,
    SukebeiRssProvider,
)

__all__ = [
    "AvMetadata",
    "MagnetCandidate",
    "ProviderError",
    "AvSearchService",
    "JavBusProvider",
    "NyaaCompatibleRssProvider",
    "NyaaRssProvider",
    "NyaaProvider",
    "NyaaRSSProvider",
    "NyaaSearchResult",
    "SukebeiRssProvider",
]
