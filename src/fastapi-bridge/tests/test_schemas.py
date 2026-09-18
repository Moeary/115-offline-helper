from __future__ import annotations

import pytest

from bridge.schemas import ActionEventRequest, DirectoryRegistryRequest, IntentModel


def test_intent_accepts_magnet_and_canonical_generic_route() -> None:
    intent = IntentModel.model_validate(
        {
            "jobId": "magnet-job",
            "sourceSite": "generic",
            "mediaType": "generic",
            "processorProfile": "generic",
            "url": " magnet:?xt=urn:btih:" + "a" * 32 + " ",
        }
    )
    assert intent.link_type == "magnet"
    assert intent.source_site == "generic"


def test_intent_accepts_standard_base32_btih() -> None:
    intent = IntentModel.model_validate(
        {
            "jobId": "base32-job",
            "url": "magnet:?xt=urn:btih:" + "27" * 16,
        }
    )
    assert intent.link_type == "magnet"


def test_intent_accepts_magnet_expected_hash_up_to_128_hex_chars() -> None:
    expected_hash = "0123456789abcdef" * 2 + "01234567"
    assert len(expected_hash) == 40
    intent = IntentModel.model_validate(
        {
            "jobId": "magnet-hash-job",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "expectedHash": expected_hash,
        }
    )
    assert intent.expected_hash == expected_hash


def test_intent_derives_ed2k_fields_after_decoding_filename() -> None:
    intent = IntentModel.model_validate(
        {
            "jobId": "ed2k-job",
            "sourceSite": "southplus",
            "mediaType": "jav",
            "processorProfile": "jav",
            "code": "abc123",
            "url": "ed2k://|file|ABC-123%20demo.mkv|123|" + "b" * 32 + "|/",
        }
    )
    assert intent.link_type == "ed2k"
    assert intent.expected_name == "ABC-123 demo.mkv"
    assert intent.expected_size == 123
    assert intent.expected_hash == "b" * 32
    assert intent.code == "ABC-123"


@pytest.mark.parametrize(
    "payload",
    [
        {
            "jobId": "bad-ed2k",
            "url": "ed2k://|file|name.mkv|not-size|" + "a" * 32 + "|/",
        },
        {
            "jobId": "bad-ed2k",
            "url": "ed2k://|server|host|4662|/",
        },
        {
            "jobId": "bad-metadata",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"access_token": "secret"},
        },
        {
            "jobId": "bad-metadata-camel-case",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"nested": {"accessToken": "secret"}},
        },
        {
            "jobId": "bad-metadata-cookie-camel-case",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"nested": {"cookieJar": "secret"}},
        },
        {
            "jobId": "bad-metadata-authorization-camel-case",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"nested": {"authorizationValue": "secret"}},
        },
        {
            "jobId": "bad-metadata-auth-prefix",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"nested": {"authValue": "secret"}},
        },
        {
            "jobId": "bad-metadata-authentication-prefix",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"nested": {"authenticationValue": "secret"}},
        },
        {
            "jobId": "bad-metadata-auth-separator",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"nested": {"user_auth": "secret"}},
        },
        {
            "jobId": "bad-metadata-nonfinite",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"nested": {"score": float("nan")}},
        },
        {
            "jobId": "bad-metadata-infinity",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"nested": {"score": float("inf")}},
        },
        {
            "jobId": "bad-metadata-negative-infinity",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
            "metadata": {"nested": {"score": float("-inf")}},
        },
        {
            "jobId": "bad-magnet-unicode-btih",
            "url": "magnet:?xt=urn:btih:" + "K" + "a" * 31,
        },
        {
            "jobId": "bad-magnet-non-base32-btih",
            "url": "magnet:?xt=urn:btih:" + "0" * 32,
        },
        {
            "jobId": "bad-ed2k-percent-escape",
            "url": "ed2k://|file|name%ZZ.mkv|123|" + "a" * 32 + "|/",
        },
        {
            "jobId": "bad-ed2k-utf8",
            "url": "ed2k://|file|name%C3%28.mkv|123|" + "a" * 32 + "|/",
        },
        {
            "jobId": "bad-ed2k-del",
            "url": "ed2k://|file|name%7F.mkv|123|" + "a" * 32 + "|/",
        },
        {
            "jobId": "bad-source",
            "sourceSite": "SouthPlus",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
        },
        {
            "jobId": "bad-source",
            "sourceSite": "generic-",
            "url": "magnet:?xt=urn:btih:" + "a" * 32,
        },
    ],
)
def test_intent_rejects_malformed_links_sensitive_metadata_and_source_labels(payload) -> None:
    with pytest.raises(Exception):
        IntentModel.model_validate(payload)


