"""AcroForm round-trip test.

Generates a PDF with a text widget and a checkbox, imports it,
changes the text value, toggles the checkbox, adds a brand-new text
widget, exports, and verifies all three flow through.

Run from repo root:
    python tests/form_test.py
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


def make_form_pdf(path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 72), "Form test")
    # text widget
    wt = pymupdf.Widget()
    wt.rect = pymupdf.Rect(72, 120, 372, 144)
    wt.field_name = "applicant_name"
    wt.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    wt.field_value = ""
    page.add_widget(wt)
    # checkbox
    wc = pymupdf.Widget()
    wc.rect = pymupdf.Rect(72, 160, 88, 176)
    wc.field_name = "agree"
    wc.field_type = pymupdf.PDF_WIDGET_TYPE_CHECKBOX
    wc.field_value = "Off"
    page.add_widget(wc)
    doc.save(str(path))
    doc.close()


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "source.pdf"
        make_form_pdf(src)
        udm = import_pdf(src, source_url="/source.pdf", enable_ocr=False)

        page0 = udm["content"]["pages"][0]
        form_layer = next((l for l in page0["layers"] if l.get("type") == "form"), None)
        if form_layer is None:
            print("  [FAIL] importer didn't capture a form layer")
            return 1
        names = [f["name"] for f in form_layer["fields"]]
        print(f"  imported fields: {names}")
        if "applicant_name" not in names or "agree" not in names:
            print("  [FAIL] importer missed a field")
            return 1
        print("  [PASS] importer captured text + checkbox")

        # Edit values + add a brand-new field
        for f in form_layer["fields"]:
            if f["name"] == "applicant_name":
                f["value"] = "Karalee Wugate"
            elif f["name"] == "agree":
                f["value"] = True
        form_layer["fields"].append(
            {
                "kind": "text",
                "name": "phone",
                "rect": {"x": 72, "y": 200, "w": 200, "h": 24},
                "value": "0-814-885-3555",
                "_meta": {"added": True},
            }
        )

        out = td_path / "filled.pdf"
        export_pdf(udm, out, base_dir=td_path)

        ok = True
        result = pymupdf.open(str(out))
        try:
            widgets = {w.field_name: w for w in result[0].widgets()}
            if widgets.get("applicant_name") and widgets["applicant_name"].field_value == "Karalee Wugate":
                print("  [PASS] text field updated")
            else:
                print(f"  [FAIL] applicant_name value = {widgets.get('applicant_name') and widgets['applicant_name'].field_value!r}")
                ok = False
            agree_w = widgets.get("agree")
            if agree_w and str(agree_w.field_value).lower() in ("yes", "on", "true", "1"):
                print(f"  [PASS] checkbox flipped on (value={agree_w.field_value!r})")
            else:
                print(f"  [FAIL] agree value = {agree_w and agree_w.field_value!r}")
                ok = False
            phone_w = widgets.get("phone")
            if phone_w and phone_w.field_value == "0-814-885-3555":
                print("  [PASS] brand-new text field added")
            else:
                print(f"  [FAIL] phone field = {phone_w and phone_w.field_value!r}")
                ok = False
        finally:
            result.close()
        print()
        return 0 if ok else 1


if __name__ == "__main__":
    print("AcroForm round-trip test\n")
    sys.exit(main())
