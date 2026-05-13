"""CLI entry point.

Import (default):
    pdf-adapter input.pdf -o output.udm.json [--assets-dir DIR --assets-url-prefix URL]

Export:
    pdf-adapter --export input.udm.json -o output.pdf
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .exporter import export_pdf_from_file
from .importer import import_pdf


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pdf-adapter",
        description="Convert between PDF and UDM v0.1 JSON.",
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
    parser.add_argument(
        "--assets-dir",
        type=Path,
        default=None,
        help="Import: extract images and fonts to this directory (creates images/ and fonts/ subdirs)",
    )
    parser.add_argument(
        "--assets-url-prefix",
        default="",
        help="Import: URL prefix prepended to extracted asset data_refs (e.g. /synthetic.assets)",
    )
    parser.add_argument(
        "--export",
        action="store_true",
        help="Export mode: input is a UDM JSON, output is a PDF",
    )
    parser.add_argument(
        "--base-dir",
        type=Path,
        default=None,
        help=(
            "Export: base directory for resolving relative data_ref values "
            "(defaults to the UDM file's parent directory)."
        ),
    )
    args = parser.parse_args(argv)

    if not args.input.exists():
        print(f"error: input not found: {args.input}", file=sys.stderr)
        return 2

    if args.export:
        if not args.output:
            print("error: --export requires -o OUTPUT", file=sys.stderr)
            return 2
        if args.base_dir is not None:
            from .exporter import export_pdf

            udm = json.loads(args.input.read_text(encoding="utf-8"))
            export_pdf(udm, args.output, base_dir=args.base_dir)
        else:
            export_pdf_from_file(args.input, args.output)
        size = args.output.stat().st_size
        print(f"Exported {args.output} ({size} bytes)", file=sys.stderr)
        return 0

    udm = import_pdf(
        args.input,
        assets_dir=args.assets_dir,
        assets_url_prefix=args.assets_url_prefix,
    )

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
