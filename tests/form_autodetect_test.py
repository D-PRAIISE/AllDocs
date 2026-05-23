"""Form auto-detection test.

Generates a "Word-export-style" PDF: visual underlines for text blanks
and small square outlines for checkboxes, with labels — but NO real
widgets. Imports through AllDocs, exports, and verifies the output now
has proper AcroForm widgets at the detected positions.

Run from repo root:
    python tests/form_autodetect_test.py
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


def make_static_form(path: Path) -> None:
    """A static page that *looks* like a form but has no widgets."""
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 72), "Membership Application", fontsize=18)

    # Labels + blank lines for three text fields.
    rows = [("Full Name", 150), ("Email", 200), ("Phone", 250)]
    for label, y in rows:
        page.insert_text((72, y), f"{label}:", fontsize=11)
        # underline as a thin filled rect
        page.draw_rect(
            pymupdf.Rect(170, y + 1, 540, y + 1.5), color=(0, 0, 0), fill=(0, 0, 0)
        )

    # Two checkbox glyphs with labels.
    page.draw_rect(pymupdf.Rect(72, 320, 86, 334), color=(0, 0, 0), width=1)
    page.insert_text((96, 332), "I agree to the terms", fontsize=11)
    page.draw_rect(pymupdf.Rect(72, 345, 86, 359), color=(0, 0, 0), width=1)
    page.insert_text((96, 357), "Send me updates", fontsize=11)

    doc.save(str(path))
    doc.close()


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "source.pdf"
        make_static_form(src)

        udm = import_pdf(src, source_url="/source.pdf", enable_ocr=False)
        page0 = udm["content"]["pages"][0]
        form_layer = next((l for l in page0["layers"] if l.get("type") == "form"), None)

        ok = True

        if form_layer is None:
            print("  [FAIL] no form layer materialized from static form")
            return 1
        fields = form_layer["fields"]
        by_kind: dict[str, list[dict]] = {}
        for f in fields:
            by_kind.setdefault(f["kind"], []).append(f)
        print(f"  detected {len(fields)} fields: {sorted(by_kind)}")
        if len(by_kind.get("text", [])) >= 3:
            print(f"  [PASS] >= 3 text fields detected ({len(by_kind['text'])})")
        else:
            print(f"  [FAIL] only {len(by_kind.get('text', []))} text fields detected")
            ok = False
        if len(by_kind.get("checkbox", [])) >= 2:
            print(f"  [PASS] >= 2 checkboxes detected ({len(by_kind['checkbox'])})")
        else:
            print(f"  [FAIL] only {len(by_kind.get('checkbox', []))} checkboxes detected")
            ok = False

        names = [f["name"] for f in fields]
        if any("name" in n.lower() for n in names) and any("email" in n.lower() for n in names):
            print(f"  [PASS] labels borrowed as field names ({names[:4]}...)")
        else:
            print(f"  [FAIL] labels not used; got names {names}")
            ok = False

        # Fill a text and a checkbox to round-trip through export
        for f in fields:
            if "name" in f["name"].lower() and f["kind"] == "text":
                f["value"] = "Karalee Wugate"
            if f["kind"] == "checkbox":
                f["value"] = True
                break

        out = td_path / "exported.pdf"
        export_pdf(udm, out, base_dir=td_path)

        result = pymupdf.open(str(out))
        try:
            widgets = list(result[0].widgets())
            print(f"  output PDF has {len(widgets)} widgets")
            if len(widgets) >= 5:
                print("  [PASS] exporter materialized >= 5 widgets")
            else:
                print("  [FAIL] not enough widgets in output")
                ok = False
            name_w = next((w for w in widgets if "name" in (w.field_name or "").lower()), None)
            if name_w and name_w.field_value == "Karalee Wugate":
                print("  [PASS] filled text field round-trips")
            else:
                print("  [FAIL] text field value lost")
                ok = False
            cb_w = next((w for w in widgets if w.field_type_string == "CheckBox"), None)
            if cb_w and str(cb_w.field_value).lower() in ("yes", "on", "true"):
                print("  [PASS] toggled checkbox round-trips")
            else:
                print(f"  [FAIL] checkbox value = {cb_w and cb_w.field_value!r}")
                ok = False
        finally:
            result.close()
        print()
        return 0 if ok else 1


if __name__ == "__main__":
    print("Form auto-detection test\n")
    sys.exit(main())
