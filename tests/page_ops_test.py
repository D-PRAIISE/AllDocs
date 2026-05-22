"""Page operations export test.

Imports a multi-page PDF, then reorders / deletes / rotates / inserts
pages in the UDM and exports. Verifies the output page set matches.

Run from repo root:
    python tests/page_ops_test.py
"""
from __future__ import annotations

import copy
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
        src_pages = udm["content"]["pages"]
        if len(src_pages) < 4:
            print(f"SKIP: need a 4-page fixture, got {len(src_pages)}")
            return 0

        # Build a new page set: [src3, src1 rotated 90, blank, src0]
        blank = {
            "number": 0,
            "width": copy.deepcopy(src_pages[0]["width"]),
            "height": copy.deepcopy(src_pages[0]["height"]),
            "layers": [],
            "rotation": 0,
            "_meta": {},
        }
        p3 = copy.deepcopy(src_pages[3])
        p1 = copy.deepcopy(src_pages[1])
        p1["rotation"] = 90
        p0 = copy.deepcopy(src_pages[0])
        new_pages = [p3, p1, blank, p0]
        for i, pg in enumerate(new_pages):
            pg["number"] = i + 1
        udm["content"]["pages"] = new_pages

        out = td_path / "page_ops.pdf"
        export_pdf(udm, out, base_dir=td_path)

        result = pymupdf.open(str(out))
        ok = True
        try:
            if len(result) != 4:
                print(f"  [FAIL] output has {len(result)} pages, expected 4")
                ok = False
            else:
                print("  [PASS] output has 4 pages")

            # page 0 == source page 4 ("Page 4" footer)
            if "Page 4" in result[0].get_text():
                print("  [PASS] page 0 is the original page 4 (reorder)")
            else:
                print("  [FAIL] page 0 is not the original page 4")
                ok = False

            # page 1 rotated 90
            if result[1].rotation == 90:
                print("  [PASS] page 1 rotated 90°")
            else:
                print(f"  [FAIL] page 1 rotation is {result[1].rotation}, expected 90")
                ok = False

            # page 2 blank
            if not result[2].get_text().strip():
                print("  [PASS] page 2 is blank (inserted)")
            else:
                print("  [FAIL] page 2 is not blank")
                ok = False

            # page 3 == source page 1
            if "Page 1" in result[3].get_text():
                print("  [PASS] page 3 is the original page 1")
            else:
                print("  [FAIL] page 3 is not the original page 1")
                ok = False

            # The new set is [src3, src1, blank, src0] — source page 3
            # ("Page 3" footer) is the one dropped.
            all_text = "\n".join(p.get_text() for p in result)
            if "Page 3" not in all_text:
                print("  [PASS] deleted page (source page 3) absent from output")
            else:
                print("  [FAIL] deleted page still present")
                ok = False
        finally:
            result.close()

        print()
        return 0 if ok else 1


if __name__ == "__main__":
    print("Page operations export test\n")
    sys.exit(main())
