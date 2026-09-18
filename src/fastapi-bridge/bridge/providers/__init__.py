"""Replaceable metadata providers used by the Telegram command handler."""

from .base import AvMetadata, MagnetCandidate, ProviderError
from .javbus import JavBusProvider
from .nyaa import NyaaProvider, NyaaRSSProvider, NyaaRssProvider, NyaaSearchResult

__all__ = [
    "AvMetadata",
    "MagnetCandidate",
    "ProviderError",
    "JavBusProvider",
    "NyaaRssProvider",
    "NyaaProvider",
    "NyaaRSSProvider",
    "NyaaSearchResult",
]
