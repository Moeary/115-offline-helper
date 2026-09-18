"""Replaceable metadata providers used by the Telegram command handler."""

from .base import AvMetadata, MagnetCandidate, ProviderError
from .javbus import JavBusProvider

__all__ = [
    "AvMetadata",
    "MagnetCandidate",
    "ProviderError",
    "JavBusProvider",
]
