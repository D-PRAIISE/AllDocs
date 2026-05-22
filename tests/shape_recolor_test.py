"""Shape recolor export test.

Imports a PDF with rectangle shapes, recolors one, exports, and checks
the new fill renders while overlapping text + the rest of the page are
preserved.

Run from repo root:
    python tests/shape_recolor_test.py
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

        # Find the largest rect shape that has no image overlapping it —
        # the navy header bar on a content page is the target.
        target = None
        target_page = -1
        for pi, page in enumerate(udm["content"]["pages"]):
            images = [li for li in page["layers"] if li.get("type") == "image"]
            for layer in page["layers"]:
                if layer.get("type") != "shape":
                    continue
                geom = layer.get("geometry") or {}
                if geom.get("kind") != "rect":
                    continue
                w = geom["w"]["value"]
                h = geom["h"]["value"]
                if w < 200 or h < 20:
                    continue
                # skip if an image overlaps (would block the recolor)
                sx, sy = geom["x"]["value"], geom["y"]["value"]
                overlaps_img = False
                for im in images:
                    ix, iy = im["x"]["value"], im["y"]["value"]
                    iw, ih = im["width"]["value"], im["height"]["value"]
                    if not (sx + w <= ix or ix + iw <= sx or sy + h <= iy or iy + ih <= sy):
                        overlaps_img = True
                        break
                if overlaps_img:
                    continue
                target = layer
                target_page = pi
                break
            if target:
                break

        if target is None:
            print("  SKIP: no suitable rect shape found")
            return 0

        old = target["fill"]["color"]["literal"]
        print(f"  recoloring shape on page {target_page + 1}: rgb"
              f"({old.get('r')},{old.get('g')},{old.get('b')}) -> rgb(0,150,0)")
        target["fill"]["color"]["literal"] = {"kind": "rgb", "r": 0, "g": 150, "b": 0}

        out = td_path / "recolored.pdf"
        export_pdf(udm, out, base_dir=td_path)

        ok = True
        result = pymupdf.open(str(out))
        try:
            geom = target["geometry"]
            cx = geom["x"]["value"] + geom["w"]["value"] / 2
            cy = geom["y"]["value"] + geom["h"]["value"] / 2
            page = result[target_page]
            pix = page.get_pixmap(dpi=150)
            from PIL import Image

            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            px = img.getpixel((int(cx * 150 / 72), int(cy * 150 / 72)))
            # The sampled point may land on text; check several points.
            hits = 0
            for fx in (0.2, 0.4, 0.6, 0.8):
                sx = int((geom["x"]["value"] + geom["w"]["value"] * fx) * 150 / 72)
                sy = int(cy * 150 / 72)
                p = img.getpixel((sx, sy))
                if p[1] > 100 and p[0] < 120 and p[2] < 120:
                    hits += 1
            if hits >= 2:
                print(f"  [PASS] shape shows the new green fill ({hits}/4 sample points)")
            else:
                print(f"  [FAIL] new fill not detected (sample center {px})")
                ok = False

            # The rest of the document survived.
            all_text = "\n".join(p.get_text() for p in result)
            if "1000PDF" in all_text:
                print("  [PASS] document text preserved")
            else:
                print("  [FAIL] document text lost")
                ok = False

            if len(result) == len(udm["content"]["pages"]):
                print("  [PASS] page count unchanged")
            else:
                print("  [FAIL] page count changed")
                ok = False
        finally:
            result.close()

        print()
        return 0 if ok else 1


if __name__ == "__main__":
    print("Shape recolor export test\n")
    sys.exit(main())
