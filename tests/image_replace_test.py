"""Image replacement export test.

Imports a PDF, replaces an image resource with a freshly generated one
(as the editor would — a data: URL), exports, and verifies the new
image bytes landed in the output while the rest of the PDF is intact.

Run from repo root:
    python tests/image_replace_test.py
"""
from __future__ import annotations

import base64
import hashlib
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


def make_replacement_png() -> bytes:
    """A distinctive solid-magenta PNG to swap in."""
    img = Image.new("RGB", (256, 256), (255, 0, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def main() -> int:
    if not WHITEPAPER.exists():
        print(f"SKIP: fixture missing: {WHITEPAPER}")
        return 0

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        source_in = td_path / "source.pdf"
        source_in.write_bytes(WHITEPAPER.read_bytes())

        udm = import_pdf(source_in, source_url="/source.pdf", enable_ocr=False)

        images = udm["resources"]["images"]
        if not images:
            print("  [FAIL] no image resources found to replace")
            return 1

        new_png = make_replacement_png()
        new_sha = hashlib.sha256(new_png).hexdigest()[:16]
        target = images[0]
        target_xref = (target.get("_meta") or {}).get("xref")
        print(f"  replacing image {target['id']} (source xref {target_xref})")

        if not target_xref:
            print("  [FAIL] image resource has no _meta.xref")
            return 1

        target["data_ref"] = "data:image/png;base64," + base64.b64encode(new_png).decode()

        out = td_path / "image_replaced.pdf"
        export_pdf(udm, out, base_dir=td_path)

        ok = True

        # Verify by rendering — garbage=4 on save renumbers xrefs, so
        # extracting the original xref from the output is unreliable.
        # The page-1 logo sits at ~(62,14)-(141,93) pt; sample its center.
        result = pymupdf.open(str(out))
        try:
            page = result[0]
            pix = page.get_pixmap(dpi=150)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            cx = int(101 * 150 / 72)
            cy = int(53 * 150 / 72)
            px = img.getpixel((cx, cy))
            # Tolerance — JPEG/PNG re-encode may shift the magenta slightly.
            if px[0] > 200 and px[1] < 80 and px[2] > 200:
                print(f"  [PASS] replacement image rendered (magenta {px}, sha {new_sha})")
            else:
                print(f"  [FAIL] logo region is {px}, not magenta — swap didn't render")
                ok = False

            page_text = page.get_text()
            if "1000PDF" in page_text:
                print("  [PASS] document text preserved")
            else:
                print("  [FAIL] document text lost after image swap")
                ok = False
        finally:
            result.close()

        print(f"  source={source_in.stat().st_size:,}b  output={out.stat().st_size:,}b")
        return 0 if ok else 1


if __name__ == "__main__":
    print("Image replacement export test\n")
    sys.exit(main())
