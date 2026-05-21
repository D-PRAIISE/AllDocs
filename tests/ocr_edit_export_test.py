"""OCR edit export test.

Imports a scanned PDF, edits one OCR'd run, exports, and verifies the
edit is burned into the output:
  - the new text is present (OCR'd back out of the rendered output)
  - the old text is gone
  - the rest of the page is untouched (other OCR text still recognizable)

Requires Tesseract. Reports SKIP (not FAIL) if it's missing.

Run from repo root:
    python tests/ocr_edit_export_test.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "pdf-adapter" / "src"))

import pymupdf  # noqa: E402

from pdf_adapter import _ocr  # noqa: E402
from pdf_adapter.exporter import export_pdf  # noqa: E402
from pdf_adapter.importer import import_pdf  # noqa: E402

SCANNED = Path.home() / "Downloads" / "Kara_CV_Edited.pdf"


def ocr_text_of(pdf_path: Path) -> str:
    """OCR a PDF and return all recognized text, lowercased."""
    doc = pymupdf.open(str(pdf_path))
    try:
        chunks = []
        for page in doc:
            for run in _ocr.ocr_page(page).runs:
                chunks.append(run.text)
        return " ".join(chunks).lower()
    finally:
        doc.close()


def main() -> int:
    if not _ocr.tesseract_available():
        print("SKIP: Tesseract not installed")
        return 0
    if not SCANNED.exists():
        print(f"SKIP: fixture missing: {SCANNED}")
        return 0

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        source_in = td_path / "source.pdf"
        source_in.write_bytes(SCANNED.read_bytes())

        udm = import_pdf(source_in, source_url="/source.pdf")

        # Find an OCR run to edit — pick one with distinctive text.
        target = None
        for page in udm["content"]["pages"]:
            for layer in page.get("layers", []):
                if layer.get("type") != "text":
                    continue
                for run in layer.get("runs", []):
                    if run.get("ocr") and "cashier" in run.get("text", "").lower():
                        target = run
                        break
                if target:
                    break
            if target:
                break

        if target is None:
            print("  [FAIL] no OCR run containing 'cashier' found to edit")
            return 1

        original = target["text"]
        target["text"] = "Detailed SUPERVISOR with strong"
        print(f"  edited OCR run: {original!r} -> {target['text']!r}")

        out = td_path / "ocr_edited.pdf"
        export_pdf(udm, out, base_dir=td_path)

        result_text = ocr_text_of(out)
        ok = True

        if "supervisor" in result_text:
            print("  [PASS] new text 'SUPERVISOR' burned into output")
        else:
            print("  [FAIL] new text not found when OCR'ing the output")
            ok = False

        # The old word "cashier" from this line should be gone. (Other
        # lines may still contain 'cashier'; this run had 'Detailed
        # cashier with strong' — check the specific phrase.)
        if "detailed cashier with strong" not in result_text:
            print("  [PASS] old text covered (phrase no longer OCRs)")
        else:
            print("  [FAIL] old text still visible in output")
            ok = False

        # Untouched content elsewhere should survive.
        if "karalee" in result_text:
            print("  [PASS] untouched page content preserved")
        else:
            print("  [FAIL] untouched content lost")
            ok = False

        print(f"  source={source_in.stat().st_size:,}b  output={out.stat().st_size:,}b")
        return 0 if ok else 1


if __name__ == "__main__":
    print("OCR edit export test\n")
    sys.exit(main())
