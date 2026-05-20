"""OCR pipeline test.

Verifies:
  - A scanned/rasterized PDF (no native text) gets OCR'd text runs
  - OCR runs carry the `ocr` marker with confidence + engine
  - A native-text PDF is NOT OCR'd (no false positives)

Requires Tesseract. If it isn't installed the test reports SKIP, not FAIL.

Run from repo root:
    python tests/ocr_test.py
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "pdf-adapter" / "src"))

from pdf_adapter import _ocr  # noqa: E402
from pdf_adapter.importer import import_pdf  # noqa: E402

SCANNED = Path.home() / "Downloads" / "Kara_CV_Edited.pdf"
NATIVE = Path.home() / "Downloads" / "1000PDF_Whitepaper.pdf"


def ocr_runs(udm: dict) -> list[dict]:
    return [
        run
        for page in udm["content"]["pages"]
        for layer in page.get("layers", [])
        if layer.get("type") == "text"
        for run in layer.get("runs", [])
        if run.get("ocr")
    ]


def main() -> int:
    if not _ocr.tesseract_available():
        print("SKIP: Tesseract not installed — OCR pipeline cannot be tested")
        return 0

    ok = True

    # Scanned PDF -> should be OCR'd
    if SCANNED.exists():
        udm = import_pdf(SCANNED, source_url="/source.pdf")
        runs = ocr_runs(udm)
        if len(runs) < 10:
            print(f"  [FAIL] scanned PDF produced only {len(runs)} OCR runs (expected >= 10)")
            ok = False
        else:
            print(f"  [PASS] scanned PDF -> {len(runs)} OCR runs")

        bad_conf = [r for r in runs if not (0.0 <= r["ocr"]["confidence"] <= 1.0)]
        if bad_conf:
            print(f"  [FAIL] {len(bad_conf)} runs have out-of-range confidence")
            ok = False
        else:
            print("  [PASS] all OCR runs have confidence in [0, 1]")

        if any(r["ocr"]["engine"] != "tesseract" for r in runs):
            print("  [FAIL] some OCR runs have an unexpected engine name")
            ok = False
        else:
            print("  [PASS] all OCR runs tagged engine=tesseract")

        # Sanity: at least one run should contain a recognizable word.
        joined = " ".join(r["text"] for r in runs).lower()
        if "karalee" in joined or "cashier" in joined:
            print("  [PASS] OCR text contains expected content")
        else:
            print("  [FAIL] OCR text missing expected content (Karalee/cashier)")
            ok = False
    else:
        print(f"  SKIP: scanned fixture missing: {SCANNED}")

    # Native-text PDF -> should NOT be OCR'd
    if NATIVE.exists():
        udm = import_pdf(NATIVE, source_url="/source.pdf")
        runs = ocr_runs(udm)
        if runs:
            print(f"  [FAIL] native-text PDF wrongly OCR'd ({len(runs)} OCR runs)")
            ok = False
        else:
            print("  [PASS] native-text PDF not OCR'd")
    else:
        print(f"  SKIP: native fixture missing: {NATIVE}")

    print()
    return 0 if ok else 1


if __name__ == "__main__":
    print("OCR pipeline test\n")
    sys.exit(main())
