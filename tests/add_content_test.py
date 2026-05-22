"""Add-content export test.

Imports a PDF, adds a net-new text run and a net-new image to the UDM
(as the editor would), exports, and verifies both land in the output
while the original content is preserved.

Run from repo root:
    python tests/add_content_test.py
"""
from __future__ import annotations

import base64
import io
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "pdf-adapter" / "src"))

import pymupdf  # noqa: E402
from PIL import Image  # noqa: E402

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

        # --- add a text run --------------------------------------------
        udm["resources"]["fonts"].append(
            {
                "id": "font_added",
                "family": "sans-serif",
                "weight": 700,
                "style": "normal",
                "source": "substituted",
            }
        )
        page0 = udm["content"]["pages"][0]
        page0["layers"].append(
            {
                "type": "text",
                "runs": [
                    {
                        "text": "ANNOTATEDBYALLDOCS",
                        "font_id": "font_added",
                        "font_size": {"value": 18.0, "unit": "pt"},
                        "color": {"literal": {"kind": "rgb", "r": 200, "g": 0, "b": 0}},
                        "x": {"value": 120.0, "unit": "pt"},
                        "y": {"value": 400.0, "unit": "pt"},
                        "_meta": {"added": True},
                    }
                ],
            }
        )

        # --- add an image ----------------------------------------------
        png = Image.new("RGB", (120, 120), (0, 90, 200))
        buf = io.BytesIO()
        png.save(buf, format="PNG")
        data_url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        udm["resources"]["images"].append(
            {
                "id": "img_added",
                "format": "png",
                "width": 120,
                "height": 120,
                "data_ref": data_url,
            }
        )
        page0["layers"].append(
            {
                "type": "image",
                "image_id": "img_added",
                "x": {"value": 200.0, "unit": "pt"},
                "y": {"value": 450.0, "unit": "pt"},
                "width": {"value": 100.0, "unit": "pt"},
                "height": {"value": 100.0, "unit": "pt"},
            }
        )

        out = td_path / "added.pdf"
        export_pdf(udm, out, base_dir=td_path)

        ok = True
        result = pymupdf.open(str(out))
        try:
            page_text = result[0].get_text()
            if "ANNOTATEDBYALLDOCS" in page_text.replace(" ", ""):
                print("  [PASS] added text run present in output")
            else:
                print("  [FAIL] added text run missing from output")
                ok = False

            if "1000PDF" in "\n".join(p.get_text() for p in result):
                print("  [PASS] original document text preserved")
            else:
                print("  [FAIL] original text lost")
                ok = False

            # Sample the added image's location for the blue fill.
            pix = result[0].get_pixmap(dpi=150)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            px = img.getpixel((int(250 * 150 / 72), int(500 * 150 / 72)))
            if px[2] > 120 and px[0] < 120:
                print(f"  [PASS] added image rendered ({px})")
            else:
                print(f"  [FAIL] added image not found at its location ({px})")
                ok = False
        finally:
            result.close()

        print()
        return 0 if ok else 1


if __name__ == "__main__":
    print("Add-content export test\n")
    sys.exit(main())