def test_intent_rejects_mismatched_ed2k_declarations() -> None:
    with pytest.raises(Exception):
        IntentModel.model_validate(
            {
                "jobId": "mismatch",
                "sourceSite": "generic",
                "mediaType": "generic",
                "processorProfile": "generic",
                "url": "ed2k://|file|name.mkv|123|" + "c" * 32 + "|/",
                "expectedSize": 124,
            }
        )


@pytest.mark.parametrize(
    "key",
    [
        "clientAuth",
        "apiAuth",
        "secretValue",
        "passwordHash",
        "credentialId",
        "xHeader",
        "headersMap",
    ],
)
def test_intent_rejects_sensitive_metadata_substrings_case_insensitively(key: str) -> None:
    with pytest.raises(Exception):
        IntentModel.model_validate(
            {
                "jobId": "sensitive-metadata",
                "url": "magnet:?xt=urn:btih:" + "a" * 32,
                "metadata": {"nested": {key.swapcase(): "value"}},
            }
        )


def test_intent_rejects_ed2k_filename_that_would_bypass_name_limit() -> None:
    with pytest.raises(Exception):
        IntentModel.model_validate(
            {
                "jobId": "long-name",
                "sourceSite": "generic",
                "url": "ed2k://|file|" + ("a" * 1025) + "|1|" + "d" * 32 + "|/",
            }
        )


def test_intent_rejects_unicode_and_oversized_save_path_cids() -> None:
    base = {
        "jobId": "cid-validation",
        "url": "magnet:?xt=urn:btih:" + "a" * 32,
    }
    with pytest.raises(Exception):
        IntentModel.model_validate({**base, "savePathCid": "١٢٣"})
    with pytest.raises(Exception):
        IntentModel.model_validate({**base, "savePathCid": "1" * 65})
    accepted = IntentModel.model_validate({**base, "savePathCid": "1" * 64})
    assert accepted.save_path_cid == "1" * 64


def test_action_result_has_bounded_json_shape() -> None:
    accepted = ActionEventRequest.model_validate(
        {
            "leaseId": "lease",
            "eventId": "event",
            "state": "applied",
            "result": {"ok": True, "nested": [1, "two"]},
        }
    )
    assert accepted.result["ok"] is True
    with pytest.raises(Exception):
        ActionEventRequest.model_validate(
            {
                "leaseId": "lease",
                "eventId": "too-deep",
                "state": "applied",
                "result": {"a": {"b": {"c": {"d": {"e": {"f": {"g": 1}}}}}}},
            }
        )
    with pytest.raises(Exception):
        ActionEventRequest.model_validate(
            {
                "leaseId": "lease",
                "eventId": "too-many",
                "state": "applied",
                "result": {str(index): index for index in range(201)},
            }
        )


def _directory_registry(**overrides):
    payload = {
        "schema": 1,
        "revision": 1,
        "scannedAt": 1700000000000,
        "roots": ["0"],
        "directories": [
            {"cid": "0", "parentCid": None, "name": "根目录", "path": "/", "depth": 0},
            {"cid": "12", "parentCid": "0", "name": "影视", "path": "/影视", "depth": 1},
        ],
    }
    payload.update(overrides)
    return payload


def test_directory_registry_accepts_aliases_and_preserves_bounded_entries() -> None:
    registry = DirectoryRegistryRequest.model_validate(_directory_registry())
    assert registry.revision == 1
    assert registry.directories[1].parent_cid == "0"
    assert registry.model_dump(by_alias=True)["scannedAt"] == 1700000000000


@pytest.mark.parametrize(
    "payload",
    [
        _directory_registry(
            directories=[
                {"cid": "1", "name": "一", "path": "/同一路径", "depth": 0},
                {"cid": "2", "name": "二", "path": "/同一路径", "depth": 0},
            ]
        ),
        _directory_registry(
            directories=[
                {"cid": "1", "name": "一", "path": "/一", "depth": 0},
                {"cid": "1", "name": "二", "path": "/二", "depth": 0},
            ]
        ),
        _directory_registry(
            directories=[{"cid": "01", "name": "一", "path": "/一", "depth": 0}]
        ),
        _directory_registry(
            directories=[{"cid": "1", "name": "一", "path": "../一", "depth": 0}]
        ),
        _directory_registry(
            directories=[{"cid": "1", "name": "一", "path": "/一/../二", "depth": 0}]
        ),
    ],
)
def test_directory_registry_rejects_duplicate_or_unsafe_entries(payload) -> None:
    with pytest.raises(Exception):
        DirectoryRegistryRequest.model_validate(payload)


def test_directory_registry_rejects_oversized_input() -> None:
    with pytest.raises(Exception):
        DirectoryRegistryRequest.model_validate(
            _directory_registry(
                directories=[
                    {
                        "cid": str(index + 1),
                        "name": "目录",
                        "path": f"/目录{index}",
                        "depth": 0,
                    }
                    for index in range(5001)
                ]
            )
        )
