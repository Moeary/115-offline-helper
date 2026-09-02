"""Remove generated build artifacts owned by this project."""

from __future__ import annotations

import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    for relative in ("dist", ".build"):
        path = ROOT / relative
        if path.is_dir():
            shutil.rmtree(path)
            print(f"已清理：{path}")


if __name__ == "__main__":
    main()
