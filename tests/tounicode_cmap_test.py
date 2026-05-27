"""ToUnicode CMap preservation test (lesson #13 deep fix).

Two layers:

1. Importer: a real PDF that uses Type0 / CID fonts (CSCA Chemistry
   Syllabus is the canonical fixture) should produce font resources
   carrying `_meta.tounicode_cmap` pointing at a non-empty stream.

2. Exporter: `_attach_tounicode_to_font` should actually add a
   /ToUnicode entry to the font's xref when called on a freshly-
   inserted font, so re-embedded CIDFonts stay text-extractable.

Run from repo root:
    python tests/tounicode_cmap_test.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "pdf-adapter" / "src"))

import pymupdf  # noqa: E402

from pdf_adapter.exporter import _attach_tounicode_to_font  # noqa: E402
from pdf_adapter.importer import import_pdf  # noqa: E402


CSCA = Path.home() / "Downloads" / "CSCA Chemistry Examination Syllabus-2025.pdf"


def test_importer_extracts_cmap() -> bool:
    """Verify the importer captures /ToUnicode for at least one font."""
    if not CSCA.exists():
        print(f"  SKIP: fixture missing: {CSCA}")
        return True
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        udm = import_pdf(
            CSCA,
            assets_dir=td_path / "assets",
            assets_url_prefix="/assets",
            enable_ocr=False,
        )
        cmap_fonts = [
            f for f in udm["resources"]["fonts"]
            if (f.get("_meta") or {}).get("tounicode_cmap")
        ]
        if not cmap_fonts:
            print("  [FAIL] no font carried _meta.tounicode_cmap (CSCA uses Type0/Identity-H)")
            return False
        # Verify the saved CMap files exist and are non-empty.
        for f in cmap_fonts:
            ref = (f.get("_meta") or {}).get("tounicode_cmap")
            # ref is like "/assets/fonts/<id>.tounicode.cmap"
            local = td_path / "assets" / ref.removeprefix("/assets/")
            if not local.exists() or local.stat().st_size == 0:
                print(f"  [FAIL] cmap file empty or missing: {ref}")
                return False
        print(f"  [PASS] {len(cmap_fonts)} font(s) carried a non-empty ToUnicode CMap")
        return True


def test_exporter_attaches_cmap() -> bool:
    """Unit-test _attach_tounicode_to_font on a fresh PDF."""
    bundled_font = (
        REPO_ROOT
        / "services"
        / "pdf-adapter"
        / "src"
        / "pdf_adapter"
        / "fonts"
        / "arimo-Regular.ttf"
    )
    if not bundled_font.exists():
        print(f"  SKIP: bundled font missing: {bundled_font}")
        return True
    with tempfile.TemporaryDirectory() as td:
        # Build a tiny PDF, insert text with a udm_-prefixed font so
        # _attach_tounicode_to_font can find it by name.
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text(
            (72, 100),
            "Probe",
            fontname="udm_test_font",
            fontfile=str(bundled_font),
        )

        cmap_bytes = (
            b"/CIDInit /ProcSet findresource begin\n"
            b"12 dict begin\n"
            b"begincmap\n"
            b"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
            b"/CMapName /Adobe-Identity-UCS def\n"
            b"/CMapType 2 def\n"
            b"1 begincodespacerange\n"
            b"<0000> <FFFF>\n"
            b"endcodespacerange\n"
            b"endcmap\n"
            b"CMapName currentdict /CMap defineresource pop end end\n"
        )

        ok = _attach_tounicode_to_font(page, "test_font", cmap_bytes)
        if not ok:
            print("  [FAIL] _attach_tounicode_to_font returned False")
            doc.close()
            return False

        # Save + reopen, then verify the font dict has /ToUnicode.
        out_path = Path(td) / "out.pdf"
        doc.save(str(out_path))
        doc.close()

        reopened = pymupdf.open(str(out_path))
        try:
            attached = False
            for entry in reopened.get_page_fonts(0, full=True):
                xref = entry[0]
                refname = entry[4] if len(entry) > 4 else ""
                basefont = entry[3] if len(entry) > 3 else ""
                if "test_font" not in str(basefont) and "test_font" not in str(refname):
                    continue
                kind, val = reopened.xref_get_key(xref, "ToUnicode")
                if kind == "xref" and val:
                    attached = True
                    break
            if not attached:
                print("  [FAIL] re-opened PDF has no /ToUnicode on the test font")
                return False
            print("  [PASS] /ToUnicode survived save + reopen")
            return True
        finally:
            reopened.close()


def main() -> int:
    print("ToUnicode CMap preservation test\n")
    ok = True
    print("Test 1: importer captures /ToUnicode from a real Type0 PDF")
    ok = test_importer_extracts_cmap() and ok
    print()
    print("Test 2: exporter attaches /ToUnicode to a re-embedded font")
    ok = test_exporter_attaches_cmap() and ok
    print()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
