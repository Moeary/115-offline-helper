"""Bounded Nyaa RSS search provider.

The provider deliberately consumes RSS only.  It does not scrape result pages,
follow torrent download links, or maintain subscriptions.  A configured HTTPS
host allowlist and a byte limit protect the local bridge from an accidental or
malicious feed redirect.
"""

from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from urllib.parse import urlencode, urljoin, urlsplit

import httpx

from ..normalize import dedupe_key, extract_btih, is_magnet, valid_public_https_url
from .base import MagnetCandidate, ProviderError


_MAGNET_TEXT = re.compile(r"magnet:\?[^<>\s'\"`]+", re.IGNORECASE)
_MAX_KEYWORD = 256


@dataclass(frozen=True)
class NyaaSearchResult:
    """One bounded RSS lookup and its de-duplicated Magnet candidates."""

    keyword: str
    feed_url: str
    candidates: tuple[MagnetCandidate, ...]

    @property
    def results(self) -> tuple[MagnetCandidate, ...]:
        return self.candidates

    def __iter__(self):
        return iter(self.candidates)

    def __len__(self) -> int:
        return len(self.candidates)

    def __getitem__(self, index):
        return self.candidates[index]


def _local_name(tag: object) -> str:
    value = str(tag or "")
    return value.rsplit("}", 1)[-1].lower()


def _clean_text(value: object, limit: int = 512) -> str:
    value = html.unescape(str(value or ""))
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


