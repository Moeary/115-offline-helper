"""Build the unpacked Chrome extension into dist/."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "chrome-extension"
DIST = ROOT / "dist"
EXTENSION_DIST = DIST / "extension"


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
        _resource_path(extension_dir, background.get("service_worker"), "background.service_worker")

    action = manifest.get("action")
    if isinstance(action, dict) and action.get("default_popup"):
        _resource_path(extension_dir, action.get("default_popup"), "action.default_popup")

    icons = manifest.get("icons")
    if isinstance(icons, dict):
        for size, icon in icons.items():
            _resource_path(extension_dir, icon, f"icons[{size}]")

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
