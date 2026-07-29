from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from .app import create_app
from .security import load_or_create_installation_token


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Lumi QC local service.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=Path(".lumi-qc"))
    parser.add_argument("--print-token", action="store_true")
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    token = load_or_create_installation_token(args.data_dir.resolve())
    if args.print_token:
        print(token)
        return
    print(f"Lumi QC service: http://{args.host}:{args.port}")
    print(f"Installation token: {token}")
    uvicorn.run(
        create_app(args.data_dir, token),
        host=args.host,
        port=args.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
