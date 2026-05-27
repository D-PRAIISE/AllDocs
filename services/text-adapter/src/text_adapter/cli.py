"""CLI entry point for text-adapter.

Import (default):
    text-adapter input.md -o output.udm.json
    text-adapter input.html -o output.udm.json

Export:
    text-adapter --export input.udm.json -o output.md
    text-adapter --export input.udm.json -o output.html
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .exporter import export_html, export_markdown
from .importer import import_html, import_markdown


def _detect_input_format(path: Path) -> str:
    ext = path.suffix.lower().lstrip(".")
    if ext in ("md", "markdown", "mdown"):
        return "md"
    if ext in ("html", "htm", "xhtml"):
        return "html"
    raise ValueError(f"unsupported input extension: {path.suffix!r}")


def _detect_output_format(path: Path) -> str:
    ext = path.suffix.lower().lstrip(".")
    if ext in ("md", "markdown"):
        return "md"
    if ext in ("html", "htm"):
        return "html"
    raise ValueError(f"unsupported output extension: {path.suffix!r}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="text-adapter",
        description="Convert between Markdown / HTML and UDM v0.1 JSON.",
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("-o", "--output", type=Path, default=None)
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument(
        "--export",
        action="store_true",
        help="Export mode: input is UDM JSON, output is .md or .html",
    )
    args = parser.parse_args(argv)

    if not args.input.exists():
        print(f"error: input not found: {args.input}", file=sys.stderr)
        return 2

    if args.export:
        if not args.output:
            print("error: --export requires -o OUTPUT", file=sys.stderr)
            return 2
        udm = json.loads(args.input.read_text(encoding="utf-8"))
        fmt = _detect_output_format(args.output)
        if fmt == "md":
            export_markdown(udm, args.output)
        else:
            export_html(udm, args.output)
        size = args.output.stat().st_size
        print(f"Exported {args.output} ({size} bytes)", file=sys.stderr)
        return 0

    fmt = _detect_input_format(args.input)
    udm = import_markdown(args.input) if fmt == "md" else import_html(args.input)

    js = json.dumps(udm, indent=2 if args.pretty else None, ensure_ascii=False)
    if args.output:
        args.output.write_text(js, encoding="utf-8")
        print(f"Wrote {args.output} ({len(js)} bytes)", file=sys.stderr)
    else:
        sys.stdout.write(js + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
