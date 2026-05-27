"""Adjacent-span redaction collateral test (lesson #8 real fix).

Builds a PDF with two text-show ops on the same line so close that
PyMuPDF's apply_redactions would normally eat both when redacting
one. Edits only the first, exports via the patch path, and verifies
the neighbour text survives in the output.

This is the regression test that locks in the pre/post-redact span
diff + neighbour reinsertion logic added in patch_export.

Run from repo root:
    python tests/adjacent_span_test.py
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


def build_adjacent_span_pdf(path: Path) -> None:
    """Two text-show ops on the same baseline, separated by a few
    points. Each insert_text call creates an independent text op."""
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=200)
    # First span at x=72, second at x=120 — close enough that
    # PyMuPDF's redact rect on the first will overlap the second.
    page.insert_text((72, 100), "Cook", fontsize=18, fontname="helv")
    page.insert_text((120, 100), "/ Cashier", fontsize=18, fontname="helv")
    doc.save(str(path))
    doc.close()


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "adj.pdf"
        build_adjacent_span_pdf(src)

        udm = import_pdf(src, source_url="/adj.pdf", enable_ocr=False)

        # Find both source runs.
        runs = []
        for page in udm["content"]["pages"]:
            for layer in page.get("layers", []):
                if layer.get("type") != "text":
                    continue
                runs.extend(layer.get("runs", []))

        cook = next((r for r in runs if r.get("text") == "Cook"), None)
        cashier = next((r for r in runs if "Cashier" in r.get("text", "")), None)
        if cook is None or cashier is None:
            print(f"  [FAIL] importer didn't capture both spans: {[r.get('text') for r in runs]!r}")
            return 1
        print(f"  imported spans: {[r.get('text') for r in runs]!r}")

        # Edit only the first span.
        cook["text"] = "Waiter"

        out = td_path / "edited.pdf"
        export_pdf(udm, out, base_dir=td_path)

        result_doc = pymupdf.open(str(out))
        try:
            output_text = "\n".join(p.get_text() for p in result_doc)
        finally:
            result_doc.close()
        print(f"  output text: {output_text!r}")

        ok = True
        if "Waiter" not in output_text:
            print("  [FAIL] new text 'Waiter' not in output")
            ok = False
        else:
            print("  [PASS] edited text 'Waiter' present")
        if "Cook" in output_text:
            print("  [FAIL] old text 'Cook' still in output")
            ok = False
        else:
            print("  [PASS] old text 'Cook' removed")
        if "Cashier" not in output_text:
            print("  [FAIL] adjacent span '/ Cashier' was eaten by the redact (lesson #8 collateral)")
            ok = False
        else:
            print("  [PASS] adjacent span '/ Cashier' survived")
        return 0 if ok else 1


if __name__ == "__main__":
    print("Adjacent-span redaction collateral test\n")
    sys.exit(main())
