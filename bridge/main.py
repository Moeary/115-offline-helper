"""Command-line entry point for the local bridge."""

from __future__ import annotations

import argparse
import sys

from .app import create_app
from .config import Settings, load_or_create_token


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="115 Offline Helper local bridge")
    parser.add_argument(
        "--print-token",
        action="store_true",
        help="print the configured/generated bearer token and exit",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        settings = Settings.from_env()
    except (OSError, ValueError) as error:
        print(f"bridge 配置无效：{error}", file=sys.stderr)
        return 2
    if args.print_token:
        # Explicit user action is required before the secret is printed.  Do
        # not add labels, timestamps, or logging that could make copy/paste
        # into the extension ambiguous.
        token = settings.bearer_token
        if not token:
            token = load_or_create_token(settings.token_file)
        print(token)
        return 0
    try:
        import uvicorn
    except ImportError:
        print(
            "缺少 uvicorn，请先安装 bridge/requirements.txt 中的依赖。",
            file=sys.stderr,
        )
        return 2
    application = create_app(settings)
    uvicorn.run(application, host=settings.host, port=settings.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
