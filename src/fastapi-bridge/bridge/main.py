"""Command-line entry point for the local bridge."""

from __future__ import annotations

import argparse
import sys

from .app import create_app
from .config import PairingWindowClosed, Settings, load_or_create_token


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="115 Offline Helper local bridge")
    parser.add_argument(
        "--print-token",
        action="store_true",
        help="print the configured/generated bearer token and exit",
    )
    parser.add_argument(
        "--print-pairing",
        action="store_true",
        help="print the current local pairing information and exit",
    )
    parser.add_argument(
        "--pair",
        action="store_true",
        help="start the bridge and print local pairing information",
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
    if args.print_pairing:
        application = create_app(settings)
        try:
            pairing = application.state.pairing_manager
            code = pairing.current_code
            if code is None:
                status = pairing.status()
                print(
                    f"Bridge 已完成配对或配对窗口已关闭（paired={status.paired}）"
                )
                return 1
            print(f"配对码: {code}")
            print(f"有效期至（Unix time）: {int(pairing.status().expires_at or 0)}")
            return 0
        finally:
            application.state.store.close()
    try:
        import uvicorn
    except ImportError:
        print(
            "缺少 uvicorn，请先在仓库根目录运行 pixi install。",
            file=sys.stderr,
        )
        return 2
    application = create_app(settings)
    pairing = application.state.pairing_manager
    if args.pair:
        try:
            # An explicit ``pixi run pair`` command is the documented recovery
            # path after a browser reinstall.  It rotates the pairing window;
            # the old Bearer token remains valid until a new client pairs.
            pairing.open_window(force=True)
        except PairingWindowClosed:
            pass
    code = pairing.current_code
    if code is not None:
        print(
            f"115 Offline Helper Bridge 1.11.0 配对码: {code} "
            f"（5 分钟内有效，最多失败 5 次）",
            flush=True,
        )
    elif pairing.status().paired:
        print("115 Offline Helper Bridge 已完成配对。", flush=True)
    uvicorn.run(application, host=settings.host, port=settings.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
