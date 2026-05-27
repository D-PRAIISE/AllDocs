"""CLI entry point for the office (DOCX) adapter.

Import (default):
    office-adapter input.docx -o output.udm.json [--pretty | --summary]

Export:
    office-adapter --export input.udm.json -o output.docx
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .exporter import export_docx_from_file
from .importer import import_docx
from .pptx_adapter import export_pptx, import_pptx
from .xlsx import export_xlsx, import_xlsx


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="office-adapter",
        description="Convert between DOCX and UDM v0.1 JSON (flow mode).",
    )
    parser.add_argument("input", type=Path, help="Path to input file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Output path (default: stdout for import; required for export)",
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Print a one-line block-type summary instead of full JSON",
    )
    parser.add_argument(
        "--export",
        action="store_true",
        help="Export mode: input is a UDM JSON, output is a DOCX",
    )
    parser.add_argument(
        "--base-dir",
        type=Path,
        default=None,
        help=(
            "Export: base directory used to resolve relative paths in the UDM "
            "(esp. metadata.passthrough.source_url, which enables pdf2docx "
            "layout-faithful PDF→DOCX export)."
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
        out_ext = args.output.suffix.lower()
        if out_ext == ".xlsx":
            udm = json.loads(args.input.read_text(encoding="utf-8"))
            export_xlsx(udm, args.output)
        elif out_ext == ".pptx":
            udm = json.loads(args.input.read_text(encoding="utf-8"))
            export_pptx(udm, args.output)
        else:
            export_docx_from_file(args.input, args.output, base_dir=args.base_dir)
        print(
            f"Exported {args.output} ({args.output.stat().st_size} bytes)",
            file=sys.stderr,
        )
        return 0

    in_ext = args.input.suffix.lower()
    if in_ext == ".xlsx":
        udm = import_xlsx(args.input)
    elif in_ext == ".pptx":
        udm = import_pptx(args.input)
    else:
        udm = import_docx(args.input)

    if args.summary:
        if udm.get("mode") == "sheet":
            sheets = udm["content"]["sheets"]
            total_cells = sum(len(s.get("cells") or {}) for s in sheets)
            print(
                f"{args.input.name}: {len(sheets)} sheet(s), {total_cells} cell(s)"
            )
            return 0
        if udm.get("mode") == "slides":
            slides = udm["content"]["slides"]
            total_shapes = sum(len(s.get("shapes") or []) for s in slides)
            print(
                f"{args.input.name}: {len(slides)} slide(s), {total_shapes} shape(s)"
            )
            return 0
        blocks = udm["content"]["blocks"]
        counts: dict[str, int] = {}
        for b in blocks:
            t = b.get("type", "?")
            counts[t] = counts.get(t, 0) + 1
        type_str = ", ".join(f"{n} {t}" for t, n in sorted(counts.items()))
        print(f"{args.input.name}: {len(blocks)} block(s) ({type_str})")
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
