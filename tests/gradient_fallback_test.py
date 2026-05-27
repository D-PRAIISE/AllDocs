"""Gradient / pattern KNOWN-LIMITATION test (lesson #12 sub-item).

Empirically PyMuPDF's get_drawings doesn't return ANY entry for pure
shading-pattern fills (DeviceN /Pattern + /Shading) — they appear
only in get_bboxlog() as 'fill-shade' ops with an Int32-range
all-space bbox, which is unusable for placement. Properly capturing
these needs a clip-stack-aware content-stream interpreter resolving
the `sh` operator under the active clip — its own focused stretch.

This test documents the current behaviour: a gradient-only PDF
imports as zero shape layers. The test passes when that's true (the
honest baseline), and FAILS the moment we add real gradient capture
so it acts as a regression sentinel.

Run from repo root:
    python tests/gradient_fallback_test.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "pdf-adapter" / "src"))

try:
    import pikepdf
except ImportError:
    print("SKIP: pikepdf not installed")
    sys.exit(0)

from pdf_adapter.importer import import_pdf  # noqa: E402


def build_gradient_pdf(path: Path) -> None:
    """Construct a PDF with a single rect filled by a linear gradient
    pattern. Done at the dict / content-stream level via pikepdf
    because PyMuPDF doesn't expose gradient construction.
    """
    pdf = pikepdf.Pdf.new()
    # 8.5x11 in points
    page = pdf.add_blank_page(page_size=(612, 792))

    # Build /Shading dict (type 2 = axial / linear gradient).
    function = pikepdf.Dictionary({
        "/FunctionType": 2,
        "/Domain": pikepdf.Array([0, 1]),
        "/C0": pikepdf.Array([1, 0, 0]),  # start red
        "/C1": pikepdf.Array([0, 0, 1]),  # end blue
        "/N": 1,
    })
    shading = pdf.make_indirect(pikepdf.Dictionary({
        "/ShadingType": 2,
        "/ColorSpace": pikepdf.Name("/DeviceRGB"),
        "/Coords": pikepdf.Array([100, 100, 400, 100]),
        "/Function": function,
        "/Extend": pikepdf.Array([False, False]),
    }))
    pattern = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/Pattern"),
        "/PatternType": 2,  # shading pattern
        "/Shading": shading,
    }))

    # Attach to page resources.
    page.Resources = pikepdf.Dictionary({
        "/Pattern": pikepdf.Dictionary({"/P1": pattern}),
        "/ColorSpace": pikepdf.Dictionary({"/CS1": pikepdf.Name("/Pattern")}),
    })
    # Content stream: select pattern colorspace, then the pattern, then
    # paint a rect.
    content = (
        b"q\n"
        b"/CS1 cs\n"
        b"/P1 scn\n"
        b"100 100 300 200 re\n"
        b"f\n"
        b"Q\n"
    )
    page.Contents = pdf.make_stream(content)
    pdf.save(str(path))


def main() -> int:
    print("Gradient / pattern fallback test\n")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "gradient.pdf"
        try:
            build_gradient_pdf(src)
        except Exception as e:
            print(f"  SKIP: couldn't build gradient fixture: {e}")
            return 0

        udm = import_pdf(src, source_url="/gradient.pdf", enable_ocr=False)

        shapes = [
            l for p in udm["content"]["pages"]
            for l in p.get("layers", [])
            if l.get("type") == "shape"
        ]
        print(f"  imported {len(shapes)} shape layer(s) from a gradient-only PDF")
        # Documented baseline: zero shapes captured. If a future
        # implementation starts capturing them, this test will fail and
        # the next contributor will update both this test AND the
        # gradient-capture path with proper fixture coverage.
        if len(shapes) == 0:
            print("  [PASS] documented baseline: gradient shapes are not captured")
            print("        (see importer.py — lesson #12 'KNOWN LIMITATION')")
            return 0
        print("  [FAIL/NEW] shapes were captured — implementation changed; "
              "update this test and add gradient round-trip coverage.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
