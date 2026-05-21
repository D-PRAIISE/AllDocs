"""Image placement detection test.

Verifies that images placed through a Form XObject (the watermark
pattern) are detected — `page.get_image_rects` misses these, so the
importer falls back to `get_bboxlog`. Also checks the faint-watermark
ExtGState alpha is captured as layer opacity.

Run from repo root:
    python tests/image_placement_test.py
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "pdf-adapter" / "src"))

from pdf_adapter.importer import import_pdf  # noqa: E402

WHITEPAPER = Path.home() / "Downloads" / "1000PDF_Whitepaper.pdf"


def main() -> int:
    if not WHITEPAPER.exists():
        print(f"SKIP: fixture missing: {WHITEPAPER}")
        return 0

    udm = import_pdf(WHITEPAPER, source_url="/source.pdf", enable_ocr=False)
    pages = udm["content"]["pages"]
    ok = True

    # The watermark (a Form-XObject-nested image) appears on every page.
    for page in pages:
        imgs = [layer for layer in page["layers"] if layer.get("type") == "image"]
        watermark = [
            i for i in imgs if i["width"]["value"] > 200 and i["height"]["value"] > 200
        ]
        if not watermark:
            print(f"  [FAIL] page {page['number']}: watermark image not detected")
            ok = False
            continue
        opacity = watermark[0].get("opacity", 1.0)
        if opacity < 0.5:
            print(f"  [PASS] page {page['number']}: watermark detected, faint (opacity={opacity})")
        else:
            print(f"  [FAIL] page {page['number']}: watermark opacity={opacity} (expected faint)")
            ok = False

    # Page 1 also has the direct-placed small logo at full opacity.
    p1_imgs = [layer for layer in pages[0]["layers"] if layer.get("type") == "image"]
    small = [i for i in p1_imgs if i["width"]["value"] < 150]
    if small and small[0].get("opacity", 1.0) == 1.0:
        print("  [PASS] page 1: direct-placed logo at full opacity")
    else:
        print("  [FAIL] page 1: direct-placed logo missing or wrongly faded")
        ok = False

    print()
    return 0 if ok else 1


if __name__ == "__main__":
    print("Image placement detection test\n")
    sys.exit(main())
