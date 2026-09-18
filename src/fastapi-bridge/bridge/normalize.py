"""Small, dependency-free normalization helpers shared by the bridge."""

from __future__ import annotations

import hashlib
import ipaddress
import re
from urllib.parse import parse_qs, unquote, urlsplit


INVALID_CODE_PREFIXES = frozenset(
    {
        "FULL",
        "H264",
        "HEVC",
        "MP4",
        "AVI",
        "MKV",
        "WMV",
        "JPG",
        "PNG",
        "COM",
        "NET",
        "WWW",
        "JAV",
        "HD",
        "FHD",
        "RESTORE",
        "UNCENSORED",
        "CHINESE",
        "ARCHIVE",
        "XXX",
    }
)

_FC2_PATTERN = re.compile(r"\b(FC2-(?:PPV-)?\d{5,7})\b", re.IGNORECASE)
_GENERAL_CODE_PATTERN = re.compile(
    r"\b([A-Z]{2,6})[-\s]?(\d{2,5})(?:[-\s]?([A-Z]))?\b",
    re.IGNORECASE,
)
_EXACT_CODE_INPUT = re.compile(r"^[A-Z0-9]+(?:[-_.\s][A-Z0-9]+)*$", re.IGNORECASE)
_NORMALIZED_CODE = re.compile(
    r"^(?:FC2-(?:PPV-)?\d{5,7}|[A-Z]{2,6}-\d{2,5}(?:-[A-Z])?)$"
)
_ED2K_PATTERN = re.compile(
    r"^ed2k://\|file\|([^|]*)\|([0-9]+)\|([0-9a-f]{32})\|/\s*$",
    re.IGNORECASE,
)


def normalize_code(value: object) -> str:
    """Return the same conservative code shape used by the extension."""

    text = str(value or "").upper()
    text = re.sub(r"\.[^.]+$", "", text)
    text = re.sub(r"[\[\]【】()]", " ", text)
    text = re.sub(r"[@_.]", "-", text)

    fc2 = _FC2_PATTERN.search(text)
    if fc2:
        return fc2.group(1).upper()

    # Keep looking after a generic word such as JAV, FULL or HD. This mirrors
    # the extension's candidate scan and lets a title like "JAV FULL ABC-123"
    # still resolve to ABC-123.
    for general in _GENERAL_CODE_PATTERN.finditer(text):
        if general.group(1).upper() in INVALID_CODE_PREFIXES:
            continue
        suffix = f"-{general.group(3).upper()}" if general.group(3) else ""
        return f"{general.group(1).upper()}-{general.group(2)}{suffix}"
    return ""


def normalize_exact_code(value: object) -> str:
    """Normalize one command argument, rejecting surrounding free text."""

    raw = str(value or "").strip()
    if not _EXACT_CODE_INPUT.fullmatch(raw):
        return ""
    normalized = normalize_code(raw)
    return normalized if _NORMALIZED_CODE.fullmatch(normalized) else ""


def extract_btih(url: object) -> str:
    try:
        parsed = urlsplit(str(url or "").strip())
    except ValueError:
        return ""
    if parsed.scheme.lower() != "magnet":
        return ""
    for value in parse_qs(parsed.query, keep_blank_values=True).get("xt", []):
        # Keep the wire contract ASCII-only.  Python's Unicode-aware
        # IGNORECASE can make ranges such as ``[a-z]`` match non-ASCII
        # lookalikes, which are not valid BTIH text.
        match = re.fullmatch(
            r"urn:btih:([A-Za-z2-7]{32}|[A-Fa-f0-9]{40})", value
        )
        if match:
            return match.group(1).lower()
    return ""


def is_magnet(url: object) -> bool:
    value = str(url or "").strip()
    return value.lower().startswith("magnet:?") and bool(extract_btih(value))


def parse_ed2k(url: object) -> dict[str, object] | None:
    """Parse one strict ED2K file link and return canonical file metadata."""

    value = str(url or "").strip()
    match = _ED2K_PATTERN.fullmatch(value)
    if not match:
        return None
    try:
        encoded_name = match.group(1)
        if re.search(r"%(?![0-9a-fA-F]{2})", encoded_name):
            return None
        try:
            file_name = unquote(encoded_name, errors="strict").strip()
        except UnicodeDecodeError:
            return None
        size = int(match.group(2), 10)
    except (TypeError, ValueError):
        return None
    if not file_name or "|" in file_name or any(
        ord(char) < 0x20 or ord(char) == 0x7F for char in file_name
    ):
        return None
    if size < 0 or size > 2**63 - 1:
        return None
    return {
        "linkType": "ed2k",
        "fileName": file_name,
        "size": size,
        "hash": match.group(3).lower(),
    }


def is_ed2k(url: object) -> bool:
    return parse_ed2k(url) is not None


def link_type(url: object) -> str:
    if is_magnet(url):
        return "magnet"
    if is_ed2k(url):
        return "ed2k"
    return ""


def dedupe_key(url: object) -> str:
    value = str(url or "").strip()
    btih = extract_btih(value)
    if btih:
        return f"btih:{btih}"
    return f"url:{value}"


def opaque_key(value: object) -> str:
    """Stable non-secret key for candidates without a BTIH."""

    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def valid_public_https_url(value: object) -> bool:
    """Reject local/private URL targets before any server-side fetch."""

    try:
        parsed = urlsplit(str(value or "").strip())
    except ValueError:
        return False
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        return False
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname in {"localhost", "localhost.localdomain"}:
        return False
    try:
        address = ipaddress.ip_address(hostname.strip("[]"))
    except ValueError:
        address = None
    if address is not None:
        # A public IP is intentionally rejected too: providers should use a
        # named HTTPS allowlist, never an arbitrary IP target.
        return False
    return True
