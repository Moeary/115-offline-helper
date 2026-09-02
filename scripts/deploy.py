"""Build the extension and open Chrome with the compiled directory ready to load."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tomllib
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.toml"
DIST = ROOT / "dist"
EXTENSION_DIST = DIST / "extension"


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def read_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    if not path.is_file():
        return {}
    with path.open("rb") as handle:
        value = tomllib.load(handle)
    return value if isinstance(value, dict) else {}


def _configured_path(config: Mapping[str, Any], section: str, key: str) -> Path | None:
    section_value = config.get(section)
    if not isinstance(section_value, Mapping):
        return None
    value = section_value.get(key)
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(os.path.expandvars(value.strip().strip('"')))
    return path if path.is_absolute() else ROOT / path


def _common_chrome_paths() -> list[Path]:
    roots = [
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("LOCALAPPDATA"),
    ]
    relatives = (
        Path("Google") / "Chrome" / "Application" / "chrome.exe",
        Path("Chromium") / "Application" / "chrome.exe",
    )
    return [Path(root) / relative for root in roots if root for relative in relatives]


def find_chrome(config: Mapping[str, Any]) -> Path:
    configured = _configured_path(config, "browser", "chrome")
    if configured is not None:
        if configured.is_file():
            return configured
        raise FileNotFoundError(f"配置的 Chrome 路径不存在：{configured}")

    environment_path = os.environ.get("CHROME_PATH")
    if environment_path:
        candidate = Path(environment_path.strip().strip('"'))
        if candidate.is_file():
            return candidate
        raise FileNotFoundError(f"CHROME_PATH 指向的文件不存在：{candidate}")

    for candidate in _common_chrome_paths():
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "找不到 Chrome，请在 config.toml 的 [browser] chrome 中填写 chrome.exe 路径"
    )


def open_extensions_page(chrome_path: Path, extension_dir: Path, *, load_extension: bool = True) -> None:
    """Open the extensions page and ask Chrome to load the compiled unpacked extension.

    Chrome may ignore --load-extension when an existing browser process owns the
    profile. In that case the page is still opened and the user can select the
    printed dist/extension directory once.
    """

    arguments = [str(chrome_path)]
    if load_extension:
        arguments.append(f"--load-extension={extension_dir.resolve()}")
    arguments.append("chrome://extensions/")
    subprocess.Popen(
        arguments,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def deploy(*, open_browser: bool = True, load_extension: bool = True) -> None:
    sys.path.insert(0, str(ROOT / "scripts"))
    from build import build_extension  # type: ignore[import-not-found]

    config = read_config()
    extension_dir = build_extension()
    chrome_path = find_chrome(config)

    print(f"Chrome：{chrome_path}")
    print(f"编译产物：{extension_dir}")
    if open_browser:
        try:
            open_extensions_page(chrome_path, extension_dir, load_extension=load_extension)
            if load_extension:
                print("已请求 Chrome 加载编译产物；若页面未出现扩展，请在 chrome://extensions 开启开发者模式并加载上述目录。")
            else:
                print("已打开 chrome://extensions，请开启开发者模式并加载上述目录。")
        except OSError as error:
            print(f"无法自动打开 Chrome，请手动打开 chrome://extensions：{error}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build and deploy the 115 Offline Helper extension")
    parser.add_argument("--no-open", action="store_true", help="部署后不自动打开 chrome://extensions")
    parser.add_argument(
        "--no-load-extension",
        action="store_true",
        help="只打开扩展管理页，不传递 --load-extension 参数",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        deploy(open_browser=not args.no_open, load_extension=not args.no_load_extension)
    except Exception as error:
        print(f"部署失败：{error}", file=sys.stderr)
        raise SystemExit(1)
