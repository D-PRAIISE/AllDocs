"""CLI entry point: `pdf-adapter input.pdf -o output.udm.json`."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .importer import import_pdf


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pdf-adapter",
        description="Convert a PDF to UDM v0.1 JSON.",
    )
    parser.add_argument("input", type=Path, help="Path to input PDF file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Output UDM JSON path (default: stdout)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output",
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Print a one-line summary instead of the full document",
    )
    args = parser.parse_args(argv)

    if not args.input.exists():
        print(f"error: input not found: {args.input}", file=sys.stderr)
        return 2

    udm = import_pdf(args.input)

    if args.summary:
        n_pages = len(udm["content"]["pages"])
        n_fonts = len(udm["resources"]["fonts"])
        n_images = len(udm["resources"]["images"])
        n_subsets = sum(
            1 for f in udm["resources"]["fonts"] if f.get("_meta", {}).get("subset")
        )
        n_runs = sum(
            sum(len(layer.get("runs", [])) for layer in page["layers"] if layer["type"] == "text")
            for page in udm["content"]["pages"]
        )
        print(
            f"{args.input.name}: {n_pages} page(s), "
            f"{n_runs} text run(s), {n_fonts} font(s) ({n_subsets} subset), "
            f"{n_images} image(s), udm_version={udm['udm_version']}"
        )
        return 0

    js = json.dumps(udm, indent=2 if args.pretty else None, ensure_ascii=False)
    if args.output:
        args.output.write_text(js, encoding="utf-8")
        print(f"Wrote {args.output} ({len(js)} bytes)", file=sys.stderr)
    else:
        sys.stdout.write(js + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
