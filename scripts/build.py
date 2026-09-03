"""Build the unpacked Chrome extension into dist/."""

from __future__ import annotations

from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "chrome-extension"
DIST = ROOT / "dist"
EXTENSION_DIST = DIST / "extension"

REQUIRED_ARCHITECTURE_ENTRIES = (
    "shared/config.js",
    "shared/download-intent.js",
    "shared/path-utils.js",
    "shared/file-rules.js",
    "content/bootstrap.js",
    "content/runtime-generic.js",
    "content/runtime-sites.js",
    "content/sites/generic.js",
    "content/sites/javbus.js",
    "content/sites/nyaa.js",
    "content/sites/mikan.js",
    "content/intent-factory.js",
    "content/ui/download-confirmation.js",
    "content/ui/batch-progress.js",
    "content/ui/submission-queue.js",
    "background/api/client.js",
    "background/tasks/store.js",
    "background/tasks/monitor.js",
    "background/processors/generic.js",
    "background/processors/anime.js",
    "background/processors/jav.js",
    "ui/popup/index.js",
    "ui/options/index.js",
    "ui/options/site-profiles.js",
)


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def _remove_generated(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def _resource_path(root: Path, value: Any, label: str) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"Manifest 的 {label} 必须是扩展目录内的相对路径：{value}")
    path = root / relative
    if not path.is_file():
        raise FileNotFoundError(f"Manifest 的 {label} 指向的文件不存在：{path}")
    return path


class _LocalHtmlReferenceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "script" and values.get("src"):
            self.references.append(("script", values["src"] or ""))
        if tag == "link" and values.get("href") and "stylesheet" in (values.get("rel") or ""):
            self.references.append(("stylesheet", values["href"] or ""))


def _validate_html_references(extension_dir: Path, html_path: Path) -> None:
    parser = _LocalHtmlReferenceParser()
    parser.feed(html_path.read_text(encoding="utf-8-sig"))
    for kind, reference in parser.references:
        if not reference or "://" in reference or reference.startswith(("data:", "#")):
            continue
        target = (html_path.parent / reference).resolve()
        try:
            target.relative_to(extension_dir.resolve())
        except ValueError as error:
            raise ValueError(f"{html_path.name} 的 {kind} 引用越出扩展目录：{reference}") from error
        if not target.is_file():
            raise FileNotFoundError(f"{html_path.name} 的 {kind} 引用不存在：{target}")


def _validate_import_scripts(extension_dir: Path, worker_path: Path) -> None:
    source = worker_path.read_text(encoding="utf-8-sig")
    for reference in re.findall(r"['\"]([^'\"]+\.js)['\"]", source):
        target = (worker_path.parent / reference).resolve()
        try:
            target.relative_to(extension_dir.resolve())
        except ValueError as error:
            raise ValueError(f"Service worker importScripts 越出扩展目录：{reference}") from error
        if not target.is_file():
            raise FileNotFoundError(f"Service worker importScripts 引用不存在：{target}")


def validate_extension(extension_dir: Path) -> dict[str, Any]:
    manifest_path = extension_dir / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"找不到 manifest.json：{manifest_path}")

    with manifest_path.open("r", encoding="utf-8-sig") as handle:
        manifest = json.load(handle)
    if not isinstance(manifest, dict):
        raise ValueError("manifest.json 的顶层必须是 JSON 对象")
    if manifest.get("manifest_version") != 3:
        raise ValueError("扩展必须使用 Manifest V3")
    if not isinstance(manifest.get("name"), str) or not manifest["name"].strip():
        raise ValueError("manifest.json 缺少有效的 name")
    if not isinstance(manifest.get("version"), str) or not manifest["version"].strip():
        raise ValueError("manifest.json 缺少有效的 version")

    background = manifest.get("background")
    if isinstance(background, dict):
        worker_path = _resource_path(extension_dir, background.get("service_worker"), "background.service_worker")
        if worker_path:
            _validate_import_scripts(extension_dir, worker_path)

    action = manifest.get("action")
    if isinstance(action, dict) and action.get("default_popup"):
        popup_path = _resource_path(extension_dir, action.get("default_popup"), "action.default_popup")
        if popup_path:
            _validate_html_references(extension_dir, popup_path)

    options_ui = manifest.get("options_ui")
    if isinstance(options_ui, dict) and options_ui.get("page"):
        options_path = _resource_path(extension_dir, options_ui.get("page"), "options_ui.page")
        if options_path:
            _validate_html_references(extension_dir, options_path)

    icons = manifest.get("icons")
    if isinstance(icons, dict):
        for size, icon in icons.items():
            _resource_path(extension_dir, icon, f"icons[{size}]")

    for index, content_script in enumerate(manifest.get("content_scripts") or []):
        if not isinstance(content_script, dict):
            continue
        for kind in ("js", "css"):
            for item_index, resource in enumerate(content_script.get(kind) or []):
                _resource_path(extension_dir, resource, f"content_scripts[{index}].{kind}[{item_index}]")

    for relative in REQUIRED_ARCHITECTURE_ENTRIES:
        _resource_path(extension_dir, relative, f"architecture entry {relative}")

    return manifest


def build_extension() -> Path:
    if not SOURCE.is_dir():
        raise FileNotFoundError(f"找不到扩展源码目录：{SOURCE}")

    validate_extension(SOURCE)
    DIST.mkdir(parents=True, exist_ok=True)
    _remove_generated(EXTENSION_DIST)
    shutil.copytree(SOURCE, EXTENSION_DIST)
    manifest = validate_extension(EXTENSION_DIST)

    print(f"Extension: {EXTENSION_DIST}")
    print(f"Version: {manifest['version']}")
    return EXTENSION_DIST


if __name__ == "__main__":
    build_extension()
