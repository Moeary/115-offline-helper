from __future__ import annotations

from bridge.auth import authenticate, extract_bearer_token, token_matches


def test_bearer_header_is_strict_and_constant_time_compatible() -> None:
    token = "a" * 32
    assert extract_bearer_token(f"  Bearer {token}  ") == token
    assert authenticate(f"Bearer {token}", token)
    assert token_matches(token, token)
    assert not authenticate(None, token)
    assert not authenticate("Basic abc", token)
    assert not authenticate(f"Bearer {token} extra", token)
