"""Underline export test.

Underline is the one text attribute AllDocs stores on the run rather
than on the FontResource: there is no underlined weight to point a font
at, and PDF has no underline text attribute either. PyMuPDF offers
nothing for it — not a parameter on insert_text, not a render mode — so
both exporters measure the string and stroke the rule themselves.

Verifies the rule actually reaches the PDF, sits under the baseline
rather than through the glyphs, and spans the text rather than some
arbitrary width. Also checks an un-underlined run stays clean, so the
drawing isn't firing on everything.

Run from repo root:
    python tests/underline_test.py
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

TEXT = "Underline this line"
PLAIN = "Leave this one alone"
SIZE = 16
BASELINE_Y = 100.0
PLAIN_Y = 160.0


def build_source(path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=220)
    page.insert_text((50, BASELINE_Y), TEXT, fontsize=SIZE, fontname="helv")
    page.insert_text((50, PLAIN_Y), PLAIN, fontsize=SIZE, fontname="helv")
    doc.save(str(path))
    doc.close()


def horizontal_lines(page: pymupdf.Page) -> list[tuple[float, float, float]]:
    """Every roughly-horizontal stroked segment as (y, x0, x1)."""
    out: list[tuple[float, float, float]] = []
    for d in page.get_drawings():
        for item in d.get("items", []):
            if item[0] == "l":
                p1, p2 = item[1], item[2]
                if abs(p1.y - p2.y) < 0.6:
                    out.append((p1.y, min(p1.x, p2.x), max(p1.x, p2.x)))
            elif item[0] == "re":
                r = item[1]
                if r.height < 1.5:
                    out.append((r.y0, r.x0, r.x1))
    return out


def main() -> int:
    failures = 0
    print("Underline export test\n")
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "u.pdf"
        build_source(src)

        udm = import_pdf(src, source_url="/u.pdf", enable_ocr=False)
        runs = [
            r
            for p in udm["content"]["pages"]
            for l in p["layers"]
            if l["type"] == "text"
            for r in l["runs"]
        ]
        target = next((r for r in runs if TEXT in r["text"]), None)
        if target is None:
            print(f"  [FAIL] couldn't find the run: {[r['text'] for r in runs]!r}")
            return 1

        # What the editor does when you press U.
        target["underline"] = True
        target.setdefault("_meta", {})["edited"] = True

        out = td_path / "underlined.pdf"
        export_pdf(udm, out, base_dir=td_path)
        result = pymupdf.open(str(out))
        lines = horizontal_lines(result[0])
        result.close()  # Windows won't remove the tempdir while it's open
        print(f"  horizontal strokes in export: {len(lines)}")

        # 1. a rule exists just below the baseline of the underlined run
        under = [
            (y, x0, x1)
            for (y, x0, x1) in lines
            if BASELINE_Y < y <= BASELINE_Y + SIZE * 0.5
        ]
        if not under:
            print(f"  [FAIL] no rule below baseline {BASELINE_Y}: {lines!r}")
            failures += 1
        else:
            y, x0, x1 = under[0]
            print(f"  [PASS] rule at y={y:.1f} ({y - BASELINE_Y:.1f}pt below baseline)")

            # 2. it spans the text, not some arbitrary width
            expected = pymupdf.get_text_length(TEXT, fontname="helv", fontsize=SIZE)
            got = x1 - x0
            if abs(got - expected) > max(2.0, expected * 0.15):
                print(f"  [FAIL] rule is {got:.1f}pt wide, text is {expected:.1f}pt")
                failures += 1
            else:
                print(f"  [PASS] rule spans {got:.1f}pt against {expected:.1f}pt of text")

            # 3. it's under the glyphs, not through them
            if y <= BASELINE_Y:
                print(f"  [FAIL] rule at {y:.1f} is on/above the baseline")
                failures += 1
            else:
                print("  [PASS] rule sits below the baseline, not through the text")

        # 4. the un-underlined run got nothing
        stray = [
            (y, x0, x1) for (y, x0, x1) in lines if PLAIN_Y < y <= PLAIN_Y + SIZE * 0.5
        ]
        if stray:
            print(f"  [FAIL] un-underlined run also got a rule: {stray!r}")
            failures += 1
        else:
            print("  [PASS] un-underlined run left clean")

    print()
    print("ALL PASS" if failures == 0 else f"{failures} FAILURE(S)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
