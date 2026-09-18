"""Authentication helpers for the loopback bridge.

The extension sends a bearer token over the fixed loopback HTTP endpoint.  The
bridge keeps the comparison in one small module so route handlers never need
to manipulate or log the token themselves.
"""

from __future__ import annotations

import hmac
from typing import Final


AUTH_SCHEME: Final[str] = "Bearer"


class AuthenticationError(ValueError):
    """Raised when an Authorization header is missing or malformed."""


def extract_bearer_token(authorization: str | None) -> str:
    """Return the token from a strict ``Authorization: Bearer`` header.

    Whitespace around the header is accepted, while extra words, embedded
    whitespace, and an empty token are rejected.  The raw value is never
    included in an exception message.
    """

    value = str(authorization or "").strip()
    scheme, separator, token = value.partition(" ")
    if not separator or scheme.lower() != AUTH_SCHEME.lower():
        raise AuthenticationError("需要 Bearer Authorization")
    token = token.strip()
    if not token or any(character.isspace() for character in token):
        raise AuthenticationError("Bearer token 格式无效")
    return token


def token_matches(candidate: str | None, expected: str) -> bool:
    """Compare two tokens in constant time, including length differences."""

    left = str(candidate or "").encode("utf-8")
    right = str(expected or "").encode("utf-8")
    return hmac.compare_digest(left, right)


def authenticate(authorization: str | None, expected: str) -> bool:
    """Validate a bearer header without exposing the configured secret."""

    try:
        candidate = extract_bearer_token(authorization)
    except AuthenticationError:
        return False
    return token_matches(candidate, expected)
