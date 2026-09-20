from __future__ import annotations

import asyncio

import pytest

from bridge.providers.javbus import JavBusProvider
from bridge.providers.base import ProviderError


class FakeResponse:
    def __init__(self, url: str, content: str, status_code: int = 200) -> None:
        self.url = url
        self.content = content.encode("utf-8")
        self.text = content
        self.status_code = status_code
        self.headers = {"content-type": "text/html"}


class FakeClient:
    def __init__(self, responses: dict[str, FakeResponse]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def get(self, url: str, *, params=None, headers=None, **_kwargs):
        self.calls.append((url, dict(params or {})))
        if "uncledatoolsbyajax.php" in url:
            return self.responses["ajax"]
        return self.responses["page"]


def test_javbus_parses_page_and_ajax_magnets() -> None:
    page_url = "https://www.javbus.com/ABC-123"
    page = """
    <html><head>
      <meta property="og:title" content="ABC-123 Demo">
      <meta property="og:image" content="https://images.example/cover.jpg">
    </head><body>
      <script>var gid = '42'; var uc = '1'; var lang = 'zh'; var img = '1';</script>
    </body></html>
    """
    ajax = '<a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=Demo">one</a>'
    client = FakeClient(
        {
            "page": FakeResponse(page_url, page),
            "ajax": FakeResponse("https://www.javbus.com/ajax/uncledatoolsbyajax.php", ajax),
        }
    )
    provider = JavBusProvider(
        "https://javbus.com",
        allowed_hosts={"javbus.com", "www.javbus.com"},
        client=client,
    )
    metadata = asyncio.run(provider.lookup("abc123"))
    assert metadata.code == "ABC-123"
    assert metadata.cover_url.endswith("cover.jpg")
    assert len(metadata.candidates) == 1
    assert any("uncledatoolsbyajax.php" in url for url, _ in client.calls)


def test_javbus_keeps_page_magnet_when_ajax_enrichment_is_rejected() -> None:
    page = """
    <html><head><title>ABC-123 Demo</title></head><body>
      <a href="magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=Page">page</a>
      <script>var gid = '42'; var uc = '1'; var lang = 'zh';</script>
    </body></html>
    """
    client = FakeClient(
        {
            "page": FakeResponse("https://www.javbus.com/ABC-123", page),
            "ajax": FakeResponse(
                "https://www.javbus.com/ajax/uncledatoolsbyajax.php", "", 403
            ),
        }
    )
    provider = JavBusProvider(
        "https://javbus.com",
        allowed_hosts={"javbus.com", "www.javbus.com"},
        client=client,
    )
    metadata = asyncio.run(provider.lookup("ABC-123"))
    assert len(metadata.candidates) == 1
    assert metadata.candidates[0].btih == "b" * 32


def test_javbus_reads_ajax_parameters_from_data_attributes() -> None:
    page = """
    <html><head><title>ABC-123 Demo</title></head><body>
      <div data-gid="42" data-uc="1" data-lang="zh"></div>
    </body></html>
    """
    ajax = '<a href="magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccc&dn=Data">data</a>'
    client = FakeClient(
        {
            "page": FakeResponse("https://www.javbus.com/ABC-123", page),
            "ajax": FakeResponse("https://www.javbus.com/ajax/uncledatoolsbyajax.php", ajax),
        }
    )
    provider = JavBusProvider("https://javbus.com", allowed_hosts={"javbus.com", "www.javbus.com"}, client=client)
    metadata = asyncio.run(provider.lookup("ABC-123"))
    assert metadata.candidates[0].btih == "c" * 32
    assert any(params.get("gid") == "42" for _url, params in client.calls)


def test_javbus_rejects_a_different_resolved_page_code() -> None:
    client = FakeClient(
        {
            "page": FakeResponse("https://www.javbus.com/XYZ-999", "<title>XYZ-999</title>"),
            "ajax": FakeResponse("https://www.javbus.com/ajax/uncledatoolsbyajax.php", ""),
        }
    )
    provider = JavBusProvider("https://javbus.com", client=client)
    with pytest.raises(ProviderError):
        asyncio.run(provider.lookup("ABC-123"))