class NyaaRssProvider:
    """Search a Nyaa-compatible RSS endpoint over a fixed HTTPS origin."""

    def __init__(
        self,
        base_url: str = "https://nyaa.si",
        *,
        allowed_hosts: set[str] | frozenset[str] | None = None,
        timeout_seconds: float = 15.0,
        max_response_bytes: int = 2_000_000,
        max_results: int = 20,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        parsed = urlsplit(str(base_url or "").rstrip("/"))
        if (
            parsed.scheme.lower() != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Nyaa base URL 必须是无凭据的 HTTPS 地址")
        self.base_url = str(base_url).rstrip("/")
        self.base_host = parsed.hostname.lower().rstrip(".")
        self.allowed_hosts = {
            str(host).lower().rstrip(".")
            for host in (allowed_hosts or {self.base_host})
            if str(host).strip()
        }
        self.allowed_hosts.add(self.base_host)
        if self.base_host in {"nyaa.si", "www.nyaa.si"}:
            self.allowed_hosts.update({"nyaa.si", "www.nyaa.si"})
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 60.0))
        self.max_response_bytes = max(1, min(int(max_response_bytes), 8_000_000))
        self.max_results = max(1, min(int(max_results), 100))
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout_seconds),
            follow_redirects=False,
            headers={
                "User-Agent": "115-Offline-Helper local bridge/0.1 (Nyaa RSS)",
                "Accept": "application/rss+xml, application/xml, text/xml",
            },
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    def _validate_allowed_url(self, value: str) -> str:
        parsed = urlsplit(str(value or ""))
        host = (parsed.hostname or "").lower().rstrip(".")
        if (
            parsed.scheme.lower() != "https"
            or not host
            or host not in self.allowed_hosts
            or parsed.username
            or parsed.password
            or not valid_public_https_url(value)
        ):
            raise ProviderError("Nyaa URL 不在允许的 HTTPS 来源内")
        return str(value)

    def feed_url(self, keyword: str) -> str:
        keyword = self._keyword(keyword)
        # Nyaa's RSS mode is selected by page=rss.  No page number or
        # subscription state is accepted by this first search implementation.
        return f"{self.base_url}/?{urlencode({'page': 'rss', 'f': '0', 'c': '1_0', 'q': keyword})}"

    @staticmethod
    def _keyword(value: object) -> str:
        keyword = _clean_text(value, _MAX_KEYWORD + 1)
        if not keyword:
            raise ProviderError("Nyaa 搜索关键词不能为空")
        if len(keyword) > _MAX_KEYWORD:
            raise ProviderError("Nyaa 搜索关键词过长")
        return keyword

    async def _get(self, url: str) -> bytes:
        current = self._validate_allowed_url(url)
        for _ in range(3):
            stream = getattr(self.client, "stream", None)
            if callable(stream):
                try:
                    context = stream(
                        "GET",
                        current,
                        follow_redirects=False,
                    )
                except TypeError:
                    context = stream("GET", current)
                try:
                    async with context as response:
                        status = int(getattr(response, "status_code", 0) or 0)
                        if 300 <= status < 400:
                            location = getattr(response, "headers", {}).get("location")
                            if not location:
                                raise ProviderError("Nyaa 返回了无目标的重定向")
                            current = self._validate_allowed_url(urljoin(current, location))
                            continue
                        if status < 200 or status >= 300:
                            raise ProviderError(f"Nyaa 请求失败（HTTP {status}）")
                        headers = getattr(response, "headers", {}) or {}
                        try:
                            if int(headers.get("content-length", 0) or 0) > self.max_response_bytes:
                                raise ProviderError("Nyaa RSS 响应超过大小限制")
                        except (TypeError, ValueError):
                            pass
                        chunks: list[bytes] = []
                        total = 0
                        iterator = getattr(response, "aiter_bytes", None)
                        if callable(iterator):
                            async for chunk in iterator():
                                data = bytes(chunk)
                                total += len(data)
                                if total > self.max_response_bytes:
                                    raise ProviderError("Nyaa RSS 响应超过大小限制")
                                chunks.append(data)
                        else:
                            data = bytes(getattr(response, "content", b"") or b"")
                            if len(data) > self.max_response_bytes:
                                raise ProviderError("Nyaa RSS 响应超过大小限制")
                            chunks.append(data)
                        final_url = str(getattr(response, "url", current) or current)
                        self._validate_allowed_url(final_url)
                        return b"".join(chunks)
                except ProviderError:
                    raise
                except Exception as error:
                    raise ProviderError("Nyaa RSS 请求失败") from error
                continue
            try:
                response = await self.client.get(current, follow_redirects=False)
            except TypeError:
                response = await self.client.get(current)
            except Exception as error:
                raise ProviderError("Nyaa RSS 请求失败") from error
            status = int(getattr(response, "status_code", 0) or 0)
            if 300 <= status < 400:
                location = getattr(response, "headers", {}).get("location")
                if not location:
                    raise ProviderError("Nyaa 返回了无目标的重定向")
                current = self._validate_allowed_url(urljoin(current, location))
                continue
            if status < 200 or status >= 300:
                raise ProviderError(f"Nyaa 请求失败（HTTP {status}）")
            headers = getattr(response, "headers", {}) or {}
            try:
                if int(headers.get("content-length", 0) or 0) > self.max_response_bytes:
                    raise ProviderError("Nyaa RSS 响应超过大小限制")
            except (TypeError, ValueError):
                pass
            content = getattr(response, "content", None)
            data = bytes(content or b"") if content is not None else str(getattr(response, "text", "") or "").encode()
            if len(data) > self.max_response_bytes:
                raise ProviderError("Nyaa RSS 响应超过大小限制")
            final_url = str(getattr(response, "url", current) or current)
            self._validate_allowed_url(final_url)
            return data
        raise ProviderError("Nyaa 重定向次数过多")

    def _detail_url(self, value: object) -> str:
        value = _clean_text(value, 2048)
        if not value:
            return ""
        try:
            return self._validate_allowed_url(value)
        except ProviderError:
            return ""

    @classmethod
    def parse_feed(
        cls,
        source: bytes | str,
        *,
        keyword: str = "",
        feed_url: str = "",
        max_results: int = 20,
        provider: "NyaaRssProvider | None" = None,
    ) -> NyaaSearchResult:
        data = source.encode("utf-8") if isinstance(source, str) else bytes(source)
        if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
            raise ProviderError("Nyaa RSS XML 类型声明被拒绝")
        try:
            root = ET.fromstring(data)
        except (ET.ParseError, ValueError) as error:
            raise ProviderError("Nyaa RSS 返回格式无效") from error
        candidates: list[MagnetCandidate] = []
        seen: set[str] = set()
        cap = max(1, min(int(max_results), 100))
        for item in [element for element in root.iter() if _local_name(element.tag) == "item"]:
            values: list[str] = []
            info_hashes: list[str] = []
            title = ""
            guid = ""
            link = ""
            for child in item.iter():
                name = _local_name(child.tag)
                text = html.unescape(str(child.text or "")).strip()
                attributes = [str(value) for value in getattr(child, "attrib", {}).values()]
                if name == "title" and not title:
                    title = _clean_text(text)
                elif name == "guid" and not guid:
                    guid = _clean_text(text, 2048)
                elif name == "link" and not link:
                    link = _clean_text(text, 2048)
                elif name == "infohash":
                    info_hash = _clean_text(text, 64).lower()
                    if re.fullmatch(r"[0-9a-f]{40}", info_hash):
                        info_hashes.append(info_hash)
                if name in {"magnet", "magneturl", "magneturi", "magnetlink", "link", "description"}:
                    values.extend([text, *attributes])
            values.append(ET.tostring(item, encoding="unicode"))
            magnets: list[str] = []
            for value in values:
                for match in _MAGNET_TEXT.finditer(html.unescape(value)):
                    magnet = html.unescape(match.group(0)).strip()
                    if is_magnet(magnet):
                        magnets.append(magnet)
            magnets.extend(
                f"magnet:?xt=urn:btih:{info_hash}"
                for info_hash in info_hashes
            )
            detail_url = ""
            if provider is not None:
                detail_url = provider._detail_url(guid) or provider._detail_url(link)
            else:
                detail_url = guid or link
            for magnet in magnets:
                btih = extract_btih(magnet)
                key = dedupe_key(magnet)
                if not btih or key in seen:
                    continue
                seen.add(key)
                candidates.append(
                    MagnetCandidate(
                        url=magnet,
                        title=title or _clean_text(keyword) or "Nyaa torrent",
                        btih=btih,
                        dedupe_key=key,
                        guid=guid,
                        detail_url=detail_url,
                    )
                )
                if len(candidates) >= cap:
                    break
            if len(candidates) >= cap:
                break
        return NyaaSearchResult(
            keyword=_clean_text(keyword, _MAX_KEYWORD),
            feed_url=str(feed_url or ""),
            candidates=tuple(candidates),
        )

    async def search(self, keyword: str) -> NyaaSearchResult:
        keyword = self._keyword(keyword)
        url = self.feed_url(keyword)
        source = await self._get(url)
        return self.parse_feed(
            source,
            keyword=keyword,
            feed_url=url,
            max_results=self.max_results,
            provider=self,
        )

    async def lookup(self, keyword: str) -> NyaaSearchResult:
        """Alias matching the metadata provider interface used by `/av`."""

        return await self.search(keyword)


NyaaProvider = NyaaRssProvider
NyaaRSSProvider = NyaaRssProvider

__all__ = ["NyaaProvider", "NyaaRSSProvider", "NyaaRssProvider", "NyaaSearchResult"]
