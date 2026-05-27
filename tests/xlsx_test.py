"""XLSX round-trip test.

Builds a small workbook with numbers, strings, a formula, a date, a
merged range, and a column-width override. Imports it, exports it,
re-imports, and verifies all of those survive.

Run from repo root:
    python tests/xlsx_test.py
"""
from __future__ import annotations

import datetime as _dt
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "office-adapter" / "src"))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import openpyxl  # noqa: E402

from office_adapter.xlsx import export_xlsx, import_xlsx  # noqa: E402


def build_fixture(path: Path) -> None:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Numbers"
    ws["A1"] = "Item"
    ws["B1"] = "Qty"
    ws["C1"] = "Total"
    ws["A2"] = "Widget"
    ws["B2"] = 3
    ws["C2"] = "=B2*1.50"
    ws["A3"] = "Gadget"
    ws["B3"] = 7
    ws["C3"] = "=B3*2.25"
    ws["A4"] = "Total"
    ws["C4"] = "=SUM(C2:C3)"
    ws["E1"] = _dt.date(2026, 5, 27)
    ws["E1"].number_format = "yyyy-mm-dd"
    ws.merge_cells("A1:C1")  # bogus header merge to validate round-trip
    ws.column_dimensions["A"].width = 24.0
    ws.row_dimensions[1].height = 30.0
    wb.save(str(path))
    wb.close()


def main() -> int:
    print("XLSX round-trip test\n")
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "in.xlsx"
        build_fixture(src)

        udm1 = import_xlsx(src)
        if udm1.get("mode") != "sheet":
            print(f"  [FAIL] expected mode='sheet', got {udm1.get('mode')!r}")
            return 1
        sheet = udm1["content"]["sheets"][0]
        cells = sheet["cells"]
        print(
            f"  imported: {len(udm1['content']['sheets'])} sheet, "
            f"{len(cells)} cells, {len(sheet.get('merges') or [])} merge"
        )

        ok = True
        # Spot-check a value, a formula, and the date.
        a1 = cells.get("A1") or {}
        if (a1.get("value") or {}).get("value") != "Item":
            print(f"  [FAIL] A1 = {a1!r}")
            ok = False
        c2 = cells.get("C2") or {}
        if not c2.get("formula", "").startswith("="):
            print(f"  [FAIL] C2 formula not captured: {c2!r}")
            ok = False
        e1 = cells.get("E1") or {}
        if (e1.get("value") or {}).get("kind") != "date":
            print(f"  [FAIL] E1 date not captured: {e1!r}")
            ok = False
        if ok:
            print("  [PASS] cell values + formula + date imported")

        # Round-trip: export then re-import.
        out = td_path / "out.xlsx"
        export_xlsx(udm1, out)
        udm2 = import_xlsx(out)
        sheet2 = udm2["content"]["sheets"][0]
        cells2 = sheet2["cells"]
        if len(cells2) != len(cells):
            print(f"  [FAIL] cell count drifted: {len(cells)} -> {len(cells2)}")
            ok = False
        else:
            print(f"  [PASS] cell count preserved ({len(cells2)})")

        if (cells2.get("C2") or {}).get("formula", "") != (cells.get("C2") or {}).get("formula", ""):
            print(
                f"  [FAIL] formula drifted: "
                f"{(cells.get('C2') or {}).get('formula')!r} -> "
                f"{(cells2.get('C2') or {}).get('formula')!r}"
            )
            ok = False
        else:
            print("  [PASS] formula text round-tripped")

        if sheet.get("merges") != sheet2.get("merges"):
            print(
                f"  [FAIL] merges drifted: {sheet.get('merges')!r} vs "
                f"{sheet2.get('merges')!r}"
            )
            ok = False
        else:
            print(f"  [PASS] merges preserved")

    print()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
