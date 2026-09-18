"""JavBus metadata and magnet provider.

JavBus pages in the wild can render an empty magnet container and populate it
with an AJAX response. The provider follows the page's numeric gid/uc values
to the fixed same-origin uncledatoolsbyajax.php endpoint. It does not bypass
challenge pages, rotate identities, or follow redirects outside the configured
JavBus host allowlist.
"""

from __future__ import annotations

import html as html_module
import re
from collections.abc import Mapping
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup

from ..normalize import (
    dedupe_key,
    extract_btih,
    is_magnet,
    normalize_code,
    valid_public_https_url,
)
from .base import AvMetadata, MagnetCandidate, ProviderError


_AJAX_KEYS = ("gid", "uc", "lang", "img")
_AJAX_VALUE = r'''['"]?([^'";,\s<]+)'''
_MAGNET_TEXT = re.compile(r'''magnet:\?[^<>\s'"\x60]+''', re.IGNORECASE)


class JavBusProvider:
    def __init__(
        self,
        base_url: str = "https://javbus.com",
        *,
        allowed_hosts: set[str] | frozenset[str] | None = None,
        timeout_seconds: float = 15.0,
        max_response_bytes: int = 2_000_000,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        parsed = urlsplit(base_url.rstrip("/"))
        if parsed.scheme.lower() != "https" or not parsed.hostname:
            raise ValueError("JavBus base URL 必须是 HTTPS")
        self.base_url = base_url.rstrip("/")
        self.base_host = parsed.hostname.lower().rstrip(".")
        self.allowed_hosts = {
            str(host).lower().rstrip(".")
            for host in (allowed_hosts or {self.base_host})
        }
        self.allowed_hosts.add(self.base_host)
        # JavBus commonly redirects its apex host to www.  Both hosts are
        # explicit, fixed provider origins; custom test/deployment hosts keep
        # the caller-supplied allowlist unchanged.
        if self.base_host in {"javbus.com", "www.javbus.com"}:
            self.allowed_hosts.update({"javbus.com", "www.javbus.com"})
        self.timeout_seconds = float(timeout_seconds)
        self.max_response_bytes = int(max_response_bytes)
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout_seconds),
            follow_redirects=False,
            headers={
                "User-Agent": (
                    "115-Offline-Helper local bridge/"
                    "0.1 (+JavBus metadata lookup)"
                ),
                "Accept": "text/html,application/xhtml+xml",
            },
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    def _validate_allowed_url(self, value: str) -> str:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if (
            parsed.scheme.lower() != "https"
            or not host
            or host not in self.allowed_hosts
            or parsed.username
            or parsed.password
            or not valid_public_https_url(value)
        ):
            raise ProviderError("JavBus URL 不在允许的 HTTPS 来源内")
        return value

    async def _get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> tuple[httpx.Response, str]:
        current = self._validate_allowed_url(url)
        current_params = dict(params or {})
        for _ in range(3):
            stream = getattr(self.client, "stream", None)
            if callable(stream):
                try:
                    context = stream(
                        "GET",
                        current,
                        params=current_params,
                        headers=dict(headers or {}),
                        follow_redirects=False,
                    )
                except TypeError:
                    context = stream(
                        "GET",
                        current,
                        params=current_params,
                        headers=dict(headers or {}),
                    )
                try:
                    async with context as response:
                        status = int(getattr(response, "status_code", 0))
                        if 300 <= status < 400:
                            location = getattr(response, "headers", {}).get("location")
                            if not location:
                                raise ProviderError("JavBus 返回了无目标的重定向")
                            current = self._validate_allowed_url(
                                urljoin(current, location)
                            )
                            current_params = {}
                            continue
                        if status < 200 or status >= 300:
                            if status in {401, 403, 429}:
                                raise ProviderError(f"JavBus 暂拒绝请求（HTTP {status}）")
                            raise ProviderError(f"JavBus 请求失败（HTTP {status}）")
                        content_length = getattr(response, "headers", {}).get(
                            "content-length"
                        )
                        try:
                            if content_length and int(content_length) > self.max_response_bytes:
                                raise ProviderError("JavBus 响应超过大小限制")
                        except (TypeError, ValueError):
                            pass
                        chunks: list[bytes] = []
                        total = 0
                        aiter_bytes = getattr(response, "aiter_bytes", None)
                        if callable(aiter_bytes):
                            async for chunk in aiter_bytes():
                                data = bytes(chunk)
                                total += len(data)
                                if total > self.max_response_bytes:
                                    raise ProviderError("JavBus 响应超过大小限制")
                                chunks.append(data)
                        else:
                            data = bytes(getattr(response, "content", b"") or b"")
                            if len(data) > self.max_response_bytes:
                                raise ProviderError("JavBus 响应超过大小限制")
                            chunks.append(data)
                        final_url = str(getattr(response, "url", current) or current)
                        self._validate_allowed_url(final_url)
                        return (
                            httpx.Response(
                                status,
                                headers=dict(getattr(response, "headers", {}) or {}),
                                content=b"".join(chunks),
                                request=getattr(response, "request", None),
                            ),
                            final_url,
                        )
                except ProviderError:
                    raise
                except Exception as error:
                    raise ProviderError("JavBus 请求失败") from error
                # Redirects continue inside the context manager.  The loop
                # reaches the next iteration after the response is closed.
                continue
            try:
                response = await self.client.get(
                    current,
                    params=current_params,
                    headers=dict(headers or {}),
                    follow_redirects=False,
                )
            except TypeError:
                # Small fake clients used by tests may not expose the
                # follow_redirects keyword.
                response = await self.client.get(
                    current,
                    params=current_params,
                    headers=dict(headers or {}),
                )
            status = int(getattr(response, "status_code", 0))
            if 300 <= status < 400:
                location = getattr(response, "headers", {}).get("location")
                if not location:
                    raise ProviderError("JavBus 返回了无目标的重定向")
                current = self._validate_allowed_url(urljoin(current, location))
                current_params = {}
                continue
            if status < 200 or status >= 300:
                if status in {401, 403, 429}:
                    raise ProviderError(f"JavBus 暂拒绝请求（HTTP {status}）")
                raise ProviderError(f"JavBus 请求失败（HTTP {status}）")
            final_url = str(getattr(response, "url", current) or current)
            self._validate_allowed_url(final_url)
            return response, final_url
        raise ProviderError("JavBus 重定向次数过多")

    def _response_text(self, response: httpx.Response) -> str:
        content_length = getattr(response, "headers", {}).get("content-length")
        try:
            if content_length and int(content_length) > self.max_response_bytes:
                raise ProviderError("JavBus 响应超过大小限制")
        except (TypeError, ValueError):
            pass
        content = getattr(response, "content", None)
        if isinstance(content, bytes):
            if len(content) > self.max_response_bytes:
                raise ProviderError("JavBus 响应超过大小限制")
            return content.decode("utf-8", errors="replace")
        text = str(getattr(response, "text", "") or "")
        if len(text.encode("utf-8")) > self.max_response_bytes:
            raise ProviderError("JavBus 响应超过大小限制")
        return text

    @staticmethod
    def _script_text(soup: BeautifulSoup) -> str:
        return "\n".join(
            str(script.string or script.get_text() or "")
            for script in soup.find_all("script")
        )

    @staticmethod
    def _ajax_parameters(source: str) -> dict[str, str]:
        values: dict[str, str] = {}
        for key in _AJAX_KEYS:
            pattern = re.compile(
                rf"(?:\b(?:var|let|const)\s+)?\b{key}\b\s*=\s*{_AJAX_VALUE}",
                re.IGNORECASE,
            )
            match = pattern.search(source)
            if match:
                value = match.group(1).strip()
                if key in {"gid", "uc"} and not value.isdigit():
                    continue
                if key == "lang" and not re.fullmatch(r"[A-Za-z_-]{1,16}", value):
                    continue
                values[key] = value
        return values

    @staticmethod
    def _first_text(soup: BeautifulSoup, selectors: tuple[str, ...]) -> str:
        for selector in selectors:
            element = soup.select_one(selector)
            if not element:
                continue
            if element.name == "meta":
                value = element.get("content", "")
            else:
                value = element.get_text(" ", strip=True)
            value = re.sub(r"\s+", " ", str(value or "")).strip()
            if value:
                return value[:512]
        return ""

    @staticmethod
    def _cover_url(soup: BeautifulSoup, page_url: str) -> str:
        candidates: list[str] = []
        for selector in (
            "meta[property='og:image']",
            "meta[name='twitter:image']",
            ".bigImage img",
            "img#bigImage",
        ):
            element = soup.select_one(selector)
            if not element:
                continue
            if element.name == "meta":
                candidates.append(str(element.get("content", "")))
            else:
                candidates.extend(
                    str(element.get(name, ""))
                    for name in ("src", "data-src", "data-original")
                )
        for candidate in candidates:
            value = urljoin(page_url, html_module.unescape(candidate).strip())
            if valid_public_https_url(value):
                return value[:2048]
        return ""

    @staticmethod
    def _candidate_title(anchor: object, url: str, fallback: str) -> str:
        text = ""
        if hasattr(anchor, "get_text"):
            text = anchor.get_text(" ", strip=True)
        if not text and hasattr(anchor, "get"):
            text = str(anchor.get("title", "") or "")
        if not text:
            text = unquote(parse_qs(urlsplit(url).query).get("dn", [""])[0])
        return (re.sub(r"\s+", " ", text).strip() or fallback)[:512]

    @classmethod
    def _parse_magnets(cls, source: str, fallback_title: str) -> list[MagnetCandidate]:
        soup = BeautifulSoup(source, "html.parser")
        raw_values: list[tuple[str, object | None]] = []
        for anchor in soup.select("a[href^='magnet:']"):
            raw_values.append((str(anchor.get("href", "")), anchor))
        for match in _MAGNET_TEXT.finditer(html_module.unescape(source)):
            raw_values.append((match.group(0), None))

        candidates: list[MagnetCandidate] = []
        seen: set[str] = set()
        for raw_url, anchor in raw_values:
            value = html_module.unescape(str(raw_url or "")).strip()
            if not is_magnet(value):
                continue
            key = dedupe_key(value)
            if key in seen:
                continue
            seen.add(key)
            btih = extract_btih(value)
            title = cls._candidate_title(anchor, value, fallback_title)
            candidates.append(
                MagnetCandidate(
                    url=value,
                    title=title,
                    btih=btih,
                    dedupe_key=key,
                )
            )
        return candidates

    async def lookup(self, code: str) -> AvMetadata:
        normalized = normalize_code(code)
        if not normalized:
            raise ProviderError("无法识别番号")
        page_url = f"{self.base_url}/{quote(normalized, safe='')}"
        page_response, resolved_page_url = await self._get(page_url)
        page_source = self._response_text(page_response)
        page_soup = BeautifulSoup(page_source, "html.parser")
        title = self._first_text(
            page_soup,
            (
                "meta[property='og:title']",
                ".container h3",
                ".movie h3",
                "h3",
                "h1",
                "title",
            ),
        ) or normalized
        page_code = normalize_code(
            urlsplit(resolved_page_url).path.rsplit("/", 1)[-1]
        )
        title_code = normalize_code(title)
        if page_code and page_code != normalized:
            raise ProviderError("JavBus 页面番号与请求不一致")
        if not page_code and title_code and title_code != normalized:
            raise ProviderError("JavBus 页面番号与请求不一致")
        page_code = page_code or title_code or normalized
        cover_url = self._cover_url(page_soup, resolved_page_url)
        candidates = self._parse_magnets(page_source, title)

        ajax = self._ajax_parameters(self._script_text(page_soup))
        if ajax.get("gid"):
            endpoint = urljoin(resolved_page_url, "/ajax/uncledatoolsbyajax.php")
            endpoint = self._validate_allowed_url(endpoint)
            ajax_params = {
                "gid": ajax["gid"],
                "uc": ajax.get("uc", "0"),
                "lang": ajax.get("lang", "zh"),
            }
            if ajax.get("img"):
                ajax_params["img"] = ajax["img"]
            ajax_response, _ = await self._get(
                endpoint,
                params=ajax_params,
                headers={"Referer": resolved_page_url},
            )
            ajax_source = self._response_text(ajax_response)
            candidates.extend(self._parse_magnets(ajax_source, title))

        deduped: list[MagnetCandidate] = []
        seen: set[str] = set()
        for candidate in candidates:
            if candidate.dedupe_key in seen:
                continue
            seen.add(candidate.dedupe_key)
            deduped.append(candidate)
        return AvMetadata(
            code=page_code,
            title=title,
            page_url=resolved_page_url,
            cover_url=cover_url,
            candidates=tuple(deduped),
        )
