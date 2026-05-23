"""Annotation export test.

Adds a highlight, a comment (sticky note), and an ink stroke to a PDF
in the UDM, exports, and verifies each lands as a proper PDF
annotation on the page.

Run from repo root:
    python tests/annotation_test.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "pdf-adapter" / "src"))

import pymupdf  # noqa: E402

from pdf_adapter.exporter import export_pdf  # noqa: E402
from pdf_adapter.importer import import_pdf  # noqa: E402

WHITEPAPER = Path.home() / "Downloads" / "1000PDF_Whitepaper.pdf"


def main() -> int:
    if not WHITEPAPER.exists():
        print(f"SKIP: fixture missing: {WHITEPAPER}")
        return 0

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        source_in = td_path / "source.pdf"
        source_in.write_bytes(WHITEPAPER.read_bytes())

        udm = import_pdf(source_in, source_url="/source.pdf", enable_ocr=False)
        page0 = udm["content"]["pages"][0]
        page0["layers"].append(
            {
                "type": "annotation",
                "kind": "highlight",
                "data": {
                    "rect": {"x": 100, "y": 200, "w": 200, "h": 16},
                    "color": [255, 235, 59],
                    "_meta": {"added": True},
                },
            }
        )
        page0["layers"].append(
            {
                "type": "annotation",
                "kind": "comment",
                "data": {
                    "x": 320,
                    "y": 200,
                    "text": "Reviewed by AllDocs",
                    "_meta": {"added": True},
                },
            }
        )
        page0["layers"].append(
            {
                "type": "annotation",
                "kind": "ink",
                "data": {
                    "strokes": [
                        [[100, 400], [150, 410], [200, 420], [250, 415], [300, 400]],
                    ],
                    "color": [200, 0, 0],
                    "width": 2.0,
                    "_meta": {"added": True},
                },
            }
        )

        out = td_path / "annotated.pdf"
        export_pdf(udm, out, base_dir=td_path)

        ok = True
        result = pymupdf.open(str(out))
        try:
            kinds = []
            for an in result[0].annots():
                kinds.append(an.type[1] if an.type else "?")
            print(f"  annotation types on page 1: {kinds}")
            need = {"Highlight": 0, "Text": 0, "Ink": 0}
            for k in kinds:
                if k in need:
                    need[k] += 1
            for k, n in need.items():
                if n >= 1:
                    print(f"  [PASS] {k} annotation present")
                else:
                    print(f"  [FAIL] {k} annotation missing")
                    ok = False

            # Original text still intact
            if "1000PDF" in result[0].get_text():
                print("  [PASS] original text preserved")
            else:
                print("  [FAIL] original text lost")
                ok = False
        finally:
            result.close()
        print()
        return 0 if ok else 1


if __name__ == "__main__":
    print("Annotation export test\n")
    sys.exit(main())
